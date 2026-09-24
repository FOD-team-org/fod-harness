import { notify } from './notify.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sampleMemory, judgeMemory, type MemorySample, type MemoryWatch } from './memory.ts';
import { readMeta, finishRun, resultDir, result } from './codex-record.ts';
import { codexOwnership } from './process-identity.ts';
import { reclaimCodexOwner } from './codex-reclaim.ts';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendLedger } from './ledger.ts';
import { redact } from '../provider/privacy.ts';
import { loadConfig } from './config.ts';
import { addInboxOnce, queueInbox, listInbox, type InboxRecord } from './inbox.ts';
import { isProcessAlive } from './lock.ts';
import { listProcs } from './procs.ts';
import { activeStates, isPaused, readState, updateState } from './state.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';

import { slotOwnerIdentity } from './slots.ts';

export interface WatchState {
  slotCheck?: { since: string; at: string; ownerRunId?: string; unknownCount?: number; unknownNotified?: boolean };
  memory?: MemoryWatch; memorySampleFailed?: boolean;
  lastTickAt?: string;
  judgment: { path?: string; observed: { hash: string | null; since: string }; lastEmitted?: string | null };
  codexEmitted?: string[];
  codexLostFailures?: Record<string, string>;
  emittedKeys: string[];
  decided: string[];
  deferredLogged?: string[];
  decisionFailures?: Record<string, number>;
  stalledSince?: string;
  childTimeouts: number;
}
export interface WatcherFile {
  judgment?: { expectedHash?: string; externalPending?: { hash: string; at: string }; [key: string]: unknown };
  watch?: WatchState;
  [key: string]: unknown;
}
export interface WatcherStatus {
  lastTickAt: string | null;
  judgment: { observedHash: string | null; stableFor: number; expectedHash: string | null };
  stalledSince?: string;
  childTimeouts: number;
}
// Pi loads each extension in an isolated module cache; status still shares process-local ticks.
const tickCacheKey = Symbol.for('fod-harness.watcher.lastTicks');
const shared = globalThis as typeof globalThis & { [tickCacheKey]?: Map<string, string> };
const lastTicks = shared[tickCacheKey] ??= new Map<string, string>();
function summary(file: WatcherFile, now: number): WatcherStatus {
  const watch = file.watch;
  return {
    lastTickAt: watch?.lastTickAt ?? null,
    judgment: {
      observedHash: watch?.judgment.observed.hash?.slice(0, 12) ?? null,
      stableFor: watch ? Math.max(0, (now - Date.parse(watch.judgment.observed.since)) / 1000) : 0,
      expectedHash: file.judgment?.expectedHash?.slice(0, 12) ?? null,
    },
    ...(watch?.stalledSince ? { stalledSince: watch.stalledSince } : {}),
    childTimeouts: watch?.childTimeouts ?? 0,
  };
}
export async function watcherStatus(root: string, now = Date.now()): Promise<WatcherStatus> {
  const file = await readJson<WatcherFile>(harnessPath(root, 'harness-watcher.json'), {});
  const result = summary(file, now);
  const memoryTick = lastTicks.get(resolve(root));
  if (memoryTick && (!result.lastTickAt || memoryTick > result.lastTickAt)) result.lastTickAt = memoryTick;
  return result;
}
export interface TickOptions {
  now?: number | (() => number);
  hash?: (content: Buffer) => string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  ctx?: unknown;
  judgmentOnly?: boolean;
}
export async function tick(root: string, options: TickOptions = {}): Promise<{ emitted: InboxRecord[]; status: WatcherStatus }> {
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const config = await loadConfig(root);
  const path = harnessPath(root, 'harness-watcher.json');
  if (!options.judgmentOnly) await recoverLostRuns(root, now, options);
  return withFileLock(path, async () => {
    const file = await readJson<WatcherFile>(path, {});
    const before = JSON.stringify(file);
    const watch: WatchState = file.watch ?? {
      judgment: { observed: { hash: null, since: at } }, emittedKeys: [], decided: [], childTimeouts: 0,
    };
    watch.decided ??= [];
    const emitted: InboxRecord[] = [];
    const emit = async (entry: { kind: string; dedupeKey: string; [key: string]: unknown }, once = false) => {
      if (once && watch.emittedKeys.includes(entry.dedupeKey)) return;
      const result = await addInboxOnce(root, entry);
      const record = await queueInbox(root, result.record.id);
      if (result.created) emitted.push(record);
      if (once) watch.emittedKeys.push(entry.dedupeKey);
    };
    const judgmentPath = resolve(root, config.judgment.file);
    let content: Buffer | undefined;
    try { content = await readFile(judgmentPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const hash = content === undefined ? null
      : (options.hash ?? (value => createHash('sha256').update(value).digest('hex')))(content);
    if (watch.judgment.path !== judgmentPath) {
      watch.judgment = { path: judgmentPath, observed: { hash, since: at } };
    } else if (watch.judgment.observed.hash !== hash) watch.judgment.observed = { hash, since: at };
    const expectedHash = file.judgment?.expectedHash;
    const externalPending = file.judgment?.externalPending;
    if (hash !== null) {
      if (externalPending) {
        if (now - Date.parse(externalPending.at) >= config.watch.stableSeconds * 1000) {
          await emit({ kind: 'judgment-changed', dedupeKey: `judgment:${judgmentPath}:${hash}`, path: judgmentPath,
            hashBefore: watch.judgment.lastEmitted ?? null, hashAfter: hash, external: externalPending.hash, size: content!.length });
          watch.judgment.lastEmitted = hash;
          delete file.judgment!.externalPending;
        }
      } else if (hash === expectedHash) watch.judgment.lastEmitted = hash;
      else if (hash !== watch.judgment.lastEmitted && now - Date.parse(watch.judgment.observed.since) >= config.watch.stableSeconds * 1000) {
        await emit({ kind: 'judgment-changed', dedupeKey: `judgment:${judgmentPath}:${hash}`,
          path: judgmentPath, hashBefore: watch.judgment.lastEmitted ?? expectedHash ?? null, hashAfter: hash, size: content!.length });
        watch.judgment.lastEmitted = hash;
      }
    }
    if (!options.judgmentOnly) {
      const state = await readState(root);
      const waiting = state.awaitingSlot;
      if (waiting && state.state !== 'paused(slot)') {
        await updateState(root, current => current.state !== 'paused(slot)' && current.awaitingSlot?.since === waiting.since
          && current.awaitingSlot.owner.runId === waiting.owner.runId ? { awaitingSlot: undefined } : {});
        delete watch.slotCheck;
      } else if (waiting && (watch.slotCheck?.since !== waiting.since || watch.slotCheck.ownerRunId !== waiting.owner.runId
        || now - Date.parse(watch.slotCheck.at) >= 60000)) {
        const previous = watch.slotCheck?.since === waiting.since && watch.slotCheck.ownerRunId === waiting.owner.runId ? watch.slotCheck : undefined;
        const identity = await slotOwnerIdentity(waiting.owner);
        watch.slotCheck = { since: waiting.since, at, ownerRunId: waiting.owner.runId,
          unknownCount: identity === 'unknown' ? (previous?.unknownCount ?? 0) + 1 : 0,
          unknownNotified: previous?.unknownNotified };
        if (watch.slotCheck.unknownCount! >= 10 && !watch.slotCheck.unknownNotified) {
          await notify(root, { key: 'slot:unknown-owner', title: '슬롯 소유자 확인 불가', level: 'warning',
            body: '슬롯 소유자를 10회 연속 확인하지 못했습니다. 대기를 유지합니다. fodh slots status 로 확인하세요.' }, undefined, { now, config });
          watch.slotCheck.unknownNotified = true;
        }
        if (!['owned', 'unknown', 'orphan'].includes(identity)) await emit({ kind: 'slot-free',
          dedupeKey: `slot-free:${waiting.since}:${waiting.owner.runId}`, since: waiting.since, ownerRunId: waiting.owner.runId }, true);
      } else if (!waiting) delete watch.slotCheck;
      const procs = await listProcs(root);
      const aliveByPid = new Map<number, boolean>();
      for (const proc of procs) aliveByPid.set(proc.pid, await (options.isProcessAlive ?? isProcessAlive)(proc.pid));
      const brainAlive = procs.some(proc => proc.kind === 'brain' && aliveByPid.get(proc.pid));
      const heartbeat = Math.max(...[state.lastEventAt, state.enteredAt, state.savedAt]
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(Number.isFinite));
      if (activeStates.has(state.state) && state.state !== 'recovering' && !state.userAborted && !state.delegation && !brainAlive && state.awaitingUser !== true && Number.isFinite(heartbeat)
        && now - heartbeat > config.watch.stallMinutes * 60000) {
        watch.stalledSince = new Date(heartbeat).toISOString();
        await emit({ kind: 'stalled', dedupeKey: `stalled:${JSON.stringify([state.state, state.runId ?? state.enteredAt, heartbeat])}`,
          state: state.state, task: state.taskId, lastEventAt: state.lastEventAt, runId: state.runId,
          minutes: (now - heartbeat) / 60000 }, true);
      } else delete watch.stalledSince;
      watch.childTimeouts = 0;
      for (const proc of procs) {
        const alive = aliveByPid.get(proc.pid);
        const minutes = (now - Date.parse(proc.startedAt.replace(/^spawn:/u, ''))) / 60000;
        const codexMeta = proc.kind === 'codex' ? await readMeta(root, proc.runId) : undefined;
        const limit = proc.kind === 'brain' ? config.brain.maxTurnMinutes : codexMeta ? codexMeta.timeoutMinutes + 5 : config.watch.childTimeoutMinutes;
        if (alive && !(minutes > limit)) continue;
        const kind = alive ? 'child-timeout' : 'child-gone';
        if (alive) watch.childTimeouts++;
        await emit({ kind, dedupeKey: `${kind}:${JSON.stringify([proc.pid, proc.startedAt, proc.kind])}`,
          pid: proc.pid, pgid: proc.pgid, runId: proc.runId, procKind: proc.kind,
          ...(alive ? { minutes } : {}) }, true);
      }
      const doneInbox = await listInbox(root);
      const emittedRuns = new Set([...(watch.codexEmitted ?? []), ...doneInbox.filter(item => item.kind === 'codex-done').map(item => String(item.codexRunId ?? item.runId))]);
      let directories: string[] = [];
      try { directories = await readdir(harnessPath(root, 'codex')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (state.delegation && !directories.includes(state.delegation.runId)) directories.push(state.delegation.runId);
      for (const runId of directories) {
        if (!/^[A-Za-z0-9_-]+$/u.test(runId) || emittedRuns.has(runId)) continue;
        let meta = await readMeta(root, runId);
        if (!meta) {
          const delegation = state.delegation;
          if (delegation?.runId === runId && now - Date.parse(delegation.startedAt) >= 60000) {
            await emit({ kind: 'codex-done', dedupeKey: `codex-done:${runId}`, runId, codexRunId: runId,
              taskId: delegation.taskId, codexKind: delegation.kind, codexStatus: 'lost' });
            watch.codexEmitted = [...(watch.codexEmitted ?? []), runId].slice(-50);
          }
          continue;
        }
        if (meta.finishedAt) {
          delete watch.codexLostFailures?.[runId];
          await emit({ kind: 'codex-done', dedupeKey: `codex-done:${runId}`, runId, codexRunId: runId, taskId: meta.taskId,
            codexKind: meta.kind, codexStatus: meta.status, exit: meta.exit, threadId: meta.threadId, ...(meta.supervisorLost ? { supervisorLost: true } : {}), resultDir: resultDir(root, runId) });
          watch.codexEmitted = [...(watch.codexEmitted ?? []), runId].slice(-50);
        }
      }
      const inbox = await listInbox(root);
      const applied = new Set(inbox.filter(record => record.status === 'applied').map(record => record.id));
      watch.decided = watch.decided.filter(id => !applied.has(id)).slice(-200);
      if (watch.deferredLogged) {
        const pending = new Set(inbox.filter(record => record.status !== 'applied').map(record => record.id));
        watch.deferredLogged = watch.deferredLogged.filter(id => pending.has(id));
      }
      const registered = new Set(procs.map(proc => JSON.stringify([proc.pid, proc.startedAt, proc.kind])));
      const current = (key: string): boolean => {
        if (key.startsWith('child-')) return registered.has(key.slice(key.indexOf(':') + 1));
        if (key.startsWith('stalled:')) {
          try { const [name, run] = JSON.parse(key.slice(8)); return name === state.state && run === (state.runId ?? state.enteredAt ?? null); }
          catch { return false; }
        }
        return false;
      };
      const old = new Set(watch.emittedKeys.filter(key => !current(key)).slice(-200));
      watch.emittedKeys = watch.emittedKeys.filter(key => current(key) || old.has(key));
    }
    file.watch = watch;
    const changed = JSON.stringify(file) !== before;
    watch.lastTickAt = at;
    lastTicks.set(resolve(root), at);
    if (!options.judgmentOnly || changed) await atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
    return { emitted, status: summary(file, now) };
  });
}
export async function detectRecovery(root: string, sessionStartedAt: string): Promise<InboxRecord[]> {
  return withFileLock(harnessPath(root, 'harness-watcher.json'), async () => {
    const state = await readState(root);
    if (!activeStates.has(state.state) && !isPaused(state.state) && !state.state.startsWith('WAIT_')) return [];
    const dedupeKey = `recover:${sessionStartedAt}`;
    // A session recovery stays one-shot even after its inbox record is acknowledged.
    if ((await listInbox(root)).some(record => record.dedupeKey === dedupeKey)) return [];
    const { record, created } = await addInboxOnce(root, { kind: 'recover', dedupeKey,
      state: state.state, task: state.taskId, savedAt: state.savedAt, resumeState: state.resumeState });
    const queued = await queueInbox(root, record.id);
    return created ? [queued] : [];
  });
}

const watcherKinds = new Set(['judgment-changed', 'stalled', 'child-timeout', 'child-gone', 'recover', 'codex-done', 'memory-pressure', 'memory-critical', 'memory-recovered', 'slot-free']);
export async function pendingDecisions(root: string): Promise<InboxRecord[]> {
  const file = await readJson<WatcherFile>(harnessPath(root, 'harness-watcher.json'), {});
  const decided = new Set(file.watch?.decided ?? []);
  return (await listInbox(root)).filter(record => watcherKinds.has(record.kind) && record.status !== 'applied' && !decided.has(record.id));
}
export async function recordDecision(root: string, record: InboxRecord, error?: unknown): Promise<void> {
  const path = harnessPath(root, 'harness-watcher.json');
  let exhausted = false;
  await withFileLock(path, async () => {
    const file = await readJson<WatcherFile>(path, {});
    const watch = file.watch ??= { judgment: { observed: { hash: null, since: new Date().toISOString() } }, emittedKeys: [], decided: [], childTimeouts: 0 };
    watch.decided ??= [];
    if (error !== undefined) {
      watch.decisionFailures ??= {};
      const failures = (watch.decisionFailures[record.id] ?? 0) + 1;
      watch.decisionFailures[record.id] = failures;
      exhausted = failures >= 3;
      if (!exhausted) { await atomicWrite(path, JSON.stringify(file, null, 2) + '\n'); return; }
    }
    if (!watch.decided.includes(record.id)) watch.decided.push(record.id);
    if (!error) delete watch.decisionFailures?.[record.id];
    await atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
  });
  if (exhausted) await appendLedger(root, { runId: record.id, action: `watcher:decide:${record.kind}`, status: 'fail',
    evidence: { ids: [record.id], attempts: 3, message: redact(error instanceof Error ? error.message : '결정 실패') } });
}
export async function judgmentStableFor(root: string, now = Date.now()): Promise<number> {
  const config = await loadConfig(root);
  const file = await readJson<WatcherFile>(harnessPath(root, 'harness-watcher.json'), {});
  let content: Buffer;
  try { content = await readFile(resolve(root, config.judgment.file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  const observed = file.watch?.judgment.observed;
  return observed?.hash === createHash('sha256').update(content).digest('hex')
    ? Math.max(0, (now - Date.parse(observed.since)) / 1000) : 0;
}

// Persist the first deferred notice so polling and session reloads do not duplicate it.
export async function logDeferredDecision(root: string, records: InboxRecord[], applied: string[], resumed: boolean): Promise<void> {
  const path = harnessPath(root, 'harness-watcher.json');
  await withFileLock(path, async () => {
    const file = await readJson<WatcherFile>(path, {});
    const watch = file.watch ??= { judgment: { observed: { hash: null, since: new Date().toISOString() } }, emittedKeys: [], decided: [], childTimeouts: 0 };
    const logged = new Set(watch.deferredLogged ?? []);
    const fresh = records.filter(record => !logged.has(record.id));
    if (!fresh.length) return;
    await appendLedger(root, { runId: fresh[0].id, action: `watcher:decide:${fresh[0].kind}`, status: 'skip',
      evidence: { ids: fresh.map(record => record.id), applied, resumed } });
    watch.deferredLogged = [...logged, ...fresh.map(record => record.id)];
    await atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
  });
}

// Only collect candidates while holding the watcher lock. Process-tree waits and meta
// finalization must not block inbox decisions or judgment writers.
async function recoverLostRuns(root: string, now: number, options: TickOptions) {
  const path = harnessPath(root, 'harness-watcher.json');
  const candidates = await withFileLock(path, async () => {
    let names: string[] = [];
    try { names = await readdir(harnessPath(root, 'codex')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return names.filter(name => /^[A-Za-z0-9_-]+$/u.test(name));
  });
  const procs = await listProcs(root);
  for (const runId of candidates) {
    try { if (!(await stat(resultDir(root, runId))).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Serialize recovery for this run, independently of the watcher file.
    await withFileLock(harnessPath(root, `codex/${runId}/recovery`), async () => {
      let meta = await readMeta(root, runId);
      if (!meta || meta.finishedAt || meta.status !== 'running' || now - Date.parse(meta.startedAt) < 60000) return;
          const proc = procs.find(item => item.kind === 'codex' && item.runId === runId);
          const pid = meta.pid ?? proc?.pid;
          const owner = pid === undefined ? undefined : { pid, pgid: pid, startedAt: meta.processStartedAt ?? proc?.startedAt,
            childPid: meta.childPid, childStartedAt: meta.childStartedAt, toolGroups: meta.toolGroups };
          const identity = owner ? await codexOwnership(owner, options.isProcessAlive) : 'gone';
          if (!['owned', 'unknown'].includes(identity)) {
            const reclaimed = owner ? await reclaimCodexOwner(owner, { root, runId }).catch(() => ({ reclaimed: false, owner: identity, reason: undefined })) : { reclaimed: true, owner: 'gone', reason: undefined };
            if (!reclaimed.reclaimed) {
              await withFileLock(path, async () => {
                const file = await readJson<WatcherFile>(path, {});
                const watch = file.watch ??= emptyWatch(new Date(now).toISOString());
                const last = watch.codexLostFailures?.[runId];
                if (!last || now - Date.parse(last) >= 10 * 60000) {
                  await appendLedger(root, { runId, action: 'codex:lost', status: 'fail', evidence: { reason: 'group-alive' } });
                  (watch.codexLostFailures ??= {})[runId] = new Date(now).toISOString();
                  await atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
                }
              });
              return;
            }
            const completed = identity === 'gone' && !('skippedGroups' in reclaimed && reclaimed.skippedGroups.length) && (await result(root, runId)).turnCompleted;
            meta = await finishRun(root, runId, { status: completed ? 'ok' : 'lost', exit: null, reason: reclaimed.reason ?? ('skippedGroups' in reclaimed && reclaimed.skippedGroups.length ? 'residual' : undefined),
              ...(completed ? { supervisorLost: true } : {}) });
          }
    });
  }
}
function emptyWatch(at: string): WatchState {
  return { judgment: { observed: { hash: null, since: at } }, emittedKeys: [], decided: [], childTimeouts: 0 };
}

export async function memoryStatus(root: string) {
  const file = await readJson<WatcherFile>(harnessPath(root, 'harness-watcher.json'), {});
  return { sample: await sampleMemory((await loadConfig(root)).cleanup.swapWarnGB), memory: file.watch?.memory };
}
export async function memoryTick(root: string, options: { now?: number; sample?: () => Promise<MemorySample | undefined> } = {}) {
  const config = await loadConfig(root);
  const now = options.now ?? Date.now(), sample = await (options.sample ? options.sample() : sampleMemory(config.cleanup.swapWarnGB));
  const emitted: InboxRecord[] = [];
  await withFileLock(harnessPath(root, 'harness-watcher.json'), async () => {
    const path = harnessPath(root, 'harness-watcher.json'), file = await readJson<WatcherFile>(path, {});
    const watch = file.watch ??= emptyWatch(new Date(now).toISOString());
    if (!sample) {
      if (!watch.memorySampleFailed) await appendLedger(root, { runId: 'memory', action: 'memory:sample', status: 'fail' });
      watch.memorySampleFailed = true;
    } else {
      const decision = judgeMemory(watch.memory, sample, config.cleanup.swapWarnGB, now);
      watch.memory = decision.watch;
      for (const entry of decision.events) {
        const { record, created } = await addInboxOnce(root, entry);
        await queueInbox(root, record.id); if (created) emitted.push(record);
      }
    }
    await atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
  });
  await reportUnregistered(root, config.cleanup.processes.killPatterns, now);
  return emitted;
}
// An orphan command match is diagnostic evidence, never ownership or kill authority.
export async function reportUnregistered(root: string, patterns: string[], now = Date.now(), run: () => Promise<{ stdout: string }> = () => promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { timeout: 1000 })) {
  const registered = new Set((await listProcs(root)).map(p => p.pgid));
  const residual = await readJson<Record<string, { groups: number[] }>>(harnessPath(root, 'harness-tool-residual.json'), {});
  const groups = new Set(Object.values(residual).flatMap(v => v.groups));
  try {
    const { stdout } = await run();
    const found = stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      if (!match || registered.has(Number(match[3])) || Number(match[1]) === process.pid) return [];
      return groups.has(Number(match[3])) || Number(match[2]) === 1 && patterns.some(p => match[4].includes(p))
        ? [{ pid: Number(match[1]), pgid: Number(match[3]), cmd: redact(match[4]).slice(0, 200) }] : [];
    });
    if (!found.length) return;
    const path = harnessPath(root, 'harness-residual-report.json');
    await withFileLock(path, async () => {
      const previous = await readJson<{ at?: number }>(path, {});
      if (previous.at !== undefined && now - previous.at < 600000) return;
      await appendLedger(root, { runId: 'watchdog', action: 'memory:residual', status: 'skip', evidence: { reportOnly: true, processes: found } });
      await atomicWrite(path, JSON.stringify({ at: now }) + '\n');
    });
  } catch { /* No process visibility means no residual claim. */ }
}
