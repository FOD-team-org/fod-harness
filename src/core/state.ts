import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { getTask, setTask } from './backlog.ts';
import { appendLedger } from './ledger.ts';

export interface HarnessState {
  state: string; sessionId?: string; taskId?: string; savedAt?: string; resumeState?: string;
  enteredAt?: string; autoTurns?: number; phase?: 'project' | 'task'; lastPaused?: string;
  retry?: { count: number; nextAt?: string }; [key: string]: unknown;
}
export async function readState(root: string): Promise<HarnessState> {
  return readJson(harnessPath(root, 'harness-state.json'), { state: 'IDLE', autoTurns: 0 });
}
export async function updateState(
  root: string,
  patch: Partial<HarnessState> | ((current: HarnessState) => Partial<HarnessState> | Promise<Partial<HarnessState>>),
): Promise<HarnessState> {
  const path = harnessPath(root, 'harness-state.json');
  return withFileLock(path, async () => {
    const current = await readState(root);
    const next: HarnessState = { ...current, ...(typeof patch === 'function' ? await patch(current) : patch), savedAt: new Date().toISOString() };
    if (typeof next.state !== 'string' || !next.state.trim()) throw new Error('상태 값이 올바르지 않습니다');
    const changed = next.state !== current.state;
    if (changed || next.taskId !== current.taskId) { next.autoTurns = 0; next.enteredAt = next.savedAt; }
    if (changed && isPaused(next.state)) next.lastPaused = next.state.slice(7, -1);
    if (changed && next.state === 'recovering') next.recoveryAutoResumed = false;
    await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    if (changed) await appendLedger(root, { runId: typeof next.runId === 'string' ? next.runId : randomUUID(),
      action: `state:${current.state}→${next.state}`, status: 'ok', taskId: next.taskId, state: next.state });
    return next;
  });
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
  FIX: ['VERIFY', 'RECLAIM'], MERGE: ['DOCS', 'RECLAIM'], DOCS: ['CLEANUP'],
  CLEANUP: ['PICK', 'CLEANUP_FAILED'], CLEANUP_FAILED: ['CLEANUP'], RECLAIM: ['PICK', 'CLEANUP_FAILED'],
  WAIT_JUDGMENT: ['PICK', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'],
  WAIT_RETRY: ['PICK'], WAIT_RESOURCE: ['PICK'], DEADLOCK: ['WAIT_JUDGMENT'],
  DONE_ALL: ['IDLE', 'PLANNING'], recovering: ['PICK', 'IDLE'], READY: [],
};
export const isPaused = (state: string) => /^paused\((billing|quota|error|memory|budget|cleanup)\)$/u.test(state);
const projectStates = ['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'];
export function judgmentResume(current: HarnessState): string {
  return projectStates.includes(current.state) && (current.state !== 'REVIEW' || current.phase === 'project' || !current.taskId)
    ? current.state : 'PICK';
}
export function allowedTransition(from: string, to: string, system = false): boolean {
  if (isPaused(to)) return system;
  return (isPaused(from) ? ['recovering', 'PICK'] : transitionGraph[from] ?? []).includes(to);
}
export class TransitionError extends Error {
  action?: string;
  constructor(message: string, action?: string) { super(message); this.action = action; }
}
export interface TransitionOptions { taskId?: string; commit?: string; system?: boolean }
export async function transitionState(root: string, to: string, input: TransitionOptions | string = {}): Promise<HarnessState> {
  const options = typeof input === 'string' ? { taskId: input } : input;
  if (!states.has(to) && !isPaused(to)) throw new Error('지원하지 않는 상태입니다');
  return updateState(root, async current => {
    if (!allowedTransition(current.state, to, options.system)) throw new Error('허용되지 않는 전이');
    if (current.state === 'WAIT_JUDGMENT' && to !== (current.resumeState ?? 'PICK') && !isPaused(to)) {
      throw new Error('허용되지 않는 전이: resumeState로만 복귀할 수 있습니다');
    }
    if (options.taskId) await getTask(root, options.taskId);
    if (options.taskId && current.taskId && current.taskId !== options.taskId && current.state !== 'PICK') {
      throw new Error('진행 중 task를 바꿀 수 없습니다');
    }
    const projectReview = to === 'REVIEW' && (current.state === 'ARCH'
      || (current.state === 'WAIT_JUDGMENT' && current.resumeState === 'REVIEW' && (current.phase === 'project' || !current.taskId)));
    if (current.state === 'REVIEW' && !isPaused(to)) {
      const project = current.phase === 'project' || !current.taskId;
      if (project ? ['MERGE', 'FIX', 'RECLAIM'].includes(to) : ['PROJECT_READY', 'INTERVIEW', 'WAIT_JUDGMENT'].includes(to)) {
        throw new Error('허용되지 않는 전이: 프로젝트 검수와 task 검수를 구분해야 합니다');
      }
    }
    if (current.state === 'IDLE' && to === 'PLANNING') {
      await access(join(root, 'docs/backlog.md')).catch(() => { throw new Error('PLANNING 진입에는 백로그가 필요합니다'); });
    }
    const needsTask = ['SPEC', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FIX', 'MERGE', 'DOCS'].includes(to) && !projectReview;
    let task;
    if (needsTask) {
      if (!options.taskId) throw new Error('--task 인자가 필요합니다');
      task = await getTask(root, options.taskId);
      if (current.taskId && current.state !== 'PICK' && current.taskId !== task.id) throw new Error('진행 중 task를 바꿀 수 없습니다');
      if (task.status === 'done' || task.status.startsWith('blocked(')) throw new Error('완료 또는 차단된 task는 진행할 수 없습니다');
    }
    if (['IMPLEMENT', 'MERGE'].includes(to) && !doctorFresh(current)) {
      throw new Error('doctor 검증이 없거나 오래되었습니다. Pi 세션을 재시작하거나 fodh doctor 를 실행하세요.');
    }
    if (current.state === 'MERGE' && to === 'DOCS'
      && (!options.commit || !task?.review?.commit || task.review.high !== 0 || task.review.commit !== options.commit)) {
      throw new Error('현재 커밋과 일치하는 높음 0 검수 증거가 필요합니다');
    }
    if (to === 'FIX' && task) {
      if (task.repair + 1 > 3) throw new TransitionError('repair 초과', 'reclaim');
      await setTask(root, task.id, { repair: task.repair + 1, status: 'fix', verify: { ok: false },
        review: { high: undefined }, merge: { commit: undefined }, docs: { ok: false }, cleanup: { ok: false } });
    }
    if (current.state === 'CLEANUP' && to === 'PICK' && current.pendingReclaim) {
      throw new Error('실패한 RECLAIM을 같은 task와 판단 번호로 다시 완료해야 합니다');
    }
    const clearsTask = ['PICK', 'IDLE', 'PLANNING', 'DONE_ALL', 'INTERVIEW', 'PROJECT_READY'].includes(to);
    return { state: to,
      ...(current.state === 'WAIT_RESOURCE' && to === 'PICK' && ['memory', 'budget'].includes(current.lastPaused ?? '')
        ? { lastPaused: undefined } : {}),
      taskId: clearsTask || projectReview ? undefined : options.taskId ?? current.taskId,
      ...(to === 'WAIT_JUDGMENT' ? { resumeState: judgmentResume(current) } : {}),
      ...(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'PROJECT_READY'].includes(to) || projectReview ? { phase: 'project' as const } : {}),
      ...(to === 'PLANNING' || to === 'SPEC' ? { phase: 'task' as const } : {}),
    };
  });
}
// 정체 안전 중단만 사용하는 내부 경로. CLI --system으로 일반 그래프를 우회할 수는 없다.
export async function stopForJudgment(root: string): Promise<HarnessState> {
  return updateState(root, current => ({ state: 'WAIT_JUDGMENT', resumeState: judgmentResume(current) }));
}
export function doctorFresh(state: HarnessState, ttlHours = 12): boolean {
  const doctor = state.doctor as { ok?: boolean; checkedAt?: string } | undefined;
  const age = Date.now() - Date.parse(doctor?.checkedAt ?? '');
  return doctor?.ok === true && Number.isFinite(age) && age >= 0 && age <= ttlHours * 3600000;
}
