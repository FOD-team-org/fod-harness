import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { harnessPath, withFileLock } from './storage.ts';
import { resolve } from 'node:path';
import { loadConfig, type HarnessConfig } from './config.ts';
import { appendLedger } from './ledger.ts';
import { redact } from '../provider/privacy.ts';
export interface Notification { key: string; level: 'info' | 'warning' | 'error'; title: string; body: string }
export interface NotifyContext { hasUI?: boolean; notify?: (message: string, level: Notification['level']) => void }
const cacheKey = Symbol.for('fod-harness.notify.last');
const shared = globalThis as typeof globalThis & { [cacheKey]?: Map<string, number> };
const last = shared[cacheKey] ??= new Map<string, number>();
const contextKey = Symbol.for('fod-harness.notify.contexts');
const contextShared = globalThis as typeof globalThis & { [contextKey]?: Map<string, NotifyContext> };
const contexts = contextShared[contextKey] ??= new Map<string, NotifyContext>();
export function setNotifyContext(root: string, context?: NotifyContext) { if (context) contexts.set(resolve(root), context); else contexts.delete(resolve(root)); }
export const appleString = (text: string) => `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\r/gu, '\\r').replace(/\n/gu, '\\n')}"`;
// Read only the tail, even when the ledger spans many runs.
async function recentNotifications(root: string): Promise<{ action?: string; status?: string; at?: string }[]> {
  const file = await open(harnessPath(root, 'harness-ledger.jsonl'), 'r').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!file) return [];
  try {
    let position = (await file.stat()).size, bytes = Buffer.alloc(0), lines = 0;
    while (position > 0 && lines <= 200) {
      const size = Math.min(8192, position), block = Buffer.alloc(size); position -= size;
      const { bytesRead } = await file.read(block, 0, size, position);
      const chunk = block.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 10) lines++;
      bytes = Buffer.concat([chunk, bytes]);
    }
    return bytes.toString('utf8').trimEnd().split('\n').slice(-200).flatMap(line => {
      try { const entry = JSON.parse(line); return entry && typeof entry === 'object' ? [entry] : []; } catch { return []; }
    });
  } finally { await file.close(); }
}
export async function notify(root: string, message: Notification, ctxLike?: NotifyContext,
  options: { now?: number; exec?: (file: string, args: string[]) => Promise<unknown>; config?: HarnessConfig; dedupe?: boolean } = {}) {
  // Configuration diagnostics may notify; load before taking the notification lock.
  const config = options.config ?? await loadConfig(root);
  return withFileLock(harnessPath(root, 'harness-notify'), async () => {
    ctxLike ??= contexts.get(resolve(root));
    message = { ...message, key: redact(message.key).slice(0, 200) };
    const now = options.now ?? Date.now(), key = `${resolve(root)}:${message.key}`;
    const title = redact(message.title).slice(0, 200), body = redact(message.body).slice(0, 200);
    const recent = await recentNotifications(root);
    const inWindow = (at: number) => now >= at && now - at < 60000;
    const limited = options.dedupe !== false && (last.has(key) && inWindow(last.get(key)!)
      || recent.some(entry => entry.action === `notify:${message.key}` && entry.status === 'ok' && inWindow(Date.parse(entry.at ?? ''))));
    if (!limited) last.set(key, now);
    await appendLedger(root, { runId: message.key, action: `notify:${message.key}`, status: limited ? 'skip' : 'ok', at: new Date(now).toISOString(), evidence: { title, body, level: message.level } });
    if (config.notify.channels.includes('slack')) await appendLedger(root, { runId: message.key, action: 'notify:slack', status: 'skip' });
    if (limited) return { sent: false, limited: true };
    if (config.notify.channels.includes('tui') && ctxLike?.hasUI !== false) {
      try { ctxLike?.notify?.(body, message.level); } catch { /* A disposed UI does not suppress other channels. */ }
    }
    if (config.notify.channels.includes('macos')) {
      if (!options.exec && process.env.FODH_NOTIFY_OS === 'off') {
        await appendLedger(root, { runId: message.key, action: 'notify:macos', status: 'skip', evidence: { reason: 'FODH_NOTIFY_OS=off' } });
      } else try {
        await (options.exec ?? ((file, args) => promisify(execFile)(file, args, { timeout: 3000 })))('osascript', ['-e', `display notification ${appleString(body)} with title ${appleString(title)}`]);
      } catch { await appendLedger(root, { runId: message.key, action: 'notify:macos', status: 'fail' }); }
    }
    return { sent: true, limited: false };
  });
}
