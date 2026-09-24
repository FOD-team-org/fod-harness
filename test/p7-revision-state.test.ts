import { expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { readState, transitionState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import * as processes from '../src/core/process-time.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { atomicWrite } from '../src/core/storage.ts';
import { metaPath } from '../src/core/codex-record.ts';

async function evidence(root: string, kind: 'task' | 'review', taskId?: string, patch = {}) {
  await atomicWrite(metaPath(root, 'evidence'), JSON.stringify({ kind, taskId, status: 'ok',
    startedAt: new Date().toISOString(), ...patch }));
}

it.each([['PROJECT_READY', 'PLANNING'], ['DONE_ALL', 'PLANNING'], ['DONE_ALL', 'IDLE']])(
  'N1 사용자 전이 %s→%s: env·자손 체인 거부, 사용자 허용', async (from, to) => {
    const root = await project(from);
    const message = from === 'PROJECT_READY' ? 'PROJECT_READY 는 사용자가 /develop-start 로 시작합니다'
      : 'DONE_ALL 은 사용자가 /develop-start 또는 IDLE 전이로 이어갑니다';
    vi.stubEnv('FODH_BRAIN', '1');
    expect(await cli(root, ['state', 'transition', to])).toEqual({ code: 1, value: { error: message } });
    vi.stubEnv('FODH_BRAIN', '');
    await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: process.ppid, startedAt: 'owner-start', token: 'fixture' }));
    vi.spyOn(processes, 'processStartedAt').mockResolvedValue('owner-start');
    const chain = vi.spyOn(processes, 'descendantOf').mockResolvedValue(true);
    expect(await cli(root, ['state', 'transition', to])).toEqual({ code: 1, value: { error: message } });
    expect(chain).toHaveBeenCalledWith(process.ppid, process.ppid);
    expect((await readState(root)).state).toBe(from);
    expect((await readLedger(root)).filter(e => e.action === `state:${from}→${to}` && e.status === 'fail')).toHaveLength(2);
    chain.mockResolvedValue(false);
    expect(await cli(root, ['state', 'transition', to])).toMatchObject({ code: 0, value: { state: to } });
  },
);

it('N9 --system은 두뇌 CLI만 거부하고 사용자 CLI·내부 전이는 허용한다', async () => {
  const root = await project('WAIT_JUDGMENT'); await updateState(root, { resumeState: 'REVIEW', phase: 'project' });
  vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['state', 'transition', 'REVIEW', '--system'])).toMatchObject({ code: 1, value: { error: expect.stringContaining('두뇌 세션') } });
  expect((await readState(root)).state).toBe('WAIT_JUDGMENT');
  expect((await transitionState(root, 'REVIEW', { system: true })).state).toBe('REVIEW');
  await transitionState(root, 'WAIT_JUDGMENT'); vi.stubEnv('FODH_BRAIN', '');
  expect(await cli(root, ['state', 'transition', 'REVIEW', '--system'])).toMatchObject({ code: 0, value: { state: 'REVIEW' } });
});

it.each([undefined, 'codex', 'claude'] as const)('N2 delegate=%s와 무관하게 실제 구현 또는 검수 meta를 요구한다', async delegate => {
  const root = await project('PICK'), task = await addTask(root, { title: '증거 검사', category: 'docs' });
  if (delegate) await setTask(root, task.id, { delegate });
  await updateState(root, { state: 'REVIEW', taskId: task.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거가 없습니다');
  await evidence(root, 'task', 'T99');
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거가 없습니다');
  await evidence(root, 'task', task.id, { status: 'fail' });
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거가 없습니다');
  await evidence(root, 'task', task.id, { startedAt: '2000-01-01T00:00:00Z' });
  expect((await transitionState(root, 'MERGE', task.id)).state).toBe('MERGE');
});

it('N2 구현 meta 없이 review ok meta만으로도 MERGE 허용', async () => {
  const root = await project('PICK'), task = await addTask(root, { title: '검수 증거', category: 'docs' });
  await updateState(root, { state: 'REVIEW', taskId: task.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await evidence(root, 'review', task.id);
  expect((await transitionState(root, 'MERGE', task.id)).state).toBe('MERGE');
});

it('N3 프로젝트 REVIEW→WAIT_JUDGMENT→REVIEW는 기존 reviewSince 증거를 복원한다', async () => {
  const root = await project('ARCH'); await transitionState(root, 'REVIEW');
  await updateState(root, { reviewSince: '2026-09-24T00:00:00Z' });
  await evidence(root, 'review', undefined, { startedAt: '2026-09-24T00:00:01Z' });
  await transitionState(root, 'WAIT_JUDGMENT');
  expect(await readState(root)).toMatchObject({ resumeReviewSince: '2026-09-24T00:00:00Z' });
  expect((await readState(root)).reviewSince).toBeUndefined();
  await transitionState(root, 'REVIEW', { judgmentApplied: true });
  expect((await readState(root)).reviewSince).toBe('2026-09-24T00:00:00Z');
  expect((await readState(root)).enteredAt).not.toBe('2026-09-24T00:00:00Z');
  await transitionState(root, 'PROJECT_READY');
  expect((await readState(root)).reviewSince).toBeUndefined();
  expect((await readState(root)).resumeReviewSince).toBeUndefined();
});

it('N3 task paused→PICK→resume REVIEW는 시각을 보존하고 VERIFY 새 진입은 갱신한다', async () => {
  const root = await project('PICK'), task = await addTask(root, { title: '복귀', category: 'docs' });
  await updateState(root, { state: 'VERIFY', taskId: task.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await updateState(root, { verify: { runId: 'verify-fixture', taskId: task.id, ok: true, at: new Date().toISOString(), heavy: false } });
  await transitionState(root, 'REVIEW', task.id);
  await updateState(root, { reviewSince: '2026-09-24T00:00:00Z' });
  await evidence(root, 'review', task.id, { startedAt: '2026-09-24T00:00:01Z' });
  await updateState(root, { state: 'paused(error)' });
  expect((await readState(root)).reviewSince).toBeUndefined();
  await transitionState(root, 'PICK');
  await transitionState(root, 'REVIEW', { taskId: task.id, resume: true });
  expect((await readState(root)).reviewSince).toBe('2026-09-24T00:00:00Z');
  await transitionState(root, 'MERGE', task.id);
  await updateState(root, { state: 'VERIFY' });
  await updateState(root, { verify: { runId: 'verify-fixture', taskId: task.id, ok: true, at: new Date().toISOString(), heavy: false } });
  await transitionState(root, 'REVIEW', task.id);
  expect((await readState(root)).reviewSince).not.toBe('2026-09-24T00:00:00Z');
  await expect(transitionState(root, 'MERGE', task.id)).rejects.toThrow('교차검수 증거');
});

it.each([
  ['PROJECT_READY', 'PLANNING'], ['DONE_ALL', 'PLANNING'], ['DONE_ALL', 'IDLE'],
  ['WAIT_RETRY', 'PICK'], ['WAIT_RESOURCE', 'PICK'], ['WAIT_JUDGMENT', 'INTERVIEW'], ['CLEANUP_FAILED', 'CLEANUP'],
])('F10 %s→%s 코어 전이가 awaitingUser를 해제한다', async (from, to) => {
  const root = await project(from), task = to === 'CLEANUP' ? await addTask(root, { title: '정리', category: 'docs' }) : undefined;
  await updateState(root, { awaitingUser: true, resumeState: to, ...(task ? { taskId: task.id } : {}) });
  expect(await transitionState(root, to, { taskId: task?.id, system: from === 'WAIT_JUDGMENT' })).toMatchObject({ state: to, awaitingUser: false });
});
