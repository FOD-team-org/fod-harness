import { getTask, setTask } from './backlog.ts';
import { readJudgment } from './judgment.ts';
import { listProcs, removeProc, type ProcRecord } from './procs.ts';
import { processStartedAt } from './process-time.ts';
import { readState, transitionState, updateState } from './state.ts';
import { harnessPath, withFileLock } from './storage.ts';
import { groupAlive, reclaimOwnedGroup } from '../provider/runner.ts';

export async function cleanupReport(root: string) {
  const records = await listProcs(root);
  const residual = records.filter(record => record.kind !== 'brain');
  return { ok: residual.length === 0, remaining: residual.length, residual,
    protected: records.filter(record => record.kind === 'brain') };
}
async function reclaimRecord(record: ProcRecord): Promise<boolean> {
  // runner의 핸들 없는 영속 레지스트리를 쓰므로 신호 전에 소유권을 새로 확인한다.
  if (!Number.isSafeInteger(record.pgid) || record.pgid <= 1 || record.pgid !== record.pid || record.pid === process.pid) return false;
  if (!groupAlive(record.pgid)) return true;
  const observed = await processStartedAt(record.pid);
  if (!observed || record.startedAt.startsWith('spawn:')) return false;
  const a = Date.parse(observed), b = Date.parse(record.startedAt);
  if (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) > 2000 : observed !== record.startedAt) return false;
  return reclaimOwnedGroup(record.pgid);
}
export async function reclaimTask(root: string, taskId: string, judgmentId: string) {
  return withFileLock(harnessPath(root, 'harness-reclaim'), async () => {
    await getTask(root, taskId);
    const judgment = (await readJudgment(root)).items.find(item => item.id === judgmentId);
    if (!judgment || !judgment.blocks.split(/[,\s]+/u).includes(taskId)) throw new Error('task를 막는 열린 판단 번호가 필요합니다');
    const state = await readState(root);
    if (state.taskId !== taskId) throw new Error('현재 task만 회수할 수 있습니다');
    const retry = state.state === 'CLEANUP' && (state.pendingReclaim as { taskId?: string; judgmentId?: string } | undefined)?.taskId === taskId
      && (state.pendingReclaim as { judgmentId?: string }).judgmentId === judgmentId;
    if (state.state !== 'RECLAIM' && !retry) await transitionState(root, 'RECLAIM', { taskId });
    await updateState(root, { pendingReclaim: { taskId, judgmentId } });
    const records = await listProcs(root);
    const brainGroups = new Set(records.filter(record => record.kind === 'brain').map(record => record.pgid));
    let failed = false;
    for (const record of records.filter(record => record.taskId === taskId && record.kind !== 'brain')) {
      const reclaimed = !brainGroups.has(record.pgid) && await reclaimRecord(record).catch(() => false);
      if (reclaimed) await removeProc(root, record.pid, record.runId);
      else failed = true;
    }
    const residual = (await listProcs(root)).filter(record => record.kind !== 'brain');
    if (failed || residual.length) {
      await transitionState(root, 'CLEANUP_FAILED');
      return { judgment: judgmentId, reclaimed: false, next: 'CLEANUP_FAILED', residual };
    }
    await setTask(root, taskId, { status: `blocked(${judgmentId})`, judgment: judgmentId });
    await updateState(root, { pendingReclaim: undefined });
    await transitionState(root, 'PICK');
    return { judgment: judgmentId, reclaimed: true, next: 'PICK' };
  });
}
