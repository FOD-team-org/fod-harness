import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';

export interface ProcRecord { pid: number; pgid: number; startedAt: string; runId: string; kind: string; cmd?: string; taskId?: string; sessionId?: string; protectedUntil?: string; ownerPid?: number; ownerStartedAt?: string }
export async function listProcs(root: string): Promise<ProcRecord[]> { return readJson(harnessPath(root, 'harness-procs.json'), []); }

export async function registerProc(root: string, record: ProcRecord): Promise<ProcRecord> {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1
    || !Number.isSafeInteger(record.pgid) || record.pgid <= 1 || !record.startedAt || !record.runId) {
    throw new Error('프로세스 등록 정보가 올바르지 않습니다');
  }
  record = { ...record, sessionId: record.sessionId ?? process.env.FODH_SESSION_ID };
  const path = harnessPath(root, 'harness-procs.json');
  await withFileLock(path, async () => {
    const records = await listProcs(root);
    if (records.some(value => value.pid === record.pid
      && (value.runId !== record.runId || value.startedAt !== record.startedAt))) {
      throw new Error('다른 실행이 소유한 프로세스 번호입니다');
    }
    await atomicWrite(path, JSON.stringify([...records.filter(value => value.pid !== record.pid), record], null, 2) + '\n');
  });
  return record;
}

export async function removeProc(root: string, pid: number, runId?: string): Promise<void> {
  const path = harnessPath(root, 'harness-procs.json');
  await withFileLock(path, async () => {
    const records = await listProcs(root);
    await atomicWrite(path, JSON.stringify(
      records.filter(record => record.pid !== pid || (runId !== undefined && record.runId !== runId)), null, 2,
    ) + '\n');
  });
}

export async function refreshProcStartedAt(root: string, pid: number, runId: string, expected: string, startedAt: string): Promise<void> {
  const path = harnessPath(root, 'harness-procs.json');
  await withFileLock(path, async () => {
    const records = await listProcs(root);
    const record = records.find(value => value.pid === pid && value.runId === runId && value.startedAt === expected);
    if (!record) return;
    record.startedAt = startedAt;
    await atomicWrite(path, JSON.stringify(records, null, 2) + '\n');
  });
}
