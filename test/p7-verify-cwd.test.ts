import { setTask } from '../src/core/backlog.ts';
import { expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitProject } from './p7-git-helpers.ts';
import { runVerify } from '../src/core/verify.ts';
import { setConfig } from '../src/core/config.ts';
import { readState, transitionState } from '../src/core/state.ts';

it('H2 루트·하위 폴더 검증은 거부하고 기본 워크트리 cwd 증거만 허용한다', async () => {
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
