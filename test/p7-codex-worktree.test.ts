import { expect, it, vi } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { updateState, readState } from '../src/core/state.ts';
import { startCodex } from '../src/core/codex.ts';
import { readLedger } from '../src/core/ledger.ts';
import * as slots from '../src/core/slots.ts';
import * as processes from '../src/core/process-time.ts';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
async function setup(git: 'file' | 'directory' | false) {
  const root = await project('PICK'), task = await addTask(root, { title: '구현', category: 'docs' });
  if (git === 'directory') await mkdir(join(root, '.git'));
  if (git === 'file') await writeFile(join(root, '.git'), 'gitdir: unused-fixture');
  await writeFile(join(root, 'spec.md'), 'fixture');
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id });
  vi.mocked(spawn).mockReset();
  vi.spyOn(slots, 'acquireSlot').mockResolvedValue({ acquired: true });
  vi.spyOn(slots, 'updateSlot').mockResolvedValue(undefined);
  vi.spyOn(processes, 'processStartedAt').mockResolvedValue('fixture-start');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.mocked(spawn).mockImplementation(() => {
    const child = new ChildProcess(); Object.defineProperty(child, 'pid', { value: 99999991 });
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  return { root, task, start: (cwd?: string) => startCodex(root, 'task', { taskId: task.id, spec: 'spec.md', cwd }) };
}

it.each(['file', 'directory'] as const)('F8 .git %s 프로젝트는 등록 워크트리 없으면 spawn 전 거부', async git => {
  const { root, task, start } = await setup(git);
  await expect(start()).rejects.toThrow('IMPLEMENT 는 워크트리가 필요합니다: fodh worktree create <task>');
  const worktree = join(root, 'wt'); await mkdir(worktree);
  await setTask(root, task.id, { worktree });
  await expect(start()).rejects.toThrow('IMPLEMENT 는 워크트리가 필요합니다');
  await updateState(root, { worktrees: [{ taskId: 'T99', path: worktree, branch: 'fixture', createdAt: 'fixture' }] });
  await expect(start()).rejects.toThrow('IMPLEMENT 는 워크트리가 필요합니다');
  expect(spawn).not.toHaveBeenCalled();
});

it('F8 등록된 task 워크트리 내부만 허용하고 루트·다른 등록 워크트리 cwd는 거부', async () => {
  const { root, task, start } = await setup('directory');
  const worktree = join(root, 'wt'), other = join(root, 'other'), nested = join(worktree, 'src');
  await mkdir(nested, { recursive: true }); await mkdir(other);
  await setTask(root, task.id, { worktree });
  await updateState(root, { worktrees: [
    { taskId: task.id, path: worktree, branch: 'fixture', createdAt: 'fixture' },
    { taskId: 'T99', path: other, branch: 'other', createdAt: 'fixture' },
  ] });
  await expect(start(root)).rejects.toThrow('--cwd는 해당 task의 등록된 워크트리 안');
  await expect(start(other)).rejects.toThrow('--cwd는 해당 task의 등록된 워크트리 안');
  expect(spawn).not.toHaveBeenCalled();
  expect(await start(nested)).toMatchObject({ cwd: nested, worktree, kind: 'task' });
  expect(spawn).toHaveBeenCalledOnce();
  const entry = (await readLedger(root)).find(e => e.action === 'codex:task' && e.status === 'pre');
  expect(entry?.evidence).not.toHaveProperty('fallback');
});

it('F8 비-git 프로젝트는 기존 루트 폴백과 증거를 유지한다', async () => {
  const { root, start } = await setup(false);
  expect(await start()).toMatchObject({ cwd: root, worktree: null, kind: 'task' });
  expect((await readLedger(root)).find(e => e.action === 'codex:task' && e.status === 'pre')?.evidence).toMatchObject({ fallback: 'root' });
});

it('F16 슬롯 거부는 owner·wait를 기록하고 다음 획득 성공 때 해제한다', async () => {
  const { root, task, start } = await setup(false);
  const owner = { root: '/fixture/other', runId: 'busy', pid: 99999999, startedAt: 'fixture', acquiredAt: 'fixture' };
  await updateState(root, { delegation: { kind: 'task', runId: 'stale', taskId: task.id, startedAt: 'old' }, awaitingDelegation: true });
  vi.mocked(slots.acquireSlot).mockResolvedValueOnce({ acquired: false, owner });
  expect(await cli(root, ['codex', 'task', '--spec', 'spec.md', '--task', task.id])).toMatchObject({ code: 1,
    value: { error: 'codex 슬롯 사용 중', wait: 'slot', owner } });
  expect((await readState(root)).delegation).toBeUndefined();
  expect((await readState(root)).awaitingDelegation).toBe(false);
  expect(await readState(root)).toMatchObject({ awaitingSlot: { kind: 'codex', owner, since: expect.any(String) } });
  expect(spawn).not.toHaveBeenCalled();
  await start();
  expect((await readState(root)).awaitingSlot).toBeUndefined();
});
