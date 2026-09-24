import { liveHarness } from './p7-brain-helpers.ts';
import * as processTime from '../src/core/process-time.ts';
import * as lock from '../src/core/lock.ts';
import * as runner from '../src/provider/runner.ts';
import { writeMeta, readMeta } from '../src/core/codex-record.ts';
import { cleanupReport } from '../src/core/reclaim.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runCleanup } from '../src/core/cleanup.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import { updateState, readState } from '../src/core/state.ts';
import { setConfig } from '../src/core/config.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { atomicWrite, harnessPath } from '../src/core/storage.ts';
import { createWorktree } from '../src/core/worktree.ts';
import * as reclaim from '../src/core/codex-reclaim.ts';
const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const child of children.splice(0)) { child.kill('SIGKILL'); } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'fodh-cleanup-')); roots.push(root); await setConfig(root, 'notify.channels', '["ledger"]'); return root; }
async function sleeper(root: string, patch: Record<string, unknown> = {}) {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); children.push(child);
  await new Promise<void>((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
  const startedAt = await processStartedAt(child.pid!);
  const record = { pid: child.pid!, pgid: child.pid!, runId: `run-${child.pid}`, kind: 'verify', taskId: 'T01', startedAt: startedAt ?? 'spawn:unknown', ...patch };
  await registerProc(root, record); return { child, record, startedAt };
}
it('실제 sleep 회수·레지스트리 제거·보고서 및 pre→ok 원장', async () => {
  const root = await setup(); const { child, startedAt } = await sleeper(root, { kind: 'worker' });
  expect(startedAt, '/bin/ps 시작 시각 확인 필요').toBeTruthy();
  const report = await runCleanup(root, { scope: 'processes' });
  expect(report.ok).toBe(true); expect(report.processes?.reclaimed).toHaveLength(1); expect(await listProcs(root)).toEqual([]);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(JSON.parse(await readFile(harnessPath(root, 'cleanup-last.json'), 'utf8'))).toMatchObject({ ok: true });
  expect((await readLedger(root)).filter(e => e.action === 'cleanup:processes').map(e => e.status)).toEqual(['pre', 'ok']);
});
it('neverKill·brain·활성 위임 보호, task/session 필터, spawn 미검증에는 신호 없음', async () => {
  vi.spyOn(lock, 'isProcessAlive').mockReturnValue(true);
  const root = await setup(); await setConfig(root, 'cleanup.processes.neverKill', '["dev-server"]');
  const records = [
    { pid: 100001, kind: 'verify', cmd: 'dev-server' }, { pid: 100002, kind: 'brain' },
    { pid: 100003, kind: 'codex', runId: 'active' }, { pid: 100004, kind: 'verify', startedAt: 'spawn:2026-09-24' },
    { pid: 100005, kind: 'verify', taskId: 'T02' }, { pid: 100006, kind: 'verify', sessionId: 'other' },
  ];
  for (const p of records) await registerProc(root, { pgid: p.pid, startedAt: '2026-09-24', runId: String(p.pid), taskId: 'T01', sessionId: 'self', ...p });
  await liveHarness(root);
  await updateState(root, { brainTurn: { runId: '100002', startedAt: 'now' }, delegation: { runId: 'active', taskId: 'T01', kind: 'task', startedAt: 'now' } });
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner');
  const report = await runCleanup(root, { scope: 'processes', taskId: 'T01', sessionId: 'self' });
  expect(report.processes?.protected).toHaveLength(3); expect(report.processes?.unverified).toHaveLength(1);
  expect(report.ok).toBe(false); expect(reap).not.toHaveBeenCalled(); expect(await listProcs(root)).toHaveLength(6);
});
it('잔존·재사용 pid 보고, killPatterns는 대상 필터가 아니다', async () => {
  vi.spyOn(lock, 'isProcessAlive').mockReturnValue(true);
  const root = await setup(); await setConfig(root, 'cleanup.processes.killPatterns', '["jest"]');
  await registerProc(root, { pid: 100001, pgid: 100001, startedAt: 'now', runId: 'one', kind: 'tool', cmd: 'unmatched' });
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner').mockResolvedValue({ reclaimed: false, owner: 'owned', skippedGroups: [] });
  expect((await runCleanup(root, { scope: 'processes' })).processes?.residual).toHaveLength(1); expect(reap).toHaveBeenCalledOnce();
  reap.mockResolvedValue({ reclaimed: true, owner: 'foreign', skippedGroups: [], reason: 'pid-reused' });
  expect((await runCleanup(root, { scope: 'processes' })).processes?.stale).toHaveLength(1); expect(await listProcs(root)).toHaveLength(0);
});
it('dry-run은 프로세스·파일을 그대로 두고 삭제 계획만 기록', async () => {
  const root = await setup(); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/out'), 'x');
  await setConfig(root, 'cleanup.rebuildablePaths', '["dist"]');
  const { child } = await sleeper(root, { startedAt: '2026-09-24' });
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner');
  const report = await runCleanup(root, { scope: 'all', dryRun: true });
  expect(report.storage?.planned[0]).toMatchObject({ path: 'dist', sizeKB: expect.any(Number) });
  expect(await readFile(join(root, 'dist/out'), 'utf8')).toBe('x'); expect(child.exitCode).toBe(null); expect(reap).not.toHaveBeenCalled();
});
it('루트 밖·심링크·keepPaths 자신/하위/부모 보호, du 크기와 공유 캐시 보고만', async () => {
  const root = await setup(), outside = await setup();
  await mkdir(join(root, 'parent/keep'), { recursive: true }); await writeFile(join(root, 'parent/keep/file'), 'keep');
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/file'), 'x'.repeat(12000));
  await writeFile(join(outside, 'sentinel'), 'keep'); await symlink(outside, join(root, 'link'));
  await setConfig(root, 'cleanup.rebuildablePaths', JSON.stringify(['../bad', outside, 'link', 'parent', 'parent/keep', 'dist', '.pi', '.']));
  await setConfig(root, 'cleanup.keepPaths', '["parent/keep"]');
  await setConfig(root, 'cleanup.sharedCaches', JSON.stringify({ enabled: true, paths: [outside] }));
  const report = await runCleanup(root, { scope: 'storage' });
  expect(report.storage?.deleted).toHaveLength(1); expect(report.storage?.deleted[0].sizeKB).toBeGreaterThan(0);
  expect(report.storage?.kept).toHaveLength(7); expect(report.storage?.sharedCaches[0]).toMatchObject({ reportOnly: true });
  expect(await readFile(join(root, 'parent/keep/file'), 'utf8')).toBe('keep'); expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep');
});
it('완료 실행 최신 N개, 활성 delegation·task codexThread meta/last-message 보존', async () => {
  const root = await setup(); await setConfig(root, 'cleanup.codexRunsKeep', '1');
  const task = await addTask(root, { title: 'thread', category: 'docs' }); await setTask(root, task.id, { codexThread: 'thread-kept' });
  await updateState(root, { delegation: { runId: 'delegated', kind: 'research', startedAt: 'now' } });
  for (const [i, runId] of ['old', 'thread', 'delegated', 'latest'].entries()) {
    const dir = harnessPath(root, `codex/${runId}`); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ runId, finishedAt: new Date(i * 1000).toISOString(), threadId: runId === 'thread' ? 'thread-kept' : undefined }));
    for (const name of ['last-message.md', 'events.jsonl', 'stderr.txt']) await writeFile(join(dir, name), name);
  }
  await runCleanup(root, { scope: 'storage' });
  await expect(access(harnessPath(root, 'codex/old'))).rejects.toThrow();
  for (const run of ['thread', 'delegated', 'latest']) await access(harnessPath(root, `codex/${run}/meta.json`));
  for (const run of ['thread', 'delegated']) { await access(harnessPath(root, `codex/${run}/last-message.md`)); await expect(access(harnessPath(root, `codex/${run}/events.jsonl`))).rejects.toThrow(); }
  await access(harnessPath(root, 'codex/latest/events.jsonl'));
});
it('임시 git: done+clean만 제거하고 dirty/미완/위임은 보존', { timeout: 30000 }, async () => {
  const root = await gitProject();
  const tasks = [];
  for (let i = 0; i < 4; i++) { const task = await addTask(root, { title: `task ${i}`, category: 'docs' }); tasks.push(task); await createWorktree(root, task.id); }
  const backlogPath = harnessPath(root, 'harness-backlog.json');
  const file = JSON.parse(await readFile(backlogPath, 'utf8'));
  // Seed completed fixture records with their required DoD via the serialized backlog.
  const list = Array.isArray(file) ? file : file.tasks;
  for (const [i, task] of list.entries()) if (i !== 2) Object.assign(task, { status: 'done', verify: { ok: true }, review: { commit: 'abc', high: 0 }, merge: { commit: 'abc' }, docs: { ok: true }, cleanup: { ok: true } });
  await atomicWrite(backlogPath, JSON.stringify(file));
  const state = await readState(root); await writeFile(join(state.worktrees![1].path, 'dirty'), 'keep');
  await updateState(root, { delegation: { runId: 'active', taskId: tasks[3].id, kind: 'task', startedAt: 'now' } });
  const report = await runCleanup(root, { scope: 'worktrees' });
  expect(report.worktrees?.removed).toEqual([state.worktrees![0].path]); expect(report.worktrees?.kept).toHaveLength(3);
});

it('범위 실행 오류도 fail 원장과 cleanup-last 보고서에 남긴다', async () => {
  const root = await setup(); await writeFile(harnessPath(root, 'harness-procs.json'), '{broken');
  const report = await runCleanup(root, { scope: 'processes' });
  expect(report.ok).toBe(false); expect(report.errors).toHaveLength(1);
  expect((await readLedger(root)).map(e => e.status)).toEqual(['pre', 'fail']);
  expect(JSON.parse(await readFile(harnessPath(root, 'cleanup-last.json'), 'utf8')).ok).toBe(false);
});

it('보호된 개발 서버는 정리 성공과 cleanup-ok 보고를 막지 않고 레지스트리에 남는다', async () => {
  const root = await setup(); await setConfig(root, 'cleanup.processes.neverKill', '["dev-server"]');
  await registerProc(root, { pid: 100001, pgid: 100001, startedAt: 'spawn:unknown', runId: 'protected', kind: 'tool', cmd: 'dev-server' });
  expect((await runCleanup(root, { scope: 'processes' })).ok).toBe(true);
  expect(await cleanupReport(root)).toMatchObject({ ok: true, remaining: 0, protected: [{ pid: 100001 }] });
  expect(await listProcs(root)).toHaveLength(1);
});

async function gitProject() {
  const parent = await setup(), root = join(parent, 'project'); await mkdir(root);
  await setConfig(root, 'notify.channels', '["ledger"]'); await promisify(execFile)('git', ['init', root]);
  const object = async (kind: string, content: string) => {
    const bytes = Buffer.from(`${kind} ${Buffer.byteLength(content)}\0${content}`), id = createHash('sha1').update(bytes).digest('hex');
    const path = join(root, '.git/objects', id.slice(0, 2), id.slice(2)); await mkdir(dirname(path), { recursive: true }); await writeFile(path, deflateSync(bytes)); return id;
  };
  const tree = await object('tree', ''), commit = await object('commit', `tree ${tree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nfixture\n`);
  await mkdir(join(root, '.git/refs/heads'), { recursive: true }); await writeFile(join(root, '.git/refs/heads/main'), commit + '\n'); await writeFile(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  return root;
}

it('M1: 죽은 spawn 기록은 stale, codex meta는 lost로 마감하고 재실행도 성공한다', async () => {
  const root = await setup(); vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  const record = { pid: 100001, pgid: 100001, startedAt: 'spawn:unknown', runId: 'stale-run', kind: 'codex' };
  await registerProc(root, record);
  await writeMeta(root, { runId: record.runId, kind: 'research', cwd: root, sandbox: 'read-only', command: ['fixture'],
    model: 'fake', effort: 'high', workerModel: 'fake', workerEffort: 'high', startedAt: new Date().toISOString(), timeoutMinutes: 1, status: 'running', state: 'RESEARCH', pid: record.pid });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(false);
  const kill = vi.spyOn(process, 'kill');
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ ok: true, processes: { stale: [{ pid: record.pid }], residual: [], unverified: [] } });
  expect(await readMeta(root, record.runId)).toMatchObject({ status: 'lost', finishedAt: expect.any(String) });
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ ok: true, processes: { stale: [] } });
  expect(await listProcs(root)).toEqual([]); expect(kill).not.toHaveBeenCalled();
});
it.each(['run', 'report'])('M1: PID 재사용은 %s에서 신호 없이 stale로 제거한다', async mode => {
  const root = await setup(), record = { pid: 100001, pgid: 100001, startedAt: '2026-09-24T00:00:00Z', runId: 'foreign', kind: 'worker' };
  await registerProc(root, record);
  vi.spyOn(lock, 'isProcessAlive').mockReturnValue(true);
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('2026-09-24T01:00:00Z');
  const kill = vi.spyOn(process, 'kill');
  const report = mode === 'run' ? (await runCleanup(root, { scope: 'processes' })).processes : await cleanupReport(root);
  expect(report).toMatchObject({ ok: true, stale: [{ pid: record.pid }], residual: [] });
  expect(await listProcs(root)).toEqual([]); expect(kill).not.toHaveBeenCalled();
});
it('M1: spawn PID 또는 그룹 중 하나라도 살아 있으면 미확인 기록을 보존한다', async () => {
  const root = await setup();
  for (const pid of [100001, 100002]) await registerProc(root, { pid, pgid: pid, startedAt: 'spawn:unknown', runId: String(pid), kind: 'worker' });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || pid === 100001);
  vi.spyOn(runner, 'groupAlive').mockImplementation(pgid => pgid === 100002);
  const kill = vi.spyOn(process, 'kill');
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ ok: false, processes: { unverified: [{ pid: 100001 }, { pid: 100002 }], stale: [] } });
  expect(await listProcs(root)).toHaveLength(2); expect(kill).not.toHaveBeenCalled();
});
it('M5: owned verify는 보호하고 죽은 verify는 stale로 보고한다', async () => {
  const root = await setup(), startedAt = '2026-09-24T00:00:00Z';
  for (const pid of [100001, 100002]) await registerProc(root, { pid, pgid: pid, startedAt, runId: String(pid), kind: 'verify', ownerPid: process.pid, ownerStartedAt: startedAt });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || pid === 100001);
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(startedAt);
  vi.spyOn(runner, 'groupAlive').mockImplementation(pid => pid === 100001);
  const kill = vi.spyOn(process, 'kill');
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ ok: true, processes: { protected: [{ pid: 100001 }], stale: [{ pid: 100002 }] } });
  expect(await cleanupReport(root)).toMatchObject({ ok: true, remaining: 0, protected: [{ pid: 100001 }], stale: [] });
  expect(await listProcs(root)).toHaveLength(1); expect(kill).not.toHaveBeenCalled();
});
it.each([false, true])('M6: CLEANUP 현재 task clean/dirty=%s만 처리하고 다른 task는 보존한다', { timeout: 30000 }, async dirty => {
  const root = await gitProject(), task = await addTask(root, { title: '현재', category: 'docs' }), other = await addTask(root, { title: '다른', category: 'docs' });
  await createWorktree(root, task.id); await createWorktree(root, other.id);
  const worktrees = (await readState(root)).worktrees!;
  if (dirty) await writeFile(join(worktrees[0].path, 'dirty'), 'keep');
  await updateState(root, { state: 'CLEANUP', taskId: task.id });
  const report = await runCleanup(root, { scope: 'worktrees', taskId: task.id });
  expect(report.worktrees?.removed).toEqual(dirty ? [] : [worktrees[0].path]);
  expect(report.worktrees?.kept).toEqual(dirty ? [{ ...worktrees[0], reason: '작업 트리 변경 있음' }] : []);
  await access(worktrees[1].path); expect((await readState(root)).worktrees).toContainEqual(worktrees[1]);
  if (!dirty) await expect(access(worktrees[0].path)).rejects.toThrow();
});
it('L1: delegation 게시 전 protectedUntil 기록은 보호하고 만료 뒤 stale로 정리한다', async () => {
  const root = await setup(), until = Date.now() + 60000;
  await registerProc(root, { pid: 100001, pgid: 100001, runId: 'starting', kind: 'codex', startedAt: 'spawn:unknown', protectedUntil: new Date(until).toISOString() });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(false);
  expect((await readState(root)).delegation).toBeUndefined();
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ processes: { protected: [{ pid: 100001 }], stale: [] } });
  vi.spyOn(Date, 'now').mockReturnValue(until);
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ processes: { protected: [], stale: [{ pid: 100001 }] } });
});
it('L7: rebuildablePaths가 등록 worktree 자신·상위·하위를 가리켜도 보존한다', async () => {
  const root = await setup(), path = join(root, 'build/wt'); await mkdir(join(path, 'dist'), { recursive: true });
  await writeFile(join(path, 'dist/keep'), 'evidence');
  await updateState(root, { worktrees: [{ taskId: 'T01', path, branch: 'task', createdAt: 'now' }] });
  await setConfig(root, 'cleanup.rebuildablePaths', '["build","build/wt","build/wt/dist"]');
  const report = await runCleanup(root, { scope: 'storage' });
  expect(report.storage?.deleted).toEqual([]); expect(report.storage?.kept).toHaveLength(3);
  expect(await readFile(join(path, 'dist/keep'), 'utf8')).toBe('evidence');
});
