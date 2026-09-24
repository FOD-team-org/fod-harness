import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readdir, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative, sep } from 'node:path';
import { loadConfig } from './config.ts';
import { readState } from './state.ts';
import { listBacklog, setTask } from './backlog.ts';
import { listProcs, removeProc, type ProcRecord } from './procs.ts';
import { readMeta, finishRun } from './codex-record.ts';
import { reclaimCodexOwner } from './codex-reclaim.ts';
import { appendLedger } from './ledger.ts';
import { atomicWrite, harnessPath, withFileLock } from './storage.ts';
import { redact } from '../provider/privacy.ts';
import { removeWorktree } from './worktree.ts';
import { processIdentity } from './process-identity.ts';
import { groupAlive } from '../provider/runner.ts';
import { sampleMemory } from './memory.ts';
const execute = promisify(execFile);
export type CleanupScope = 'processes' | 'storage' | 'worktrees' | 'all';
export interface CleanupOptions { scope: CleanupScope; taskId?: string; dryRun?: boolean; sessionId?: string }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
const summary = (p: ProcRecord) => ({ pid: p.pid, kind: p.kind, taskId: p.taskId, ...(p.cmd ? { cmd: redact(p.cmd).slice(0, 200) } : {}) });
export async function protectedProcessGroups(root: string, records: ProcRecord[]) {
  const config = await loadConfig(root), state = await readState(root);
  const groups = new Set(records.filter(p => p.kind === 'brain'
    || config.cleanup.processes.neverKill.some(pattern => p.cmd?.includes(pattern))
    || state.delegation?.runId === p.runId || Date.parse(p.protectedUntil ?? '') > Date.now()).map(p => p.pgid));
  for (const p of records) {
    if (p.kind === 'verify' && p.ownerPid && await processIdentity(p.pid, p.startedAt) === 'owned'
      && await processIdentity(p.ownerPid, p.ownerStartedAt) === 'owned') groups.add(p.pgid);
  }
  return groups;
}
export async function isStaleProcess(record: ProcRecord) {
  const identity = await processIdentity(record.pid, record.startedAt);
  return identity === 'foreign' || identity === 'dead' && !groupAlive(record.pgid);
}
export async function retireStaleProcess(root: string, record: ProcRecord) {
  const meta = record.kind === 'codex' ? await readMeta(root, record.runId) : undefined;
  if (meta && !meta.finishedAt) await finishRun(root, record.runId, { status: 'lost', exit: null });
  await removeProc(root, record.pid, record.runId);
}
// Shared by run and report: never retire a Codex record before its separate
// tool groups are reclaimed or explicitly left as residual evidence.
export async function cleanupStaleProcess(root: string, record: ProcRecord): Promise<'stale' | 'residual' | undefined> {
  const meta = record.kind === 'codex' ? await readMeta(root, record.runId) : undefined;
  if (meta?.toolGroups?.length) {
    const outcome = await reclaimCodexOwner({ ...record, childPid: meta.childPid, childStartedAt: meta.childStartedAt,
      toolGroups: meta.toolGroups }, { root, runId: record.runId }, { staleToolsOnly: true, by: 'cleanup' });
    if (outcome.owner !== 'gone' && outcome.owner !== 'foreign') return undefined;
    if (!outcome.reclaimed || outcome.skippedGroups.length) return 'residual';
  } else if (!await isStaleProcess(record)) return undefined;
  await retireStaleProcess(root, record);
  return 'stale';
}
async function processes(root: string, options: CleanupOptions) {
  const config = await loadConfig(root), records = await listProcs(root);
  const result = { ok: true, classified: records.map(record => ({ pid: record.pid, patterns: config.cleanup.processes.killPatterns.filter(pattern => record.cmd?.includes(pattern)) })), reclaimed: [] as ReturnType<typeof summary>[], protected: [] as ReturnType<typeof summary>[],
    unverified: [] as ReturnType<typeof summary>[], residual: [] as ReturnType<typeof summary>[], stale: [] as ReturnType<typeof summary>[], planned: [] as ReturnType<typeof summary>[] };
  const protectedGroups = await protectedProcessGroups(root, records);
  for (const record of records) {
    if (options.taskId && record.taskId !== options.taskId || options.sessionId && record.sessionId !== options.sessionId) continue;
    const item = summary(record);
    if (protectedGroups.has(record.pgid)) { result.protected.push(item); continue; }
    if (options.dryRun) { result.planned.push(item); continue; }
    try {
      const stale = await cleanupStaleProcess(root, record);
      if (stale) { result[stale].push(item); continue; }
      if (record.startedAt.startsWith('spawn:') || record.kind === 'verify' && await processIdentity(record.pid, record.startedAt) !== 'owned') { result.unverified.push(item); continue; }
      const meta = record.kind === 'codex' ? await readMeta(root, record.runId) : undefined;
      const outcome = await reclaimCodexOwner({ ...record, childPid: meta?.childPid, childStartedAt: meta?.childStartedAt, toolGroups: meta?.toolGroups }, { root, runId: record.runId }, { by: 'cleanup' });
      if (outcome.owner === 'foreign' || outcome.owner === 'gone') {
        if (!outcome.reclaimed || outcome.skippedGroups.length) result.residual.push(item);
        else { await retireStaleProcess(root, record); result.stale.push(item); }
        continue;
      }
      if (outcome.owner === 'unverified' || outcome.owner === 'unknown') { result.unverified.push(item); continue; }
      if (!outcome.reclaimed || outcome.skippedGroups.length) { result.residual.push(item); continue; }
      if (meta && !meta.finishedAt) await finishRun(root, record.runId, { status: 'cancelled', exit: null });
      await removeProc(root, record.pid, record.runId); result.reclaimed.push(item);
    } catch { result.residual.push(item); }
  }
  result.ok = !result.residual.length && !result.unverified.length;
  return result;
}
// Reject traversal and every symlink component before deletion. A root/ancestor of a
// keep path is protected too, because recursive removal would otherwise erase it.
export async function cleanupPath(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).some(part => part === '..') || /[*?\[\]{}\0]/u.test(path)) throw new Error('상대 경로·심링크 없는 경로만 정리할 수 있습니다');
  const base = await realpath(root), target = resolve(base, path);
  if (target === base || !inside(base, target)) throw new Error('프로젝트 루트는 정리할 수 없습니다');
  let current = base;
  for (const part of relative(base, target).split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('심링크 경로는 정리할 수 없습니다');
  }
  const canonical = await realpath(target);
  if (!inside(base, canonical)) throw new Error('프로젝트 밖 경로입니다');
  return canonical;
}
async function sizeKB(path: string) { return Number((await execute('du', ['-sk', path], { timeout: 10000 })).stdout.trim().split(/\s/u)[0]); }
async function resources(threshold: number) {
  let disk: { usedPercent: number; availableGB: number } | undefined;
  try {
    const line = (await execute('df', ['-k', '/'], { timeout: 3000 })).stdout.trim().split('\n').at(-1)!.trim().split(/\s+/u);
    disk = { usedPercent: Number(line[4].replace('%', '')), availableGB: Number(line[3]) / 1024 ** 2 };
  } catch { /* diagnostic only */ }
  return { disk, memory: await sampleMemory(threshold) };
}
async function storage(root: string, options: CleanupOptions) {
  const config = (await loadConfig(root)).cleanup, state = await readState(root);
  const deleted: { path: string; sizeKB: number }[] = [], planned: typeof deleted = [], kept: { path: string; reason: string }[] = [];
  let ok = true;
  const before = await resources(config.swapWarnGB), keep: string[] = [];
  for (const path of config.keepPaths) {
    try { keep.push(await realpath(resolve(root, path))); }
    catch { keep.push(resolve(root, path)); }
  }
  const worktreePaths = await Promise.all((state.worktrees ?? []).map(w => realpath(w.path).catch(() => resolve(root, w.path))));
  const protectedPaths = [resolve(root, '.pi'), resolve(root, '.git'), ...worktreePaths, ...keep];
  const erase = async (path: string, internal = false) => {
    try {
      const target = await cleanupPath(root, path);
      if ((internal ? [...keep, ...worktreePaths] : protectedPaths).some(p => inside(p, target) || inside(target, p))) { kept.push({ path, reason: 'keepPaths/하네스 증거 보호' }); return; }
      const entry = { path, sizeKB: await sizeKB(target) };
      if (options.dryRun) planned.push(entry);
      else {
        if (await cleanupPath(root, path) !== target) throw new Error('삭제 직전 경로 변경 감지');
        if ((await lstat(target)).isSymbolicLink()) throw new Error('삭제 직전 심링크 변경 감지');
        await rm(target, { recursive: true, force: true }); deleted.push(entry);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') ok = false;
      kept.push({ path, reason: redact((error as Error).message).slice(0, 200) });
    }
  };
  for (const path of config.rebuildablePaths) await erase(path);
  const tasks = await listBacklog(root), threads = new Set(tasks.map(task => task.codexThread).filter(Boolean));
  let names: string[] = [];
  try { names = await readdir(await cleanupPath(root, '.pi/codex')); } catch { /* absent or unsafe */ }
  const runs = [];
  for (const name of names.filter(n => /^[A-Za-z0-9_-]+$/u.test(n))) {
    try { await cleanupPath(root, `.pi/codex/${name}/meta.json`); const meta = await readMeta(root, name); if (meta?.runId === name && meta.finishedAt && Number.isFinite(Date.parse(meta.finishedAt))) runs.push(meta); } catch { /* preserve malformed/untrusted entries */ }
  }
  runs.sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!));
  for (const meta of runs.slice(config.codexRunsKeep)) {
    if (state.delegation?.runId === meta.runId || threads.has(meta.threadId) || threads.has(meta.runId)) {
      for (const name of ['events.jsonl', 'stderr.txt']) await erase(`.pi/codex/${meta.runId}/${name}`, true);
      kept.push({ path: `.pi/codex/${meta.runId}`, reason: 'delegation/codexThread 증거 보존' });
    } else await erase(`.pi/codex/${meta.runId}`, true);
  }
  const sharedCaches = [];
  if (config.sharedCaches.enabled) for (const path of config.sharedCaches.paths) {
    sharedCaches.push({ path: redact(path), sizeKB: await sizeKB(path).catch(() => null), reportOnly: true });
  }
  return { ok, before, after: await resources(config.swapWarnGB), deleted, planned, kept, sharedCaches };
}
async function worktrees(root: string, options: CleanupOptions) {
  const state = await readState(root), tasks = await listBacklog(root);
  const removed: string[] = [], planned: string[] = [], kept: { taskId: string; path: string; reason: string }[] = [];
  let ok = true;
  for (const item of state.worktrees ?? []) {
    if (options.taskId && item.taskId !== options.taskId) continue;
    const completed = tasks.find(t => t.id === item.taskId)?.status === 'done'
      || state.state === 'CLEANUP' && state.taskId === item.taskId && options.taskId === item.taskId;
    let reason = !completed ? 'task 미완료' : state.delegation?.taskId === item.taskId ? '위임 진행 중' : '';
    if (!reason) {
      try {
        if ((await execute('git', ['-C', item.path, 'status', '--porcelain'], { timeout: 10000 })).stdout.trim()) reason = '작업 트리 변경 있음';
        else if (options.dryRun) planned.push(item.path);
        else { await removeWorktree(root, item.taskId, false); removed.push(item.path); }
      } catch (error) { ok = false; reason = redact((error as Error).message).slice(0, 200); }
    }
    if (reason) kept.push({ ...item, reason });
  }
  return { ok, removed, planned, kept };
}
export async function runCleanup(root: string, options: CleanupOptions) {
  if (!['processes', 'storage', 'worktrees', 'all'].includes(options.scope)) throw new Error('정리 scope가 올바르지 않습니다');
  root = await realpath(root);
  return withFileLock(harnessPath(root, 'harness-cleanup'), async () => {
    const startedAt = new Date().toISOString();
    const runId = randomUUID(), report: { runId: string; taskId?: string; startedAt: string; finishedAt?: string; ok: boolean; dryRun: boolean; scope: CleanupScope; errors: { scope: string; error: string }[]; processes?: Awaited<ReturnType<typeof processes>>; storage?: Awaited<ReturnType<typeof storage>>; worktrees?: Awaited<ReturnType<typeof worktrees>> } = { runId, taskId: options.taskId, startedAt, ok: true, dryRun: !!options.dryRun, scope: options.scope, errors: [] };
    for (const scope of ['processes', 'storage', 'worktrees'] as const) {
      if (options.scope !== 'all' && options.scope !== scope) continue;
      await appendLedger(root, { runId, taskId: options.taskId, action: `cleanup:${scope}`, status: 'pre' });
      try {
        const value = await ({ processes, storage, worktrees }[scope])(root, options);
        Object.assign(report, { [scope]: value }); report.ok &&= value.ok;
        await appendLedger(root, { runId, taskId: options.taskId, action: `cleanup:${scope}`, status: value.ok ? 'ok' : 'fail', evidence: { ...value, dryRun: !!options.dryRun } });
      } catch (error) {
        const evidence = { scope, error: redact((error as Error).message).slice(0, 200) };
        report.ok = false; report.errors.push(evidence);
        await appendLedger(root, { runId, taskId: options.taskId, action: `cleanup:${scope}`, status: 'fail', evidence });
      }
    }
    report.finishedAt = new Date().toISOString();
    await atomicWrite(harnessPath(root, 'cleanup-last.json'), JSON.stringify(report, null, 2) + '\n');
    const state = await readState(root);
    if (report.scope === 'all' && report.ok && report.processes?.ok && report.storage?.ok && report.worktrees?.ok
      && !report.processes.residual.length && !report.processes.unverified.length && !report.worktrees.kept.length
      && !report.dryRun && report.taskId && state.state === 'CLEANUP' && state.taskId === report.taskId
      && Date.parse(report.startedAt) >= Date.parse(state.enteredAt ?? '')) {
      await setTask(root, report.taskId, { cleanup: { ok: true } });
    }
    return report;
  }, { waitMs: 120000 });
}
