import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';
import { setTask } from './backlog.ts';
import { appendLedgerOnce } from './ledger.ts';
import { removeProc } from './procs.ts';
import { releaseSlot } from './slots.ts';
import { redact } from '../provider/privacy.ts';
import type { RecordedToolGroup } from './tool-groups.ts';
export type CodexKind = 'task' | 'review' | 'research';
export interface CodexMeta {
  runId: string; kind: CodexKind; taskId?: string; title?: string; cwd: string;
  sandbox: 'workspace-write' | 'read-only'; model: string; effort: string; workerModel: string; workerEffort: string;
  resume?: string; command: string[]; startedAt: string; timeoutMinutes: number; state: string;
  status: 'running' | 'ok' | 'fail' | 'timeout' | 'lost' | 'cancelled'; pid?: number; processStartedAt?: string; childPid?: number; childStartedAt?: string; toolGroups?: RecordedToolGroup[]; reason?: string;
  worktree?: string | null; routeHint?: string; finishedAt?: string; exit?: number | null;
  threadId?: string; lastMessageFile?: string; peakRssMB?: number; durationSeconds?: number; error?: string; supervisorLost?: boolean;
}
export function resultDir(root: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(runId)) throw new Error('runId가 올바르지 않습니다');
  return harnessPath(root, join('codex', runId));
}
export const metaPath = (root: string, runId: string) => join(resultDir(root, runId), 'meta.json');
export type CancelSource = 'cancel' | 'cleanup' | 'reclaim' | 'watcher';
export async function requestCancel(root: string, runId: string, by: CancelSource): Promise<void> {
  const path = join(resultDir(root, runId), 'cancel.json');
  await withFileLock(path, async () => {
    if (!await readJson(path, undefined)) await atomicWrite(path, JSON.stringify({ by, at: new Date().toISOString() }) + '\n');
  });
}
export async function readMeta(root: string, runId: string): Promise<CodexMeta | undefined> {
  return readJson<CodexMeta | undefined>(metaPath(root, runId), undefined);
}
export async function hasReviewEvidence(root: string, reviewSince: string | undefined, taskId?: string): Promise<boolean> {
  const entered = Date.parse(reviewSince ?? '');
  const runs = await readdir(harnessPath(root, 'codex'), { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const run of runs) {
    if (!run.isDirectory() || !/^[A-Za-z0-9_-]+$/u.test(run.name)) continue;
    const meta = await readMeta(root, run.name);
    if (meta?.status === 'ok' && (taskId === undefined || meta.taskId === taskId)
      && (meta.kind === 'review' && Date.parse(meta.startedAt) >= entered
        || taskId !== undefined && meta.kind === 'task')) return true;
  }
  return false;
}
export async function writeMeta(root: string, meta: CodexMeta): Promise<void> {
  await atomicWrite(metaPath(root, meta.runId), JSON.stringify(meta, null, 2) + '\n');
}
export async function result(root: string, runId: string) {
  const meta = await readMeta(root, runId);
  if (!meta) throw new Error(`위임 실행을 찾을 수 없습니다: ${runId}`);
  const dir = resultDir(root, runId);
  let threadId = meta.threadId, lastMessage = '', usage: unknown, turnCompleted = false;
  const changedFiles = new Set<string>(), commands = new Set<string>(), errors = new Set<string>();
  const addError = (message: unknown) => {
    if (typeof message === 'string' && !/Under-development|Skill descriptions|unrecognized configuration settings/iu.test(message)) errors.add(redact(message));
  };
  let anonymousCommands = 0;
  for (const line of (await readText(join(dir, 'events.jsonl'))).split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; } // A running stream may end in a partial line.
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    if (event?.type === 'turn.completed') { usage = event.usage; turnCompleted = true; }
    if (event?.type === 'error') addError(event.message);
    if (event?.type === 'turn.failed') addError(event.error?.message);
    const item = event?.item;
    if (!item) continue;
    if (item.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
    if (item.type === 'file_change') for (const change of item.changes ?? []) {
      if (typeof change.path === 'string') {
        const absolute = resolve(meta.cwd, change.path), local = relative(meta.cwd, absolute);
        changedFiles.add(local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local : absolute);
      }
    }
    if (item.type === 'command_execution') {
      if (typeof item.id === 'string') commands.add(item.id);
      else if (event.type === 'item.completed') anonymousCommands++;
    }
    if (item.type === 'error') {
      const message = item.message ?? item.text;
      addError(message);
    }
  }
  lastMessage = await readText(join(dir, 'last-message.md'), lastMessage);
  return { runId, kind: meta.kind, taskId: meta.taskId, worktree: meta.worktree ?? null, routeHint: meta.routeHint, status: meta.finishedAt ? meta.status : 'running',
    exit: meta.exit, ...(meta.supervisorLost ? { supervisorLost: true } : {}), threadId, durationSeconds: meta.durationSeconds, lastMessage,
    changedFiles: [...changedFiles], commands: commands.size + anonymousCommands, usage, errors: [...errors], turnCompleted };
}
// All finishers serialize on meta; publish the terminal record before the one terminal ledger entry.
export async function finishRun(root: string, runId: string, patch: Partial<CodexMeta>): Promise<CodexMeta> {
  return withFileLock(metaPath(root, runId), async () => {
    const meta = await readMeta(root, runId);
    if (!meta) throw new Error('위임 메타데이터가 없습니다');
    const parsed = await result(root, runId);
    const finishedAt = meta.finishedAt ?? new Date().toISOString();
    const next: CodexMeta = meta.finishedAt ? meta : { ...meta, ...patch, finishedAt, threadId: parsed.threadId,
      lastMessageFile: join(resultDir(root, runId), 'last-message.md'),
      durationSeconds: Math.max(0, (Date.parse(finishedAt) - Date.parse(meta.startedAt)) / 1000), peakRssMB: patch.peakRssMB ?? meta.peakRssMB ?? 0 };
    if (!meta.finishedAt && meta.kind === 'task' && next.taskId && next.threadId) {
      try { await setTask(root, next.taskId, { codexThread: next.threadId }); }
      catch (error) { next.error = redact((error as Error).message); next.status = next.status === 'ok' ? 'fail' : next.status; }
    }
    await releaseSlot(root, 'codex', runId);
    if (meta.pid) await removeProc(root, meta.pid, runId);
    if (!meta.finishedAt) await writeMeta(root, next);
    await appendLedgerOnce(root, { runId, taskId: meta.taskId, state: meta.state, action: `codex:${meta.kind}`,
      status: next.status === 'ok' ? 'ok' : 'fail', evidence: { exit: next.exit, threadId: next.threadId,
        durationSeconds: next.durationSeconds, peakRssMB: next.peakRssMB, changedFiles: parsed.changedFiles.length,
        lastMessageBytes: Buffer.byteLength(parsed.lastMessage), ...(next.status === 'cancelled' ? { cancelled: true } : {}),
        ...(next.reason ? { reason: next.reason } : {}),
        ...(next.supervisorLost ? { supervisorLost: true } : {}),
        ...(next.error ? { error: next.error } : {}), status: next.status } });
    const watcherPath = harnessPath(root, 'harness-watcher.json');
    await withFileLock(watcherPath, async () => {
      const file = await readJson<{ watch?: { codexLostFailures?: Record<string, string> } }>(watcherPath, {});
      if (file.watch?.codexLostFailures && Object.hasOwn(file.watch.codexLostFailures, runId)) {
        delete file.watch.codexLostFailures[runId];
        await atomicWrite(watcherPath, JSON.stringify(file, null, 2) + '\n');
      }
    });
    return next;
  });
}
