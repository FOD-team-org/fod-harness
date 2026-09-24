import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  stalledSince?: string;
  childTimeouts: number;
}
interface WatcherFile {
  judgment?: { expectedHash?: string; [key: string]: unknown };
  watch?: WatchState;
  [key: string]: unknown;
}
export interface WatcherStatus {
  lastTickAt: string | null;
  judgment: { observedHash: string | null; stableFor: number; expectedHash: string | null };
  stalledSince?: string;
  childTimeouts: number;
}
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
  return summary(await readJson<WatcherFile>(harnessPath(root, 'harness-watcher.json'), {}), now);
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
    const watch: WatchState = file.watch ?? {
      judgment: { observed: { hash: null, since: at } }, emittedKeys: [], childTimeouts: 0,
    };
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
    if (hash !== null) {
      if (hash === expectedHash) watch.judgment.lastEmitted = hash;
      else if (hash !== watch.judgment.lastEmitted && now - Date.parse(watch.judgment.observed.since) >= config.watch.stableSeconds * 1000) {
        await emit({ kind: 'judgment-changed', dedupeKey: `judgment:${judgmentPath}:${hash}`,
          path: judgmentPath, hashBefore: watch.judgment.lastEmitted ?? expectedHash ?? null, hashAfter: hash, size: content!.length });
        watch.judgment.lastEmitted = hash;
      }
    }
    if (!options.judgmentOnly) {
      const state = await readState(root);
      const heartbeat = Math.max(...[state.lastEventAt, state.enteredAt, state.savedAt]
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(Number.isFinite));
      if (activeStates.has(state.state) && state.awaitingUser !== true && Number.isFinite(heartbeat)
        && now - heartbeat > config.watch.stallMinutes * 60000) {
        watch.stalledSince = new Date(heartbeat).toISOString();
        await emit({ kind: 'stalled', dedupeKey: `stalled:${JSON.stringify([state.state, state.runId ?? state.enteredAt])}`,
          state: state.state, task: state.taskId, lastEventAt: state.lastEventAt, runId: state.runId,
          minutes: (now - heartbeat) / 60000 }, true);
      } else delete watch.stalledSince;
      watch.childTimeouts = 0;
      for (const proc of await listProcs(root)) {
        const alive = await (options.isProcessAlive ?? isProcessAlive)(proc.pid);
        const minutes = (now - Date.parse(proc.startedAt.replace(/^spawn:/u, ''))) / 60000;
        const limit = proc.kind === 'brain' ? config.brain.maxTurnMinutes : config.watch.childTimeoutMinutes;
        if (alive && !(minutes > limit)) continue;
        const kind = alive ? 'child-timeout' : 'child-gone';
        if (alive) watch.childTimeouts++;
        await emit({ kind, dedupeKey: `${kind}:${JSON.stringify([proc.pid, proc.startedAt, proc.kind])}`,
          pid: proc.pid, pgid: proc.pgid, runId: proc.runId, procKind: proc.kind,
          ...(alive ? { minutes } : {}) }, true);
      }
    }
    watch.lastTickAt = at;
    file.watch = watch;
    await atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
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
