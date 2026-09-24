import { afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setConfig } from '../src/core/config.ts';
import { addTask } from '../src/core/backlog.ts';
import { createWorktree } from '../src/core/worktree.ts';
import { updateState } from '../src/core/state.ts';
const roots: string[] = [];
export async function git(cwd: string, ...args: string[]) {
  if (!roots.some(root => resolve(cwd).startsWith(root + sep))) throw new Error('Test git is restricted to its temporary repository');
  return (await promisify(execFile)('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
export async function gitProject() {
  const parent = await mkdtemp('/private/tmp/fodh-p7-git-'); roots.push(parent);
  const root = join(parent, 'project'); await mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Harness Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false'); await git(root, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(join(root, '.gitignore'), '.pi/\ndocs/\n');
  await writeFile(join(root, 'code.txt'), 'base\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'base');
  const base = await git(root, 'rev-parse', 'HEAD');
  await setConfig(root, 'notify.channels', '["ledger"]');
  const task = await addTask(root, { title: '실제 git 증거', category: 'docs' });
  const worktree = await createWorktree(root, task.id);
  await updateState(root, { state: 'VERIFY', taskId: task.id });
  return { root, task, worktree, path: worktree.path, base };
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
