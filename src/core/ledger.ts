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
  await withFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
  return record;
}

export async function readLedger(root: string): Promise<LedgerEntry[]> {
  const path = harnessPath(root, 'harness-ledger.jsonl');
  return withFileLock(path, async () => parseJsonLines<LedgerEntry>(await readText(path)));
}

export async function unknownEntries(root: string): Promise<LedgerEntry[]> {
  const last = new Map<string, LedgerEntry>();
  for (const entry of await readLedger(root)) last.set(JSON.stringify([entry.runId, entry.action]), entry);
  return [...last.values()]
    .filter(entry => ['pre', 'running', 'unknown'].includes(entry.status))
    .map(entry => ({ ...entry, status: 'unknown' }));
}

export async function resolveLedger(root: string, runId: string, action: string, status: string, note: string) {
  if (!['ok', 'fail'].includes(status) || !note?.trim()) throw new Error('ok|fail 및 --evidence 문장이 필요합니다.');
  if (!(await unknownEntries(root)).some(entry => entry.runId === runId && entry.action === action)) {
    throw new Error('미해결 원장 항목을 찾을 수 없습니다.');
  }
  return appendLedger(root, { runId, action, status: status as 'ok' | 'fail', evidence: { resolvedBy: 'fodh', note } });
}
