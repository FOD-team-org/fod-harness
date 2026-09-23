import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { harnessPath, parseJsonLines, readText, withFileLock } from './storage.ts';

export interface LedgerEntry {
  runId: string; action: string; status: 'pre' | 'running' | 'ok' | 'fail' | 'unknown';
  taskId?: string; state?: string; evidence?: unknown; at?: string;
}

export async function appendLedger(root: string, entry: LedgerEntry): Promise<LedgerEntry> {
  const path = harnessPath(root, 'harness-ledger.jsonl');
  const record = { ...entry, at: entry.at ?? new Date().toISOString() };
  await withFileLock(path, async () => { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 }); });
  return record;
}

export async function readLedger(root: string): Promise<LedgerEntry[]> {
  const path = harnessPath(root, 'harness-ledger.jsonl');
  return withFileLock(path, async () => parseJsonLines<LedgerEntry>(await readText(path)));
}

export async function unknownEntries(root: string): Promise<LedgerEntry[]> {
  const last = new Map<string, LedgerEntry>();
  for (const entry of await readLedger(root)) last.set(JSON.stringify([entry.runId, entry.action]), entry);
  return [...last.values()].filter(entry => ['pre', 'running', 'unknown'].includes(entry.status)).map(entry => ({ ...entry, status: 'unknown' }));
}
