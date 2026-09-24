import { processTreeSnapshot } from './proc-tree.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { groupAlive } from '../provider/runner.ts';
import { processIdentity } from './process-identity.ts';
import { processGroup, processStartedAt } from './process-time.ts';
import { appendLedger } from './ledger.ts';

export interface ToolGroup { pgid: number; pid: number; startedAt: string; observedAt?: string }
// Older meta files contain only group numbers; those never authorize a signal.
export type RecordedToolGroup = ToolGroup | number;
export interface ReclaimContext { root: string; runId: string }
export const toolGroupId = (group: RecordedToolGroup): number => typeof group === 'number' ? group : group.pgid;

export async function sampleToolGroups(previous: readonly ToolGroup[], snapshot: { pids: number[]; toolGroups: number[] }): Promise<ToolGroup[]> {
  const observedAt = new Date().toISOString();
  const groups = new Map(previous.filter(group => groupAlive(group.pgid)).map(group => [group.pgid, group]));
  const candidates = new Set(snapshot.toolGroups);
  const refresh = previous.filter(group => groups.has(group.pgid));
  for (const group of refresh) {
    const identity = await processIdentity(group.pid, group.startedAt);
    if (identity !== 'dead' && identity !== 'owned') continue;
    try {
      const members = await processTreeSnapshot(0, [], [], [group.pgid]);
      snapshot = { pids: [...snapshot.pids, ...members.pids], toolGroups: snapshot.toolGroups };
      candidates.add(group.pgid);
    } catch { /* Preserve the old witness when ps is unavailable. */ }
  }
  for (const pid of snapshot.pids) {
    const pgid = await processGroup(pid);
    if (pgid === undefined || !candidates.has(pgid)) continue;
    const startedAt = await processStartedAt(pid);
    if (startedAt && groupAlive(pgid)) {
      const previousGroup = groups.get(pgid);
      if (previousGroup && (!Number.isFinite(Date.parse(previousGroup.observedAt ?? previousGroup.startedAt))
        || !Number.isFinite(Date.parse(startedAt))
        || Date.parse(startedAt) > Date.parse(previousGroup.observedAt ?? previousGroup.startedAt))) continue;
      // Refresh the witness only from a currently observed descendant, never from a saved group number.
      if (groups.has(pgid) || groups.size < 64) groups.set(pgid, { pgid, pid, startedAt, observedAt });
      candidates.delete(pgid);
    }
  }
  return [...groups.values()].filter(group => groupAlive(group.pgid)).slice(0, 64);
}

export async function verifiedToolGroups(recorded: readonly RecordedToolGroup[], context: ReclaimContext, allowSignals = true) {
  const groups: number[] = [], skippedGroups: number[] = [];
  for (const group of recorded) {
    const pgid = toolGroupId(group);
    if (!groupAlive(pgid)) continue;
    if (allowSignals && typeof group !== 'number'
      && Number.isSafeInteger(group.pid) && group.pid > 1 && Number.isSafeInteger(pgid) && pgid > 1
      && await processIdentity(group.pid, group.startedAt) === 'owned'
      && await processGroup(group.pid) === pgid) groups.push(pgid);
    else skippedGroups.push(pgid);
  }
  if (skippedGroups.length) await reportToolResidual(context, skippedGroups);

  return { groups, skippedGroups };
}

export async function reportToolResidual(context: ReclaimContext, skippedGroups: number[], now = Date.now()) {
  const path = harnessPath(context.root, 'harness-tool-residual.json');
  await withFileLock(path, async () => {
    const entries = await readJson<Record<string, { at: number; groups: number[] }>>(path, {});
    const previous = entries[context.runId];
    if (!previous || now - previous.at >= 600000) {
      await appendLedger(context.root, { runId: context.runId, action: 'codex:tool-groups', status: 'skip',
        evidence: { reason: 'tool-group-unverified', skippedGroups } });
      await appendLedger(context.root, { runId: context.runId, action: 'codex:residual', status: 'fail', evidence: { groups: skippedGroups, reportOnly: true } });
      entries[context.runId] = { at: now, groups: skippedGroups };
      await atomicWrite(path, JSON.stringify(entries) + '\n');
    }
  });
}
