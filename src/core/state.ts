import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';

export interface HarnessState { state: string; sessionId?: string; taskId?: string; savedAt?: string; [key: string]: unknown }

export async function readState(root: string): Promise<HarnessState> {
  return readJson(harnessPath(root, 'harness-state.json'), { state: 'IDLE' });
}

export async function updateState(
  root: string,
  patch: Partial<HarnessState> | ((current: HarnessState) => Partial<HarnessState> | Promise<Partial<HarnessState>>),
): Promise<HarnessState> {
  const path = harnessPath(root, 'harness-state.json');
  return withFileLock(path, async () => {
    const current = await readState(root);
    const next = { ...current, ...(typeof patch === 'function' ? await patch(current) : patch), savedAt: new Date().toISOString() };
    if (typeof next.state !== 'string' || !next.state.trim()) throw new Error('상태 값이 올바르지 않습니다');
    await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

const states = new Set([
  'IDLE', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PROJECT_READY', 'READY', 'WAIT_JUDGMENT',
  'PLANNING', 'PICK', 'SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'MERGE', 'DOCS', 'CLEANUP', 'CLEANUP_FAILED',
  'RECLAIM', 'DONE_ALL', 'WAIT_RETRY', 'WAIT_RESOURCE', 'DEADLOCK', 'recovering',
]);

export async function transitionState(root: string, to: string, taskId?: string): Promise<HarnessState> {
  if (!states.has(to) && !/^paused\((billing|quota|error|memory|budget|cleanup)\)$/u.test(to)) throw new Error('지원하지 않는 상태입니다');
  // 전체 전이 그래프와 검수 증거 게이트는 P1에서 추가한다.
  return updateState(root, { state: to, ...(taskId === undefined ? {} : { taskId }) });
}

export function doctorFresh(state: HarnessState, ttlHours = 12): boolean {
  const doctor = state.doctor as { ok?: boolean; checkedAt?: string } | undefined;
  const age = Date.now() - Date.parse(doctor?.checkedAt ?? '');
  return doctor?.ok === true && Number.isFinite(age) && age >= 0 && age <= ttlHours * 3600000;
}
