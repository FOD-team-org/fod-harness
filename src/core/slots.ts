import { commandSnapshot, externalCodexCandidates, processCwd, type ProcessSnapshotRow } from './proc-tree.ts';
import { loadConfig, type HarnessConfig } from './config.ts';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { workspaceMembers } from './workspace.ts';
import { listWorktrees } from './worktree.ts';
import { redact } from '../provider/privacy.ts';
import { codexOwnership, processIdentity, type CodexOwner } from './process-identity.ts';
export { sameProcessStart } from './process-identity.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { appendLedger } from './ledger.ts';

export interface SlotOwner { external?: boolean; kind?: 'codex' | 'heavy'; root: string; runId: string; taskId?: string; pid: number; startedAt: string; acquiredAt: string; childPid?: number; childStartedAt?: string }
export interface Slots { codex: SlotOwner | null; heavy?: SlotOwner | null; claude: null }
export const slotsPath = (root: string) => harnessPath(root, 'harness-slots.json');
// Match config's prospectiveRealpath: normalize existing ancestors, but never
// reinterpret dangling symlinks as future directories.
async function prospectiveRealpath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    if (await lstat(path).then(entry => entry.isSymbolicLink(), () => false)) throw error;
    return resolve(await prospectiveRealpath(dirname(path)), basename(path));
  }
}
async function projectAreas(root: string, config: HarnessConfig, failed: (error: unknown) => Promise<void>): Promise<string[]> {
  const areas = [await prospectiveRealpath(resolve(root))];
  const add = async (path: string) => {
    try { areas.push(await prospectiveRealpath(resolve(path))); }
    catch (error) { await failed(error); }
  };
  // Resolve members independently: one unavailable member must not erase others.
  const memberConfigs = config.workspace ? Object.entries(config.workspace.repos).map(([name, member]) =>
    ({ ...config, workspace: { repos: { [name]: member } } })) : [config];
  for (const memberConfig of memberConfigs) {
    try {
      const [member] = await workspaceMembers(root, memberConfig);
      await add(member.path);
      const parent = resolve(member.path, member.worktrees.root ?? '..');
      const entries = await readdir(parent, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.name.startsWith(member.worktrees.prefix)) continue;
        try {
          const path = join(parent, entry.name);
          if (entry.isDirectory() || entry.isSymbolicLink() && (await stat(path)).isDirectory()) await add(path);
        } catch (error) { await failed(error); }
      }
    } catch (error) { await failed(error); }
  }
  try {
    const listed = await listWorktrees(root);
    // Only harness registrations belong to (d), not every Git worktree/toplevel.
    for (const item of listed.worktrees) await add(item.path);
  } catch (error) { await failed(error); }
  return areas;
}
interface CommandWord { value: string; start: number; end: number }
// Keep source offsets and quoted words without relying on shell command groups.
// ps usually loses argv quoting; offsets preserve repeated spaces in path guesses.
function locationWords(text: string): CommandWord[] {
  const words: CommandWord[] = [];
  let at = 0;
  while (at < text.length) {
    while (/\s/u.test(text[at] ?? '') && at < text.length) at++;
    if (at === text.length || /[;&|]/u.test(text[at])) break;
    const start = at;
    let value = '', quote = '';
    while (at < text.length) {
      const char = text[at];
      if (!quote && /[\s;&|]/u.test(char)) break;
      if (char === '\\' && quote !== "'") { at++; value += text[at++] ?? ''; }
      else if (quote) { if (char === quote) quote = ''; else value += char; at++; }
      else if (char === '"' || char === "'") { quote = char; at++; }
      else { value += char; at++; }
    }
    words.push({ value, start, end: at });
  }
  return words;
}
async function candidateRoot(candidate: ProcessSnapshotRow, cwdOf: (pid: number) => Promise<string | undefined>): Promise<string | undefined> {
  try {
    const command = /(?:^|[\s/])codex-companion\.mjs\s+task\b|(?:^|[\s/])codex\s+exec\b/u.exec(candidate.command);
    if (!command) return undefined;
    const tail = candidate.command.slice(command.index + command[0].length);
    const words = locationWords(tail);
    let first: CommandWord | undefined, next = 0;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (['-C', '--cd', '--cwd', '--root', '--project-root'].includes(word.value)) {
        first = words[i + 1];
        if (!first || first.value.startsWith('-')) return undefined;
        next = i + 2; break;
      }
      const match = /^(?:-C|--cd|--cwd|--root|--project-root)=(.*)$/u.exec(word.value);
      if (match) { first = { ...word, value: match[1] }; next = i + 1; break; }
    }
    if (!first) {
      const cwd = await cwdOf(candidate.pid);
      return cwd && isAbsolute(cwd) ? await prospectiveRealpath(resolve(cwd)) : undefined;
    }
    if (!first.value) return undefined;
    const cwd = isAbsolute(first.value) ? undefined : await cwdOf(candidate.pid);
    if (!isAbsolute(first.value) && (!cwd || !isAbsolute(cwd))) return undefined;
    const guesses = [first.value];
    let previous = first;
    for (const word of words.slice(next)) {
      if (word.value.startsWith('-')) break;
      guesses.push(guesses.at(-1)! + tail.slice(previous.end, word.start) + word.value);
      previous = word;
    }
    let longest: string | undefined;
    for (const guess of guesses) {
      const path = isAbsolute(guess) ? resolve(guess) : resolve(cwd!, guess);
      try { await stat(path); longest = await prospectiveRealpath(path); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    if (longest) return longest;
    return guesses.length === 1 ? await prospectiveRealpath(isAbsolute(first.value) ? resolve(first.value) : resolve(cwd!, first.value)) : undefined;
  } catch { return undefined; }
}
function within(path: string, area: string): boolean {
  const child = relative(area, path);
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

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
export async function acquireSlot(kind: 'codex' | 'heavy', owner: SlotOwner, options: { snapshot?: () => Promise<ProcessSnapshotRow[]>; alive?: typeof slotOwnerAlive; cwdOf?: (pid: number) => Promise<string | undefined> } = {}): Promise<{ acquired: true } | { acquired: false; owner: SlotOwner }> {
  const path = slotsPath(owner.root);
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
    if (kind === 'codex') {
      const failed = async (stage: 'config' | 'ps' | 'areas', error: unknown) => {
        await appendLedger(owner.root, { runId: owner.runId, action: 'slot:external-scan', status: 'fail',
          evidence: { stage, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) } });
      };
      let config: HarnessConfig | undefined;
      try { config = await loadConfig(owner.root); }
      catch (error) { await failed('config', error); }
      // Configuration failure keeps the guard enabled with only the harness root.
      if (!config || config.delegate.codex.externalGuard) {
        let candidates: ProcessSnapshotRow[] = [];
        try { candidates = externalCodexCandidates(await (options.snapshot ?? commandSnapshot)()); }
        catch (error) { await failed('ps', error); }
        if (candidates.length) {
          let areas = [await prospectiveRealpath(resolve(owner.root))];
          if (config) {
            try { areas = await projectAreas(owner.root, config, error => failed('areas', error)); }
            catch (error) { await failed('areas', error); }
          }
          for (const candidate of candidates) {
            const root = await candidateRoot(candidate, options.cwdOf ?? processCwd);
            if (!root) {
              await appendLedger(owner.root, { runId: owner.runId, action: 'slot:external-unlocated', status: 'ok',
                evidence: { pid: candidate.pid, command: redact(candidate.command).slice(0, 200) } });
              continue;
            }
            if (!areas.some(area => within(root, area))) continue;
            const external: SlotOwner = { external: true, root, runId: `external-${candidate.pid}`,
              pid: candidate.pid, startedAt: candidate.startedAt, acquiredAt: new Date().toISOString() };
            slots.codex = external;
            await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
            return { acquired: false, owner: external };
          }
        }
      }
    }
    slots[kind] = kind === 'heavy' ? { ...owner, kind } : owner;
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
    return { acquired: true };
  });
}
export async function updateSlot(root: string, kind: 'codex' | 'heavy', runId: string, patch: Partial<Pick<SlotOwner, 'pid' | 'startedAt' | 'childPid' | 'childStartedAt'>>): Promise<void> {
  const path = slotsPath(root);
  await withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    if (slots[kind]?.runId !== runId) throw new Error('Codex 슬롯 소유권을 잃었습니다');
    slots[kind] = { ...slots[kind]!, ...patch };
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
  });
}
export async function releaseSlot(root: string, kind: 'codex' | 'heavy', runId: string): Promise<void> {
  const path = slotsPath(root);
  await withFileLock(path, async () => {
    const slots = await readJson<Slots>(path, { codex: null, claude: null });
    if (slots[kind]?.runId !== runId) return;
    slots[kind] = null;
    await atomicWrite(path, JSON.stringify(slots, null, 2) + '\n');
  });
}
export async function slotsStatus(root: string) {
  const slots = await readJson<Slots>(slotsPath(root), { codex: null, claude: null });
  return { path: slotsPath(root), ...slots, heavy: slots.heavy ?? null, alive: { heavy: slots.heavy ? await slotOwnerAlive({ ...slots.heavy, kind: 'heavy' }) : false, codex: slots.codex ? await slotOwnerAlive(slots.codex) : false, claude: false } };
}
