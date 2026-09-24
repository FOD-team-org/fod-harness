import { runCleanup, protectedProcessGroups, cleanupStaleProcess } from './cleanup.ts';
import { cancel } from './codex.ts';
import { getTask, setTask } from './backlog.ts';
import { readJudgment } from './judgment.ts';
import { listProcs, type ProcRecord } from './procs.ts';
import { readState, transitionState, updateState, allowedTransition, taskStates } from './state.ts';
import { harnessPath, withFileLock } from './storage.ts';

export async function cleanupReport(root: string, resetFailures = true) {
  const records = await listProcs(root), stale: ProcRecord[] = [];
  const protectedGroups = await protectedProcessGroups(root, records);
  for (const record of records) {
    if (protectedGroups.has(record.pgid) || record.pid <= 1 || record.pid === process.pid) continue;
    try { if (await cleanupStaleProcess(root, record) === 'stale') stale.push(record); }
    catch { /* Keep the record residual when tool ownership or reclamation is unavailable. */ }
  }
  const remaining = await listProcs(root), residual = remaining.filter(record => !protectedGroups.has(record.pgid));
  if (!residual.length && resetFailures) await updateState(root, { cleanupFailures: 0 });
  return { ok: residual.length === 0, remaining: residual.length, residual, removed: stale, stale,
    protected: remaining.filter(record => protectedGroups.has(record.pgid)) };
}
export async function reclaimTask(root: string, taskId: string, judgmentId: string, options: { suspended?: boolean } = {}) {
  return withFileLock(harnessPath(root, 'harness-reclaim'), async () => {
    const task = await getTask(root, taskId);
    const judgment = (await readJudgment(root)).items.find(item => item.id === judgmentId);
    if (!judgment || !judgment.blocks.split(/[,\s]+/u).includes(taskId)) throw new Error('task를 막는 열린 판단 번호가 필요합니다');
    const state = await readState(root);
    if (state.taskId !== taskId) throw new Error('현재 task만 회수할 수 있습니다');
    const retry = state.state === 'CLEANUP' && (state.pendingReclaim as { taskId?: string; judgmentId?: string } | undefined)?.taskId === taskId
      && (state.pendingReclaim as { judgmentId?: string }).judgmentId === judgmentId;
    const resumeState = taskStates.includes(state.state) ? state.state : state.resumeTask?.resumeState ?? state.resumeState;
    if (!retry && ['doing', 'verify', 'review', 'fix', 'merge'].includes(task.status) && resumeState) {
      await setTask(root, taskId, { resume: { status: task.status, state: resumeState, at: new Date().toISOString() } });
      await updateState(root, { resumeTask: { taskId, resumeState } });
    }
    if (retry) await updateState(root, { state: 'RECLAIM' });
    if (state.state !== 'RECLAIM' && !retry) {
      if (options.suspended && !allowedTransition(state.state, 'RECLAIM')) await updateState(root, { state: 'RECLAIM' });
      else await transitionState(root, 'RECLAIM', { taskId });
    }
    await updateState(root, { pendingReclaim: { taskId, judgmentId } });
    // RECLAIM explicitly cancels this task's delegation; general cleanup never does.
    let failed = false;
    if (state.delegation?.taskId === taskId) {
      try { await cancel(root, state.delegation.runId); } catch { failed = true; }
    }
    const report = await runCleanup(root, { scope: 'processes', taskId });
    const { residual } = await cleanupReport(root, false);
    failed ||= !report.ok;
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
