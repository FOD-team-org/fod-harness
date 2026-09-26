import { runCleanup } from './cleanup.ts';
import { notify } from './notify.ts';
import { redact } from '../provider/privacy.ts';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { getTask, setTask, listBacklog, backlogInSync, missingDoD, BacklogError, type Task } from './backlog.ts';
import { appendLedger } from './ledger.ts';
import { loadConfig } from './config.ts';
import { todayKst } from './template-values.ts';
import { hasReviewEvidence } from './codex-record.ts';

export interface BrainTurn { startedAt: string; endedAt?: string; runId: string }
export interface HarnessState {
  brainTurn?: BrainTurn;
  userHold?: boolean;
  userHoldSource?: 'command' | 'input';
  awaitingSlot?: { kind: 'codex'; owner: import('./slots.ts').SlotOwner; since: string };
  delegation?: { runId: string; taskId?: string; kind: 'task' | 'review' | 'research'; startedAt: string; title?: string; implied?: string };
  awaitingDelegation?: boolean;
  worktrees?: { taskId: string; path: string; branch: string; base?: string; baseBranch?: string; createdAt: string; setupOk?: boolean; setupAt?: string }[];
  state: string; sessionId?: string; taskId?: string; savedAt?: string; resumeState?: string;
  resumeTask?: { taskId?: string; resumeState?: string }; awaitingUser?: boolean; userAborted?: boolean; cleanupFailures?: number;
  verify?: { runId: string; taskId?: string; ok: boolean; at: string; heavy: boolean; cwd: string; head?: string | null; clean?: boolean | null; since?: string; dirtyAfter?: string[] };
  mergeBase?: string | null;
  verifySince?: string; resumeVerifySince?: string;
  enteredAt?: string; reviewSince?: string; resumeReviewSince?: string;
  autoTurns?: number; phase?: 'project' | 'task'; lastPaused?: string;
  retry?: { count: number; nextAt?: string }; [key: string]: unknown;
}
export const activeStates = new Set(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PLANNING', 'PICK',
  'SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'MERGE', 'DOCS', 'CLEANUP', 'RECLAIM', 'recovering']);
export const taskStates = ['SPEC', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FIX', 'MERGE', 'DOCS', 'CLEANUP'];
export const userOnlyTransitions = new Set(['PROJECT_READY→PLANNING', 'DONE_ALL→PLANNING', 'DONE_ALL→IDLE']);
const projectStates = ['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'];
export const isPaused = (state: string) => /^paused\((billing|quota|error|memory|budget|cleanup|slot)\)$/u.test(state);
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
    const changes = typeof patch === 'function' ? await patch(current) : patch;
    const next: HarnessState = { ...current, ...changes, savedAt: new Date().toISOString() };
    if (typeof next.state !== 'string' || !next.state.trim()) throw new Error('상태 값이 올바르지 않습니다');
    const changed = next.state !== current.state;
    if (changed || next.taskId !== current.taskId) { next.autoTurns = 0; next.enteredAt = next.savedAt; }
    if (changed || next.taskId !== current.taskId) {
      if (next.state === 'REVIEW') {
        next.reviewSince = changes.reviewSince ?? next.savedAt;
        next.resumeReviewSince = undefined;
      } else if (current.state === 'REVIEW') {
        // REVIEW's active clock is cleared on exit; suspension keeps a separate checkpoint.
        next.resumeReviewSince = ['WAIT_JUDGMENT', 'RECLAIM'].includes(next.state) || isPaused(next.state) || next.state === 'recovering'
          ? current.reviewSince ?? current.enteredAt : undefined;
        next.reviewSince = undefined;
      } else if (!['PICK', 'WAIT_JUDGMENT', 'WAIT_RETRY', 'WAIT_RESOURCE', 'RECLAIM', 'recovering'].includes(next.state) && !isPaused(next.state)) {
        next.resumeReviewSince = undefined;
      }
    }
    if (changed || next.taskId !== current.taskId) {
      if (next.state === 'VERIFY') {
        next.verifySince = changes.verifySince ?? next.savedAt;
        next.resumeVerifySince = undefined;
        if (!changes.verifySince) next.verify = undefined;
      } else if (current.state === 'VERIFY') {
        next.resumeVerifySince = ['WAIT_JUDGMENT', 'RECLAIM'].includes(next.state) || isPaused(next.state) || next.state === 'recovering'
          ? current.verifySince ?? current.enteredAt : undefined;
        next.verifySince = undefined;
      } else if (!['PICK', 'WAIT_JUDGMENT', 'WAIT_RETRY', 'WAIT_RESOURCE', 'RECLAIM', 'recovering'].includes(next.state) && !isPaused(next.state)) {
        next.resumeVerifySince = undefined;
      }
    }
    if (changed && (isPaused(next.state) || next.state === 'recovering')) {
      if (taskStates.includes(current.state) || projectStates.includes(current.state) || current.state === 'PLANNING') {
        next.resumeState = current.state;
      } else next.resumeState = current.resumeState ?? current.resumeTask?.resumeState;
      next.taskId = current.taskId;
    }
    if (next.state === 'paused(slot)' && next.awaitingSlot) next.awaitingUser = false;
    if (changed && isPaused(next.state)) next.lastPaused = next.state.slice(7, -1);
    if (changed && next.state === 'recovering') next.recoveryAutoResumed = false;
    const committed = await withFileLock(path, async () => {
      if (JSON.stringify(await readState(root)) !== JSON.stringify(current)) return false;
      await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
      if (changed) await appendLedger(root, { runId: typeof next.runId === 'string' ? next.runId : randomUUID(),
        action: `state:${current.state}→${next.state}`, status: 'ok', taskId: next.taskId, state: next.state });
      if (changed && next.state === 'paused(slot)' && next.awaitingSlot) await appendLedger(root, {
        runId: typeof next.runId === 'string' ? next.runId : randomUUID(), action: 'wait:override', status: 'ok', evidence: { reason: 'slot' } });
      return true;
    });
    if (!committed) continue;
    committedState = next; stateChanged = changed; break;
  }
  if (!committedState) throw new Error('상태 갱신 경합이 계속됩니다');
  const next = committedState;
  if (stateChanged && next.state === 'recovering') {
    const { recoverJudgmentSnapshot } = await import('./judgment.ts');
    await recoverJudgmentSnapshot(root);
    next.brainTurn = (await readState(root)).brainTurn;
  }
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
  if (stateChanged && (next.state.startsWith('WAIT_') || isPaused(next.state) || ['PROJECT_READY', 'DONE_ALL', 'CLEANUP_FAILED'].includes(next.state))) {
    try { await notify(root, { key: `state:${next.state}`, title: '하네스 상태', body: next.state === 'PROJECT_READY'
      ? '프로젝트 준비 완료 — `/develop-start` 로 개발을 시작하세요' : `하네스 상태: ${next.state}${cleanupLine}`,
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
    let verified: HarnessState['verify'];
    let documented = false;
    let backlogWarningTask: string | undefined;
    let staleResumeTask: HarnessState['resumeTask'];
    const next = await updateState(root, async current => {
      backlogWarningTask = undefined;
      const savedTask = options.resume && options.taskId ? await getTask(root, options.taskId) : undefined;
      const taskCheckpoint = savedTask && ['doing', 'verify', 'review', 'fix', 'merge'].includes(savedTask.status)
        && savedTask.resume?.state === to;
      const resume = options.resume && current.state === 'PICK' && (taskStates.includes(to) || !current.taskId && current.phase === 'project' && to === 'RESEARCH')
        && (current.resumeTask?.taskId === options.taskId && current.resumeTask?.resumeState === to || taskCheckpoint);
      if (options.resume && !resume || !resume && !allowedTransition(current.state, to, options.system)) throw new TransitionError(transitionMessage(current.state, '허용되지 않는 전이'));
      if (current.state === 'INTERVIEW' && to === 'RESEARCH' && (await loadConfig(root)).interview.enforce) {
        const { interviewStatus, remainingAreas } = await import('./interview.ts');
        const status = await interviewStatus(root);
        if (!status.docFile) throw new TransitionError('인터뷰 기록이 없습니다. fodh interview start 를 먼저 실행하세요', 'interview');
        if (!status.remainingMust && status.skipDue.length) throw new TransitionError(`한도에 도달한 선택 질문이 남아 있습니다: ${status.skipDue.join(', ')}. fodh interview skip <ID> --reason 한도 로 처리하세요`, 'interview');
        if (!status.complete) throw new TransitionError(`인터뷰 필수 질문이 남아 있습니다: 영역 ${remainingAreas(status)}. fodh interview next 로 계속하세요`, 'interview');
      }
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
      // Check before getTask can import Markdown edits; task identity errors keep their existing priority.
      if (current.state === 'DOCS' && to === 'CLEANUP'
        && !(options.taskId && current.taskId && current.taskId !== options.taskId)) {
        const dir = join(root, (await loadConfig(root)).docs.root, '작업일지');
        const dates = [todayKst(), todayKst(new Date(Date.now() - 86400000))];
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const logs = await Promise.all(entries.filter(entry => entry.isFile()
          && dates.some(date => entry.name === `${date}.md`))
          .map(entry => readFile(join(dir, entry.name), 'utf8').catch(() => '')));
        if (!current.taskId || !logs.some(text => text.match(/\bT\d+\b/gu)?.includes(current.taskId!)) || !await backlogInSync(root)) {
          throw new Error('작업일지·백로그 갱신이 없습니다');
        }
      }
      if (options.taskId) await getTask(root, options.taskId);
      if (options.taskId && current.taskId && current.taskId !== options.taskId && current.state !== 'PICK') throw new Error('진행 중 task를 바꿀 수 없습니다');
      const projectReview = to === 'REVIEW' && (resume && !current.taskId && current.phase === 'project' || current.state === 'ARCH'
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
      if (current.state === 'PLANNING' && to === 'PICK' && !(await listBacklog(root)).length) {
        throw new Error('PICK 진입에는 등록된 task 가 필요합니다 (fodh backlog add)');
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
      if (current.state === 'VERIFY' && to === 'REVIEW'
        && (!current.verify || current.verify.taskId !== options.taskId || current.verify.ok !== true
          || !(Date.parse(current.verify.at) >= Date.parse(current.verifySince ?? '')))) {
        throw new Error('검증 증거가 없습니다: fodh verify run 이 통과해야 REVIEW 로 갈 수 있습니다(실패면 FIX)');
      }
      if (current.state === 'VERIFY' && to === 'REVIEW'
        && current.verify?.cwd !== await realpath(current.worktrees?.find(item => item.taskId === task?.id)?.path || task?.worktree || root)) {
        throw new Error('검증 증거가 다른 경로에서 만들어졌습니다');
      }
      if (current.state === 'VERIFY' && to === 'REVIEW'
        && (current.worktrees?.some(item => item.taskId === task?.id) || task?.worktree) && current.verify?.clean !== true) {
        throw new Error('검증 당시 미커밋 변경이 있었습니다: fodh worktree commit 뒤 다시 fodh verify run');
      }
      if (current.state === 'REVIEW' && (to === 'PROJECT_READY' || to === 'MERGE')
        && !await hasReviewEvidence(root, current.reviewSince ?? current.enteredAt, to === 'MERGE' ? task!.id : undefined)) {
        throw new Error('교차검수 증거가 없습니다: fodh codex review --wait 결과가 필요합니다');
      }
      if (current.state === 'MERGE' && to === 'DOCS') {
        if (!options.commit) throw new Error(`--commit <검수 커밋 sha> 를 넘기세요(현재 review.commit = ${task?.review?.commit ?? '없음'})`);
        if (options.commit !== task?.review?.commit) throw new Error('--commit 이 review.commit 과 다릅니다');
        if (task.review.high !== 0) throw new Error('검수 결과(--review-high 0)가 없습니다');
      }
      if (to === 'FIX' && task && !resume && task.repair + 1 > 3) throw new TransitionError('repair 초과', 'reclaim');
      if (current.state === 'CLEANUP' && to === 'PICK') {
        if (current.pendingReclaim) throw new Error('실패한 RECLAIM을 같은 task와 판단 번호로 다시 완료해야 합니다');
        const { cleanupReport } = await import('./reclaim.ts');
        const last = await readJson<{ processes?: { residual?: unknown[]; unverified?: unknown[] } }>(harnessPath(root, 'cleanup-last.json'), {});
        if (!(await cleanupReport(root, false)).ok || last.processes?.residual?.length || last.processes?.unverified?.length) {
          throw new Error('정리 잔존이 있습니다: fodh cleanup run --scope all 로 다시 확인하세요');
        }
        const completed = current.taskId ? await getTask(root, current.taskId) : undefined;
        if (!completed || completed.status !== 'done') throw new BacklogError('task 미완료', completed ? missingDoD(completed) : ['taskId']);
        backlogWarningTask = current.taskId;
      }
      if (current.state === 'VERIFY' && to === 'REVIEW') verified = current.verify;
      documented = current.state === 'DOCS' && to === 'CLEANUP';
      const returning = to === 'PICK' && (isPaused(current.state) || ['recovering', 'WAIT_RETRY', 'WAIT_RESOURCE'].includes(current.state));
      const checkpoint = current.resumeTask && current.resumeTask.taskId === current.taskId
        ? current.resumeTask : { taskId: current.taskId, resumeState: current.resumeState };
      if (returning && current.resumeTask && current.resumeTask.taskId !== current.taskId) staleResumeTask = current.resumeTask;
      const clearsTask = ['IDLE', 'PLANNING', 'DONE_ALL', 'INTERVIEW', 'PROJECT_READY'].includes(to) || to === 'PICK' && !returning;
      const failures = to === 'CLEANUP_FAILED' ? (current.cleanupFailures ?? 0) + 1 : current.cleanupFailures;
      const mergeBase = current.state === 'REVIEW' && to === 'MERGE'
        ? await (await import('./worktree.ts')).rootHead(root) : current.mergeBase;
      return { mergeBase, ...(to === 'FIX' && !resume ? { verify: undefined } : {}), awaitingSlot: to === 'paused(slot)' || to === 'WAIT_RESOURCE' || to === 'PICK' && current.lastPaused === 'slot'
          ? current.awaitingSlot : undefined, state: to === 'CLEANUP_FAILED' && failures! >= 2 ? 'paused(cleanup)' : to,
        ...(to === 'VERIFY' && (resume || current.state === 'WAIT_JUDGMENT') ? { verifySince: current.resumeVerifySince } : {}),
        ...(to === 'REVIEW' && (resume || current.state === 'WAIT_JUDGMENT') ? { reviewSince: current.resumeReviewSince } : {}),
        ...(current.state !== to && (['PROJECT_READY', 'DONE_ALL', 'CLEANUP_FAILED'].includes(current.state) || current.state.startsWith('WAIT_'))
          ? { awaitingUser: false } : {}),
        ...(to === 'PROJECT_READY' ? { awaitingUser: true } : {}),
        ...(to === 'CLEANUP_FAILED' ? { cleanupFailures: failures } : {}),
        ...(current.state === 'CLEANUP' && to === 'PICK' ? { cleanupFailures: 0 } : {}),
        ...(['WAIT_RESOURCE', 'WAIT_RETRY'].includes(current.state) && to === 'PICK' ? { lastPaused: current.lastPaused === 'slot' ? 'slot' : undefined, retry: undefined } : {}),
        taskId: clearsTask || projectReview ? undefined : options.taskId ?? current.taskId,
        ...(to === 'WAIT_JUDGMENT' ? { resumeState: judgmentResume(current), resumeTask: current.resumeTask } : {}),
        ...(current.state === 'WAIT_JUDGMENT' ? { resumeState: undefined, pickJudgment: undefined } : {}),
        ...(returning ? { resumeTask: checkpoint, resumeState: undefined } : {}),
        ...(to === 'RECLAIM' ? { resumeTask: { taskId: current.taskId, resumeState: taskStates.includes(current.state) ? current.state : current.resumeTask?.resumeState ?? current.resumeState } } : {}),
        ...(resume || clearsTask && !(to === 'PICK' && current.state === 'WAIT_JUDGMENT') ? { resumeTask: undefined } : {}),
        ...(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'PROJECT_READY'].includes(to) || projectReview ? { phase: 'project' as const } : {}),
        ...(to === 'PLANNING' || to === 'SPEC' || resume && !!options.taskId ? { phase: 'task' as const } : {}),
      };
    });
    if (backlogWarningTask) await (await import('./worktree.ts')).warnBacklogUncommitted(root, backlogWarningTask);
    // L7: 상태 저장이 성공한 다음에만 repair와 백로그 단계를 반영한다.
    if (task) {
      const status = ({ SPEC: 'doing', IMPLEMENT: 'doing', VERIFY: 'verify', REVIEW: 'review', FIX: 'fix',
        MERGE: 'merge', DOCS: 'merge', CLEANUP: 'merge' } as Record<string, string>)[to];
      await setTask(root, task.id, { status, ...(options.resume ? { resume: undefined } : {}), ...(documented ? { docs: { ok: true } } : {}), ...(verified ? { verify: { ok: true, runId: verified.runId, at: verified.at } } : {}), ...(to === 'FIX' && !options.resume ? { repair: task.repair + 1,
        verify: { ok: false }, review: { commit: undefined, high: undefined }, merge: { commit: undefined }, docs: { ok: false }, cleanup: { ok: false } } : {}) });
    }
    if (staleResumeTask) await appendLedger(root, { runId: randomUUID(), taskId: next.taskId,
      action: 'pick:stale-resume-task', status: 'warn', evidence: { ignored: staleResumeTask } });
    if (to === 'FIX' && task && !options.resume) await appendLedger(root, { runId: randomUUID(), taskId: task.id, action: 'review-commit:cleared', status: 'ok' });
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
