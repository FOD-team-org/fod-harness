import { randomUUID } from 'node:crypto';
import { atomicWrite, harnessPath, parseJsonLines, readText, withFileLock } from './storage.ts';

export interface InboxRecord {
  id: string; kind: string; status: 'detected' | 'queued' | 'delivered' | 'applied';
  at: string; runId?: string; dedupeKey?: string; [key: string]: unknown;
}
export async function listInbox(root: string): Promise<InboxRecord[]> {
  return parseJsonLines<InboxRecord>(await readText(harnessPath(root, 'harness-inbox.jsonl')));
}

async function mutate(root: string, action: (records: InboxRecord[]) => InboxRecord[]): Promise<InboxRecord[]> {
  const path = harnessPath(root, 'harness-inbox.jsonl');
  return withFileLock(path, async () => {
    const records = action(await listInbox(root));
    await atomicWrite(path, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
    return records;
  });
}

export async function addInboxOnce(root: string, entry: { kind: string; dedupeKey?: string; [key: string]: unknown }): Promise<{
  record: InboxRecord; created: boolean;
}> {
  if (!entry.kind.trim()) throw new Error('인박스 종류가 필요합니다');
  let record: InboxRecord = { ...entry, id: randomUUID(), kind: entry.kind, status: 'detected', at: new Date().toISOString() };
  let created = true;
  await mutate(root, records => {
    const existing = entry.dedupeKey === undefined ? undefined
      : records.find(item => item.dedupeKey === entry.dedupeKey && item.status !== 'applied');
    if (existing) { record = existing; created = false; return records; }
    return [...records, record];
  });
  return { record, created };
}
export async function addInbox(root: string, entry: { kind: string; dedupeKey?: string; [key: string]: unknown }): Promise<InboxRecord> {
  return (await addInboxOnce(root, entry)).record;
}

async function change(root: string, ids: string[], status: InboxRecord['status'], runId?: string): Promise<InboxRecord[]> {
  const records = await mutate(root, records => {
    if (ids.some(id => !records.some(record => record.id === id))) throw new Error('인박스 항목을 찾을 수 없습니다');
    return records.map(record => {
      if (!ids.includes(record.id) || record.status === 'applied') return record;
      if (status === 'queued' && record.status !== 'detected') return record;
      if (status === 'applied' && record.status !== 'delivered') throw new Error('전달되지 않은 인박스는 확인 처리할 수 없습니다');
      if (status === 'applied' && runId && record.runId !== runId) throw new Error('인박스 실행 번호가 일치하지 않습니다');
      return { ...record, status, ...(runId ? { runId } : {}) };
    });
  });
  return records.filter(record => ids.includes(record.id));
}

export async function queueInbox(root: string, id: string): Promise<InboxRecord> { return (await change(root, [id], 'queued'))[0]!; }
export async function deliverInbox(root: string, ids: string[], runId: string): Promise<InboxRecord[]> {
  return change(root, ids, 'delivered', runId);
}
export async function ackInbox(root: string, ids: string[], runId?: string): Promise<InboxRecord[]> {
  return change(root, ids, 'applied', runId);
}

export async function resolveInbox(root: string, ids: string[], by: 'orchestrator', note?: string): Promise<InboxRecord[]> {
  const records = await mutate(root, records => {
    if (ids.some(id => !records.some(record => record.id === id))) throw new Error('인박스 항목을 찾을 수 없습니다');
    return records.map(record => ids.includes(record.id)
      ? { ...record, status: 'applied', resolvedBy: by, ...(note ? { resolutionNote: note } : {}) } : record);
  });
  return records.filter(record => ids.includes(record.id));
}
