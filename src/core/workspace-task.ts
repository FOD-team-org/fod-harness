import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getTask, type Task } from './backlog.ts';
import { type HarnessConfig } from './config.ts';
import { repoOf, type ResolvedWorkspaceMember } from './workspace.ts';
import type { HarnessState } from './state.ts';
import { harnessPath, readJson } from './storage.ts';
import { appendLedger } from './ledger.ts';
import { redact } from '../provider/privacy.ts';

const execute = promisify(execFile);
export async function taskGit(path: string, args: string[]): Promise<string> {
  try { return (await execute('git', ['-C', path, ...args], { timeout: 60000 })).stdout; }
  catch (error) { throw new Error(redact((error as { stderr?: string }).stderr || 'git worktree 실행 실패')); }
}
export type WorktreeRecord = NonNullable<HarnessState['worktrees']>[number];
const missingRepo = (id: string) => new Error(`task ${id}에 레포가 없습니다: fodh backlog set ${id} --repo <이름>`);
export async function taskMember(root: string, config: HarnessConfig, task: Pick<Task, 'id' | 'repo'>): Promise<ResolvedWorkspaceMember> {
  if (config.workspace && !task.repo) throw missingRepo(task.id);
  return repoOf(root, config, task);
}
// Give execution callers the W2 diagnostic even for legacy JSON rejected by W1's reader.
export async function executionTask(root: string, id: string, config: HarnessConfig): Promise<Task> {
  if (config.workspace) {
    const stored = await readJson<{ tasks: Task[] }>(harnessPath(root, 'harness-backlog.json'), { tasks: [] });
    const task = stored.tasks.find(task => task.id === id);
    if (task && !task.repo) throw missingRepo(id);
  }
  return getTask(root, id);
}
export async function recordMember(root: string, config: HarnessConfig, record: WorktreeRecord): Promise<ResolvedWorkspaceMember> {
  if (config.workspace && !record.repo) throw new Error(`task ${record.taskId} 워크트리 기록에 레포가 없습니다`);
  return repoOf(root, config, record);
}
export function assertRecordRepo(config: HarnessConfig, task: Task, record?: WorktreeRecord) {
  if (config.workspace && record && record.repo !== task.repo) {
    throw new Error(`task ${task.id} 워크트리 기록의 레포(${record.repo ?? '없음'})가 task 레포(${task.repo})와 다릅니다`);
  }
}
export const repoEvidence = (config: HarnessConfig, member: ResolvedWorkspaceMember): { repo?: string } => config.workspace ? { repo: member.name } : {};
export async function baseTip(member: ResolvedWorkspaceMember): Promise<string> {
  try { return (await taskGit(member.path, ['rev-parse', '--verify', `refs/heads/${member.baseBranch}^{commit}`])).trim(); }
  catch { throw new Error(`멤버 ${member.name} 기준 브랜치(${member.baseBranch}) 끝을 읽을 수 없습니다`); }
}
export async function isAncestor(path: string, base: string, tip: string): Promise<boolean> {
  try { await taskGit(path, ['merge-base', '--is-ancestor', base, tip]); return true; }
  catch { return false; }
}
// Inspect supplied configuration without resolving every member first: a vanished path is a warning.
export async function workspaceBranchWarnings(root: string, config: HarnessConfig): Promise<string[]> {
  if (!config.workspace) return [];
  const warnings: string[] = [];
  for (const [repo, member] of Object.entries(config.workspace.repos)) {
    let branch: string | null = null, warning: string;
    try {
      branch = (await taskGit(resolve(root, member.path), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (branch === (member.baseBranch ?? 'main')) continue;
      if (branch === 'HEAD') branch = 'detached';
      warning = `멤버 ${repo} 체크아웃이 ${member.baseBranch ?? 'main'}가 아닙니다(현재 ${branch}) — 이 체크아웃을 읽는 다른 레포 검증이 틀릴 수 있습니다`;
    } catch { warning = `멤버 ${repo} 브랜치를 읽을 수 없습니다`; }
    warnings.push(warning);
    await appendLedger(root, { runId: randomUUID(), action: 'workspace:base-branch', status: 'warn', evidence: { repo, branch } });
  }
  return warnings;
}
