import { listBacklog, setTask, type Task } from './backlog.ts';
import { addJudgment } from './judgment.ts';
import { readState, transitionState, updateState, type HarnessState } from './state.ts';
import { harnessPath, withFileLock } from './storage.ts';

export interface PickResources { slots: 'ok' | 'unavailable' | boolean; now?: number }
export interface PickDecision {
  outcome: 'SPEC' | 'DONE_ALL' | 'WAIT_JUDGMENT' | 'WAIT_RETRY' | 'WAIT_RESOURCE' | 'DEADLOCK';
  task?: Task; reason: string; cycle?: string[]; retry?: { count: number; nextAt?: string }; exhausted?: boolean;
}
export function decidePick(backlog: Task[], state: HarnessState, resources: PickResources): PickDecision {
  const now = resources.now ?? Date.parse(state.savedAt ?? state.enteredAt ?? '1970-01-01T00:00:00Z');
  const pending = backlog.filter(task => task.status !== 'done');
  if (!pending.length) return { outcome: 'DONE_ALL', reason: '모든 task가 완료되었습니다' };
  const paused = /^paused\(([^)]+)\)$/u.exec(state.state)?.[1] ?? state.lastPaused;
  if (['memory', 'budget'].includes(paused ?? '') || resources.slots === false || resources.slots === 'unavailable') {
    return { outcome: 'WAIT_RESOURCE', reason: '슬롯·메모리·예산 회복 확인이 필요합니다' };
  }
  if (['billing', 'cleanup'].includes(paused ?? '')) {
    return { outcome: 'WAIT_JUDGMENT', reason: '과금 또는 정리 중단 원인의 수동 확인이 필요합니다', exhausted: true };
  }
  const selected = pending.find(task => task.status === 'ready'
    && task.depends.every(id => backlog.some(dependency => dependency.id === id && dependency.status === 'done')));
  if (selected && !(state.retry?.nextAt && Date.parse(state.retry.nextAt) > now)) return { outcome: 'SPEC', task: selected, reason: '표 순서상 첫 실행 가능 task' };
  if (['error', 'quota'].includes(paused ?? '')) {
    const retry = state.retry ?? { count: 0 };
    if (retry.nextAt && Date.parse(retry.nextAt) > now) return { outcome: 'WAIT_RETRY', reason: '백오프 대기 중', retry };
    if (retry.count >= 3) return { outcome: 'WAIT_JUDGMENT', reason: '재시도 3회 소진', exhausted: true };
    return { outcome: 'WAIT_RETRY', reason: '일시 오류 재시도 예약', retry: {
      count: retry.count + 1, nextAt: new Date(now + [5, 15, 60][retry.count] * 60000).toISOString(),
    } };
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
  if (pending.some(task => /^blocked\(A/u.test(task.status)) && pending.every(task => task.status === 'ready' || task.status.startsWith('blocked('))) {
    return { outcome: 'WAIT_JUDGMENT', reason: '남은 task는 판단 또는 그 의존 task를 기다립니다' };
  }
  return { outcome: 'DEADLOCK', reason: '실행 가능한 task가 없고 미완료 진행 상태의 확인이 필요합니다', cycle: pending.map(task => task.id) };
}
export async function runPick(root: string, resources: PickResources = { slots: 'ok' }): Promise<PickDecision> {
  return withFileLock(harnessPath(root, 'harness-pick'), async () => {
    let state = await readState(root);
    if (state.state !== 'PICK' && !['WAIT_RETRY', 'WAIT_RESOURCE', 'WAIT_JUDGMENT'].includes(state.state)) {
      throw new Error('PICK 상태에서만 작업을 선택할 수 있습니다');
    }
    if (state.state === 'WAIT_JUDGMENT' && state.resumeState && state.resumeState !== 'PICK') {
      throw new Error('프로젝트 판단의 resumeState로 먼저 복귀해야 합니다');
    }
    const decision = decidePick(await listBacklog(root), state, { ...resources, now: resources.now ?? Date.now() });
    if (state.state === 'WAIT_RESOURCE' && decision.outcome === 'WAIT_RESOURCE') return decision;
    if (state.state === decision.outcome && decision.outcome === 'WAIT_RETRY' && decision.retry?.nextAt === state.retry?.nextAt) return decision;
    if (state.state !== 'PICK') state = await transitionState(root, 'PICK');
    if (decision.outcome === 'SPEC') {
      await transitionState(root, 'SPEC', { taskId: decision.task!.id });
      await setTask(root, decision.task!.id, { status: 'doing' });
      await updateState(root, { retry: { count: 0 }, lastPaused: undefined });
    } else if (decision.outcome === 'DEADLOCK' || decision.exhausted) {
      const { item } = await addJudgment(root, { title: decision.outcome === 'DEADLOCK' ? '백로그 교착 해소' : decision.reason,
        background: `${decision.reason}: ${(decision.cycle ?? []).join(', ')}`,
        options: ['의존 관계와 작업 증거를 확인해 수정', '현재 상태를 보존하고 재검토'], recommend: '① 의존 관계와 중단 원인을 확인한 후 재개',
        blocks: '', dedupeKey: `pick:${decision.reason}:${(decision.cycle ?? []).join(',')}` });
      if (decision.outcome === 'DEADLOCK') await transitionState(root, 'DEADLOCK');
      await transitionState(root, 'WAIT_JUDGMENT');
      await updateState(root, { pickJudgment: item.id });
      return { ...decision, reason: `${decision.reason} (${item.id})` };
    } else {
      if (decision.retry) await updateState(root, { retry: decision.retry });
      await transitionState(root, decision.outcome);
    }
    return decision;
  });
}
