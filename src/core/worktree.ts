import { setupWorktree, assertSetupMemory } from './worktree-setup.ts';
import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath, readFile, lstat, readlink, mkdir, symlink, appendFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTask, setTask } from './backlog.ts';
import { readState, updateState } from './state.ts';
import { loadConfig } from './config.ts';
import { harnessPath, withFileLock } from './storage.ts';
import { taskGit as git, taskMember, recordMember, executionTask, assertRecordRepo, repoEvidence } from './workspace-task.ts';
import { withWorktreeLock } from './worktree-lock.ts';
import { workspaceMembers } from './workspace.ts';
import { appendLedger, readLedger } from './ledger.ts';
import { inside, CodexError, readMeta } from './codex.ts';
import { redact } from '../provider/privacy.ts';
const execute = promisify(execFile);
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
  const config = await loadConfig(root), member = await recordMember(root, config, record);
  const base = (await git(member.path, ['merge-base', `refs/heads/${record.branch}`, config.workspace ? `refs/heads/${record.baseBranch}` : 'HEAD'])).trim();
  await updateState(root, current => ({ worktrees: current.worktrees?.map(item =>
    item.taskId === record.taskId && item.path === record.path ? { ...item, base } : item) }));
  return base;
}
export async function rootHead(root: string): Promise<string | null> {
  return await exists(resolve(root, '.git')) ? (await git(root, ['rev-parse', 'HEAD'])).trim() : null;
}
export async function validateTaskCommit(root: string, taskId: string, sha: string, kind: 'review' | 'merge', reviewCommit?: string) {
  const message = kind === 'review' ? '검수 대상 커밋이 없거나 미커밋 변경이 있습니다' : '병합 커밋이 없거나 검수 커밋을 포함하지 않습니다';
  const config = await loadConfig(root), task = await executionTask(root, taskId, config), member = await taskMember(root, config, task);
  const record = (await readState(root)).worktrees?.find(item => item.taskId === taskId);
  assertRecordRepo(config, task, record);
  if (!await exists(resolve(member.path, '.git'))) {
    if (sha !== 'none') throw new Error('비-git 프로젝트는 커밋 none만 허용합니다');
    return;
  }
  const state = await readState(root), verify = state.verify;
  if (kind === 'review') {
    if (!verify?.ok || verify.taskId !== taskId || !verify.head
      || !(Date.parse(verify.at) >= Date.parse(state.verifySince ?? verify.since ?? ''))) throw new Error('검증 증거가 없습니다: fodh verify run 을 다시 실행하세요(업그레이드 전 증거는 무효)');
    if (!/^[a-f0-9]{4,64}$/iu.test(sha)) throw new Error(message);
    let commit: string, verified: string;
    try {
      commit = (await git(member.path, ['rev-parse', '--verify', `${sha}^{commit}`])).trim();
      verified = (await git(member.path, ['rev-parse', '--verify', `${verify.head}^{commit}`])).trim();
    } catch { throw new Error(message); }
    if (commit !== verified) throw new Error('검수 커밋이 검증 시점 HEAD 와 다릅니다');
  }
  if (kind === 'merge') {
    const registered = (await readState(root)).worktrees?.find(item => item.taskId === taskId);
    const branch = config.workspace ? member.baseBranch : registered?.baseBranch;
    if (branch) {
      if ((await git(member.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== branch) {
        throw new Error(config.workspace ? `멤버 ${member.name} 브랜치가 기준 브랜치(${branch})가 아닙니다` : `루트 브랜치가 base 브랜치(${branch})가 아닙니다`);
      }
    } else await appendLedger(root, { runId: randomUUID(), taskId, action: 'merge-commit:base-branch-unknown', status: 'warn' });
  }
  let dirtyHint = '', mergeError = '';
  try {
    if (!/^[a-f0-9]{4,64}$/iu.test(sha)) throw new Error();
    const cwd = kind === 'review' ? await taskWorktree(root, taskId, true) : member.path;
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
      const mergeBase = task.merge?.base ?? (!config.workspace ? state.mergeBase : undefined);
      if (mergeBase) await git(member.path, ['merge-base', '--is-ancestor', mergeBase, sha]);
      else await appendLedger(root, { runId: randomUUID(), taskId, action: 'merge-commit:merge-base-unknown', status: 'warn' });
      await git(member.path, ['merge-base', '--is-ancestor', review, sha]);
      await git(member.path, ['merge-base', '--is-ancestor', sha, 'HEAD']);
      const commit = (await git(member.path, ['rev-parse', `${sha}^{commit}`])).trim();
      const reviewed = (await git(member.path, ['rev-parse', `${review}^{commit}`])).trim();
      const parents = (await git(member.path, ['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/u).slice(1);
      if (commit !== reviewed && !parents.includes(reviewed)) {
        mergeError = '병합 커밋의 부모에 검수 커밋이 없습니다'; throw new Error();
      }
      if (commit === reviewed && (await git(member.path, ['rev-parse', 'HEAD'])).trim() !== commit) throw new Error();
    }
  } catch { throw new Error(mergeError || message + dirtyHint); }
}
export async function commitWorktree(root: string, taskId: string, message: string) {
  if (!message.trim()) throw new Error('커밋 메시지 -m이 필요합니다');
  return withWorktreeLock(root, async () => {
    const config = await loadConfig(root), member = await taskMember(root, config, await executionTask(root, taskId, config)), repo = repoEvidence(config, member);
    const path = await taskWorktree(root, taskId, true), runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'pre', evidence: { ...repo, path } });
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
        await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'skip', evidence: { ...repo, ...result } });
        return result;
      }
      check(added(await git(path, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=0', 'HEAD', '--', ...scanPaths])));
      await git(path, ['commit', '-m', message]);
      const commit = (await git(path, ['rev-parse', 'HEAD'])).trim();
      await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'ok', evidence: { ...repo, path, commit } });
      return { taskId, commit, worktree: path };
    } catch (error) {
      await appendLedger(root, { runId, taskId, action: 'worktree:commit', status: 'fail', evidence: { ...repo, error: redact((error as Error).message) } });
      throw error;
    }
  });
}
// lstat keeps dangling links and existing checkout files intact; parents must stay in this checkout.
async function linkDependencies(root: string, sourceRoot: string, path: string, taskId: string, links: string[], runId: string, repo: { repo?: string }) {
  if (!links.length) return;
  const linked: string[] = [], skipped: string[] = [];
  for (const item of links) {
    const source = resolve(sourceRoot, item), target = resolve(path, item);
    if (!await exists(source)) { skipped.push(item); continue; }
    let present = false;
    try {
      const stat = await lstat(target); present = true;
      skipped.push(item);
      if (!stat.isSymbolicLink() || resolve(dirname(target), await readlink(target)) !== source) continue;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let parent = path;
    for (const component of item.split('/').slice(0, -1)) {
      parent = resolve(parent, component);
      try { await mkdir(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('worktrees.links 부모는 워크트리 내부 디렉터리여야 합니다');
    }
    if (!present) { await symlink(source, target); linked.push(item); }
    let ignored = false;
    try { await execute('git', ['-C', path, 'check-ignore', '-q', '--', item]); ignored = true; }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (!ignored) {
      const common = resolve(path, (await git(path, ['rev-parse', '--git-common-dir'])).trim());
      const exclude = resolve(common, 'info/exclude'), line = '/' + item;
      let text = '';
      try { text = await readFile(exclude, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!text.split(/\r?\n/u).includes(line)) {
        await mkdir(dirname(exclude), { recursive: true });
        await appendFile(exclude, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
        await appendLedger(root, { runId, taskId, action: 'worktree:link-excluded', status: 'ok', evidence: { ...repo, path: item } });
      }
    }
  }
  await appendLedger(root, { runId, taskId, action: 'worktree:link', status: 'ok', evidence: { ...repo, taskId, linked, skipped } });
}
export async function createWorktree(root: string, taskId: string, base?: string, setupOptions: { timeoutMs?: number } = {}) {
  if (!/^T\d+$/u.test(taskId)) throw new Error('task ID가 올바르지 않습니다');
  if (base !== undefined && (!base || base.startsWith('-') || /[\r\n\0]/u.test(base))) throw new Error('--base가 올바르지 않습니다');
  return withWorktreeLock(root, async () => {
    const state = await readState(root), config = await loadConfig(root);
    const task = await executionTask(root, taskId, config), member = await taskMember(root, config, task), repo = repoEvidence(config, member);
    if (config.workspace && base !== undefined) throw new Error(`워크스페이스 모드에서는 --base 를 쓸 수 없습니다 — 멤버 기준 브랜치(${member.baseBranch})에서 갈라집니다`);
    base = config.workspace ? `refs/heads/${member.baseBranch}` : base ?? 'HEAD';
    const registered = state.worktrees?.find(item => item.taskId === taskId);
    assertRecordRepo(config, task, registered);
    if (member.worktrees.setup?.length && !registered?.setupOk) await assertSetupMemory(root);
    const project = await realpath(root), branch = `${member.worktrees.prefix}${taskId}`;
    const path = await canonical(resolve(member.path, member.worktrees.root ?? '..', branch));
    if (inside(project, path) || inside(path, project)) throw new Error('워크트리는 프로젝트 루트 밖의 별도 경로여야 합니다');
    if (config.workspace && (await workspaceMembers(root, config)).some(m => inside(m.path, path) || inside(path, m.path))) throw new Error('워크트리는 모든 멤버 밖의 별도 경로여야 합니다');
    try { if ((await git(member.path, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') throw new Error(); }
    catch { throw new CodexError('git 저장소가 아닙니다', { worktree: null }); }
    const baseBranch = config.workspace ? member.baseBranch! : (await git(member.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (config.workspace) {
      try { await git(member.path, ['rev-parse', '--verify', `${base}^{commit}`]); }
      catch { throw new Error(`멤버 ${member.name}에 기준 브랜치 ${baseBranch}가 없습니다`); }
    }
    if (baseBranch === 'HEAD') throw new Error('루트가 브랜치 위에 있어야 합니다');
    if (registered && await exists(registered.path)) {
      await linkDependencies(root, member.path, registered.path, taskId, member.worktrees.links ?? [], randomUUID(), repo);
      const prepared = await setupWorktree(root, taskId, setupOptions);
      return { ...prepared, base: await registeredBase(root, registered), worktree: registered.path, created: false };
    }
    const ledger = config.workspace ? await readLedger(root) : [];
    const prior = config.workspace ? ledger.filter(e => e.taskId === taskId && e.action === 'worktree:create' && (e.evidence as { repo?: string; branch?: string })?.repo === member.name && (e.evidence as { branch?: string })?.branch === branch) : [];
    const runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'pre', evidence: { ...repo, path, branch, base } });
    try {
      let branchExists = false;
      try { await git(member.path, ['show-ref', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch { /* absent branch */ }
      if (config.workspace && branchExists && !registered && !prior.some(e => e.status === 'pre' && !ledger.some(end => end.runId === e.runId && end.status === 'fail'))) throw new Error(`옛 브랜치 ${branch}이 남아 있습니다 — 사용자가 지운 뒤 다시`);
      const previousBase = (prior.findLast(e => e.status === 'ok')?.evidence as { base?: string } | undefined)?.base;
      const baseCommit = registered?.base ?? (config.workspace && !registered ? previousBase : undefined)
        ?? (await git(member.path, branchExists ? ['merge-base', `refs/heads/${branch}`, config.workspace ? base! : 'HEAD'] : ['rev-parse', `${base}^{commit}`])).trim();
      await git(member.path, ['worktree', 'prune']);
      const recoveredPath = config.workspace && !registered && branchExists && await exists(path)
        && (await git(member.path, ['worktree', 'list', '--porcelain'])).split('\n').includes(`worktree ${path}`)
        && (await git(path, ['symbolic-ref', '--short', 'HEAD']).catch(() => { throw new Error('남은 워크트리가 브랜치 위에 있지 않습니다 — 사용자가 확인'); })).trim() === branch;
      if (!recoveredPath) await git(member.path, ['worktree', 'add', ...branchExists ? [path, branch] : ['-b', branch, path, base!]]);
      const record = { ...repo, taskId, path, branch, base: baseCommit, baseBranch: registered?.baseBranch ?? baseBranch, createdAt: new Date().toISOString() };
      await setTask(root, taskId, { worktree: path });
      await updateState(root, current => ({ worktrees: [...(current.worktrees ?? []).filter(item => item.taskId !== taskId), record] }));
      await linkDependencies(root, member.path, path, taskId, member.worktrees.links ?? [], runId, repo);
      await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'ok', evidence: record });
    } catch (error) {
      await appendLedger(root, { runId, taskId, action: 'worktree:create', status: 'fail', evidence: { ...repo, error: redact((error as Error).message), path, ...((error as Error).message.startsWith('옛 브랜치 ') ? { branch, reason: 'foreign-branch' } : {}) } }); throw error;
    }
    return { ...await setupWorktree(root, taskId, setupOptions), worktree: path, created: true };
  });
}
export async function removeWorktree(root: string, taskId: string, force = false) {
  return withFileLock(harnessPath(root, 'harness-delegation'), () => withWorktreeLock(root, async () => {
    const task = await getTask(root, taskId), state = await readState(root);
    if (!['CLEANUP', 'RECLAIM', 'DOCS'].includes(state.state) && task.status !== 'done') throw new Error('현재 상태에서는 워크트리를 제거할 수 없습니다');
    const registered = state.worktrees?.find(item => item.taskId === taskId);
    if (!registered) throw new Error('등록된 워크트리가 없습니다');
    if (state.delegation && !(await readMeta(root, state.delegation.runId))?.finishedAt) {
      const meta = await readMeta(root, state.delegation.runId);
      if (state.delegation.taskId === taskId || meta && inside(registered.path, meta.cwd)) throw new Error('위임 진행 중인 워크트리는 제거할 수 없습니다');
    }
    const config = await loadConfig(root), member = await recordMember(root, config, registered), repo = repoEvidence(config, member);
    const runId = randomUUID();
    await appendLedger(root, { runId, taskId, action: 'worktree:remove', status: 'pre', evidence: { ...repo, path: registered.path, force } });
    try {
      await git(member.path, ['worktree', 'remove', ...force ? ['--force'] : [], registered.path]);
      await setTask(root, taskId, { worktree: '' });
      await updateState(root, current => ({ worktrees: (current.worktrees ?? []).filter(item => item.taskId !== taskId) }));
      await appendLedger(root, { runId, taskId, action: 'worktree:remove', status: 'ok', evidence: registered });
      return { removed: true, ...registered };
    } catch (error) {
      await appendLedger(root, { runId, taskId, action: 'worktree:remove', status: 'fail', evidence: { ...repo, error: redact((error as Error).message) } }); throw error;
    }
  }));
}
export async function listWorktrees(root: string) {
  const state = await readState(root), config = await loadConfig(root);
  if (config.workspace) {
    const porcelain: Record<string, string> = {}, error: Record<string, string> = {};
    for (const member of await workspaceMembers(root, config)) {
      try { porcelain[member.name] = await git(member.path, ['worktree', 'list', '--porcelain']); }
      catch (caught) { error[member.name] = (caught as Error).message; }
    }
    const worktrees = await Promise.all((state.worktrees ?? []).map(async item => {
      const member = await recordMember(root, config, item);
      const paths = (porcelain[member.name] ?? '').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
      return { ...item, setupOk: item.setupOk === true, exists: await exists(item.path), registeredInGit: paths.includes(item.path) };
    }));
    return { worktrees, porcelain, ...(Object.keys(error).length ? { error } : {}) };
  }
  let porcelain = '', error: string | undefined;
  try { porcelain = await git(root, ['worktree', 'list', '--porcelain']); } catch (caught) { error = (caught as Error).message; }
  const paths = porcelain.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  return { worktrees: await Promise.all((state.worktrees ?? []).map(async item => ({ ...item, setupOk: item.setupOk === true,
    exists: await exists(item.path), registeredInGit: paths.includes(item.path) }))), porcelain, ...(error ? { error } : {}) };
}

// Diagnostics only: an unavailable Git status must not block cleanup completion.
export async function warnBacklogUncommitted(root: string, taskId?: string): Promise<void> {
  if (!await exists(resolve(root, '.git'))) return;
  let dirty = false;
  try { dirty = !!(await git(root, ['status', '--porcelain', '--', 'docs/backlog.md'])).trim(); }
  catch { return; }
  if (dirty) await appendLedger(root, { runId: randomUUID(), taskId, action: 'docs:backlog-uncommitted', status: 'warn' });
}

export async function prepareWorktree(root: string, taskId: string, options: { timeoutMs?: number } = {}) {
  return withWorktreeLock(root, () => setupWorktree(root, taskId, options));
}

export { mergeWorktree } from './worktree-merge.ts';
