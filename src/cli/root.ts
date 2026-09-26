import { memberWorkspace } from '../core/workspace.ts';
import { dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { harnessPath, readText } from '../core/storage.ts';
import { readState } from '../core/state.ts';
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
async function exists(path: string) { try { return await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
export async function resolveCliRoot(cwd = process.cwd(), explicit = process.env.FODH_PROJECT_ROOT): Promise<string> {
  if (process.env.FODH_CODEX_CHILD) throw new Error('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  if (explicit) return resolve(explicit);
  const location = await realpath(cwd), candidates: string[] = [];
  // Marker authority precedes any old member harness state. Stop at the nearest git boundary.
  for (let current = location;; current = dirname(current)) {
    if (await exists(resolve(current, '.git'))) {
      const membership = await memberWorkspace(current);
      if (membership) return membership.workspace;
      break;
    }
    if (dirname(current) === current) break;
  }
  let discovered: string | undefined;
  for (let current = location;; current = dirname(current)) {
    if (await exists(harnessPath(current, 'harness-state.json'))) { discovered ??= current; candidates.push(current); }
    // Linked worktrees can be siblings of the project. Read Git's pointer files, never execute Git.
    const pointer = resolve(current, '.git');
    if ((await exists(pointer))?.isFile()) {
      const target = /^gitdir:\s*(.+)$/mu.exec(await readText(pointer))?.[1];
      if (target) {
        const gitdir = resolve(current, target.trim());
        const common = (await readText(resolve(gitdir, 'commondir'))).trim();
        if (common) candidates.push(dirname(await realpath(resolve(gitdir, common))));
      }
    }
    if (dirname(current) === current) break;
  }
  for (const candidate of new Set(candidates)) {
    const state = await readState(candidate);
    for (const entry of state.worktrees ?? []) {
      const path = await realpath(resolve(candidate, entry.path)).catch(() => undefined);
      if (path && inside(path, location)) throw new Error('워크트리 안에서는 fodh 를 실행할 수 없습니다. 프로젝트 루트에서 실행하세요');
    }
  }
  return discovered ?? location;
}
