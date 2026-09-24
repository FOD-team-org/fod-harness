import { appendLedgerOnce } from './ledger.ts';
import { processTree, processTreeSnapshot, reclaimCodexTree } from './proc-tree.ts';
import { groupAlive } from '../provider/runner.ts';
import { sampleToolGroups, verifiedToolGroups, type ToolGroup, type ReclaimContext } from './tool-groups.ts';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { harnessPath, withFileLock, readJson } from './storage.ts';
import { readMeta, writeMeta, metaPath, resultDir, finishRun } from './codex-record.ts';
import { updateSlot } from './slots.ts';
import { processStartedAt } from './process-time.ts';
import { refreshProcStartedAt } from './procs.ts';

const execute = promisify(execFile);
export function parseGroupMembers(stdout: string, pgid: number, excludePids: readonly (number | undefined)[]): number[] {
  return stdout.split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    .filter(([pid, group]) => group === pgid && Number.isSafeInteger(pid) && pid > 1 && !excludePids.includes(pid))
    .map(([pid]) => pid);
}
export function parseGroupRssMB(stdout: string, excludePids: readonly (number | undefined)[]): number {
  return stdout.split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    .filter(([pid, rss]) => Number.isSafeInteger(pid) && pid > 1 && Number.isFinite(rss) && rss >= 0 && !excludePids.includes(pid))
    .reduce((sum, [, rss]) => sum + rss, 0) / 1024;
}
// The supervisor remains alive to finalize meta; processTree excludes it and the querying ps.
async function stopChildren(child: ChildProcess, toolGroups: readonly ToolGroup[], context: ReclaimContext): Promise<void> {
  try {
    const { groups, skippedGroups } = await verifiedToolGroups(toolGroups, context);
    if (!await reclaimCodexTree(process.pid, child.pid && child.exitCode === null && child.signalCode === null ? [child.pid] : [], groups) || skippedGroups.length) throw new Error('Codex 자손 프로세스가 남아 있습니다');
  } catch (error) {
    // If ps is unavailable, still terminate our direct child, but do not claim tree cleanup.
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) { await delay(5000); child.kill('SIGKILL'); }
    throw error;
  }
}
export function codexChildEnv(env: NodeJS.ProcessEnv, runId: string): NodeJS.ProcessEnv {
  const { FODH_PROJECT_ROOT: _projectRoot, ...rest } = env;
  return { ...rest, FODH_RUN_ID: runId, FODH_CODEX_CHILD: '1' };
}
export async function supervise(root: string, runId: string): Promise<void> {
  let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined, rssTimer: ReturnType<typeof setInterval> | undefined;
  let ending: Promise<void> | undefined, stopping: 'timeout' | 'cancelled' | undefined, peakRssMB = 0;
  let failure: string | undefined, exit: number | null = null;
  let toolGroups: ToolGroup[] = [];
  const context = { root, runId };
  let sampling: Promise<void> | undefined;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const stop = (status: 'timeout' | 'cancelled') => {
    stopping ??= status;
    if (child) ending ??= stopChildren(child, toolGroups, context).catch(error => { failure = (error as Error).message; });
  };
  let signalHandling = Promise.resolve(), ignoredSignal = false;
  const onTerm = () => {
    signalHandling = signalHandling.then(async () => {
      if (await readJson(join(resultDir(root, runId), 'cancel.json'), undefined)) stop('cancelled');
      else if (!ignoredSignal) {
        ignoredSignal = true;
        process.stderr.write('SIGTERM ignored: no cancel.json; use fodh codex cancel ' + runId + '\n');
        await appendLedgerOnce(root, { runId, action: 'codex:signal', status: 'skip', evidence: { signal: 'SIGTERM', ignored: true } });
      }
    }).catch(() => undefined);
  };
  process.on('SIGTERM', onTerm);
  try {
    const meta = await withFileLock(harnessPath(root, 'harness-delegation'), async () => {
      return withFileLock(metaPath(root, runId), async () => {
        const current = await readMeta(root, runId);
        if (!current || current.finishedAt) return undefined;
        if (current.pid !== process.pid) throw new Error('감독 pid가 등록 정보와 다릅니다');
        const observed = await processStartedAt(process.pid);
        if (observed && current.processStartedAt?.startsWith('spawn:')) {
          await refreshProcStartedAt(root, process.pid, runId, current.processStartedAt, observed);
          current.processStartedAt = observed;
          await writeMeta(root, current);
        }
        await updateSlot('codex', runId, { pid: process.pid,
          startedAt: observed ?? current.processStartedAt ?? `spawn:${current.startedAt}` });
        return current;
      });
    }, { waitMs: 120000 });
    if (!meta) return;
    if (stopping) { await finishRun(root, runId, { status: stopping, exit: null }); return; }
    const dir = resultDir(root, runId);
    for (const [name, flags] of [['prompt.md', 'r'], ['events.jsonl', 'a'], ['stderr.txt', 'a']] as const) handles.push(await open(join(dir, name), flags, 0o600));
    child = spawn(meta.command[0], meta.command.slice(1), { cwd: meta.cwd, detached: false,
      stdio: handles.map(handle => handle.fd), env: codexChildEnv(process.env, runId) });
    const closed = new Promise<number | null>((ok, fail) => { child!.once('error', fail); child!.once('exit', code => ok(code)); });
    void closed.catch(() => undefined); // The child may fail while its identity is being recorded.
    if (stopping) stop(stopping);
    const childPid = child.pid;
    const childStartedAt = childPid ? await processStartedAt(childPid) : undefined;
    await withFileLock(metaPath(root, runId), async () => {
      const current = await readMeta(root, runId);
      if (current && !current.finishedAt) await writeMeta(root, { ...current, childPid, childStartedAt });
    });
    await updateSlot('codex', runId, { childPid, childStartedAt });
    timer = setTimeout(() => stop('timeout'), Math.max(1, meta.timeoutMinutes * 60000 - (Date.now() - Date.parse(meta.startedAt))));
    const sample = () => {
      if (sampling) return sampling;
      sampling = (async () => {
        toolGroups = toolGroups.filter(group => groupAlive(group.pgid));
        try {
          const snapshot = await processTreeSnapshot(process.pid, child?.pid && child.exitCode === null && child.signalCode === null ? [child.pid] : []);
          toolGroups = await sampleToolGroups(toolGroups, snapshot);
        } catch { /* ps may be unavailable; never invent an observed tool group. */ }
        await withFileLock(metaPath(root, runId), async () => {
          const current = await readMeta(root, runId);
          if (current && !current.finishedAt) await writeMeta(root, { ...current, toolGroups });
        }).catch(() => undefined); // Sampling remains best effort, including persistence.
        try {
          const pending = execute('/bin/ps', ['-o', 'pid=,rss=', '-g', String(process.pid)], { timeout: 1000 });
          const self = pending.child.pid;
          const { stdout } = await pending;
          peakRssMB = Math.max(peakRssMB, parseGroupRssMB(stdout, [self]));
        } catch { /* Sampling is best effort. */ }
      })().finally(() => { sampling = undefined; });
      return sampling;
    };
    rssTimer = setInterval(() => { void sample(); }, 30000); rssTimer.unref();
    void sample();
    exit = await closed;
    clearTimeout(timer);
    clearInterval(rssTimer);
    await sampling;
    // Reap surviving same-group descendants even after a normal child exit.
    if (!ending) {
      try { if (toolGroups.length || (await processTree(process.pid, [])).length) ending = stopChildren(child, toolGroups, context).catch(error => { failure = (error as Error).message; }); }
      catch { /* Normal exit is known; ps-only residual verification remains unavailable. */ }
    }
    await ending;
    await finishRun(root, runId, { status: stopping ?? (exit === 0 && !failure ? 'ok' : 'fail'), exit, peakRssMB,
      ...(failure ? { error: failure, reason: 'residual' } : {}) });
  } catch (error) {
    if (child) { ending ??= stopChildren(child, toolGroups, context).catch(() => undefined); await ending; }
    // Errors may contain arguments or paths: record only a bounded, credential-free diagnostic.
    const code = (error as NodeJS.ErrnoException).code;
    await finishRun(root, runId, { status: stopping ?? 'fail', exit, peakRssMB,
      error: code ? `감독 실행 실패 (${code})` : '감독 실행 또는 결과 저장 실패' }).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
    if (rssTimer) clearInterval(rssTimer);
    process.off('SIGTERM', onTerm);
    await signalHandling;
    for (const handle of handles) await handle.close().catch(() => undefined);
  }
}
