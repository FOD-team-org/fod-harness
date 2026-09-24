import { codexOwnership, type CodexOwner, type Ownership } from './process-identity.ts';
import { reclaimCodexTree } from './proc-tree.ts';
import { verifiedToolGroups, type ReclaimContext } from './tool-groups.ts';
export interface ReclaimResult { reclaimed: boolean; owner: Ownership; skippedGroups: number[]; reason?: 'pid-reused' | 'group-unverified' }
export async function reclaimCodexOwner(owner: CodexOwner, context: ReclaimContext): Promise<ReclaimResult> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.pid === process.pid || owner.pgid !== owner.pid) {
    throw new Error('감독 프로세스 소유권을 확인할 수 없습니다');
  }
  const identity = await codexOwnership(owner);
  if (identity === 'foreign' || identity === 'unverified') {
    const { skippedGroups } = await verifiedToolGroups(owner.toolGroups ?? [], context, false);
    return { reclaimed: true, owner: identity, skippedGroups,
      reason: identity === 'foreign' ? 'pid-reused' : 'group-unverified' };
  }
  if (identity === 'unknown') throw new Error('감독 프로세스 소유권을 확인할 수 없습니다');
  const { groups, skippedGroups } = await verifiedToolGroups(owner.toolGroups ?? [], context);
  if (identity === 'gone') {
    return { reclaimed: !groups.length || await reclaimCodexTree(0, [], groups), owner: identity, skippedGroups };
  }
  return { reclaimed: await reclaimCodexTree(owner.pid, identity === 'owned' ? [owner.pid] : [], groups), owner: identity, skippedGroups };
}
