import { groupAlive } from '../provider/runner.ts';
import { processIdentity } from './process-identity.ts';
import { processGroup, processStartedAt } from './process-time.ts';
import { appendLedger } from './ledger.ts';

export interface ToolGroup { pgid: number; pid: number; startedAt: string }
// Older meta files contain only group numbers; those never authorize a signal.
export type RecordedToolGroup = ToolGroup | number;
export interface ReclaimContext { root: string; runId: string }
export const toolGroupId = (group: RecordedToolGroup): number => typeof group === 'number' ? group : group.pgid;

export async function sampleToolGroups(previous: readonly ToolGroup[], snapshot: { pids: number[]; toolGroups: number[] }): Promise<ToolGroup[]> {
  const groups = new Map(previous.filter(group => groupAlive(group.pgid)).map(group => [group.pgid, group]));
  const candidates = new Set(snapshot.toolGroups);
  for (const pid of snapshot.pids) {
    const pgid = await processGroup(pid);
    if (pgid === undefined || !candidates.has(pgid)) continue;
    const startedAt = await processStartedAt(pid);
    if (startedAt && groupAlive(pgid)) {
      // Refresh the witness only from a currently observed descendant, never from a saved group number.
      if (groups.has(pgid) || groups.size < 64) groups.set(pgid, { pgid, pid, startedAt });
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
  if (skippedGroups.length) await appendLedger(context.root, { runId: context.runId, action: 'codex:tool-groups', status: 'skip',
    evidence: { reason: 'tool-group-unverified', skippedGroups } });
  return { groups, skippedGroups };
}
