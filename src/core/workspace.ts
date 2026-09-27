import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { autoVerifyMarker, loadConfig, type HarnessConfig, type WorkspaceMember } from './config.ts';
import { DetectUnreadableError, type DetectedVerify, detectVerify, verifySkipDirs } from './verify-detect.ts';
import type { Task } from './backlog.ts';
import { assertNotBrain } from './brain-guard.ts';
import { lockOwnerAlive, ownerAt } from './lock.ts';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';
import { readState } from './state.ts';

/**
 * A single-repository member has baseBranch undefined: use the current branch.
 * In workspace mode use this member's verify/worktrees, never the top-level
 * config.verify/config.worktrees defaults (which describe no workspace member).
 */
export type ResolvedWorkspaceMember = Omit<WorkspaceMember, 'path'> & { name: string; path: string };
export const isWorkspace = (config: HarnessConfig): boolean => config.workspace !== undefined;
export async function workspaceMembers(root: string, config: HarnessConfig): Promise<ResolvedWorkspaceMember[]> {
  if (!config.workspace) return [{ name: '.', path: root, baseBranch: undefined,
    worktrees: config.worktrees, verify: config.verify, secrets: config.secrets, approvalRules: config.approvalRules }];
  return Promise.all(Object.entries(config.workspace.repos).map(async ([name, member]) => ({ ...member, name,
    path: await realpath(resolve(root, member.path)), baseBranch: member.baseBranch ?? 'main' })));
}
export async function repoOf(root: string, config: HarnessConfig, task: Pick<Task, 'repo'>): Promise<ResolvedWorkspaceMember> {
  const members = await workspaceMembers(root, config);
  const member = config.workspace ? members.find(member => member.name === task.repo) : members[0];
  if (!member) throw new Error('task에 알려진 워크스페이스 repo가 필요합니다');
  return member;
}
export async function readMarker(memberGitCommonDir: string): Promise<string | undefined> {
  try { return (await readFile(join(memberGitCommonDir, 'fodh-workspace'), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function writeMarker(memberGitCommonDir: string, workspace: string): Promise<void> {
  await atomicWrite(join(memberGitCommonDir, 'fodh-workspace'), await realpath(workspace) + '\n');
}
export async function removeMarker(memberGitCommonDir: string): Promise<void> {
  await unlink(join(memberGitCommonDir, 'fodh-workspace')).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
// All marker APIs take the member Git common directory.
export async function validateMarker(memberGitCommonDir: string): Promise<{ workspace: string; member?: string; ok: boolean; reason?: string }> {
  const common = await realpath(memberGitCommonDir).catch(() => resolve(memberGitCommonDir));
  const workspace = await readMarker(common) ?? '';
  const reason = `표지가 맞지 않습니다: ${workspace}에서 fodh workspace list — 표지 파일 ${join(common, 'fodh-workspace')}; 워크스페이스가 없어졌다면 이 파일을 지우세요`;
  if (!workspace || !isAbsolute(workspace)) return { workspace, ok: false, reason };
  try {
    const actualWorkspace = await realpath(workspace);
    if (actualWorkspace !== workspace) return { workspace, ok: false, reason };
    const config = await loadConfig(workspace, undefined, { dryRun: true });
    const memberPath = await realpath(dirname(common));
    const member = config.workspace && (await workspaceMembers(workspace, config)).find(item => item.path === memberPath);
    if (member) return { workspace, member: member.name, ok: true };
  } catch { /* Invalid or moved configuration makes the marker fail closed. */ }
  return { workspace, ok: false, reason };
}
// Read metadata only: root discovery must also work with a Node-only PATH.
export async function memberWorkspace(repoRoot: string): Promise<{ workspace: string; member: string } | undefined> {
  const pointer = join(repoRoot, '.git');
  const info = await lstat(pointer).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  let gitdir = pointer, common = pointer;
  if (info.isFile()) {
    const target = /^gitdir:\s*(.+)$/mu.exec(await readText(pointer))?.[1];
    if (!target) return undefined;
    gitdir = resolve(repoRoot, target.trim());
    const value = (await readText(join(gitdir, 'commondir'))).trim();
    common = value ? resolve(gitdir, value) : gitdir;
  }
  if (await readMarker(common) === undefined) return undefined;
  const marker = await validateMarker(common);
  if (!marker.ok) throw new Error(marker.reason);
  if (await realpath(gitdir) !== await realpath(common)) {
    throw new Error(`멤버 ${marker.member}의 워크트리 안입니다 — 워크스페이스 ${marker.workspace}에서 여세요`);
  }
  return { workspace: marker.workspace, member: marker.member! };
}
const execute = promisify(execFile);
export async function workspaceGit(root: string, args: string[]): Promise<string> {
  try { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim(); }
  catch { throw new Error('워크스페이스 Git 검사·작업에 실패했습니다'); }
}
async function localIdentity(root: string) {
  const name = await workspaceGit(root, ['config', '--local', '--get', 'user.name']).catch(() => '');
  const email = await workspaceGit(root, ['config', '--local', '--get', 'user.email']).catch(() => '');
  return name && email ? { name, email } : undefined;
}
export async function checkWorkspaceMember(root: string, member: ResolvedWorkspaceMember): Promise<void> {
  const owner = await ownerAt(harnessPath(member.path, 'harness.lock'));
  if (owner && await lockOwnerAlive(owner)) throw new Error(`멤버 ${member.name}의 옛 하네스 잠금이 살아 있습니다`);
  const state = await readState(member.path);
  if (!['IDLE', 'DONE_ALL', 'PROJECT_READY'].includes(state.state)) throw new Error(`멤버 ${member.name}의 옛 하네스 상태: ${state.state}`);
  const marker = await readMarker(join(member.path, '.git'));
  if (marker !== undefined && marker !== await realpath(root)) throw new Error(`멤버 ${member.name}에 다른 워크스페이스 표지가 있습니다`);
  try { await workspaceGit(member.path, ['rev-parse', '--verify', `refs/heads/${member.baseBranch}`]); }
  catch { throw new Error(`멤버 ${member.name} baseBranch ${member.baseBranch}가 없습니다`); }
  const branches = await workspaceGit(member.path, ['branch', '--no-merged', member.baseBranch!, '--list', `${member.worktrees.prefix}*`]);
  if (branches) throw new Error(`멤버 ${member.name}에 병합 안 된 prefix 브랜치가 있습니다: ${branches}`);
}
// Unrecognized members retain a marked placeholder for detection in their first task.
export function defaultWorkspaceMember(name: string, path: string): WorkspaceMember {
  return { path, baseBranch: 'main', worktrees: { prefix: `wt-${name}-` }, verify: { commands: ['git diff --check'] } };
}
async function detectedWorkspaceMember(member: WorkspaceMember, root: string, docsRoot: string, warnings: string[]): Promise<WorkspaceMember> {
  const base = await realpath(resolve(root, member.path));
  let detected: DetectedVerify | undefined;
  try {
    detected = await detectVerify(base, { source: 'fs', skipPrefixes: [member.worktrees.prefix], skipDirs: verifySkipDirs(base, docsRoot, root) });
  } catch (error) {
    if (!(error instanceof DetectUnreadableError)) throw error;
    warnings.push(error.message);
  }
  const verify = { commands: detected?.commands ?? member.verify.commands, heavy: detected?.heavy ?? [] };
  return { ...member, verify: { ...verify, auto: autoVerifyMarker(verify, detected?.stacks ?? []) } };
}
export async function initWorkspace(options: { cwd?: string; repos: string[]; identity?: string; dryRun?: boolean }) {
  const root = await realpath(options.cwd ?? process.cwd());
  if (process.env.FODH_CODEX_CHILD) throw new Error('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  await assertNotBrain(root, 'workspace init');
  const { globalProjectLocation, projectFolderHint, assertMainWorktree, projectRoots } = await import('../cli/project-root.ts');
  if (await globalProjectLocation(root)) throw new Error(projectFolderHint);
  const discovered = await projectRoots(root);
  if (discovered.git && discovered.git !== root || discovered.member) throw new Error('워크스페이스 init은 멤버 밖의 독립 폴더·git 최상위에서 실행하세요');
  await assertMainWorktree(root);
  const repos: Record<string, WorkspaceMember> = {};
  for (const entry of options.repos) {
    const at = entry.indexOf('='), name = entry.slice(0, at), path = entry.slice(at + 1);
    if (at < 1 || !path || Object.hasOwn(repos, name)) throw new Error('--repo 이름=상대경로 형식과 중복 이름을 확인하세요');
    Object.defineProperty(repos, name, { value: defaultWorkspaceMember(name, path), enumerable: true, writable: true });
  }
  const preflight = await loadConfig(root, { workspace: { repos } }, { dryRun: true });
  const warnings: string[] = [];
  for (const name of Object.keys(repos)) repos[name] = await detectedWorkspaceMember(repos[name], root, preflight.docs.root, warnings);
  const configPath = harnessPath(root, 'harness.json'), pendingPath = harnessPath(root, 'harness-workspace-init.json');
  const old = await readText(configPath), pending = await readJson<{ repos: Record<string, WorkspaceMember> } | undefined>(pendingPath, undefined);
  const candidate = old ? JSON.parse(old) : { workspace: { repos } };
  const comparable = (value: unknown) => JSON.stringify(value, (key, entry) => key === 'auto' && entry ? { ...entry, at: undefined } : entry);
  if (old && (!pending || comparable(pending.repos) !== comparable(repos)
    || comparable(candidate.workspace?.repos) !== comparable(repos))) throw new Error('이미 하네스가 설치된 폴더입니다');
  const config = await loadConfig(root, candidate, { dryRun: true });
  const members = await workspaceMembers(root, config);
  for (const member of members) await checkWorkspaceMember(root, member);
  let identity: { name: string; email: string } | undefined;
  if (options.identity !== undefined) {
    const match = /^([^<>\r\n]+) <([^<>\s]+)>$/u.exec(options.identity);
    if (!match) throw new Error("--identity 는 '이름 <메일>' 형식이어야 합니다");
    identity = { name: match[1].trim(), email: match[2] };
  }
  const createdMarkers: string[] = [];
  const { initProject } = await import('../cli/init.ts');
  try {
    const result = await initProject({ cwd: root, dryRun: options.dryRun, workspaceInit: { repos,
      afterConfig: async () => { await atomicWrite(pendingPath, JSON.stringify({ repos }) + '\n'); },
      beforeCommit: async willCommit => {
        for (const member of members) {
          const common = join(member.path, '.git');
          if (await readMarker(common) === undefined) { await writeMarker(common, root); createdMarkers.push(common); }
        }
        if (!willCommit) return undefined;
        let selected = await localIdentity(root);
        if (!selected) {
          selected = identity;
          if (!selected) {
            const identities = await Promise.all(members.map(member => localIdentity(member.path)));
            if (identities[0] && identities.every(value => JSON.stringify(value) === JSON.stringify(identities[0]))) selected = identities[0];
          }
          if (selected) {
            await workspaceGit(root, ['config', '--local', 'user.name', selected.name]);
            await workspaceGit(root, ['config', '--local', 'user.email', selected.email]);
          }
        }
        return selected ? undefined : "저장소 명의를 정할 수 없어 첫 커밋을 건너뛰었습니다 — fodh workspace init … --identity '이름 <메일>' 로 다시";
      } } });
    if (!options.dryRun) {
      if (result.skipped.some(item => item.path === 'commit' && item.reason.startsWith('첫 커밋 실패'))) {
        for (const common of createdMarkers) await removeMarker(common);
      } else if (result.committed || result.skipped.some(item => item.reason.startsWith('커밋이 있는 저장소'))) await unlink(pendingPath);
    }
    if (warnings.length) result.warnings = [...(result.warnings ?? []), ...warnings];
    return result;
  } catch (error) {
    for (const common of createdMarkers) await removeMarker(common);
    throw error;
  }
}
async function approveMembership(root: string, approve?: boolean) {
  if (process.env.FODH_CODEX_CHILD) throw new Error('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  await assertNotBrain(root, 'workspace add/remove');
  if (!approve) throw new Error('승인 전용 명령입니다. --approve 를 붙여 사용자 터미널에서 실행하세요');
}
export async function addWorkspaceMember(root: string, name: string, path: string, options: { approve?: boolean } = {}) {
  await approveMembership(root, options.approve);
  const configPath = harnessPath(root, 'harness.json');
  // Preflight before even creating the config lock file.
  async function prepare() {
    const raw = await readJson<HarnessConfig>(configPath, {} as HarnessConfig);
    if (!raw.workspace) throw new Error('워크스페이스 설정이 필요합니다');
    if (Object.hasOwn(raw.workspace.repos, name)) throw new Error('이미 등록된 멤버입니다');
    const candidate = { ...raw, workspace: { repos: { ...raw.workspace.repos, [name]: defaultWorkspaceMember(name, path) } } };
    const config = await loadConfig(root, candidate, { dryRun: true });
    const member = (await workspaceMembers(root, config)).find(item => item.name === name)!;
    await checkWorkspaceMember(root, member);
    const warnings: string[] = [];
    candidate.workspace.repos[name] = await detectedWorkspaceMember(candidate.workspace.repos[name], root, config.docs.root, warnings);
    return { candidate, member, warnings };
  }
  await prepare();
  return withFileLock(configPath, async () => {
    const { candidate, member, warnings } = await prepare(), before = await readText(configPath);
    await atomicWrite(configPath, JSON.stringify(candidate, null, 2) + '\n');
    try { await writeMarker(join(member.path, '.git'), root); }
    catch (error) { await atomicWrite(configPath, before); throw error; }
    return { name, path: member.path, ...(warnings.length ? { warnings } : {}) };
  });
}
export async function removeWorkspaceMember(root: string, name: string, options: { approve?: boolean } = {}) {
  await approveMembership(root, options.approve);
  const configPath = harnessPath(root, 'harness.json');
  return withFileLock(configPath, async () => {
    const raw = await readJson<HarnessConfig>(configPath, {} as HarnessConfig);
    if (!raw.workspace?.repos || !Object.hasOwn(raw.workspace.repos, name)) throw new Error('등록되지 않은 멤버입니다');
    if (Object.keys(raw.workspace.repos).length <= 1) throw new Error('workspace.repos 멤버 수는 1~8개여야 합니다');
    const { readBacklog } = await import('./backlog.ts');
    // Recovery must not resolve missing members, including other members still awaiting removal.
    const tasks = (await readBacklog(root, { workspace: raw.workspace })).tasks, state = await readState(root);
    const path = resolve(root, raw.workspace.repos[name].path);
    const memberExists = await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (tasks.some(task => task.repo === name && task.status !== 'done')) throw new Error('멤버에 미완 task가 있습니다');
    if (memberExists && state.worktrees?.some(wt => wt.repo === name || tasks.some(task => task.id === wt.taskId && task.repo === name))) throw new Error('멤버 워크트리가 남아 있습니다');
    const candidate = structuredClone(raw); delete candidate.workspace!.repos[name];
    const common = join(path, '.git');
    const hasGitDirectory = await lstat(common).then(entry => entry.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error; });
    const marker = hasGitDirectory ? await readMarker(common) : undefined;
    if (marker !== undefined && marker !== await realpath(root)) throw new Error('다른 워크스페이스 표지는 지울 수 없습니다');
    const before = await readText(configPath);
    await atomicWrite(configPath, JSON.stringify(candidate, null, 2) + '\n');
    try { if (marker !== undefined) await removeMarker(common); }
    catch (error) { await atomicWrite(configPath, before); throw error; }
    return { name, removed: true };
  });
}
export async function listWorkspace(root: string, config?: HarnessConfig) {
  config ??= await loadConfig(root, undefined, { dryRun: true });
  if (!config.workspace) throw new Error('워크스페이스 설정이 필요합니다');
  return Promise.all((await workspaceMembers(root, config)).map(async member => {
    const common = join(member.path, '.git'), marker = await readMarker(common);
    const branch = await workspaceGit(member.path, ['branch', '--show-current']);
    const dirty = await workspaceGit(member.path, ['status', '--porcelain', '--untracked-files=no', '-z']);
    const owner = await ownerAt(harnessPath(member.path, 'harness.lock'));
    const oldExists = await lstat(harnessPath(member.path, 'harness-state.json')).then(() => true, () => false)
      || await lstat(harnessPath(member.path, 'harness.json')).then(() => true, () => false) || !!owner;
    // Rename records have a second NUL-delimited path, not a second dirty file.
    const records = dirty.split('\0'); let trackedDirty = 0;
    for (let i = 0; i < records.length; i++) if (records[i]) { trackedDirty++; if (/^[ MARCUD?!]{0,1}[RC]|^[RC]/u.test(records[i])) i++; }
    return { name: member.name, path: member.path, marker: marker === undefined ? 'missing' : marker === await realpath(root) && (await validateMarker(common)).ok ? 'ok' : 'mismatch',
      branch, baseBranch: member.baseBranch, onBase: branch === member.baseBranch, trackedDirty,
      oldHarness: oldExists ? { state: (await readState(member.path)).state, lockAlive: !!owner && await lockOwnerAlive(owner) } : 'none' as const };
  }));
}
