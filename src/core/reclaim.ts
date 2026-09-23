import { getTask, setTask } from './backlog.ts';
import { readJudgment } from './judgment.ts';
import { listProcs, removeProc, type ProcRecord } from './procs.ts';
import { processStartedAt } from './process-time.ts';
import { readState, transitionState, updateState, allowedTransition } from './state.ts';
import { harnessPath, withFileLock } from './storage.ts';
import { groupAlive, reclaimOwnedGroup } from '../provider/runner.ts';

export async function cleanupReport(root: string, resetFailures = true) {
  const records = await listProcs(root), removed: ProcRecord[] = [];
  const protectedGroups = new Set(records.filter(record => record.kind === 'brain').map(record => record.pgid));
  for (const record of records.filter(record => record.kind !== 'brain')) {
    if (protectedGroups.has(record.pgid) || record.pgid !== record.pid || record.pid <= 1 || record.pid === process.pid) continue;
    const observed = await processStartedAt(record.pid);
    if (observed && !sameStart(observed, record.startedAt)) continue;
    // 시작 시각을 읽을 수 없더라도 커널이 그룹 부재(ESRCH)를 확인한 경우만 삭제한다. 신호는 보내지 않는다.
    if (!groupAlive(record.pgid)) { await removeProc(root, record.pid, record.runId); removed.push(record); }
  }
  const remaining = await listProcs(root), residual = remaining.filter(record => record.kind !== 'brain');
  if (!residual.length && resetFailures) await updateState(root, { cleanupFailures: 0 });
  return { ok: residual.length === 0, remaining: residual.length, residual, removed,
    protected: remaining.filter(record => record.kind === 'brain') };
}
function sameStart(observed: string, stored: string): boolean {
  if (stored.startsWith('spawn:')) return false;
  const a = Date.parse(observed), b = Date.parse(stored);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) <= 2000 : observed === stored;
}
async function reclaimRecord(record: ProcRecord): Promise<boolean> {
  // runner의 핸들 없는 영속 레지스트리를 쓰므로 신호 전에 소유권을 새로 확인한다.
  if (!Number.isSafeInteger(record.pgid) || record.pgid <= 1 || record.pgid !== record.pid || record.pid === process.pid) return false;
  if (!groupAlive(record.pgid)) return true;
  const observed = await processStartedAt(record.pid);
  if (!observed || record.startedAt.startsWith('spawn:')) return false;
  if (!sameStart(observed, record.startedAt)) return false;
  return reclaimOwnedGroup(record.pgid);
}
export async function reclaimTask(root: string, taskId: string, judgmentId: string, options: { suspended?: boolean } = {}) {
  return withFileLock(harnessPath(root, 'harness-reclaim'), async () => {
    await getTask(root, taskId);
    const judgment = (await readJudgment(root)).items.find(item => item.id === judgmentId);
    if (!judgment || !judgment.blocks.split(/[,\s]+/u).includes(taskId)) throw new Error('task를 막는 열린 판단 번호가 필요합니다');
    const state = await readState(root);
    if (state.taskId !== taskId) throw new Error('현재 task만 회수할 수 있습니다');
    const retry = state.state === 'CLEANUP' && (state.pendingReclaim as { taskId?: string; judgmentId?: string } | undefined)?.taskId === taskId
      && (state.pendingReclaim as { judgmentId?: string }).judgmentId === judgmentId;
    if (retry) await updateState(root, { state: 'RECLAIM' });
    if (state.state !== 'RECLAIM' && !retry) {
      if (options.suspended && !allowedTransition(state.state, 'RECLAIM')) await updateState(root, { state: 'RECLAIM' });
      else await transitionState(root, 'RECLAIM', { taskId });
    }
    await updateState(root, { pendingReclaim: { taskId, judgmentId } });
    const records = await listProcs(root);
    const brainGroups = new Set(records.filter(record => record.kind === 'brain').map(record => record.pgid));
    let failed = false;
    for (const record of records.filter(record => record.taskId === taskId && record.kind !== 'brain')) {
      const reclaimed = !brainGroups.has(record.pgid) && await reclaimRecord(record).catch(() => false);
      if (reclaimed) await removeProc(root, record.pid, record.runId);
      else failed = true;
    }
    const { residual } = await cleanupReport(root, false);
    if (failed || residual.length) {
      const failedState = await transitionState(root, 'CLEANUP_FAILED');
      return { error: '프로세스 회수 실패', judgment: judgmentId, reclaimed: false, next: failedState.state, residual };
    }
    await setTask(root, taskId, { status: `blocked(${judgmentId})`, judgment: judgmentId });
    await updateState(root, { pendingReclaim: undefined, cleanupFailures: 0 });
    await transitionState(root, 'PICK');
    return { judgment: judgmentId, reclaimed: true, next: 'PICK' };
  });
}
