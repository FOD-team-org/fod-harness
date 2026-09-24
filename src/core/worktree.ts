import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTask, setTask } from './backlog.ts';
import { readState, updateState } from './state.ts';
import { loadConfig } from './config.ts';
import { harnessPath, withFileLock } from './storage.ts';
import { appendLedger } from './ledger.ts';
import { inside, CodexError, readMeta } from './codex.ts';
import { redact } from '../provider/privacy.ts';
const execute = promisify(execFile);
async function git(root: string, args: string[]): Promise<string> {
  try { return (await execute('git', ['-C', root, ...args], { timeout: 60000 })).stdout; }
  catch (error) { throw new Error(redact((error as { stderr?: string }).stderr || 'git worktree 실행 실패')); }
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return resolve(await canonical(dirname(path)), basename(path)); }
}
export async function createWorktree(root: string, taskId: string, base = 'HEAD') {
  if (!/^T\d+$/u.test(taskId)) throw new Error('task ID가 올바르지 않습니다');
  if (!base || base.startsWith('-') || /[\r\n\0]/u.test(base)) throw new Error('--base가 올바르지 않습니다');
  return withFileLock(harnessPath(root, 'harness-worktree'), async () => {
    await getTask(root, taskId);
    const state = await readState(root), config = await loadConfig(root);
    const registered = state.worktrees?.find(item => item.taskId === taskId);
    if (registered && await exists(registered.path)) return { ...registered, worktree: registered.path, created: false };
    const project = await realpath(root), branch = `${config.worktrees.prefix}${taskId}`;
    const path = await canonical(resolve(root, config.worktrees.root, branch));
    if (inside(project, path) || inside(path, project)) throw new Error('워크트리는 프로젝트 루트 밖의 별도 경로여야 합니다');
    try { if ((await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') throw new Error(); }
    catch { throw new CodexError('git 저장소가 아닙니다', { worktree: null }); }
    const runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'pre', evidence: { path, branch, base } });
    try {
      let branchExists = false;
      try { await git(root, ['show-ref', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch { /* absent branch */ }
      await git(root, ['worktree', 'prune']);
      await git(root, ['worktree', 'add', ...branchExists ? [path, branch] : ['-b', branch, path, base]]);
      const record = { taskId, path, branch, createdAt: new Date().toISOString() };
      await setTask(root, taskId, { worktree: path });
      await updateState(root, current => ({ worktrees: [...(current.worktrees ?? []).filter(item => item.taskId !== taskId), record] }));
      await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'ok', evidence: record });
      return { ...record, worktree: path, created: true };
    } catch (error) {
      await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'fail', evidence: { error: redact((error as Error).message), path } }); throw error;
    }
  });
}
export async function removeWorktree(root: string, taskId: string, force = false) {
  return withFileLock(harnessPath(root, 'harness-delegation'), () => withFileLock(harnessPath(root, 'harness-worktree'), async () => {
    const task = await getTask(root, taskId), state = await readState(root);
    if (!['CLEANUP', 'RECLAIM', 'DOCS'].includes(state.state) && task.status !== 'done') throw new Error('현재 상태에서는 워크트리를 제거할 수 없습니다');
    const registered = state.worktrees?.find(item => item.taskId === taskId);
    if (!registered) throw new Error('등록된 워크트리가 없습니다');
    if (state.delegation && !(await readMeta(root, state.delegation.runId))?.finishedAt) {
      const meta = await readMeta(root, state.delegation.runId);
      if (state.delegation.taskId === taskId || meta && inside(registered.path, meta.cwd)) throw new Error('위임 진행 중인 워크트리는 제거할 수 없습니다');
    }
    const runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:remove', status: 'pre', evidence: { path: registered.path, force } });
    try {
      await git(root, ['worktree', 'remove', ...force ? ['--force'] : [], registered.path]);
      await setTask(root, taskId, { worktree: '' });
      await updateState(root, current => ({ worktrees: (current.worktrees ?? []).filter(item => item.taskId !== taskId) }));
      await appendLedger(root, { runId, taskId, action: 'worktree:remove', status: 'ok', evidence: registered });
      return { removed: true, ...registered };
    } catch (error) {
      await appendLedger(root, { runId, taskId, action: 'worktree:remove', status: 'fail', evidence: { error: redact((error as Error).message) } }); throw error;
    }
  }));
}
export async function listWorktrees(root: string) {
  const state = await readState(root);
  let porcelain = '', error: string | undefined;
  try { porcelain = await git(root, ['worktree', 'list', '--porcelain']); } catch (caught) { error = (caught as Error).message; }
  const paths = porcelain.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  return { worktrees: await Promise.all((state.worktrees ?? []).map(async item => ({ ...item,
    exists: await exists(item.path), registeredInGit: paths.includes(item.path) }))), porcelain, ...(error ? { error } : {}) };
}
