import { requestCancel, type CancelSource } from './codex-record.ts';
import { codexOwnership, type CodexOwner, type Ownership } from './process-identity.ts';
import { reclaimCodexTree } from './proc-tree.ts';
import { verifiedToolGroups, reportToolResidual, type ReclaimContext } from './tool-groups.ts';
export interface ReclaimResult { reclaimed: boolean; owner: Ownership; skippedGroups: number[]; reason?: 'pid-reused' | 'group-unverified' }
export async function reclaimCodexOwner(owner: CodexOwner, context: ReclaimContext, options: { staleToolsOnly?: boolean; by?: CancelSource } = {}): Promise<ReclaimResult> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.pid === process.pid || owner.pgid !== owner.pid) {
    throw new Error('감독 프로세스 소유권을 확인할 수 없습니다');
  }
  const identity = await codexOwnership(owner);
  // Cleanup/report may reclaim only separately witnessed tools of stale runs.
  // They must never send a signal to a reused supervisor PID or a live run here.
  if (options.staleToolsOnly && identity !== 'gone' && identity !== 'foreign') return { reclaimed: false, owner: identity, skippedGroups: [] };
  if (identity === 'foreign' && !options.staleToolsOnly || identity === 'unverified') {
    const { skippedGroups } = await verifiedToolGroups(owner.toolGroups ?? [], context, false);
    return { reclaimed: true, owner: identity, skippedGroups,
      reason: identity === 'foreign' ? 'pid-reused' : 'group-unverified' };
  }
  if (identity === 'unknown') throw new Error('감독 프로세스 소유권을 확인할 수 없습니다');
  await requestCancel(context.root, context.runId, options.by ?? 'reclaim');
  const { groups, skippedGroups } = await verifiedToolGroups(owner.toolGroups ?? [], context);
  if (identity === 'gone' || identity === 'foreign') {
    const safeGroups = groups.filter(pgid => pgid !== owner.pid);
    if (safeGroups.length !== groups.length) { skippedGroups.push(owner.pid); await reportToolResidual(context, skippedGroups); }
    return { reclaimed: !safeGroups.length || await reclaimCodexTree(0, [], safeGroups), owner: identity, skippedGroups,
      ...(identity === 'foreign' ? { reason: 'pid-reused' as const } : {}) };
  }
  return { reclaimed: await reclaimCodexTree(owner.pid, identity === 'owned' ? [owner.pid] : [], groups), owner: identity, skippedGroups };
}
