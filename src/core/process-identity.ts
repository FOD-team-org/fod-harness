import { isProcessAlive } from './lock.ts';
import { processStartedAt, processGroup } from './process-time.ts';
import { groupAlive } from '../provider/runner.ts';
import type { RecordedToolGroup } from './tool-groups.ts';
export interface CodexOwner {
  pid: number; pgid?: number; startedAt?: string; childPid?: number; childStartedAt?: string; toolGroups?: RecordedToolGroup[];
}
export function sameProcessStart(actual: string, expected: string): boolean {
  if (expected.startsWith('spawn:')) return false;
  const a = Date.parse(actual), b = Date.parse(expected);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) <= 2000 : actual === expected;
}
export async function processIdentity(pid: number, startedAt?: string, alive: (pid: number) => boolean | Promise<boolean> = isProcessAlive): Promise<'owned' | 'foreign' | 'unknown' | 'dead'> {
  if (!await alive(pid)) return 'dead';
  const actual = await processStartedAt(pid);
  if (!actual || !startedAt || startedAt.startsWith('spawn:')) return 'unknown';
  return sameProcessStart(actual, startedAt) ? 'owned' : 'foreign';
}
export type Ownership = 'owned' | 'foreign' | 'unknown' | 'gone' | 'orphan' | 'unverified';
export async function codexOwnership(owner: CodexOwner, alive?: (pid: number) => boolean | Promise<boolean>): Promise<Ownership> {
  const leader = await processIdentity(owner.pid, owner.startedAt, alive);
  if (leader !== 'dead') return leader;
  const pgid = owner.pgid ?? owner.pid;
  if (!groupAlive(pgid)) return 'gone';
  if (owner.childPid && owner.childStartedAt) {
    const child = await processIdentity(owner.childPid, owner.childStartedAt);
    if (child === 'unknown') return 'unknown';
    if (child === 'owned') {
      const childGroup = await processGroup(owner.childPid);
      if (childGroup === undefined) return 'unknown';
      if (childGroup === pgid) return 'orphan';
    }
  }
  return 'unverified';
}
