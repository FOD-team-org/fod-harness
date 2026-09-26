import { runAutopilot } from '../orchestrator/autopilot.ts';
import { runCleanup } from '../../src/core/cleanup.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/core/config.ts';
import { appendLedger } from '../../src/core/ledger.ts';
import { detectRecovery, tick, memoryTick, pendingDecisions, recordDecision } from '../../src/core/watcher.ts';
import { redact } from '../../src/provider/privacy.ts';
import { decideInbox, clearDecisionTimers } from '../orchestrator/index.ts';
import { waitForShutdown } from '../../src/core/shutdown-wait.ts';

export default function watcher(pi: ExtensionAPI, options: { shutdownWaitMs?: number; now?: () => Date } = {}): void {
  let root: string, ctx: ExtensionContext;
  let sessionStartedAt: string;
  let timers: ReturnType<typeof setInterval>[] = [], periods = '';
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined, watchedDirectory: string | undefined;
  const missingDirectories = new Set<string>(), loggedMissingDirectories = new Set<string>();
  let pending: Promise<void> | undefined, memoryPending: Promise<void> | undefined;
  let sessionId: string | undefined;
  let stopped = true, pendingFull = false, lastWarning = -Infinity;
  let generation = 0;
  const fail = async (action: 'tick' | 'fs-watch', error: unknown) => {
    const message = redact(error instanceof Error ? error.message : '워처 실행 실패');
    try { await appendLedger(root, { runId: sessionStartedAt, action: `watcher:${action}`, status: 'fail', evidence: { message } }); }
    catch { /* Storage failure must not escape a timer callback. */ }
    if (action === 'fs-watch' && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    if (ctx?.hasUI && Date.now() - lastWarning >= 60000) {
      lastWarning = Date.now();
      try { ctx.ui.notify(`워처 ${action} 실패: ${message}`, 'warning'); } catch { /* disposed UI */ }
    }
  };
  const watchFailure = async (directory: string, error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      missingDirectories.add(directory);
      if (loggedMissingDirectories.has(directory)) return;
      loggedMissingDirectories.add(directory);
    }
    await fail('fs-watch', error);
  };
  const liveContext = (): ExtensionContext => ({ ...ctx, isIdle: () => !stopped && (ctx.isIdle?.() ?? true) });
  const decidePending = async () => {
    for (const record of await pendingDecisions(root)) {
      if (stopped) return;
      try {
        const result = await decideInbox(pi, liveContext(), root, [record], { retry: () => run(true) });
        if (!result.deferred.includes(record.id)) await recordDecision(root, record);
      } catch (error) {
        await recordDecision(root, record, error);
        await fail('tick', error);
      }
    }
  };
  const ensureWatch = async () => {
    const directory = dirname(resolve(root, (await loadConfig(root)).judgment.file));
    if (stopped || directory === watchedDirectory) return;
    watcher?.close(); watcher = undefined; watchedDirectory = undefined;
    if (missingDirectories.has(directory)) {
      try { if (!(await stat(directory)).isDirectory()) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      missingDirectories.delete(directory);
    }
    if (stopped) return;
    try {
      const current = watch(directory, { persistent: false }, () => {
        if (stopped) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { debounce = undefined; void run(true); }, 500);
        debounce.unref();
      });
      watcher = current; watchedDirectory = directory;
      current.on('error', error => {
        current.close();
        if (watcher === current) { watcher = undefined; watchedDirectory = undefined; }
        void watchFailure(directory, error);
      });
    } catch (error) { watchedDirectory = undefined; await watchFailure(directory, error); }
  };
  const configureTimers = (pollSeconds: number, tickSeconds: number) => {
    const next = `${pollSeconds}:${tickSeconds}`;
    if (stopped || periods === next) return;
    for (const timer of timers) clearInterval(timer);
    periods = next;
    timers = [setInterval(() => { void run(); }, tickSeconds * 1000),
      setInterval(() => { void run(true); }, pollSeconds * 1000),
      setInterval(() => {
        if (stopped || memoryPending) return;
        const started = generation;
        const completion = memoryTick(root).then(() => undefined)
          .catch(error => { if (started === generation) return fail('tick', error); })
          .finally(() => { if (memoryPending === completion) memoryPending = undefined; });
        memoryPending = completion;
        void completion.then(() => { if (!stopped && started === generation) return run(); });
      }, 60000)];
    for (const timer of timers) timer.unref();
  };
  const run = (judgmentOnly = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) { if (!judgmentOnly) pendingFull = true; return pending; }
    const started = generation, current = () => !stopped && started === generation;
    const completion = (async () => {
      do {
        pendingFull = false;
        try {
          const config = await loadConfig(root);
          if (!current()) return;
          configureTimers(config.watch.pollSeconds, config.watch.tickSeconds);
          await tick(root, { ctx: liveContext(), judgmentOnly });
          if (current()) await decidePending();
          // Drain an already queued full tick first; additional I/O must not delay coalesced decisions.
          if (current() && !pendingFull) await runAutopilot(pi, liveContext(), root, options.now);
        } catch (error) { if (current()) await fail('tick', error); }
        try { if (current()) await ensureWatch(); } catch (error) { if (current()) await fail('tick', error); }
        judgmentOnly = false;
      } while (current() && pendingFull);
    })().finally(() => { if (pending === completion) pending = undefined; });
    pending = completion;
    return pending;
  };
  const shutdown = async () => {
    stopped = true; pendingFull = false; generation++;
    for (const timer of timers) clearInterval(timer);
    timers = []; periods = '';
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    if (root) clearDecisionTimers(root);
    watcher?.close(); watcher = undefined; watchedDirectory = undefined;
    try { await waitForShutdown(root, 'watcher', [pending, memoryPending], options.shutdownWaitMs); }
    catch (error) { await fail('tick', error); }
    pending = undefined; memoryPending = undefined;
    // A decision already in flight may have scheduled a deferred answer after shutdown began.
    if (root) clearDecisionTimers(root);
  };
  pi.on('session_start', async (_event, context) => {
    await shutdown();
    root = context.cwd; ctx = context; lastWarning = -Infinity;
    sessionId = randomUUID(); process.env.FODH_SESSION_ID = sessionId;
    missingDirectories.clear(); loggedMissingDirectories.clear();
    sessionStartedAt = `${new Date().toISOString()}:${randomUUID()}`;
    stopped = ctx.hasUI === false;
    pending = (async () => {
      try { await detectRecovery(root, sessionStartedAt); }
      catch (error) { await fail('tick', error); }
      try { if (!stopped) await decidePending(); }
      catch (error) { await fail('tick', error); }
    })();
    await pending; pending = undefined;
    if (stopped) return;
    // Recovery/configuration failures must never prevent the fallback polling loop.
    let pollSeconds = 5, tickSeconds = 30;
    try {
      const config = await loadConfig(root);
      pollSeconds = config.watch.pollSeconds; tickSeconds = config.watch.tickSeconds;
    } catch (error) { await fail('tick', error); }
    configureTimers(pollSeconds, tickSeconds);
    try { await ensureWatch(); } catch (error) { await fail('tick', error); }
  });
  pi.on('agent_start', async (_event, context) => { ctx = context; });
  pi.on('agent_end', async (_event, context) => { ctx = context; });
  pi.on('session_shutdown', async () => {
    await shutdown();
    if (root && sessionId) {
      try { await runCleanup(root, { scope: 'processes', sessionId }); } catch (error) { await fail('tick', error); }
      if (process.env.FODH_SESSION_ID === sessionId) delete process.env.FODH_SESSION_ID;
      sessionId = undefined;
    }
  });
}
