import { codexOwnership, type CodexOwner } from './process-identity.ts';
export { sameProcessStart } from './process-identity.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, readJson, withFileLock } from './storage.ts';
import { appendLedger } from './ledger.ts';

export interface SlotOwner { root: string; runId: string; taskId?: string; pid: number; startedAt: string; acquiredAt: string; childPid?: number; childStartedAt?: string }
export interface Slots { codex: SlotOwner | null; claude: null }
export const slotsPath = () => join(process.env.FODH_SLOTS_DIR ?? join(homedir(), '.pi/agent/fod-harness'), 'slots.json');
export async function slotOwnerAlive(owner: CodexOwner & { root?: string; runId?: string }): Promise<boolean> {
  let identity = owner;
  if (!owner.childPid && owner.root && owner.runId && /^[A-Za-z0-9_-]+$/u.test(owner.runId)) {
    const meta = await readJson<Partial<CodexOwner> | undefined>(join(owner.root, '.pi/codex', owner.runId, 'meta.json'), undefined);
    if (meta) identity = { ...owner, childPid: meta.childPid, childStartedAt: meta.childStartedAt };
  }
  return ['owned', 'unknown', 'orphan'].includes(await codexOwnership(identity));
}
export async function acquireSlot(kind: 'codex', owner: SlotOwner): Promise<{ acquired: true } | { acquired: false; owner: SlotOwner }> {
  const path = slotsPath();
  return withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    const previous = slots[kind];
    if (previous && await slotOwnerAlive(previous)) return { acquired: false, owner: previous };
    if (previous) await appendLedger(owner.root, { runId: owner.runId, action: 'slot:stale', status: 'ok', evidence: { owner: previous } });
    slots[kind] = owner;
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
    return { acquired: true };
  });
}
export async function updateSlot(kind: 'codex', runId: string, patch: Partial<Pick<SlotOwner, 'pid' | 'startedAt' | 'childPid' | 'childStartedAt'>>): Promise<void> {
  const path = slotsPath();
  await withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    if (slots[kind]?.runId !== runId) throw new Error('Codex 슬롯 소유권을 잃었습니다');
    slots[kind] = { ...slots[kind]!, ...patch };
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
  });
}
export async function releaseSlot(kind: 'codex', runId: string): Promise<void> {
  const path = slotsPath();
  await withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    if (slots[kind]?.runId !== runId) return;
    slots[kind] = null;
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
  });
}
export async function slotsStatus() {
  const slots = await readJson<Slots>(slotsPath(), { codex: null, claude: null });
  return { ...slots, alive: { codex: slots.codex ? await slotOwnerAlive(slots.codex) : false, claude: false } };
}
