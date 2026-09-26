import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCliRoot } from '../src/cli/root.ts';
import { updateState, transitionState } from '../src/core/state.ts';
import { main } from '../src/cli/index.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fodh-cli-root-'))); roots.push(parent);
  const root = join(parent, 'project'), sub = join(root, 'src/nested'); await mkdir(sub, { recursive: true });
  await updateState(root, { state: 'RESEARCH' }); return { parent, root, sub };
}
it('하위 cwd에서 가장 가까운 harness-state 루트를 찾고 없으면 cwd를 사용한다', async () => {
  const { parent, root, sub } = await setup();
  expect(await resolveCliRoot(sub, '')).toBe(root); expect(await resolveCliRoot(parent, '')).toBe(parent);
  await updateState(join(root, 'src'), { state: 'IDLE' }); expect(await resolveCliRoot(sub, '')).toBe(join(root, 'src'));
});
it('등록 worktree와 그 하위·심링크 진입은 거부하고 명시적 env 루트는 우선한다', async () => {
  const { parent, root, sub } = await setup(); const wt = join(parent, 'worktree'); await mkdir(join(wt, 'src'), { recursive: true });
  // A real linked worktree exposes its original repository through these plain-text pointers.
  const gitdir = join(root, '.git/worktrees/test'); await mkdir(gitdir, { recursive: true });
  await writeFile(join(wt, '.git'), `gitdir: ${gitdir}\n`); await writeFile(join(gitdir, 'commondir'), '../..\n');
  await updateState(root, { worktrees: [{ taskId: 'T01', path: wt, branch: 'wt-T01', createdAt: new Date().toISOString() }] });
  await symlink(wt, join(parent, 'alias'));
  for (const cwd of [wt, join(wt, 'src'), join(parent, 'alias')]) await expect(resolveCliRoot(cwd, '')).rejects.toThrow('워크트리 안에서는 fodh');
  expect(await resolveCliRoot(wt, root)).toBe(root); expect(await resolveCliRoot(sub, wt)).toBe(wt);
  vi.stubEnv('FODH_PROJECT_ROOT', root); expect(await resolveCliRoot(wt)).toBe(root);
  vi.stubEnv('FODH_PROJECT_ROOT', ''); vi.spyOn(process, 'cwd').mockReturnValue(wt);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await main(['state', 'get']); expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toEqual({ error: '워크트리 안에서는 fodh 를 실행할 수 없습니다. 프로젝트 루트에서 실행하세요' });
});
it('bin/fodh도 하위 cwd에서 원래 상태를 읽는다', async () => {
  const { sub } = await setup();
  const { stdout } = await promisify(execFile)(resolve('bin/fodh'), ['state', 'get'], { cwd: sub, env: { ...process.env, FODH_PROJECT_ROOT: '' } });
  expect(JSON.parse(stdout).state).toBe('RESEARCH');
});
it('잘못된 상태명과 허용되지 않는 전이는 현재 상태와 가능한 목록을 보여준다', async () => {
  const { root } = await setup();
  await expect(transitionState(root, 'DONE')).rejects.toThrow(/RESEARCH.*가능한 전이.*PRD_DRAFT/u);
  await expect(transitionState(root, 'MERGE')).rejects.toThrow(/RESEARCH.*가능한 전이.*PRD_DRAFT/u);
});

it('Codex 자식은 명시적 프로젝트 루트가 있어도 main 진입을 거부한다', async () => {
  const { root } = await setup(); vi.stubEnv('FODH_CODEX_CHILD', '1'); vi.stubEnv('FODH_PROJECT_ROOT', root);
  await expect(resolveCliRoot(root)).rejects.toThrow('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const explicit of [undefined, root]) {
    await main(['state', 'get'], explicit);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ error: 'Codex 위임 안에서는 fodh 를 실행할 수 없습니다' });
  }
});
