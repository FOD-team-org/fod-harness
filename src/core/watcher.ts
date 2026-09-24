import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendLedger } from './ledger.ts';
import { redact } from '../provider/privacy.ts';
import { loadConfig } from './config.ts';
import { addInboxOnce, queueInbox, listInbox, type InboxRecord } from './inbox.ts';
import { isProcessAlive } from './lock.ts';
import { listProcs } from './procs.ts';
import { activeStates, isPaused, readState } from './state.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';

export interface WatchState {
  lastTickAt?: string;
  judgment: { path?: string; observed: { hash: string | null; since: string }; lastEmitted?: string | null };
  emittedKeys: string[];
  decided: string[];
  deferredLogged?: string[];
  decisionFailures?: Record<string, number>;
  stalledSince?: string;
  childTimeouts: number;
}
interface WatcherFile {
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
      const procs = await listProcs(root);
      const aliveByPid = new Map<number, boolean>();
      for (const proc of procs) aliveByPid.set(proc.pid, await (options.isProcessAlive ?? isProcessAlive)(proc.pid));
      const brainAlive = procs.some(proc => proc.kind === 'brain' && aliveByPid.get(proc.pid));
      const heartbeat = Math.max(...[state.lastEventAt, state.enteredAt, state.savedAt]
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(Number.isFinite));
      if (activeStates.has(state.state) && state.state !== 'recovering' && !state.userAborted && !brainAlive && state.awaitingUser !== true && Number.isFinite(heartbeat)
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
        const limit = proc.kind === 'brain' ? config.brain.maxTurnMinutes : config.watch.childTimeoutMinutes;
        if (alive && !(minutes > limit)) continue;
        const kind = alive ? 'child-timeout' : 'child-gone';
        if (alive) watch.childTimeouts++;
        await emit({ kind, dedupeKey: `${kind}:${JSON.stringify([proc.pid, proc.startedAt, proc.kind])}`,
          pid: proc.pid, pgid: proc.pgid, runId: proc.runId, procKind: proc.kind,
          ...(alive ? { minutes } : {}) }, true);
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

const watcherKinds = new Set(['judgment-changed', 'stalled', 'child-timeout', 'child-gone', 'recover']);
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
