import { liveHarness } from './p7-brain-helpers.ts';
import { expect, it, vi } from 'vitest';
import { project, cli } from './p5-helpers.ts';
import { readState, transitionState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { runPick } from '../src/core/pick.ts';
import { atomicWrite } from '../src/core/storage.ts';
import { metaPath, type CodexMeta } from '../src/core/codex-record.ts';

async function reviewMeta(root: string, patch: Partial<CodexMeta> = {}) {
  const runId = patch.runId ?? 'review-fixture';
  await atomicWrite(metaPath(root, runId), JSON.stringify({ runId, kind: 'review', status: 'ok',
    startedAt: (await readState(root)).enteredAt, ...patch }));
}

it('F4 PROJECT_READY 진입은 사용자 대기와 알림 1회를 저장한다', async () => {
  const root = await project('REVIEW');
  await reviewMeta(root);
  expect(await transitionState(root, 'PROJECT_READY')).toMatchObject({ state: 'PROJECT_READY', awaitingUser: true });
  await updateState(root, { autoTurns: 0 });
  const notices = (await readLedger(root)).filter(e => e.action === 'notify:state:PROJECT_READY');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ status: 'ok', evidence: { level: 'info', body: '프로젝트 준비 완료 — `/develop-start` 로 개발을 시작하세요' } });
});

it.each([
  ['없음', undefined], ['진입 전', { startedAt: '2000-01-01T00:00:00Z' }],
  ['실패', { status: 'fail' }], ['실행 중', { status: 'running' }], ['조사', { kind: 'research' }],
] as const)('F6 프로젝트 검수 증거 %s 거부', async (_label, patch) => {
  const root = await project('REVIEW');
  if (patch) await reviewMeta(root, patch);
  await expect(transitionState(root, 'PROJECT_READY')).rejects.toThrow('교차검수 증거가 없습니다: fodh codex review --wait 결과가 필요합니다');
  expect((await readState(root)).state).toBe('REVIEW');
});

it('F6 REVIEW 진입 후 성공한 review meta는 프로젝트 통과를 허용한다', async () => {
  const root = await project('REVIEW');
  await updateState(root, { reviewSince: '2026-09-24T00:00:00Z' });
  await reviewMeta(root, { startedAt: '2026-09-24T00:00:01Z' });
  expect((await transitionState(root, 'PROJECT_READY')).state).toBe('PROJECT_READY');
});

it('F6 claude task는 일치하는 taskId의 review meta만 허용한다', async () => {
  const root = await project('PICK'), task = await addTask(root, { title: 'Claude 산출물', category: 'design' });
  await setTask(root, task.id, { delegate: 'claude' });
  await updateState(root, { state: 'REVIEW', phase: 'task', taskId: task.id, doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거');
  await reviewMeta(root, { taskId: 'T99' });
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거');
  await reviewMeta(root, { taskId: task.id });
  expect((await transitionState(root, 'MERGE', task.id)).state).toBe('MERGE');
});

it('N2 codex 구현 ok meta가 있는 task는 Claude Agent 검수 증거 가드를 면제한다', async () => {
  const root = await project('PICK'), task = await addTask(root, { title: 'Codex 산출물', category: 'docs' });
  await setTask(root, task.id, { delegate: 'codex' });
  await updateState(root, { state: 'REVIEW', phase: 'task', taskId: task.id, doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거');
  await reviewMeta(root, { kind: 'task', taskId: task.id });
  expect((await transitionState(root, 'MERGE', task.id)).state).toBe('MERGE');
});

it('F5 빈 백로그는 PLANNING→PICK을 거부하고 PICK에서도 EMPTY로 유지한다', async () => {
  const root = await project('PLANNING');
  await expect(transitionState(root, 'PICK')).rejects.toThrow('PICK 진입에는 등록된 task 가 필요합니다 (fodh backlog add)');
  expect((await readState(root)).state).toBe('PLANNING');
  await updateState(root, { state: 'PICK' });
  expect(await runPick(root)).toEqual({ outcome: 'EMPTY', reason: '백로그가 비어 있습니다' });
  expect(await cli(root, ['pick'])).toMatchObject({ code: 0, value: { outcome: 'EMPTY' } });
  expect((await readState(root)).state).toBe('PICK');
  expect((await readLedger(root)).some(e => e.action.endsWith('→DONE_ALL'))).toBe(false);
});

it('F5 등록 task가 있으면 PICK 허용, done 1개만 있으면 DONE_ALL', async () => {
  const root = await project('PLANNING');
  const task = await addTask(root, { title: '완료 작업', category: 'docs' });
  await transitionState(root, 'PICK');
  await setTask(root, task.id, { status: 'done', verify: { ok: true }, review: { commit: 'sha', high: 0 },
    merge: { commit: 'sha' }, docs: { ok: true }, cleanup: { ok: true } });
  expect(await runPick(root)).toMatchObject({ outcome: 'DONE_ALL' });
  expect((await readState(root)).state).toBe('DONE_ALL');
});

it('F4 CLI 두뇌 전이는 실패 원장을 남기고 사용자 전이는 허용한다', async () => {
  const root = await project('PROJECT_READY');
  await liveHarness(root); vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['state', 'transition', 'PLANNING'])).toEqual({ code: 1,
    value: { error: 'PROJECT_READY 는 사용자가 /develop-start 로 시작합니다' } });
  expect((await readState(root)).state).toBe('PROJECT_READY');
  expect((await readLedger(root)).filter(e => e.action === 'state:PROJECT_READY→PLANNING')).toEqual([
    expect.objectContaining({ status: 'fail' }),
  ]);
  vi.stubEnv('FODH_BRAIN', '');
  expect(await cli(root, ['state', 'transition', 'PLANNING'])).toMatchObject({ code: 0, value: { state: 'PLANNING' } });
});
