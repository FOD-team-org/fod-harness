import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isProcessAlive } from './lock.ts';
import { groupAlive } from '../provider/runner.ts';
const execute = promisify(execFile);
type Row = { pid: number; ppid: number; pgid: number };
function rows(stdout: string): Row[] {
  return stdout.split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    .filter(row => row.length === 3 && row.every(Number.isSafeInteger) && row[0] > 1)
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}
export function parseProcessTree(stdout: string, rootPgid: number, rootPids: readonly number[], excludePids: readonly (number | undefined)[] = [], deadPids: readonly number[] = [], toolGroups: readonly number[] = []): number[] {
  const dead = new Set(deadPids), entries = rows(stdout).filter(row => !dead.has(row.pid));
  const found = new Set(rootPids.filter(pid => Number.isSafeInteger(pid) && pid > 1 && !dead.has(pid)));
  const groups = new Set([rootPgid, ...toolGroups].filter(pgid => pgid > 1));
  for (;;) {
    const size = found.size;
    for (const { pid, ppid, pgid } of entries) {
      if (groups.has(pgid) || found.has(ppid) || found.has(pgid)) found.add(pid);
    }
    if (size === found.size) break;
  }
  return entries.filter(({ pid }) => found.has(pid) && !excludePids.includes(pid)).map(({ pid }) => pid);
}
export async function processTreeSnapshot(rootPgid: number, rootPids: readonly number[], deadPids: readonly number[] = [], toolGroups: readonly number[] = []) {
  const pending = execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 1000 });
  const self = pending.child.pid;
  const { stdout } = await pending;
  const pids = parseProcessTree(stdout, rootPgid, rootPids, [process.pid, self], deadPids, toolGroups);
  const selected = new Set(pids);
  return { pids, toolGroups: [...new Set(rows(stdout).filter(row => selected.has(row.pid) && row.pgid > 1 && row.pgid !== rootPgid).map(row => row.pgid))] };
}
export async function processTree(rootPgid: number, rootPids: readonly number[], deadPids: readonly number[] = [], toolGroups: readonly number[] = []): Promise<number[]> {
  return (await processTreeSnapshot(rootPgid, rootPids, deadPids, toolGroups)).pids;
}
// Take the snapshot before any signal; never seed another snapshot with a PID observed dead.
export async function reclaimCodexTree(rootPgid: number, rootPids: readonly number[] = [], toolGroups: readonly number[] = []): Promise<boolean> {
  if (!Number.isSafeInteger(rootPgid) || rootPgid < 0 || rootPgid === 1) return false;
  const known = new Set<number>(), dead = new Set<number>();
  const groups = new Set([rootPgid, ...toolGroups].filter(pgid => Number.isSafeInteger(pgid) && pgid > 1));
  let initial = true;
  const remaining = async () => {
    const seeds = new Set([...known, ...(initial ? rootPids : [])]); initial = false;
    for (const pid of seeds) if (!dead.has(pid) && !isProcessAlive(pid)) dead.add(pid);
    for (const pgid of groups) if (!groupAlive(pgid)) groups.delete(pgid);
    const liveRoots = [...seeds].filter(pid => !dead.has(pid));
    const snapshot = await processTreeSnapshot(groups.has(rootPgid) ? rootPgid : 0, liveRoots, [...dead], [...groups]);
    for (const pgid of snapshot.toolGroups) if (groupAlive(pgid)) groups.add(pgid);
    for (const pid of snapshot.pids) if (!dead.has(pid)) known.add(pid);
    for (const pid of known) if (!isProcessAlive(pid)) dead.add(pid);
    return [...known].filter(pid => pid !== process.pid && !dead.has(pid));
  };
  const signal = (pids: number[], name: NodeJS.Signals) => {
    for (const pid of [...pids].reverse()) {
      if (dead.has(pid)) continue;
      try { process.kill(pid, name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') dead.add(pid); else throw error; }
    }
  };
  const empty = (pids: number[]) => !pids.length && ![...groups].some(pgid => pgid !== process.pid && groupAlive(pgid));
  signal(await remaining(), 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (empty(await remaining())) return true;
    await delay(50);
  }
  signal(await remaining(), 'SIGKILL');
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (empty(await remaining())) return true;
    await delay(50);
  }
  return empty(await remaining());
}

export interface ProcessSnapshotRow { pid: number; ppid: number; startedAt: string; command: string; root?: string }
export function parseCommandSnapshot(text: string): ProcessSnapshotRow[] {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3], command: match[4] }] : [];
  });
}
export type SnapshotExec = (file: string, args: string[], options: { timeout: number; maxBuffer?: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
export async function commandSnapshot(run: SnapshotExec = (file, args, options) => execute(file, args, options)): Promise<ProcessSnapshotRow[]> {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
    timeout: 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  return parseCommandSnapshot(stdout);
}
export async function processCwd(pid: number, run: SnapshotExec = (file, args, options) => execute(file, args, options)): Promise<string | undefined> {
  try {
    const { stdout } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return stdout.split('\n').find(line => line.startsWith('n/'))?.slice(1);
  } catch { return undefined; }
}
// Preserve the first-candidate API for callers that only need detection.
export function externalCodex(snapshot: ProcessSnapshotRow[], self = process.pid): ProcessSnapshotRow | undefined {
  return externalCodexCandidates(snapshot, self)[0];
}
export function externalCodexCandidates(snapshot: ProcessSnapshotRow[], self = process.pid): ProcessSnapshotRow[] {
  const byPid = new Map(snapshot.map(row => [row.pid, row]));
  const ancestors = (pid: number) => {
    const chain: ProcessSnapshotRow[] = [], seen = new Set<number>();
    for (let depth = 0; depth < 30; depth++) {
      const row = byPid.get(pid);
      if (!row || seen.has(row.pid)) break;
      seen.add(row.pid); chain.push(row); pid = row.ppid;
    }
    return chain;
  };
  const ours = new Set(ancestors(self).map(row => row.pid));
  const candidates = snapshot.filter(row => row.pid > 1 && row.pid !== self && !ours.has(row.pid)
    && /codex-companion\.mjs\s+task\b|(?:^|\/)codex\s+exec\b/u.test(row.command)
    && !ancestors(row.pid).some(parent => parent.pid === self || /fodh-codex-supervisor|\/Applications\/(?:ChatGPT|Codex)\.app\//u.test(parent.command)));
  const ids = new Set(candidates.map(row => row.pid)), outer = new Set<number>();
  for (const candidate of candidates) {
    const seen = new Set([candidate.pid]);
    let pid = candidate.ppid;
    while (!seen.has(pid)) {
      seen.add(pid);
      if (ids.has(pid)) outer.add(pid);
      const parent = byPid.get(pid);
      if (!parent) break;
      pid = parent.ppid;
    }
  }
  return candidates.filter(row => !outer.has(row.pid));
}
