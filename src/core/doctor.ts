import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeHookStatus } from './claude-settings.ts';
import { join, relative } from 'node:path';
import { secretPolicy, scanSecretFiles } from '../../hooks/secret-paths.mjs';
import { loadConfig } from './config.ts';
const execute = promisify(execFile);
export async function doctorFiles(root: string, ignored: (files: string[]) => Promise<string[]> = async files => {
  // stdin contains names only, never contents. Batch to avoid a process per file.
  if (!files.length || !existsSync(join(root, '.git'))) return [];
  try {
    const pending = execute('git', ['-C', root, 'check-ignore', '--stdin', '-z'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    pending.child.stdin?.end(files.join('\0') + '\0');
    return (await pending).stdout.split('\0').filter(Boolean);
  }
  catch (error) { return (error as { stdout?: string }).stdout?.split('\0').filter(Boolean) ?? []; }
}) {
  const config = await loadConfig(root), policy = secretPolicy(root, config.secrets);
  const scanned = scanSecretFiles(root, policy, { depth: 6, limit: 20000 });
  const files = scanned.files.map(path => relative(root, path));
  const excluded = new Set(await ignored(files));
  return { ...await claudeHookStatus(root), secretsNotIgnored: files.filter(path => !excluded.has(path)), secretsScanLimited: scanned.exceeded };
}

export interface WorkspaceDoctorCheck { member?: string; check: string; level: 'error' | 'warning' | 'ok'; message: string }
export async function doctorWorkspace(root: string) {
  const { listWorkspace, workspaceMembers, workspaceGit } = await import('./workspace.ts');
  const { readState } = await import('./state.ts');
  const { readJson, harnessPath } = await import('./storage.ts');
  const raw = await readJson<{ workspace?: unknown }>(harnessPath(root, 'harness.json'), {});
  if (raw.workspace === undefined) return undefined;
  const checks: WorkspaceDoctorCheck[] = [];
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try { config = await loadConfig(root, raw, { dryRun: true }); }
  catch (error) { return { ok: false, checks: [{ check: 'config', level: 'error' as const, message: (error as Error).message }] }; }
  const state = await readState(root);
  for (const member of await workspaceMembers(root, config)) {
    const add = (check: string, level: WorkspaceDoctorCheck['level'], message: string) => checks.push({ member: member.name, check, level, message });
    add('path', 'ok', '멤버 경로와 .git 디렉터리 확인');
    add('verify', 'ok', 'verify.commands 확인');
    if (member.verify.commands.length === 1 && member.verify.commands[0] === 'git diff --check') {
      add('verify-default', 'warning', `멤버 ${member.name} 검증 명령이 기본값뿐입니다 — harness.json 의 workspace.repos.${member.name}.verify.commands 를 채우세요`);
    }
    try {
      const [status] = await listWorkspace(root, { ...config, workspace: { repos: { [member.name]: config.workspace!.repos[member.name] } } });
      add('marker', status.marker === 'ok' ? 'ok' : 'error', `표지 ${status.marker}`);
      add('old-lock', typeof status.oldHarness === 'object' && status.oldHarness.lockAlive ? 'error' : 'ok', '옛 하네스 잠금 확인');
      if (!status.onBase) add('branch', 'warning', `현재 브랜치가 baseBranch(${member.baseBranch})와 다릅니다`);
      if (status.trackedDirty) add('tracked-dirty', 'warning', `추적 파일 미커밋 ${status.trackedDirty}개`);
    } catch { add('member-status', 'error', '멤버 상태를 확인할 수 없습니다'); }
    try {
      await workspaceGit(member.path, ['rev-parse', '--verify', `refs/heads/${member.baseBranch}`]);
      add('baseBranch', 'ok', 'baseBranch 확인');
      const branches = (await workspaceGit(member.path, ['branch', '--format=%(refname:short)', '--no-merged', member.baseBranch!, '--list', `${member.worktrees.prefix}*`])).split('\n').filter(Boolean);
      const unregistered = branches.filter(branch => !state.worktrees?.some(wt => wt.repo === member.name && wt.branch === branch));
      if (unregistered.length) add('unregistered-branches', 'warning', `병합 안 된 미등록 prefix 브랜치: ${unregistered.join(', ')}`);
    } catch { add('baseBranch', 'error', `baseBranch ${member.baseBranch}가 없습니다`); }
  }
  return { ok: !checks.some(check => check.level === 'error'), checks };
}
