import { memberWorkspace } from '../core/workspace.ts';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export const projectFolderHint = 'HOME 또는 / 에는 하네스를 설치하거나 열 수 없습니다. 프로젝트 폴더에서 실행하세요';
export async function globalProjectLocation(path: string, home = process.env.HOME ?? homedir()) {
  const actual = await realpath(path), actualHome = await realpath(home).catch(() => resolve(home));
  return actual === actualHome || dirname(actual) === actual;
}
export async function assertMainWorktree(root: string) {
  const pointer = join(root, '.git');
  if (!await lstat(pointer).then(s => s.isFile(), () => false)) return;
  let common: string, gitdir: string;
  try {
    const target = /^gitdir:\s*(.+)$/mu.exec(await readFile(pointer, 'utf8'))?.[1];
    if (!target) throw new Error('invalid git pointer');
    gitdir = await realpath(resolve(root, target.trim()));
    const { stdout } = await execute('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 3000 });
    common = await realpath(resolve(root, stdout.trim()));
  } catch { throw new Error('워크트리 정보를 확인할 수 없습니다. 본 저장소에서 실행하세요'); }
  // A submodule also has a .git file, but its gitdir and common directory are identical.
  if (common !== gitdir) throw new Error(`하네스 워크트리입니다 — 본 저장소 ${dirname(common)} 에서 실행하세요`);
}

// Ordinary root discovery uses metadata; .git pointers additionally resolve the Git common directory.
export async function projectRoots(cwd = process.cwd(), home = process.env.HOME ?? homedir()) {
  let current = await realpath(cwd);
  const stop = await realpath(home).catch(() => resolve(home));
  let harness: string | undefined;
  for (;;) {
    if (current === stop || dirname(current) === current) {
      const git = await lstat(join(current, '.git')).then(s => s.isDirectory() || s.isFile(), () => false);
      return { harness, ...(git ? { git: current } : {}) };
    }
    if (!harness && await stat(join(current, '.pi/harness.json')).then(s => s.isFile(), () => false)) harness = current;
    if (await lstat(join(current, '.git')).then(s => s.isDirectory() || s.isFile(), () => false)) {
      const membership = await memberWorkspace(current);
      if (membership) return { harness: membership.workspace, git: current, member: membership.member };
      await assertMainWorktree(current);
      return { harness, git: current };
    }
    const parent = dirname(current);
    if (parent === current) return { harness };
    current = parent;
  }
}
