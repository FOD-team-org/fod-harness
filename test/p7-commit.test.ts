import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: execute }) };
});
import { project, cli } from './p5-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { updateState } from '../src/core/state.ts';
import { commitWorktree, validateTaskCommit } from '../src/core/worktree.ts';
import { readLedger } from '../src/core/ledger.ts';

async function setup(git = true) {
  execute.mockReset().mockResolvedValue({ stdout: '' });
  const root = await project('VERIFY'), path = await project('IDLE');
  if (git) await mkdir(join(root, '.git'));
  const task = await addTask(root, { title: '커밋', category: 'docs' });
  await setTask(root, task.id, { worktree: path, review: { commit: 'aaaa1111' } });
  await updateState(root, { taskId: task.id, worktrees: [{ taskId: task.id, path, branch: 'fixture', createdAt: 'now' }] });
  return { root, path, task };
}
it('F14 없는 SHA·dirty 거부, 커밋 후 clean 검수 허용: 등록 워크트리만 검사', async () => {
  const { root, path, task } = await setup();
  execute.mockRejectedValueOnce(new Error('missing'));
  await expect(validateTaskCommit(root, task.id, 'deadbeef', 'review')).rejects.toThrow('검수 대상 커밋이 없거나 미커밋 변경이 있습니다');
  execute.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: '?? change.ts' });
  expect(await cli(root, ['backlog', 'set', task.id, '--review-commit', 'aaaa1111'])).toMatchObject({ code: 1 });
  expect(await cli(root, ['backlog', 'set', task.id, '--review-commit', 'bbbb2222'])).toMatchObject({ code: 0 });
  expect(execute).toHaveBeenCalledWith('git', ['-C', path, 'cat-file', '-e', 'bbbb2222^{commit}'], expect.anything());
  expect(execute).toHaveBeenCalledWith('git', ['-C', path, 'status', '--porcelain'], expect.anything());
});
it('F14 merge는 루트에서 존재·review 조상을 검사한다', async () => {
  const { root, task } = await setup();
  execute.mockResolvedValueOnce({ stdout: '' }).mockRejectedValueOnce(new Error('not ancestor'));
  expect(await cli(root, ['backlog', 'set', task.id, '--merge-commit', 'bbbb2222'])).toMatchObject({ code: 1 });
  expect(await cli(root, ['backlog', 'set', task.id, '--merge-commit', 'cccc3333'])).toMatchObject({ code: 0 });
  expect(execute).toHaveBeenCalledWith('git', ['-C', root, 'merge-base', '--is-ancestor', 'aaaa1111', 'cccc3333'], expect.anything());
});
it('F14 비-git은 none만 허용하며 git을 실행하지 않는다', async () => {
  const { root, task } = await setup(false);
  for (const kind of ['review', 'merge'] as const) {
    await expect(validateTaskCommit(root, task.id, 'aaaa1111', kind)).rejects.toThrow('none');
    await validateTaskCommit(root, task.id, 'none', kind);
  }
  expect(execute).not.toHaveBeenCalled();
});
it('F14 worktree commit은 등록 경로 add→commit과 원장 증거를 남긴다', async () => {
  const { root, path, task } = await setup();
  execute.mockImplementation(async (_file, args: string[]) => ({ stdout: args.includes('rev-parse') ? 'bbbb2222\n' : '' }));
  vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['worktree', 'commit', task.id, '-m', '구현'])).toMatchObject({ code: 0, value: { commit: 'bbbb2222', worktree: path } });
  const calls = execute.mock.calls.map(call => call[1]);
  expect(calls).toContainEqual(['-C', path, 'add', '-A']);
  expect(calls.indexOf(calls.find(args => args.includes('add')))).toBeLessThan(calls.indexOf(calls.find(args => args.includes('commit'))));
  expect((await readLedger(root)).filter(e => e.action === 'worktree:commit').map(e => e.status)).toEqual(['pre', 'ok']);
  await updateState(root, { worktrees: [] });
  await expect(commitWorktree(root, task.id, 'invalid')).rejects.toThrow('등록된');
});
it.each(['tracked', 'untracked', 'staged'])('F14 %s 비밀 패턴은 커밋하지 않고 원장도 마스킹한다', async kind => {
  const { root, path, task } = await setup();
  const secret = 'sk-ant-FAKE_TEST_CREDENTIAL';
  await writeFile(join(path, 'new.txt'), secret);
  execute.mockImplementation(async (_file, args: string[]) => ({ stdout:
    kind === 'untracked' && args.includes('ls-files') ? 'new.txt\0'
      : args.includes('diff') && (kind === 'tracked' || kind === 'staged' && args.includes('--cached')) ? `+${secret}` : '' }));
  await expect(commitWorktree(root, task.id, 'unsafe')).rejects.toThrow('비밀값');
  expect(execute.mock.calls.some(call => call[1].includes('commit'))).toBe(false);
  const ledger = await readLedger(root);
  expect(JSON.stringify(ledger)).not.toContain(secret);
  expect(ledger.findLast(e => e.action === 'worktree:commit')?.status).toBe('fail');
});
