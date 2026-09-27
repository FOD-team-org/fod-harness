import { homedir } from 'node:os';
import { taskMember, executionTask, assertRecordRepo } from './workspace-task.ts';
import { repoOf, type ResolvedWorkspaceMember } from './workspace.ts';
import { codexOwnership } from './process-identity.ts';
import { reclaimCodexOwner } from './codex-reclaim.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type HarnessConfig } from './config.ts';
import { setTask } from './backlog.ts';
import { readState, updateState } from './state.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { appendLedger } from './ledger.ts';
import { listProcs, registerProc } from './procs.ts';
import { processStartedAt } from './process-time.ts';
import { acquireSlot, updateSlot, releaseSlot, slotOwnerAlive, slotsStatus } from './slots.ts';
import { childEnv, commandParts } from '../provider/runner.ts';
import { redact } from '../provider/privacy.ts';
import { resultDir, metaPath, readMeta, writeMeta, result, finishRun, requestCancel, type CodexKind, type CodexMeta } from './codex-record.ts';
export { result, readMeta, resultDir } from './codex-record.ts';
export class CodexError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) { super(message); this.details = details; }
}
const pkg = fileURLToPath(new URL('../../', import.meta.url));
export const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export interface StartOptions { repo?: string; spec: string; taskId?: string; resume?: string; wait?: boolean; cwd?: string; title?: string }
export function codexArgs(config: HarnessConfig['delegate']['codex'], input: { sandbox: string; cwd: string; resultDir: string; resume?: string }): string[] {
  return [...commandParts(config.command), 'exec', ...(input.resume
    ? ['resume', input.resume, '-c', `sandbox_mode=${JSON.stringify(input.sandbox)}`]
    : ['-s', input.sandbox, '-C', input.cwd]), '--skip-git-repo-check', '-m', config.brainModel,
  '-c', `model_reasoning_effort=${config.brainEffort}`, '--json', '-o', join(input.resultDir, 'last-message.md'), '-'];
}
export async function buildHeader(meta: Pick<CodexMeta, 'kind' | 'runId' | 'taskId' | 'cwd' | 'sandbox' | 'workerModel' | 'workerEffort'>, maxChildAgents: number, spec: string, member?: ResolvedWorkspaceMember): Promise<string> {
  const home = homedir(), memberPath = member?.path === home ? '~' : member?.path.startsWith(home + sep) ? '~' + member.path.slice(home.length) : member?.path;
  const values: Record<string, string> = { ...meta, taskId: meta.taskId ?? '없음', maxChildAgents: String(maxChildAgents), spec,
    readOnly: meta.sandbox === 'read-only' ? ' — 파일을 쓸 수 없다. 결과는 마지막 메시지에 전부 적는다.' : '',
    kindFormat: meta.kind === 'review' ? ' review 는 `## 판정` (`APPROVE|REQUEST_CHANGES`) + 높음/중간/낮음 표(파일:줄·재현·수정안).'
      : meta.kind === 'research' ? ' research 는 `## 조사 결과` + 출처 목록.' : '' };
  const header = (await readFile(join(pkg, 'templates/codex-header.md'), 'utf8')).replace(/\{\{(\w+)\}\}/gu, (_, key: string) => values[key] ?? '');
  return member && meta.kind === 'task' ? header.replace(/^(- 작업 폴더:.*)$/mu, line => `${line}\n- 대상 레포: ${member.name} (${memberPath}) — 다른 멤버 레포는 읽기만 한다. 그 레포의 AGENTS.md 규칙을 따른다.`) : header;
}
async function assertCodexMemory(root: string) {
  const state = await readState(root);
  const watch = await readJson<{ watch?: { memory?: { critical?: boolean } } }>(harnessPath(root, 'harness-watcher.json'), {});
  if (watch.watch?.memory?.critical === true) throw new Error('메모리 임계 상태입니다');
  if (state.state === 'paused(memory)' || state.lastPaused === 'memory') throw new Error('메모리 회복 전에는 위임을 시작할 수 없습니다');
}
export async function startCodex(root: string, kind: CodexKind, options: StartOptions, launcher: { bin?: string; timeoutMs?: number } = {}) {
  root = await realpath(root);
  const started = await withFileLock(harnessPath(root, 'harness-delegation'), async () => {
    const state = await readState(root), config = await loadConfig(root), cfg = config.delegate.codex;
    if (options.repo !== undefined) {
      if (kind !== 'research') throw new Error('--repo 는 codex research 에서만 씁니다');
      if (!config.workspace) throw new Error('--repo 는 워크스페이스 모드에서만 씁니다');
      if (options.cwd !== undefined) throw new Error('--repo 와 --cwd 는 함께 쓸 수 없습니다');
    }
    const researchMember = options.repo !== undefined ? await repoOf(root, config, { repo: options.repo }) : undefined;
    await assertCodexMemory(root);
    if (kind === 'task' && !options.taskId || options.taskId !== undefined && !/^T\d+$/u.test(options.taskId)) throw new Error('--task T번호가 필요합니다');
    if (kind === 'review' && state.state !== 'REVIEW' || kind === 'research' && !['RESEARCH', 'ARCH', 'PLANNING', 'SPEC', 'REVIEW'].includes(state.state)) throw new Error(`현재 상태에서는 codex ${kind} 를 시작할 수 없습니다`);
    const task = options.taskId ? await executionTask(root, options.taskId, config) : undefined;
    if (kind === 'task' && (!['IMPLEMENT', 'FIX'].includes(state.state) || state.taskId !== options.taskId)) throw new Error('현재 상태에서는 codex task 를 시작할 수 없습니다');
    if (kind === 'task' && task?.status === 'done') throw new Error('완료된 task는 위임할 수 없습니다');
    if (state.delegation) {
      const previous = await readMeta(root, state.delegation.runId);
      if (!previous) await appendLedger(root, { runId: state.delegation.runId, action: 'delegation:stale', status: 'ok', evidence: { runId: state.delegation.runId } });
      if (previous && !previous.finishedAt) throw new Error(`이미 위임이 진행 중입니다: ${state.delegation.runId}`);
    }
    if (!options.spec || isAbsolute(options.spec) || !inside(root, resolve(root, options.spec))) throw new Error('--spec은 프로젝트 내부 상대 경로여야 합니다');
    const specPath = await realpath(resolve(root, options.spec));
    if (!inside(root, specPath)) throw new Error('--spec은 프로젝트 내부 상대 경로여야 합니다');
    const spec = await readFile(specPath, 'utf8');
    const member = task ? await taskMember(root, config, task) : undefined;
    if (task) assertRecordRepo(config, task, state.worktrees?.find(item => item.taskId === task.id));
    const gitTask = kind === 'task' && await lstat(join(member!.path, '.git')).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    const needsWorktree = config.workspace ? `워크스페이스 모드 task ${task?.id}에 워크트리가 없습니다 — fodh worktree create ${task?.id} 먼저` : 'IMPLEMENT 는 워크트리가 필요합니다: fodh worktree create <task>';
    const worktree = kind === 'task' && task?.worktree ? await realpath(resolve(root, task.worktree)).catch(error => {
      if (gitTask && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(needsWorktree);
      throw error;
    }) : null;
    const registered = await Promise.all((state.worktrees ?? []).map(async item => realpath(resolve(root, item.path)).catch(() => '')));
    if (gitTask && (!worktree || !(state.worktrees ?? []).some((item, index) => item.taskId === task!.id && registered[index] === worktree))) {
      throw new Error(needsWorktree);
    }
    const cwd = await realpath(options.cwd ? resolve(root, options.cwd) : researchMember?.path ?? worktree ?? root);
    if (gitTask && !inside(worktree!, cwd)) throw new Error('--cwd는 해당 task의 등록된 워크트리 안이어야 합니다');
    if (!researchMember && !inside(root, cwd) && !registered.some(path => path && inside(path, cwd))) throw new Error('--cwd는 프로젝트 또는 등록된 워크트리 안이어야 합니다');
    if (!(await stat(cwd)).isDirectory()) throw new Error('--cwd는 디렉터리여야 합니다');
    const resume = options.resume === 'last' ? task?.codexThread : options.resume;
    if (options.resume === 'last' && !resume) throw new Error('재개할 task.codexThread가 없습니다');
    if (resume !== undefined && (!resume.trim() || resume.startsWith('-') || /[\r\n\0]/u.test(resume))) throw new Error('재개 threadId가 올바르지 않습니다');
    const runId = randomUUID(), startedAt = new Date().toISOString(), dir = resultDir(root, runId);
    const sandbox = kind === 'task' ? cfg.sandbox : 'read-only';
    const command = codexArgs(cfg, { sandbox, cwd, resultDir: dir, resume });
    const meta: CodexMeta = { runId, kind, taskId: task?.id, title: options.title, cwd, sandbox, command, resume,
      model: cfg.brainModel, effort: cfg.brainEffort, workerModel: cfg.workerModel, workerEffort: cfg.workerEffort,
      startedAt, timeoutMinutes: cfg.timeoutMinutes, status: 'running', state: state.state, worktree,
      routeHint: task ? config.delegate.route[task.category] ?? config.delegate.route.default : undefined };
    const prompt = await buildHeader(meta, cfg.maxChildAgents, spec, config.workspace && kind === 'task' ? member : undefined);
    await assertCodexMemory(root);
    const acquired = await acquireSlot('codex', { root, runId, taskId: task?.id, pid: process.pid,
      startedAt: await processStartedAt(process.pid) ?? `spawn:${startedAt}`, acquiredAt: startedAt });
    if (!acquired.acquired) {
      await updateState(root, { awaitingSlot: { kind: 'codex', owner: acquired.owner, since: startedAt },
        delegation: undefined, awaitingDelegation: false });
      throw new CodexError('codex 슬롯 사용 중', { owner: acquired.owner, wait: 'slot' });
    }
    let pid: number | undefined;
    try {
      if (kind === 'task' && worktree) await (await import('./worktree.ts')).prepareWorktree(root, task!.id);
      await assertCodexMemory(root);
      await updateState(root, { awaitingSlot: undefined });
      await atomicWrite(join(dir, 'prompt.md'), prompt);
      for (const name of ['events.jsonl', 'stderr.txt']) await atomicWrite(join(dir, name), '');
      await writeMeta(root, meta);
      await appendLedger(root, { runId, taskId: task?.id, state: state.state, action: `codex:${kind}`, status: 'pre',
        evidence: { cwd, sandbox, model: meta.model, effort: meta.effort, spec: options.spec, resume, title: options.title,
          ...(kind === 'task' && !worktree ? { fallback: 'root' } : {}) } });
      const log = await open(join(dir, 'supervisor.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [launcher.bin ?? join(pkg, 'bin/fodh-codex-supervisor'), root, runId, '--launch'], {
          detached: true, stdio: ['ignore', 'pipe', log.fd], cwd: root,
          env: { ...childEnv(), FODH_PROJECT_ROOT: root, FODH_RUN_ID: runId },
        });
        let output = '';
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', chunk => { output = (output + chunk).slice(0, 4096); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const code = await new Promise<number | null>((ok, fail) => {
          child.once('close', ok); child.once('error', fail);
          timer = setTimeout(() => {
            try {
              const reported = JSON.parse(output.trim());
              if (Number.isSafeInteger(reported.pid) && reported.pid > 1 && reported.pid !== process.pid) pid = reported.pid;
            } catch { /* A launcher without a complete pid response has no known supervisor. */ }
            if (child.pid && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
            fail(new Error('감독 런처 종료 대기 시간 초과'));
          }, launcher.timeoutMs ?? 15000);
        }).finally(() => clearTimeout(timer));
        const launched = code === 0 ? JSON.parse(output.trim() || '{}') : {};
        if (!Number.isSafeInteger(launched.pid) || launched.pid <= 1) throw new Error('감독 런처가 pid를 반환하지 않았습니다');
        pid = launched.pid;
      } finally { await log.close(); }
      if (!pid) throw new Error('감독 pid가 없습니다');
      const identity = await processStartedAt(pid) ?? `spawn:${new Date().toISOString()}`;
      await registerProc(root, { pid, pgid: pid, startedAt: identity, runId, kind: 'codex', taskId: task?.id, protectedUntil: new Date(Date.now() + 60000).toISOString(), cmd: `fodh-codex-supervisor ${runId}` });
      await updateSlot(root, 'codex', runId, { pid, startedAt: identity });
      await withFileLock(metaPath(root, runId), async () => {
        const current = await readMeta(root, runId);
        if (!current || current.finishedAt) throw new Error('감독 초기화 전에 실행이 마감되었습니다');
        await writeMeta(root, { ...current, pid, processStartedAt: identity });
      });
      if (kind === 'task') await setTask(root, task!.id, { delegate: 'codex' });
      await updateState(root, { delegation: { runId, kind, taskId: task?.id, title: options.title, startedAt }, awaitingDelegation: false });
      return { runId, kind, taskId: task?.id, cwd, sandbox, pid, resultDir: dir, worktree, routeHint: meta.routeHint, wait: false, timeoutMinutes: cfg.timeoutMinutes };
    } catch (error) {
      // Supervisor is still waiting on our start lock; it cannot have spawned Codex yet.
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
      if (await readMeta(root, runId)) await finishRun(root, runId, { status: 'fail', exit: null, error: redact((error as Error).message) });
      else await releaseSlot(root, 'codex', runId);
      throw error;
    }
  });
  process.stderr.write(JSON.stringify({ runId: started.runId }) + '\n');
  if (options.wait) return waitForResult(root, started.runId, started.timeoutMinutes);
  const { timeoutMinutes: _timeout, ...output } = started;
  return output;
}
export function waitLimitMinutes(timeoutMinutes: number, maxTurnMinutes: number, waitMinutes = 8, env: NodeJS.ProcessEnv = process.env): number {
  const bashMs = Number(env.BASH_DEFAULT_TIMEOUT_MS);
  const bashLimit = Number.isFinite(bashMs) && bashMs > 0 ? bashMs * 0.9 / 60000 : Infinity;
  return Math.min(timeoutMinutes + 1, Math.max(1, maxTurnMinutes - 5), waitMinutes, bashLimit);
}
export async function waitForResult(root: string, runId: string, timeoutMinutes: number) {
  const config = await loadConfig(root);
  const deadline = Date.now() + waitLimitMinutes(timeoutMinutes, config.brain.maxTurnMinutes, config.delegate.codex.waitMinutes) * 60000;
  do {
    if ((await readMeta(root, runId))?.finishedAt) {
      await updateState(root, current => current.delegation?.runId === runId ? { delegation: undefined, awaitingDelegation: false, autoTurns: 0 } : {});
      return result(root, runId);
    }
    await delay(2000);
  } while (Date.now() < deadline);
  throw new CodexError('위임이 아직 진행 중입니다', { runId });
}
export async function status(root: string, runId?: string) {
  if (runId) {
    const meta = await readMeta(root, runId);
    if (!meta) throw new Error(`위임 실행을 찾을 수 없습니다: ${runId}`);
    const record = (await listProcs(root)).find(proc => proc.runId === runId && proc.kind === 'codex');
    return { ...meta, alive: record ? await slotOwnerAlive({ ...record, root, childPid: meta.childPid, childStartedAt: meta.childStartedAt }) : false };
  }
  const state = await readState(root);
  return { delegation: state.delegation ?? null, meta: state.delegation ? await readMeta(root, state.delegation.runId) : null, slots: await slotsStatus(root) };
}
export async function cancel(root: string, runId: string) {
  if (/^external-\d+$/u.test(runId)) throw new Error('외부 Codex 소유자는 취소 대상이 아닙니다');
  return withFileLock(harnessPath(root, 'harness-delegation'), async () => {
    const meta = await readMeta(root, runId);
    if (!meta) {
      const state = await readState(root);
      if (state.delegation?.runId !== runId) throw new Error(`위임 실행을 찾을 수 없습니다: ${runId}`);
      await updateState(root, current => current.delegation?.runId === runId ? { delegation: undefined, awaitingDelegation: false } : {});
      return { runId, cancelled: true, meta: null };
    }
    if (!meta.finishedAt) {
      const record = (await listProcs(root)).find(proc => proc.runId === runId && proc.kind === 'codex');
      const owner = record ?? (meta.pid ? { pid: meta.pid, pgid: meta.pid, startedAt: meta.processStartedAt } : undefined);
      if (owner && await codexOwnership(owner) === 'owned') {
        await requestCancel(root, runId, 'cancel');
        try { process.kill(owner.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !(await readMeta(root, runId))?.finishedAt) await delay(100);
      }
      const latest = await readMeta(root, runId);
      if (!latest?.finishedAt) {
      const reclaimed = owner ? await reclaimCodexOwner({ ...owner, childPid: meta.childPid, childStartedAt: meta.childStartedAt, toolGroups: meta.toolGroups }, { root, runId }, { by: 'cancel' }) : undefined;
      if (reclaimed && !reclaimed.reclaimed) throw new Error('감독 프로세스 트리 회수 실패');
      await finishRun(root, runId, { status: reclaimed?.owner === 'unverified' ? 'lost' : 'cancelled', exit: null, reason: reclaimed?.reason });
      }
    }
    await updateState(root, current => current.delegation?.runId === runId ? { delegation: undefined, awaitingDelegation: false } : {});
    return result(root, runId);
  });
}
