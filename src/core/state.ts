import { runCleanup } from './cleanup.ts';
import { notify } from './notify.ts';
import { redact } from '../provider/privacy.ts';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { getTask, setTask, missingDoD, BacklogError, type Task } from './backlog.ts';
import { appendLedger } from './ledger.ts';
import { loadConfig } from './config.ts';

export interface HarnessState {
  delegation?: { runId: string; taskId?: string; kind: 'task' | 'review' | 'research'; startedAt: string; title?: string };
  awaitingDelegation?: boolean; delegationReminder?: string;
  worktrees?: { taskId: string; path: string; branch: string; createdAt: string }[];
  state: string; sessionId?: string; taskId?: string; savedAt?: string; resumeState?: string;
  resumeTask?: { taskId?: string; resumeState?: string }; awaitingUser?: boolean; userAborted?: boolean; cleanupFailures?: number;
  enteredAt?: string; autoTurns?: number; phase?: 'project' | 'task'; lastPaused?: string;
  retry?: { count: number; nextAt?: string }; [key: string]: unknown;
}
export const activeStates = new Set(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PLANNING', 'PICK',
  'SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'MERGE', 'DOCS', 'CLEANUP', 'RECLAIM', 'recovering']);
export const taskStates = ['SPEC', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FIX', 'MERGE', 'DOCS', 'CLEANUP'];
const projectStates = ['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'];
export const isPaused = (state: string) => /^paused\((billing|quota|error|memory|budget|cleanup)\)$/u.test(state);
export async function readState(root: string): Promise<HarnessState> {
  return readJson(harnessPath(root, 'harness-state.json'), { state: 'IDLE', autoTurns: 0 });
}
export async function updateState(
  root: string,
  patch: Partial<HarnessState> | ((current: HarnessState) => Partial<HarnessState> | Promise<Partial<HarnessState>>),
): Promise<HarnessState> {
  const path = harnessPath(root, 'harness-state.json');
  let committedState: HarnessState | undefined, stateChanged = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readState(root);
    const next: HarnessState = { ...current, ...(typeof patch === 'function' ? await patch(current) : patch), savedAt: new Date().toISOString() };
    if (typeof next.state !== 'string' || !next.state.trim()) throw new Error('상태 값이 올바르지 않습니다');
    const changed = next.state !== current.state;
    if (changed || next.taskId !== current.taskId) { next.autoTurns = 0; next.enteredAt = next.savedAt; }
    if (changed && (isPaused(next.state) || next.state === 'recovering')) {
      if (taskStates.includes(current.state) || projectStates.includes(current.state) || current.state === 'PLANNING') {
        next.resumeState = current.state;
      } else next.resumeState = current.resumeState ?? current.resumeTask?.resumeState;
      next.taskId = current.taskId;
    }
    if (changed && isPaused(next.state)) next.lastPaused = next.state.slice(7, -1);
    if (changed && next.state === 'recovering') next.recoveryAutoResumed = false;
    const committed = await withFileLock(path, async () => {
      if (JSON.stringify(await readState(root)) !== JSON.stringify(current)) return false;
      await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
      if (changed) await appendLedger(root, { runId: typeof next.runId === 'string' ? next.runId : randomUUID(),
        action: `state:${current.state}→${next.state}`, status: 'ok', taskId: next.taskId, state: next.state });
      return true;
    });
    if (!committed) continue;
    committedState = next; stateChanged = changed; break;
  }
  if (!committedState) throw new Error('상태 갱신 경합이 계속됩니다');
  const next = committedState;
  const recordFailure = async (action: string, error: unknown) => {
    try { await appendLedger(root, { runId: typeof next.runId === 'string' ? next.runId : randomUUID(), action, status: 'fail',
      evidence: { error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) } }); }
    catch { /* A storage failure cannot undo the committed transition. */ }
  };
  let cleanupLine = '';
  if (stateChanged && (next.state.startsWith('WAIT_') || isPaused(next.state))) {
    try {
      const report = await runCleanup(root, { scope: 'processes' });
      cleanupLine = ` — 프로세스 ${report.processes?.reclaimed.length ?? 0}개 회수, 잔존 ${(report.processes?.residual.length ?? 0) + (report.processes?.unverified.length ?? 0)}개`;
    } catch (error) { await recordFailure('cleanup:processes', error); }
  }
  if (stateChanged && (next.state.startsWith('WAIT_') || isPaused(next.state) || ['DONE_ALL', 'CLEANUP_FAILED'].includes(next.state))) {
    try { await notify(root, { key: `state:${next.state}`, title: '하네스 상태', body: `하네스 상태: ${next.state}${cleanupLine}`,
      level: isPaused(next.state) || next.state === 'CLEANUP_FAILED' ? 'warning' : 'info' }); }
    catch (error) { await recordFailure(`notify:state:${next.state}`, error); }
  }
  return next;
}

export const states = new Set([
  'IDLE', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PROJECT_READY', 'READY', 'WAIT_JUDGMENT',
  'PLANNING', 'PICK', 'SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'MERGE', 'DOCS', 'CLEANUP', 'CLEANUP_FAILED',
  'RECLAIM', 'DONE_ALL', 'WAIT_RETRY', 'WAIT_RESOURCE', 'DEADLOCK', 'recovering',
]);
export const transitionGraph: Record<string, readonly string[]> = {
  IDLE: ['INTERVIEW', 'PLANNING'], INTERVIEW: ['RESEARCH', 'WAIT_JUDGMENT'], RESEARCH: ['PRD_DRAFT', 'WAIT_JUDGMENT'],
  PRD_DRAFT: ['ARCH', 'WAIT_JUDGMENT'], ARCH: ['REVIEW', 'WAIT_JUDGMENT'],
  REVIEW: ['PROJECT_READY', 'INTERVIEW', 'WAIT_JUDGMENT', 'MERGE', 'FIX', 'RECLAIM'],
  PROJECT_READY: ['PLANNING'], PLANNING: ['PICK'],
  PICK: ['SPEC', 'DONE_ALL', 'WAIT_JUDGMENT', 'WAIT_RETRY', 'WAIT_RESOURCE', 'DEADLOCK'],
  SPEC: ['IMPLEMENT', 'RECLAIM'], IMPLEMENT: ['VERIFY', 'RECLAIM'], VERIFY: ['REVIEW', 'FIX', 'RECLAIM'],
  FIX: ['VERIFY', 'RECLAIM'], MERGE: ['DOCS', 'RECLAIM'], DOCS: ['CLEANUP', 'RECLAIM'],
  CLEANUP: ['PICK', 'CLEANUP_FAILED'], CLEANUP_FAILED: ['CLEANUP'], RECLAIM: ['PICK', 'CLEANUP_FAILED'],
  WAIT_JUDGMENT: ['PICK', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'],
  WAIT_RETRY: ['PICK'], WAIT_RESOURCE: ['PICK'], DEADLOCK: ['WAIT_JUDGMENT'],
  DONE_ALL: ['IDLE', 'PLANNING'], recovering: ['PICK', 'IDLE'], READY: [],
};
export function judgmentResume(current: HarnessState): string {
  return projectStates.includes(current.state) && (current.state !== 'REVIEW' || current.phase === 'project' || !current.taskId)
    ? current.state : 'PICK';
}
export function allowedTransition(from: string, to: string, system = false): boolean {
  if (isPaused(to)) return system;
  return (isPaused(from) ? ['recovering', 'PICK'] : transitionGraph[from] ?? []).includes(to);
}
export function transitionMessage(from: string, reason: string): string {
  return `${reason}. 현재 상태 ${from}에서 가능한 전이: ${(isPaused(from) ? ['recovering', 'PICK'] : transitionGraph[from] ?? []).join(', ') || '없음'}`;
}
export class TransitionError extends Error {
  action?: string;
  constructor(message: string, action?: string) { super(message); this.action = action; }
}
// resume/judgmentApplied는 내부 호출 전용이다. CLI 플래그로 노출하지 않는다.
export interface TransitionOptions { taskId?: string; commit?: string; system?: boolean; resume?: boolean; judgmentApplied?: boolean; now?: number }
export async function refreshJudgmentStatus(root: string): Promise<void> {
  const { readJudgment, writeJudgmentStatus } = await import('./judgment.ts');
  const items = (await readJudgment(root)).items.filter(item => !item.followup);
  await writeJudgmentStatus(root, `${items.map(item => item.id).join(', ') || '판단'} 답 대기 — ${items.map(item => item.title).join('; ') || '판단 확인 필요'}`);
}
export async function transitionState(root: string, to: string, input: TransitionOptions | string = {}): Promise<HarnessState> {
  const options = typeof input === 'string' ? { taskId: input } : input;
  if (!states.has(to) && !isPaused(to)) throw new TransitionError(transitionMessage((await readState(root)).state, '지원하지 않는 상태입니다'));
  return withFileLock(harnessPath(root, 'harness-transition'), async () => {
    let task: Task | undefined;
    const next = await updateState(root, async current => {
      const resume = options.resume && current.state === 'PICK' && taskStates.includes(to)
        && current.resumeTask?.taskId === options.taskId && current.resumeTask?.resumeState === to;
      if (options.resume && !resume || !resume && !allowedTransition(current.state, to, options.system)) throw new TransitionError(transitionMessage(current.state, '허용되지 않는 전이'));
      if (current.state === 'WAIT_JUDGMENT') {
        if (!options.system && !options.judgmentApplied) {
          const { readJudgment } = await import('./judgment.ts');
          const ids = (await readJudgment(root)).items.filter(item => !item.followup).map(item => item.id);
          throw new Error(`열린 판단 ${ids.join(', ') || current.pickJudgment || ''} 답이 필요합니다`);
        }
        if (to !== (current.resumeState ?? 'PICK') && !isPaused(to)) throw new Error('허용되지 않는 전이: resumeState로만 복귀할 수 있습니다');
      }
      if (current.state === 'WAIT_RETRY' && to === 'PICK' && current.retry?.nextAt
        && Date.parse(current.retry.nextAt) > (options.now ?? Date.now())) throw new Error('백오프 시간이 아직 지나지 않았습니다');
      if (options.taskId) await getTask(root, options.taskId);
      if (options.taskId && current.taskId && current.taskId !== options.taskId && current.state !== 'PICK') throw new Error('진행 중 task를 바꿀 수 없습니다');
      const projectReview = to === 'REVIEW' && (current.state === 'ARCH'
        || current.state === 'WAIT_JUDGMENT' && current.resumeState === 'REVIEW' && (current.phase === 'project' || !current.taskId));
      if (current.state === 'REVIEW' && !isPaused(to)) {
        const project = current.phase === 'project' || !current.taskId;
        if (project ? ['MERGE', 'FIX', 'RECLAIM'].includes(to) : ['PROJECT_READY', 'INTERVIEW', 'WAIT_JUDGMENT'].includes(to)) {
          throw new Error('허용되지 않는 전이: 프로젝트 검수와 task 검수를 구분해야 합니다');
        }
      }
      if (current.state === 'IDLE' && to === 'PLANNING') {
        await access(join(root, 'docs/backlog.md')).catch(() => { throw new Error('PLANNING 진입에는 백로그가 필요합니다'); });
      }
      const needsTask = taskStates.includes(to) && !projectReview;
      const id = options.taskId ?? (to === 'CLEANUP' ? current.taskId : undefined);
      if (needsTask) {
        if (!id) throw new Error('--task 인자가 필요합니다');
        task = await getTask(root, id);
        if (current.taskId && current.state !== 'PICK' && current.taskId !== task.id) throw new Error('진행 중 task를 바꿀 수 없습니다');
        if (task.status === 'done' || task.status.startsWith('blocked(')) throw new Error('완료 또는 차단된 task는 진행할 수 없습니다');
      }
      if (['IMPLEMENT', 'MERGE'].includes(to) && !doctorFresh(current, (await loadConfig(root)).brain.doctorTtlHours)) {
        throw new Error('doctor 검증이 없거나 오래되었습니다. Pi 세션을 재시작하거나 fodh doctor 를 실행하세요.');
      }
      if (current.state === 'MERGE' && to === 'DOCS'
        && (!options.commit || !task?.review?.commit || task.review.high !== 0 || task.review.commit !== options.commit)) {
        throw new Error('현재 커밋과 일치하는 높음 0 검수 증거가 필요합니다');
      }
      if (to === 'FIX' && task && !resume && task.repair + 1 > 3) throw new TransitionError('repair 초과', 'reclaim');
      if (current.state === 'CLEANUP' && to === 'PICK') {
        if (current.pendingReclaim) throw new Error('실패한 RECLAIM을 같은 task와 판단 번호로 다시 완료해야 합니다');
        const completed = current.taskId ? await getTask(root, current.taskId) : undefined;
        if (!completed || completed.status !== 'done') throw new BacklogError('task 미완료', completed ? missingDoD(completed) : ['taskId']);
      }
      const returning = to === 'PICK' && (isPaused(current.state) || ['recovering', 'WAIT_RETRY', 'WAIT_RESOURCE'].includes(current.state));
      const clearsTask = ['IDLE', 'PLANNING', 'DONE_ALL', 'INTERVIEW', 'PROJECT_READY'].includes(to) || to === 'PICK' && !returning;
      const failures = to === 'CLEANUP_FAILED' ? (current.cleanupFailures ?? 0) + 1 : current.cleanupFailures;
      return { state: to === 'CLEANUP_FAILED' && failures! >= 2 ? 'paused(cleanup)' : to,
        ...(to === 'CLEANUP_FAILED' ? { cleanupFailures: failures } : {}),
        ...(current.state === 'CLEANUP' && to === 'PICK' ? { cleanupFailures: 0 } : {}),
        ...(['WAIT_RESOURCE', 'WAIT_RETRY'].includes(current.state) && to === 'PICK' ? { lastPaused: undefined, retry: undefined } : {}),
        taskId: clearsTask || projectReview ? undefined : options.taskId ?? current.taskId,
        ...(to === 'WAIT_JUDGMENT' ? { resumeState: judgmentResume(current), resumeTask: undefined } : {}),
        ...(current.state === 'WAIT_JUDGMENT' ? { resumeState: undefined, pickJudgment: undefined } : {}),
        ...(returning ? { resumeTask: current.resumeTask ?? { taskId: current.taskId, resumeState: current.resumeState }, resumeState: undefined } : {}),
        ...(resume || clearsTask ? { resumeTask: undefined } : {}),
        ...(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'PROJECT_READY'].includes(to) || projectReview ? { phase: 'project' as const } : {}),
        ...(to === 'PLANNING' || to === 'SPEC' || resume ? { phase: 'task' as const } : {}),
      };
    });
    // L7: 상태 저장이 성공한 다음에만 repair와 백로그 단계를 반영한다.
    if (task) {
      const status = ({ SPEC: 'doing', IMPLEMENT: 'doing', VERIFY: 'verify', REVIEW: 'review', FIX: 'fix',
        MERGE: 'merge', DOCS: 'merge', CLEANUP: 'merge' } as Record<string, string>)[to];
      await setTask(root, task.id, { status, ...(to === 'FIX' && !options.resume ? { repair: task.repair + 1,
        verify: { ok: false }, review: { high: undefined }, merge: { commit: undefined }, docs: { ok: false }, cleanup: { ok: false } } : {}) });
    }
    if (next.state === 'WAIT_JUDGMENT') {
      const { readJudgment } = await import('./judgment.ts');
      if (!next.pickJudgment && next.phase === 'project') {
        const first = (await readJudgment(root)).items.find(item => !item.followup);
        if (first) { next.pickJudgment = first.id; await updateState(root, { pickJudgment: first.id }); }
      }
      await refreshJudgmentStatus(root);
    }
    if (to === 'CLEANUP_FAILED' && next.state === 'paused(cleanup)') {
      const { addJudgment } = await import('./judgment.ts');
      const { listProcs } = await import('./procs.ts');
      const pids = (await listProcs(root)).filter(record => record.kind !== 'brain').map(record => record.pid);
      const { item } = await addJudgment(root, { title: `정리 실패: 잔존 프로세스 ${pids.join(', ')}`,
        background: '연속 정리 실패 2회. 사용자가 잔존을 확인해야 합니다.', options: ['사용자가 정리했음 → PICK', '보류'],
        recommend: '① 실제 정리 확인 후 재개', blocks: next.taskId ?? '-', resolution: 'cleanup',
        dedupeKey: `cleanup:${next.taskId}:${pids.join(',')}` });
      return updateState(root, { pickJudgment: item.id });
    }
    return next;
  });
}
export async function stopForJudgment(root: string): Promise<HarnessState> {
  const current = await readState(root);
  const { addJudgment } = await import('./judgment.ts');
  const { item } = await addJudgment(root, { title: `진행 정체: ${current.state}/${current.taskId ?? '-'}`,
    background: `상태와 작업이 바뀌지 않은 자동 턴 ${current.autoTurns ?? 0}회. 진행 증거를 확인해야 합니다.`,
    options: ['ready 로 되돌려 재개', 'blocked 유지(보류)'], recommend: '① 원인을 확인한 뒤 재개',
    blocks: current.taskId ?? '-', resolution: 'resume', dedupeKey: `stall:${current.state}:${current.taskId}:${current.enteredAt}` });
  if (current.taskId && [...taskStates, 'RECLAIM'].includes(current.state)) {
    const { reclaimTask } = await import('./reclaim.ts');
    const result = await reclaimTask(root, current.taskId, item.id, { suspended: true });
    if (!result.reclaimed) return readState(root);
    await transitionState(root, 'WAIT_JUDGMENT');
    return updateState(root, { pickJudgment: item.id });
  }
  const next = await updateState(root, { state: 'WAIT_JUDGMENT', resumeState: judgmentResume(current), pickJudgment: item.id });
  await refreshJudgmentStatus(root);
  return next;
}
export function doctorFresh(state: HarnessState, ttlHours = 12): boolean {
  const doctor = state.doctor as { ok?: boolean; checkedAt?: string } | undefined;
  const age = Date.now() - Date.parse(doctor?.checkedAt ?? '');
  return doctor?.ok === true && Number.isFinite(age) && age >= 0 && age <= ttlHours * 3600000;
}
