import { setTask } from '../src/core/backlog.ts';
import { expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitProject } from './p7-git-helpers.ts';
import { runVerify } from '../src/core/verify.ts';
import { setConfig } from '../src/core/config.ts';
import { readState, transitionState } from '../src/core/state.ts';

it('H2 루트·하위 폴더 검증은 거부하고 기본 워크트리 cwd 증거만 허용한다', { timeout: 60_000 }, async () => {
  const { root, task, path } = await gitProject();
  await setConfig(root, 'verify.commands', JSON.stringify([`${process.execPath} -e "process.exit(0)"`]));
  await mkdir(join(path, 'sub'));
  for (const cwd of [root, join(path, 'sub')]) {
    expect((await runVerify(root, { cwd })).ok).toBe(true);
    await expect(transitionState(root, 'REVIEW', task.id)).rejects.toThrow('검증 증거가 다른 경로에서 만들어졌습니다');
  }
  await setTask(root, task.id, { worktree: root });
  await runVerify(root, { cwd: root });
  await expect(transitionState(root, 'REVIEW', task.id)).rejects.toThrow('검증 증거가 다른 경로에서 만들어졌습니다');
  const report = await runVerify(root);
  expect(report).toMatchObject({ ok: true, cwd: path });
  expect((await readState(root)).verify).toMatchObject({ cwd: path });
  if (!('runId' in report)) throw new Error('결과 없음');
  expect(JSON.parse(await readFile(join(root, '.pi/verify', report.runId, 'result.json'), 'utf8')).cwd).toBe(path);
  await transitionState(root, 'REVIEW', task.id);
});
it('S4 dirty 검증은 전이를 거부하고 커밋→검증의 HEAD만 검수에 허용한다', { timeout: 60_000 }, async () => {
  const { writeFile } = await import('node:fs/promises');
  const { commitWorktree } = await import('../src/core/worktree.ts');
  const { cli } = await import('./p5-helpers.ts');
  const { root, path, task, base } = await gitProject();
  await setConfig(root, 'verify.commands', JSON.stringify([`${process.execPath} -e "process.exit(0)"`]));
  await writeFile(join(path, 'code.txt'), 'implementation');
  expect(await runVerify(root)).toMatchObject({ ok: true, head: base, clean: false });
  await expect(transitionState(root, 'REVIEW', task.id)).rejects.toThrow('검증 당시 미커밋 변경이 있었습니다');
  const commit = await commitWorktree(root, task.id, 'implementation');
  if (!('commit' in commit)) throw new Error('commit missing');
  const report = await runVerify(root);
  expect(report).toMatchObject({ ok: true, head: commit.commit, clean: true });
  expect((await readState(root)).verify).toMatchObject({ head: commit.commit, clean: true });
  if (!('runId' in report)) throw new Error('report missing');
  expect(JSON.parse(await readFile(join(root, '.pi/verify', report.runId, 'result.json'), 'utf8'))).toMatchObject({ head: commit.commit, clean: true });
  await transitionState(root, 'REVIEW', task.id);
  expect((await cli(root, ['backlog', 'set', task.id, '--review-commit', commit.commit])).code).toBe(0);
  expect((await cli(root, ['backlog', 'set', task.id, '--review-commit', base])).value.error).toBe('검수 커밋이 검증 시점 HEAD 와 다릅니다');
  await writeFile(join(path, 'code.txt'), 'later code');
  const later = await commitWorktree(root, task.id, 'later');
  if (!('commit' in later)) throw new Error('commit missing');
  expect((await cli(root, ['backlog', 'set', task.id, '--review-commit', later.commit])).value.error).toBe('검수 커밋이 검증 시점 HEAD 와 다릅니다');
});
