import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/core/config.ts';
import { appendLedger } from '../../src/core/ledger.ts';
import { detectRecovery, tick } from '../../src/core/watcher.ts';
import { redact } from '../../src/provider/privacy.ts';
import { decideInbox } from '../orchestrator/index.ts';

export default function watcher(pi: ExtensionAPI): void {
  let root: string, ctx: ExtensionContext;
  let sessionStartedAt: string;
  let timers: ReturnType<typeof setInterval>[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined, watchedDirectory: string | undefined;
  let pending: Promise<void> | undefined;
  let stopped = true, lastWarning = -Infinity;
  const fail = async (action: 'tick' | 'fs-watch', error: unknown) => {
    const message = redact(error instanceof Error ? error.message : '워처 실행 실패');
    try { await appendLedger(root, { runId: sessionStartedAt, action: `watcher:${action}`, status: 'fail', evidence: { message } }); }
    catch { /* Storage failure must not escape a timer callback. */ }
    if (ctx?.hasUI && Date.now() - lastWarning >= 60000) {
      lastWarning = Date.now();
      try { ctx.ui.notify(`워처 ${action} 실패: ${message}`, 'warning'); } catch { /* disposed UI */ }
    }
  };
  const ensureWatch = async () => {
    const directory = dirname(resolve(root, (await loadConfig(root)).judgment.file));
    if (stopped || directory === watchedDirectory) return;
    watcher?.close(); watcher = undefined; watchedDirectory = directory;
    try {
      watcher = watch(directory, { persistent: false }, () => {
        if (stopped) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { debounce = undefined; void run(true); }, 500);
        debounce.unref();
      });
      watcher.on('error', error => {
        watcher?.close(); watcher = undefined;
        void fail('fs-watch', error);
      });
    } catch (error) { await fail('fs-watch', error); }
  };
  const run = (judgmentOnly = false): Promise<void> => {
    if (stopped || pending) return Promise.resolve();
    pending = (async () => {
      try {
        const result = await tick(root, { ctx, judgmentOnly });
        if (!stopped && result.emitted.length) await decideInbox(pi, ctx, root, result.emitted);
        if (!stopped) await ensureWatch();
      } catch (error) { await fail('tick', error); }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const shutdown = async () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    watcher?.close(); watcher = undefined; watchedDirectory = undefined;
    await pending;
  };
  pi.on('session_start', async (_event, context) => {
    await shutdown();
    root = context.cwd; ctx = context; lastWarning = -Infinity;
    sessionStartedAt = `${new Date().toISOString()}:${randomUUID()}`;
    try {
      const records = await detectRecovery(root, sessionStartedAt);
      // Print mode only records recovery; it never starts another turn.
      if (ctx.hasUI === false) return;
      if (records.length) await decideInbox(pi, ctx, root, records);
      const config = await loadConfig(root);
      stopped = false;
      // Register the full tick first so coincident poll deadlines cannot starve it.
      timers = [setInterval(() => { void run(); }, config.watch.tickSeconds * 1000),
        setInterval(() => { void run(true); }, config.watch.pollSeconds * 1000)];
      for (const timer of timers) timer.unref();
      await ensureWatch();
    } catch (error) { await fail('tick', error); }
  });
  // Keep UI/idle access tied to the newest live Pi context.
  pi.on('agent_start', async (_event, context) => { ctx = context; });
  pi.on('agent_end', async (_event, context) => { ctx = context; });
  pi.on('session_shutdown', shutdown);
}
