import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath, readFile, lstat, readlink } from 'node:fs/promises';
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
async function taskWorktree(root: string, taskId: string, required = false): Promise<string> {
  const task = await getTask(root, taskId), state = await readState(root);
  const registered = state.worktrees?.find(item => item.taskId === taskId);
  if (!task.worktree && !registered && !required) return realpath(root);
  if (!task.worktree || !registered) throw new Error('등록된 task 워크트리가 필요합니다');
  const path = await realpath(resolve(root, registered.path));
  if (path !== await realpath(resolve(root, task.worktree)) || inside(await realpath(root), path)) throw new Error('등록된 task 워크트리가 필요합니다');
  return path;
}
async function registeredBase(root: string, record: NonNullable<Awaited<ReturnType<typeof readState>>['worktrees']>[number]) {
  if (record.base) return record.base;
  const base = (await git(root, ['merge-base', `refs/heads/${record.branch}`, 'HEAD'])).trim();
  await updateState(root, current => ({ worktrees: current.worktrees?.map(item =>
    item.taskId === record.taskId && item.path === record.path ? { ...item, base } : item) }));
  return base;
}
export async function rootHead(root: string): Promise<string | null> {
  return await exists(resolve(root, '.git')) ? (await git(root, ['rev-parse', 'HEAD'])).trim() : null;
}
export async function validateTaskCommit(root: string, taskId: string, sha: string, kind: 'review' | 'merge', reviewCommit?: string) {
  const message = kind === 'review' ? '검수 대상 커밋이 없거나 미커밋 변경이 있습니다' : '병합 커밋이 없거나 검수 커밋을 포함하지 않습니다';
  if (!await exists(resolve(root, '.git'))) {
    if (sha !== 'none') throw new Error('비-git 프로젝트는 커밋 none만 허용합니다');
    return;
  }
  const state = await readState(root), verify = state.verify;
  if (kind === 'review') {
    if (!verify?.ok || verify.taskId !== taskId || !verify.head
      || !(Date.parse(verify.at) >= Date.parse(state.verifySince ?? verify.since ?? ''))) throw new Error('검증 증거가 없습니다');
    if (!/^[a-f0-9]{4,64}$/iu.test(sha)) throw new Error(message);
    let commit: string, verified: string;
    try {
      commit = (await git(root, ['rev-parse', '--verify', `${sha}^{commit}`])).trim();
      verified = (await git(root, ['rev-parse', '--verify', `${verify.head}^{commit}`])).trim();
    } catch { throw new Error(message); }
    if (commit !== verified) throw new Error('검수 커밋이 검증 시점 HEAD 와 다릅니다');
  }
  if (kind === 'merge') {
    const registered = (await readState(root)).worktrees?.find(item => item.taskId === taskId);
    if (registered?.baseBranch) {
      if ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== registered.baseBranch) {
        throw new Error(`루트 브랜치가 base 브랜치(${registered.baseBranch})가 아닙니다`);
      }
    } else await appendLedger(root, { runId: randomUUID(), taskId, action: 'merge-commit:base-branch-unknown', status: 'warn' });
  }
  let dirtyHint = '';
  try {
    if (!/^[a-f0-9]{4,64}$/iu.test(sha)) throw new Error();
    const cwd = kind === 'review' ? await taskWorktree(root, taskId, true) : root;
    await git(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
    if (kind === 'review') {
      const record = (await readState(root)).worktrees!.find(item => item.taskId === taskId)!;
      const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
      const commit = (await git(cwd, ['rev-parse', `${sha}^{commit}`])).trim();
      const branch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).trim();
      const base = await registeredBase(root, record);
      if (commit !== head || branch !== record.branch || Number((await git(cwd, ['rev-list', '--count', `${base}..HEAD`])).trim()) < 1) throw new Error();
      if ((await git(cwd, ['status', '--porcelain'])).trim()) {
        if (verify?.dirtyAfter?.length) dirtyHint = `: ${redact(verify.dirtyAfter.join(', '))} — 검증 산출물이면 프로젝트 .gitignore 에 추가(위임)`;
        throw new Error();
      }
    } else {
      const review = reviewCommit ?? (await getTask(root, taskId)).review?.commit;
      if (!review || !/^[a-f0-9]{4,64}$/iu.test(review)) throw new Error();
      if (state.mergeBase) await git(root, ['merge-base', '--is-ancestor', state.mergeBase, sha]);
      else await appendLedger(root, { runId: randomUUID(), taskId, action: 'merge-commit:merge-base-unknown', status: 'warn' });
      await git(root, ['merge-base', '--is-ancestor', review, sha]);
      await git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']);
      const commit = (await git(root, ['rev-parse', `${sha}^{commit}`])).trim();
      const reviewed = (await git(root, ['rev-parse', `${review}^{commit}`])).trim();
      if (commit === reviewed && (await git(root, ['rev-parse', 'HEAD'])).trim() !== commit) throw new Error();
    }
  } catch { throw new Error(message + dirtyHint); }
}
export async function commitWorktree(root: string, taskId: string, message: string) {
  if (!message.trim()) throw new Error('커밋 메시지 -m이 필요합니다');
  return withFileLock(harnessPath(root, 'harness-worktree'), async () => {
    const path = await taskWorktree(root, taskId, true), runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'pre', evidence: { path } });
    const check = (text: string) => { if (redact(text) !== text) throw new Error('비밀값 패턴이 있어 커밋을 거부합니다'); };
    try {
      const registered = (await readState(root)).worktrees!.find(item => item.taskId === taskId)!;
      if ((await git(path, ['symbolic-ref', '--short', 'HEAD'])).trim() !== registered.branch) {
        throw new Error('등록된 task 브랜치에서만 커밋할 수 있습니다');
      }
      const paths = ['.', ':!.pi', ':!.pi/**'];
      const added = (diff: string) => {
        let hunk = false; const lines: string[] = [];
        for (const line of diff.split('\n')) {
          if (line.startsWith('diff --git ')) hunk = false;
          else if (line.startsWith('@@ ')) hunk = true;
          else if (hunk && line.startsWith('+')) lines.push(line.slice(1));
        }
        return lines.join('\n');
      };
      const untracked = await git(path, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]);
      const unscanned: string[] = [];
      for (const file of untracked.split('\0').filter(Boolean)) {
        const target = resolve(path, file), info = await lstat(target);
        if (info.isSymbolicLink()) check(await readlink(target));
        else if (!info.isFile() || info.size > 1024 * 1024) unscanned.push(file);
        else {
          const bytes = await readFile(target);
          if (bytes.includes(0) || !isUtf8(bytes)) unscanned.push(file);
          else check(bytes.toString('utf8'));
        }
      }
      if (unscanned.length) await appendLedger(root, { runId, taskId, action: 'worktree:commit:unscanned', status: 'skip', evidence: { files: unscanned } });
      const scanPaths = [...paths, ...unscanned.map(file => `:(exclude,literal)${file}`)];
      check(added(await git(path, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', 'HEAD', '--', ...scanPaths])));
      await git(path, ['add', '-A', '--', ...paths]);
      if (!(await git(path, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--', ...paths])).trim()) {
        const result = { ok: false as const, error: '커밋할 변경이 없습니다' };
        await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'skip', evidence: result });
        return result;
      }
      check(added(await git(path, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=0', 'HEAD', '--', ...scanPaths])));
      await git(path, ['commit', '-m', message]);
      const commit = (await git(path, ['rev-parse', 'HEAD'])).trim();
      await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'ok', evidence: { path, commit } });
      return { taskId, commit, worktree: path };
    } catch (error) {
      await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'fail', evidence: { error: redact((error as Error).message) } });
      throw error;
    }
  });
}
export async function createWorktree(root: string, taskId: string, base = 'HEAD') {
  if (!/^T\d+$/u.test(taskId)) throw new Error('task ID가 올바르지 않습니다');
  if (!base || base.startsWith('-') || /[\r\n\0]/u.test(base)) throw new Error('--base가 올바르지 않습니다');
  return withFileLock(harnessPath(root, 'harness-worktree'), async () => {
    await getTask(root, taskId);
    const state = await readState(root), config = await loadConfig(root);
    const registered = state.worktrees?.find(item => item.taskId === taskId);
    const project = await realpath(root), branch = `${config.worktrees.prefix}${taskId}`;
    const path = await canonical(resolve(root, config.worktrees.root, branch));
    if (inside(project, path) || inside(path, project)) throw new Error('워크트리는 프로젝트 루트 밖의 별도 경로여야 합니다');
    try { if ((await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') throw new Error(); }
    catch { throw new CodexError('git 저장소가 아닙니다', { worktree: null }); }
    const baseBranch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (baseBranch === 'HEAD') throw new Error('루트가 브랜치 위에 있어야 합니다');
    if (registered && await exists(registered.path)) return { ...registered, base: await registeredBase(root, registered), worktree: registered.path, created: false };
    const runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'pre', evidence: { path, branch, base } });
    try {
      let branchExists = false;
      try { await git(root, ['show-ref', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch { /* absent branch */ }
      const baseCommit = registered?.base ?? (await git(root, branchExists ? ['merge-base', `refs/heads/${branch}`, 'HEAD'] : ['rev-parse', `${base}^{commit}`])).trim();
      await git(root, ['worktree', 'prune']);
      await git(root, ['worktree', 'add', ...branchExists ? [path, branch] : ['-b', branch, path, base]]);
      const record = { taskId, path, branch, base: baseCommit, baseBranch: registered?.baseBranch ?? baseBranch, createdAt: new Date().toISOString() };
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
