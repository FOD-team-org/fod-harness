import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { commandParts, groupAlive } from '../provider/runner.ts';
import { redact } from '../provider/privacy.ts';
import { loadConfig } from './config.ts';
import { readState, updateState } from './state.ts';
import { getTask } from './backlog.ts';
import { acquireSlot, releaseSlot, updateSlot } from './slots.ts';
import { inside } from './codex.ts';
import { registerProc, removeProc } from './procs.ts';
import { processStartedAt } from './process-time.ts';
import { reclaimCodexTree } from './proc-tree.ts';
import { parseGroupRssMB } from './codex-supervisor.ts';
import { sampleMemory } from './memory.ts';
import { appendLedger } from './ledger.ts';
import { harnessPath, atomicWrite } from './storage.ts';
export async function runVerify(root: string, options: { heavy?: boolean; cwd?: string } = {}) {
  const state = await readState(root), config = await loadConfig(root);
  if (!['VERIFY', 'FIX'].includes(state.state)) return { ok: false, error: 'VERIFY 또는 FIX 상태에서만 검증할 수 있습니다' };
  const runId = randomUUID(), startedAt = new Date().toISOString();
  root = await realpath(root);
  const task = state.taskId ? await getTask(root, state.taskId) : undefined;
  const taskPath = state.worktrees?.find(item => item.taskId === state.taskId)?.path || task?.worktree || root;
  const cwd = await realpath(resolve(root, options.cwd ?? taskPath));
  const registered = await Promise.all((state.worktrees ?? []).map(w => realpath(w.path).catch(() => '')));
  if (!inside(root, cwd) && !registered.some(path => path && inside(path, cwd))) throw new Error('--cwd는 프로젝트 또는 등록된 워크트리 안이어야 합니다');
  if (!(await stat(cwd)).isDirectory()) throw new Error('--cwd는 디렉터리여야 합니다');
  async function finish<T extends { ok: boolean }>(report: T) {
    const finishedAt = new Date().toISOString();
    const result = { ...report, runId, taskId: state.taskId, startedAt, finishedAt, heavy: !!options.heavy, cwd };
    await atomicWrite(harnessPath(root, `verify/${runId}/result.json`), `${JSON.stringify(result, null, 2)}\n`);
    await updateState(root, { verify: { runId, taskId: state.taskId, ok: report.ok, at: finishedAt, heavy: !!options.heavy, cwd } });
    return result;
  }
  const commands = options.heavy ? config.verify.heavy : config.verify.commands;
  if (!commands.length) return finish({ ok: false, error: `verify.${options.heavy ? 'heavy' : 'commands'} 가 비어 있습니다` });
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
    await appendLedger(root, { runId, taskId: state.taskId, action: 'verify:run', status: 'pre', evidence: { heavy: !!options.heavy, cwd } });
    for (const [index, cmd] of commands.entries()) {
      const argv = commandParts(cmd), file = await open(join(dir, `${index + 1}.log`), 'w+', 0o600);
      const start = Date.now(); let timedOut = false, residual = false, pid: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, rssTimer: ReturnType<typeof setInterval> | undefined;
      let stopping: Promise<boolean> | undefined, sampling: Promise<void> | undefined;
      const stop = () => stopping ??= reclaimCodexTree(pid!, [pid!]).catch(() => false);
      let interrupted: 'signal' | undefined;
      const onSignal = () => { interrupted = 'signal'; if (pid) void stop(); };
      process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
      let exit: number | null = null, failure = '';
      try {
        const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', file.fd, file.fd] });
        const closed = new Promise<number | null>((done, fail) => { child.once('exit', (code, signal) => { if (!timedOut && (signal === 'SIGTERM' || signal === 'SIGINT')) interrupted = 'signal'; done(code); }); child.once('error', fail); });
        void closed.catch(() => undefined);
        pid = child.pid;
        if (pid) {
          timer = setTimeout(() => { timedOut = true; void stop(); }, config.verify.timeoutMinutes * 60000);
          if (options.heavy) await updateSlot('heavy', runId, { childPid: pid, childStartedAt: await processStartedAt(pid) });
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
        // Even if process-table access fails, bound the wait and kill only the
        // directly spawned child. Its wider tree remains registered as residual.
        if (pid) {
          const limit = new Promise<null>(done => {
            const poll = setInterval(() => { if (timedOut || interrupted) { clearInterval(poll); void stop().then(success => { if (!success) child.kill('SIGKILL'); done(null); }); } }, 25);
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
    await appendLedger(root, { runId, taskId: state.taskId, action: 'verify:run', status: ok ? 'ok' : 'fail', evidence: report });
    return await finish(report);
  } finally { if (options.heavy) await releaseSlot('heavy', runId); }
}
