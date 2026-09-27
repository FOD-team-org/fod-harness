import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { groupAlive } from '../provider/runner.ts';
import { redact } from '../provider/privacy.ts';
import { DetectGitError, DetectUnreadableError, harnessGit, detectVerify, verifySkipDirs, type DetectedVerify } from './verify-detect.ts';
import { assertNotBrain } from './brain-guard.ts';
import { notify } from './notify.ts';
import { generateClaudeMd } from './claude-md.ts';
import { repoOf } from './workspace.ts';
import { loadConfig, writeAutoVerify, userSetVerify, verifyHash, verifyUserSetError } from './config.ts';
import { readState, updateState } from './state.ts';
import { taskMember, executionTask, assertRecordRepo, repoEvidence, workspaceBranchWarnings } from './workspace-task.ts';
import { acquireSlot, releaseSlot, updateSlot } from './slots.ts';
import { inside } from './codex.ts';
import { registerProc, removeProc } from './procs.ts';
import { processStartedAt } from './process-time.ts';
import { reclaimCodexTree } from './proc-tree.ts';
import { parseGroupRssMB } from './codex-supervisor.ts';
import { sampleMemory } from './memory.ts';
import { appendLedger } from './ledger.ts';
import { harnessPath, atomicWrite } from './storage.ts';
const statusArgs = ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'];
async function dirtyPaths(cwd: string): Promise<string[]> {
  const stdout = (await harnessGit(cwd, [...statusArgs, '-z'])).toString('utf8');
  const entries = stdout.split('\0'), paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    paths.push(entry.slice(3));
    if (/[RC]/u.test(entry.slice(0, 2))) i++;
  }
  return paths;
}
async function gitSnapshot(cwd: string, registeredRoot?: string, mainPath?: string): Promise<{ head: string | null; clean: boolean | null }> {
  const git = async (...args: string[]) => (await harnessGit(cwd, args)).toString('utf8').trim();
  let repository = false;
  try { repository = await git('rev-parse', '--is-inside-work-tree') === 'true'; }
  catch { /* Non-git projects have no commit evidence. Registered worktrees still require clean=true at the gate. */ }
  if (!repository) return { head: null, clean: null };
  if (registeredRoot || mainPath) {
    const top = await git('rev-parse', '--show-toplevel').then(realpath).catch(() => null);
    if (!top || registeredRoot && top !== registeredRoot || !mainPath) return { head: null, clean: null };
    try {
      const commonDir = async (path: string) => realpath(resolve(path,
        (await harnessGit(path, ['rev-parse', '--git-common-dir'])).toString('utf8').trim()));
      const common = await commonDir(mainPath);
      if (await commonDir(cwd) !== common) return { head: null, clean: null };
      const gitDir = await realpath(await git('rev-parse', '--absolute-git-dir'));
      if (top === await realpath(mainPath)) {
        if (gitDir !== common) return { head: null, clean: null };
      } else {
        if (!registeredRoot) return { head: null, clean: null };
        // Both the management directory and its backlink belong to the trusted common dir.
        if (gitDir !== await realpath(join(common, 'worktrees', basename(gitDir)))) return { head: null, clean: null };
        const backlink = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim();
        if (await realpath(resolve(gitDir, backlink)) !== await realpath(join(registeredRoot, '.git'))) return { head: null, clean: null };
      }
    } catch { return { head: null, clean: null }; }
  }
  const head = await git('rev-parse', 'HEAD').catch(() => null);
  try {
    if (await git(...statusArgs)) return { head, clean: false };
    // Scan the whole index, even when verification runs in a subdirectory.
    const top = await git('rev-parse', '--show-toplevel');
    const stdout = (await harnessGit(top, ['ls-files', '-v', '-z'])).toString('utf8');
    if (stdout.split('\0').some(entry => /^[a-zS] /u.test(entry))) return { head, clean: false };
    return { head, clean: true };
  } catch { return { head, clean: null }; }
}
export async function runVerify(root: string, options: { heavy?: boolean; cwd?: string } = {}) {
  const state = await readState(root), config = await loadConfig(root);
  if (!['VERIFY', 'FIX'].includes(state.state)) return { ok: false, error: 'VERIFY 또는 FIX 상태에서만 검증할 수 있습니다' };
  const runId = randomUUID(), startedAt = new Date().toISOString();
  root = await realpath(root);
  const task = state.taskId ? await executionTask(root, state.taskId, config) : undefined;
  if (config.workspace && !task) throw new Error('워크스페이스 검증에는 현재 task가 필요합니다');
  const member = await taskMember(root, config, task ?? { id: '' }), repo = repoEvidence(config, member);
  const record = state.worktrees?.find(item => item.taskId === state.taskId);
  assertRecordRepo(config, task!, record);
  if (config.workspace && !record) throw new Error(`워크스페이스 모드 task ${task!.id}에 워크트리가 없습니다 — fodh worktree create ${task!.id} 먼저`);
  const warnings = config.workspace ? await workspaceBranchWarnings(root, config) : [];
  const taskPath = state.worktrees?.find(item => item.taskId === state.taskId)?.path || task?.worktree || root;
  const cwd = await realpath(resolve(root, options.cwd ?? taskPath));
  const registered = await Promise.all((state.worktrees ?? []).map(w => realpath(w.path).catch(() => '')));
  if (config.workspace && !inside(await realpath(record!.path), cwd)) throw new Error('워크스페이스 모드 검증은 현재 task 워크트리 안에서만 합니다');
  if (!inside(root, cwd) && !registered.some(path => path && inside(path, cwd))) throw new Error('--cwd는 프로젝트 또는 등록된 워크트리 안이어야 합니다');
  if (!(await stat(cwd)).isDirectory()) throw new Error('--cwd는 디렉터리여야 합니다');
  if (options.heavy && !member.verify.heavy?.length) return { ok: false, skipped: 'heavy-empty',
    error: 'verify.heavy 가 비어 있어 heavy 검증을 건너뜁니다(상태 변경 없음)' };
  const autoPlaceholder = config.workspace && member.verify.auto
    && member.verify.commands.length === 1 && member.verify.commands[0] === 'git diff --check' && !userSetVerify(member.verify);
  const registeredCwd = registered.find(path => path && inside(path, cwd));
  let snapshot = await gitSnapshot(cwd, registeredCwd, member.path);
  let beforePaths = new Set(snapshot.head && snapshot.clean !== null ? await dirtyPaths(cwd) : []);
  async function finish<T extends { ok: boolean }>(report: T) {
    const dirtyAfter = snapshot.head && snapshot.clean !== null ? (await dirtyPaths(cwd)).filter(path => !beforePaths.has(path)) : [];
    const evidence = { ...snapshot, since: state.verifySince, ...(dirtyAfter.length ? { dirtyAfter } : {}) };
    const finishedAt = new Date().toISOString();
    const result = { ...report, runId, taskId: state.taskId, startedAt, finishedAt, heavy: !!options.heavy, cwd, ...evidence, ...(warnings.length ? { warnings } : {}) };
    await atomicWrite(harnessPath(root, `verify/${runId}/result.json`), `${JSON.stringify(result, null, 2)}\n`);
    await updateState(root, { verify: { runId, taskId: state.taskId, ok: report.ok, at: finishedAt, heavy: !!options.heavy, cwd, ...evidence } });
    return result;
  }
  if (!options.heavy && ((!config.workspace && !member.verify.commands.length) || autoPlaceholder)) {
    const base = await realpath(taskPath);
    const registeredBase = registered.find(path => path && inside(path, base));
    const baseSnapshot = base === cwd ? snapshot : await gitSnapshot(base, registeredBase, member.path);
    if (registeredBase && (!baseSnapshot.head || baseSnapshot.clean === null)) return finish({ ok: false, error: new DetectGitError().message });
    if (baseSnapshot.clean === false) return finish({ ok: false, error: autoVerifyDirtyError });
    let detected: DetectedVerify | undefined;
    try {
      detected = await detectVerify(base, { source: 'auto', registered: !!registeredBase, skipPrefixes: [member.worktrees.prefix],
        skipDirs: verifySkipDirs(base, config.docs.root, config.workspace ? root : undefined) });
    } catch (error) {
      if (error instanceof DetectUnreadableError || error instanceof DetectGitError) return finish({ ok: false, error: error.message });
      throw error;
    }
    if (!detected) return finish({ ok: false, error: noDetectedVerify });
    let written: Awaited<ReturnType<typeof writeAutoVerify>>;
    try { written = await writeAutoVerify(root, config.workspace ? `workspace.repos.${member.name}.verify` : 'verify', detected); }
    catch (error) { return finish({ ok: false, error: redact((error as Error).message) }); }
    member.verify = { ...member.verify, ...written };
    try { await recordAutoVerify(root, base, detected, written, { taskId: state.taskId, ...repo }); }
    catch (error) { console.error(`검증 명령 자동 설정 기록·알림 실패: ${redact((error as Error).message)}`); }
    // Keep execution evidence relative to the tree after automatic configuration/doc generation.
    snapshot = await gitSnapshot(cwd, registeredCwd, member.path);
    beforePaths = new Set(snapshot.head && snapshot.clean !== null ? await dirtyPaths(cwd) : []);
  } else if (!options.heavy && member.verify.auto?.hash === verifyHash(member.verify) && !autoPlaceholder) {
    const base = await realpath(taskPath);
    let detected: DetectedVerify | undefined;
    try {
      const registeredBase = registered.find(path => path && inside(path, base));
      const baseState = base === cwd ? snapshot : await gitSnapshot(base, registeredBase, member.path);
      if (registeredBase && (!baseState.head || baseState.clean === null)) throw new DetectGitError();
      if (baseState.clean === true || !registeredBase && baseState.head === null && baseState.clean === null) {
        detected = await detectVerify(base, { source: 'auto', registered: !!registeredBase, skipPrefixes: [member.worktrees.prefix],
          skipDirs: verifySkipDirs(base, config.docs.root, config.workspace ? root : undefined) });
      }
      const next = detected;
      const current = member.verify, compareHeavy = current.auto?.heavySource !== 'user';
      if (next && current.commands.every(cmd => next.commands.includes(cmd))
        && (!compareHeavy || (current.heavy ?? []).every(cmd => next.heavy.includes(cmd)))
        && (next.commands.some(cmd => !current.commands.includes(cmd))
          || compareHeavy && next.heavy.some(cmd => !(current.heavy ?? []).includes(cmd)))) {
        const written = await writeAutoVerify(root, config.workspace ? `workspace.repos.${member.name}.verify` : 'verify', next);
        member.verify = { ...member.verify, ...written };
        await recordAutoVerify(root, base, next, written, { taskId: state.taskId, ...repo, via: 'refresh' });
        snapshot = await gitSnapshot(cwd, registeredCwd, member.path);
        beforePaths = new Set(snapshot.head && snapshot.clean !== null ? await dirtyPaths(cwd) : []);
      }
    } catch (error) {
      await appendLedger(root, { runId, taskId: state.taskId, action: 'verify:auto-config', status: 'warn',
        evidence: { ...repo, base, via: 'refresh', warning: redact((error as Error).message) } });
    }
  }
  const commands = options.heavy ? member.verify.heavy ?? [] : member.verify.commands;
  if (!commands.length) return finish({ ok: false, error: noDetectedVerify });
  const ownerStartedAt = await processStartedAt(process.pid) ?? `spawn:${startedAt}`;
  if (options.heavy) {
    const acquired = await acquireSlot('heavy', { root, runId, taskId: state.taskId, pid: process.pid,
      startedAt: ownerStartedAt, acquiredAt: startedAt });
    if (!acquired.acquired) return finish({ ok: false, error: '위임 실행 중에는 무거운 검증을 시작할 수 없습니다', owner: acquired.owner });
  }
  const results: { cmd: string; exit: number | null; seconds: number; tailLog: string; timedOut: boolean; residual: boolean; interrupted?: 'signal' }[] = [];
  let peakRssMB = 0, ok = true;
  const before = await sampleMemory(config.cleanup.swapWarnGB);
  try {
    const dir = harnessPath(root, `verify/${runId}`); await mkdir(dir, { recursive: true });
    await appendLedger(root, { runId, taskId: state.taskId, action: 'verify:run', status: 'pre', evidence: { ...repo, heavy: !!options.heavy, cwd, ...snapshot } });
    for (const [index, cmd] of commands.entries()) {
      const file = await open(join(dir, `${index + 1}.log`), 'w+', 0o600);
      const start = Date.now(); let timedOut = false, residual = false, pid: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, rssTimer: ReturnType<typeof setInterval> | undefined;
      let stopping: Promise<boolean> | undefined, sampling: Promise<void> | undefined;
      const stop = () => stopping ??= reclaimCodexTree(pid!, [pid!]).catch(() => false);
      let interrupted: 'signal' | undefined;
      const onSignal = () => { interrupted = 'signal'; if (pid) void stop(); };
      process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
      let exit: number | null = null, failure = '';
      try {
        const child = spawn('/bin/sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', file.fd, file.fd] });
        const closed = new Promise<number | null>((done, fail) => { child.once('exit', (code, signal) => { if (!timedOut && (signal === 'SIGTERM' || signal === 'SIGINT')) interrupted = 'signal'; done(code); }); child.once('error', fail); });
        void closed.catch(() => undefined);
        pid = child.pid;
        if (pid) {
          timer = setTimeout(() => { timedOut = true; void stop(); }, (member.verify.timeoutMinutes ?? 30) * 60000);
          if (options.heavy) await updateSlot(root, 'heavy', runId, { childPid: pid, childStartedAt: await processStartedAt(pid) });
          await registerProc(root, { pid, pgid: pid, runId, kind: 'verify', ownerPid: process.pid, ownerStartedAt, taskId: state.taskId, cmd: redact(cmd).slice(0, 200),
            startedAt: await processStartedAt(pid) ?? `spawn:${new Date().toISOString()}` });
          const sample = () => sampling ??= (async () => {
            try {
              const pending = promisify(execFile)('/bin/ps', ['-o', 'pid=,rss=', '-g', String(pid)], { timeout: 1000 });
              const self = pending.child.pid;
              peakRssMB = Math.max(peakRssMB, parseGroupRssMB((await pending).stdout, [self]));
            } catch { /* best effort measurement */ }
          })().finally(() => { sampling = undefined; });
          rssTimer = setInterval(() => { void sample(); }, 30000); rssTimer.unref(); await sample();
        }
        // If process-table access fails, kill the detached group (pgid = shell pid).
        // Keep the conservative residual result from the tree reclamation attempt.
        if (pid) {
          const limit = new Promise<null>(done => {
            const poll = setInterval(() => {
              if (timedOut || interrupted) {
                clearInterval(poll);
                void stop().then(success => {
                  if (!success) {
                    try { process.kill(-pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
                  }
                  done(null);
                });
              }
            }, 25);
            void closed.finally(() => clearInterval(poll)).catch(() => undefined);
          });
          exit = await Promise.race([closed, limit]);
        } else exit = await closed;
        if (pid && (stopping || groupAlive(pid))) residual = !await stop();
      } catch (error) { failure = redact((error as Error).message).slice(0, 200); if (pid) residual = !await stop(); }
      finally {
        if (timer) clearTimeout(timer); if (rssTimer) clearInterval(rssTimer); await sampling;
        process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
        if (pid && !residual) await removeProc(root, pid, runId);
      }
      const length = (await file.stat()).size, tail = Buffer.alloc(Math.min(4096, length));
      await file.read(tail, 0, tail.length, Math.max(0, length - tail.length)); await file.close();
      results.push({ cmd: redact(cmd), exit, seconds: (Date.now() - start) / 1000, tailLog: redact(tail.toString('utf8') + failure), timedOut, residual, ...(interrupted ? { interrupted } : {}) });
      if (exit !== 0 || timedOut || interrupted || residual || failure) { ok = false; break; }
    }
    const after = await sampleMemory(config.cleanup.swapWarnGB);
    const report = { runId, commands: results, ...(results.some(r => r.interrupted) ? { interrupted: 'signal' as const } : {}), peakRssMB, swapBeforeGB: before?.swapUsedGB, swapAfterGB: after?.swapUsedGB, ok };
    await appendLedger(root, { runId, taskId: state.taskId, action: 'verify:run', status: ok ? 'ok' : 'fail', evidence: { ...repo, ...report } });
    return await finish(report);
  } finally { if (options.heavy) await releaseSlot(root, 'heavy', runId); }
}

export const autoVerifyDirtyError = '검증 명령 자동 설정은 커밋된 깨끗한 작업 트리에서만 합니다 — 먼저 fodh worktree commit 으로 커밋하세요';
export const noDetectedVerify = 'verify.commands 가 비어 있고 자동 감지된 스택이 없습니다(지원: flutter·dart·node·go·rust·swift·python·gradle) — 사용자가 harness.json verify.commands 를 설정해야 합니다';
async function recordAutoVerify(root: string, base: string, detected: DetectedVerify,
  written: { commands: string[]; heavy: string[] }, context: { taskId?: string; repo?: string; via?: 'detect' | 'refresh' } = {}) {
  const { taskId, ...extra } = context;
  await appendLedger(root, { runId: randomUUID(), taskId, action: 'verify:auto-config', status: 'ok',
    evidence: { base, stacks: detected.stacks, commands: written.commands.map(redact), heavy: written.heavy.map(redact), ...extra } });
  await notify(root, { key: 'verify:auto-config', level: 'info', title: '검증 명령 자동 설정',
    body: `${detected.stacks.map(s => s.stack).join(', ')} → ${written.commands.map(redact).join(' · ')}` });
  try { await generateClaudeMd(root); }
  catch { await appendLedger(root, { runId: randomUUID(), taskId, action: 'verify:auto-config', status: 'warn', evidence: { warning: 'CLAUDE.md 갱신 실패' } }); }
}
export async function detectVerifyConfig(root: string, options: { cwd?: string; apply?: boolean; approve?: boolean; repo?: string } = {}) {
  root = await realpath(root);
  const config = await loadConfig(root), state = await readState(root);
  const task = state.taskId ? await executionTask(root, state.taskId, config) : undefined;
  if (options.repo && !config.workspace) throw new Error('--repo 는 워크스페이스에서만 사용합니다');
  if (config.workspace && !options.repo && !task) throw new Error('워크스페이스 감지에는 현재 task 또는 --repo 가 필요합니다');
  const member = options.repo ? await repoOf(root, config, { repo: options.repo }) : await taskMember(root, config, task ?? { id: '' });
  const sameTask = !config.workspace || task?.repo === member.name;
  const record = sameTask ? state.worktrees?.find(w => w.taskId === state.taskId) : undefined;
  if (sameTask && task) assertRecordRepo(config, task, record);
  const taskPath = record?.path || (sameTask ? task?.worktree : undefined);
  const canonicalBase = await realpath(resolve(root, taskPath ?? member.path));
  const requestedBase = options.cwd === undefined ? canonicalBase : await realpath(resolve(root, options.cwd));
  if (options.apply && requestedBase !== canonicalBase) throw new Error(`--apply 는 --cwd 없이 기준 경로(${canonicalBase})에서만 감지합니다`);
  const base = options.apply ? canonicalBase : requestedBase;
  const registered = await Promise.all((state.worktrees ?? []).filter(w => !config.workspace || w.repo === member.name).map(w => realpath(w.path).catch(() => '')));
  const boundary = config.workspace ? member.path : root;
  if (!inside(boundary, base) && !registered.some(p => p && inside(p, base))) throw new Error('--cwd는 프로젝트 또는 등록된 워크트리 안이어야 합니다');
  if (!(await stat(base)).isDirectory()) throw new Error('--cwd는 디렉터리여야 합니다');
  const registeredBase = registered.find(path => path && inside(path, base));
  const baseSnapshot = await gitSnapshot(base, registeredBase, member.path);
  if (registeredBase && (!baseSnapshot.head || baseSnapshot.clean === null)) throw new DetectGitError();
  if (options.apply) {
    if (options.approve) {
      try { await assertNotBrain(root, 'verify detect --approve'); } catch { throw new Error(verifyUserSetError); }
    } else if (baseSnapshot.clean === false) throw new Error(autoVerifyDirtyError);
  }
  const detected = await detectVerify(base, { source: 'auto', registered: !!registeredBase, skipPrefixes: [member.worktrees.prefix],
    skipDirs: verifySkipDirs(base, config.docs.root, config.workspace ? root : undefined) });
  const current = { commands: member.verify.commands, heavy: member.verify.heavy ?? [], ...(member.verify.auto ? { auto: member.verify.auto } : {}) };
  const result = { base, detected: detected ?? null, current, userSet: userSetVerify(current) };
  if (!options.apply) return result;
  if (!detected) throw new Error(noDetectedVerify);
  const written = await writeAutoVerify(root, config.workspace ? `workspace.repos.${member.name}.verify` : 'verify', detected, { approve: options.approve });
  await recordAutoVerify(root, base, detected, written, { via: 'detect', ...(sameTask ? { taskId: task?.id } : {}), ...repoEvidence(config, member) });
  return { ...result, applied: written };
}
