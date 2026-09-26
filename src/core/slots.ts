import { commandSnapshot, externalCodex, type ProcessSnapshotRow } from './proc-tree.ts';
import { loadConfig } from './config.ts';
import { commandWords } from '../../hooks/shell-commands.mjs';
import { shellParts } from '../../hooks/shell-parts.mjs';
import { resolve } from 'node:path';
import { codexOwnership, processIdentity, type CodexOwner } from './process-identity.ts';
export { sameProcessStart } from './process-identity.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, readJson, withFileLock } from './storage.ts';
import { appendLedger } from './ledger.ts';

export interface SlotOwner { external?: boolean; kind?: 'codex' | 'heavy'; root: string; runId: string; taskId?: string; pid: number; startedAt: string; acquiredAt: string; childPid?: number; childStartedAt?: string }
export interface Slots { codex: SlotOwner | null; heavy?: SlotOwner | null; claude: null }
export const slotsPath = () => join(process.env.FODH_SLOTS_DIR ?? join(homedir(), '.pi/agent/fod-harness'), 'slots.json');
export async function slotOwnerIdentity(owner: CodexOwner & { root?: string; runId?: string; kind?: string; external?: boolean }) {
  if (owner.external) {
    const identity = await processIdentity(owner.pid, owner.startedAt);
    return identity === 'dead' ? 'gone' : identity;
  }
  if (owner.kind === 'heavy') {
    return processIdentity(owner.pid, owner.startedAt);
  }
  let identity = owner;
  if (!owner.childPid && owner.root && owner.runId && /^[A-Za-z0-9_-]+$/u.test(owner.runId)) {
    const meta = await readJson<Partial<CodexOwner> | undefined>(join(owner.root, '.pi/codex', owner.runId, 'meta.json'), undefined);
    if (meta) identity = { ...owner, childPid: meta.childPid, childStartedAt: meta.childStartedAt };
  }
  return codexOwnership(identity);
}
export async function slotOwnerAlive(owner: CodexOwner & { root?: string; runId?: string; kind?: string; external?: boolean }): Promise<boolean> {
  return ['owned', 'unknown', 'orphan'].includes(await slotOwnerIdentity(owner));
}
export async function acquireSlot(kind: 'codex' | 'heavy', owner: SlotOwner, options: { snapshot?: () => Promise<ProcessSnapshotRow[]>; alive?: typeof slotOwnerAlive } = {}): Promise<{ acquired: true } | { acquired: false; owner: SlotOwner }> {
  const path = slotsPath();
  return withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    const other = kind === 'codex' ? 'heavy' : 'codex';
    for (const slot of [other, kind] as const) {
      const held = slots[slot];
      if (held && await (options.alive ?? slotOwnerAlive)({ ...held, kind: slot })) return { acquired: false, owner: held };
      if (held) {
        await appendLedger(owner.root, { runId: owner.runId, action: 'slot:stale', status: 'ok', evidence: { slot, owner: held } });
        slots[slot] = null;
      }
    }
    if (kind === 'codex' && (await loadConfig(owner.root)).delegate.codex.externalGuard) {
      let detected: ProcessSnapshotRow | undefined;
      try { detected = externalCodex(await (options.snapshot ?? commandSnapshot)()); }
      catch { await appendLedger(owner.root, { runId: owner.runId, action: 'slot:external-scan', status: 'fail' }); }
      if (detected) {
        const words = commandWords(shellParts(detected.command).groups[0] ?? []);
        const index = words.findIndex(word => ['-C', '--cd', '--cwd', '--root', '--project-root'].includes(word));
        const argRoot = index >= 0 ? words[index + 1] : words.find(word => /^--(?:cd|cwd|root|project-root)=/.test(word))?.split('=').slice(1).join('=');
        const external: SlotOwner = { external: true, root: argRoot?.startsWith('/') ? resolve(argRoot) : detected.root ?? owner.root,
          runId: `external-${detected.pid}`, pid: detected.pid, startedAt: detected.startedAt, acquiredAt: new Date().toISOString() };
        slots.codex = external;
        await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
        return { acquired: false, owner: external };
      }
    }
    slots[kind] = kind === 'heavy' ? { ...owner, kind } : owner;
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
    return { acquired: true };
  });
}
export async function updateSlot(kind: 'codex' | 'heavy', runId: string, patch: Partial<Pick<SlotOwner, 'pid' | 'startedAt' | 'childPid' | 'childStartedAt'>>): Promise<void> {
  const path = slotsPath();
  await withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    if (slots[kind]?.runId !== runId) throw new Error('Codex 슬롯 소유권을 잃었습니다');
    slots[kind] = { ...slots[kind]!, ...patch };
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
  });
}
export async function releaseSlot(kind: 'codex' | 'heavy', runId: string): Promise<void> {
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
  return { ...slots, heavy: slots.heavy ?? null, alive: { heavy: slots.heavy ? await slotOwnerAlive({ ...slots.heavy, kind: 'heavy' }) : false, codex: slots.codex ? await slotOwnerAlive(slots.codex) : false, claude: false } };
}
