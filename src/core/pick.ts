import { listBacklog, setTask, type Task } from './backlog.ts';
import { addJudgment } from './judgment.ts';
import { readState, transitionState, updateState, taskStates, type HarnessState } from './state.ts';
import { harnessPath, withFileLock } from './storage.ts';

export interface PickResources { slots: 'ok' | 'unavailable' | boolean; now?: number }
export interface PickDecision {
  outcome: 'RESUME' | 'SPEC' | 'EMPTY' | 'DONE_ALL' | 'WAIT_JUDGMENT' | 'WAIT_RETRY' | 'WAIT_RESOURCE' | 'DEADLOCK';
  task?: Task; next?: string; orphans?: Task[]; reason: string; cycle?: string[];
  retry?: { count: number; nextAt?: string }; exhausted?: boolean;
}
const inProgress = (task: Task) => ['doing', 'verify', 'review', 'fix', 'merge'].includes(task.status);
export function decidePick(backlog: Task[], state: HarnessState, resources: PickResources,
  current: { taskId?: string; resumeState?: string } = state.taskId ? {
    taskId: state.taskId,
    resumeState: state.resumeTask?.taskId === state.taskId ? state.resumeTask.resumeState : state.resumeState,
  } : state.resumeTask ?? state): PickDecision {
  const now = resources.now ?? Date.parse(state.savedAt ?? state.enteredAt ?? '1970-01-01T00:00:00Z');
  const paused = /^paused\(([^)]+)\)$/u.exec(state.state)?.[1] ?? state.lastPaused;
  if ((['memory', 'budget'].includes(paused ?? '') || paused === 'slot' && (state.state !== 'PICK' || !!state.awaitingSlot)) || resources.slots === false || resources.slots === 'unavailable') {
    return { outcome: 'WAIT_RESOURCE', reason: '슬롯·메모리·예산 회복 확인이 필요합니다' };
  }
  if (['billing', 'cleanup'].includes(paused ?? '')) {
    return { outcome: 'WAIT_JUDGMENT', reason: '과금 또는 정리 중단 원인의 수동 확인이 필요합니다', exhausted: true };
  }
  if (state.retry?.nextAt && Date.parse(state.retry.nextAt) > now) return { outcome: 'WAIT_RETRY', reason: '백오프 대기 중', retry: state.retry };
  if (['error', 'quota'].includes(paused ?? '')) {
    const retry = state.retry ?? { count: 0 };
    if (retry.count >= 3) return { outcome: 'WAIT_JUDGMENT', reason: '재시도 3회 소진', exhausted: true };
    return { outcome: 'WAIT_RETRY', reason: '일시 오류 재시도 예약', retry: {
      count: retry.count + 1, nextAt: new Date(now + [5, 15, 60][retry.count] * 60000).toISOString(),
    } };
  }
  if (state.lastPaused === 'slot' && state.phase === 'project' && !current.taskId && ['RESEARCH', 'REVIEW'].includes(current.resumeState ?? '')) {
    return { outcome: 'RESUME', next: current.resumeState, reason: '슬롯 대기로 중단된 프로젝트 단계로 복귀' };
  }
  const pending = backlog.filter(task => task.status !== 'done');
  const activeTask = pending.find(task => task.id === state.taskId && (task.status === 'ready' || inProgress(task)));
  if (activeTask && taskStates.includes(state.state)) {
    return { outcome: 'RESUME', task: activeTask, next: state.state, reason: '현재 task 단계를 유지' };
  }
  const resumable = pending.find(task => task.id === current.taskId && (task.status === 'ready' || inProgress(task)));
  const resumeStage = current.resumeState ?? resumable?.resume?.state;
  if (resumable && taskStates.includes(resumeStage ?? '')) {
    return { outcome: 'RESUME', task: resumable, next: resumeStage, reason: '중단된 현재 task의 원래 단계로 복귀' };
  }
  const recovered = !resumable && pending.filter(task => inProgress(task) && taskStates.includes(task.resume?.state ?? ''))
    .sort((a, b) => Date.parse(a.resume!.at) - Date.parse(b.resume!.at))[0];
  if (recovered) return { outcome: 'RESUME', task: recovered, next: recovered.resume!.state, reason: '회수한 task의 저장된 단계로 복귀' };
  const orphans = pending.filter(task => inProgress(task) && !taskStates.includes(task.resume?.state ?? ''));
  // 고아는 먼저 차단한다. 순수 판정에서는 blocked가 된 후보 집합으로 다음 선택을 계산한다.
  if (orphans.length) {
    const remaining = backlog.map(task => orphans.some(orphan => orphan.id === task.id) ? { ...task, status: 'blocked(A0)' } : task);
    const next = decidePick(remaining, { ...state, lastPaused: undefined, resumeTask: undefined }, resources, {});
    return { ...next, orphans };
  }
  const missing = pending.flatMap(task => task.depends.filter(id => !backlog.some(other => other.id === id)).map(id => `${task.id}→${id}`));
  if (missing.length) return { outcome: 'DEADLOCK', cycle: missing, reason: '존재하지 않는 의존 ID' };
  const active = new Set<string>(), visited = new Set<string>();
  function visit(id: string, path: string[]): string[] | undefined {
    if (active.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return;
    const task = pending.find(task => task.id === id);
    if (!task) return;
    active.add(id);
    for (const dependency of task.depends) { const cycle = visit(dependency, [...path, id]); if (cycle) return cycle; }
    active.delete(id); visited.add(id);
  }
  for (const task of pending) { const cycle = visit(task.id, []); if (cycle) return { outcome: 'DEADLOCK', cycle, reason: '의존 순환' }; }
  const selected = (resumable?.status === 'ready' ? [resumable] : pending).find(task => task.status === 'ready'
    && task.depends.every(id => backlog.some(dependency => dependency.id === id && dependency.status === 'done')));
  if (selected) return { outcome: 'SPEC', task: selected, reason: '표 순서상 첫 실행 가능 task' };
  if (!pending.length) return backlog.length
    ? { outcome: 'DONE_ALL', reason: '모든 task가 완료되었습니다' }
    : { outcome: 'EMPTY', reason: '백로그가 비어 있습니다' };
  if (pending.some(task => /^blocked\(A/u.test(task.status))) {
    return { outcome: 'WAIT_JUDGMENT', reason: '남은 task는 판단 또는 그 의존 task를 기다립니다' };
  }
  return { outcome: 'DEADLOCK', reason: '실행 가능한 task의 의존 증거를 확인해야 합니다', cycle: pending.map(task => task.id) };
}
export async function runPick(root: string, resources: PickResources = { slots: 'ok' }): Promise<PickDecision> {
  return withFileLock(harnessPath(root, 'harness-pick'), async () => {
    let state = await readState(root);
    const now = resources.now ?? Date.now();
    if (state.state === 'WAIT_RETRY' && (!state.retry?.nextAt || Date.parse(state.retry.nextAt) <= now)) {
      state = await transitionState(root, 'PICK', { now });
    }
    if (!['PICK', 'WAIT_RETRY', 'WAIT_RESOURCE', ...taskStates].includes(state.state)) {
      throw new Error('PICK 상태에서만 작업을 선택할 수 있습니다');
    }
    const decision = decidePick(await listBacklog(root), state, { ...resources, now });
    if (decision.outcome !== 'WAIT_RESOURCE') await updateState(root, { lastPaused: undefined });
    if (taskStates.includes(state.state)) {
      if (decision.outcome === 'RESUME') return decision;
      throw new Error('현재 task를 먼저 완료하거나 회수해야 합니다');
    }
    if (state.state === 'WAIT_RESOURCE' && decision.outcome === 'WAIT_RESOURCE') return decision;
    if (state.state === 'WAIT_RETRY' && decision.outcome === 'WAIT_RETRY') return decision;
    if (state.state !== 'PICK') state = await transitionState(root, 'PICK', { now });
    if (decision.outcome === 'EMPTY') return decision;
    for (const orphan of decision.orphans ?? []) {
      const { item } = await addJudgment(root, { title: `고아 task ${orphan.id}: 재개 / 폐기`,
        background: '현재 재개 대상이 아닌 진행 중 task입니다. 소유 프로세스와 증거를 확인해야 합니다.',
        options: ['ready 로 되돌려 재개', 'blocked 유지(보류)'], recommend: '① 증거 확인 후 재개', blocks: orphan.id,
        resolution: 'resume', dedupeKey: `orphan:${orphan.id}` });
      await setTask(root, orphan.id, { status: `blocked(${item.id})`, judgment: item.id });
    }
    if (decision.outcome === 'RESUME') {
      await transitionState(root, decision.next!, { taskId: decision.task?.id, resume: true });
      await updateState(root, { lastPaused: undefined });
    } else if (decision.outcome === 'SPEC') {
      await transitionState(root, 'SPEC', { taskId: decision.task!.id });
      await updateState(root, { retry: undefined, lastPaused: undefined, resumeTask: undefined });
    } else if (decision.outcome === 'DEADLOCK' || decision.exhausted) {
      const { item } = await addJudgment(root, { title: decision.outcome === 'DEADLOCK' ? '백로그 교착 해소' : decision.reason,
        background: `${decision.reason}: ${(decision.cycle ?? []).join(', ')}`,
        options: ['의존 관계와 작업 증거를 확인해 수정', '현재 상태를 보존하고 재검토'], recommend: '① 의존 관계와 중단 원인을 확인한 후 재개',
        blocks: '-', dedupeKey: `pick:${decision.reason}:${(decision.cycle ?? []).join(',')}` });
      if (decision.outcome === 'DEADLOCK') await transitionState(root, 'DEADLOCK');
      await updateState(root, { pickJudgment: item.id });
      await transitionState(root, 'WAIT_JUDGMENT');
      return { ...decision, reason: `${decision.reason} (${item.id})` };
    } else {
      if (decision.retry) await updateState(root, { retry: decision.retry });
      await transitionState(root, decision.outcome);
    }
    return decision;
  });
}
