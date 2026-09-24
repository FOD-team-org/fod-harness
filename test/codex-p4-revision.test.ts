import { memoryTick } from '../src/core/watcher.ts';
import { readJson, harnessPath } from '../src/core/storage.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCodex, cancel } from '../src/core/codex.ts';
import { writeMeta, readMeta, finishRun } from '../src/core/codex-record.ts';
import { readState, updateState } from '../src/core/state.ts';
import * as procs from '../src/core/procs.ts';
import * as ownership from '../src/core/process-identity.ts';
import * as reclaim from '../src/core/codex-reclaim.ts';
import * as processTime from '../src/core/process-time.ts';
import { runCleanup } from '../src/core/cleanup.ts';
import { setConfig } from '../src/core/config.ts';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('node:timers/promises', async original => ({ ...await original<typeof import('node:timers/promises')>(), setTimeout: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(state = 'RESEARCH') {
  const root = await mkdtemp(join(tmpdir(), 'fodh-codex-p4-')); roots.push(root);
  vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots')); await setConfig(root, 'notify.channels', '["ledger"]');
  await updateState(root, { state }); await writeFile(join(root, 'spec.md'), 'fixture'); return root;
}
it('L1: startCodex 등록 직후 delegation 전에도 60초 보호 표식이 정리를 막는다', async () => {
  const root = await setup();
  const child = Object.assign(new ChildProcess(), { pid: 100001, unref: vi.fn() });
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('2026-09-24T00:00:00Z');
  const actual = procs.registerProc, reap = vi.spyOn(reclaim, 'reclaimCodexOwner');
  const register = vi.spyOn(procs, 'registerProc').mockImplementation(async (root, record) => {
    expect((await readState(root)).delegation).toBeUndefined();
    expect(Date.parse(record.protectedUntil!) - Date.now()).toBeGreaterThan(59000);
    const result = await actual(root, record);
    expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ processes: { protected: [{ pid: child.pid }] } });
    return result;
  });
  const result = await startCodex(root, 'research', { spec: 'spec.md' });
  expect(register).toHaveBeenCalledOnce(); expect(reap).not.toHaveBeenCalled();
  expect((await readState(root)).delegation?.runId).toBe(result.runId);
});
it.each(['READY', 'RESEARCH'])('L6: watcher critical이면 %s에서도 spawn 전에 위임을 거부한다', async state => {
  const root = await setup(state);
  await writeFile(join(root, '.pi/harness-watcher.json'), JSON.stringify({ watch: { memory: { critical: true } } }));
  await expect(startCodex(root, 'research', { spec: 'spec.md' })).rejects.toThrow('메모리 임계 상태입니다');
  expect(spawn).not.toHaveBeenCalled(); expect(await procs.listProcs(root)).toEqual([]);
});
it('L10: TERM 뒤 8초에 마감하는 감독을 10초 예산 안에서 기다리고 재회수하지 않는다', async () => {
  const root = await setup(), runId = 'late-finish', startedAt = new Date().toISOString();
  await writeMeta(root, { runId, kind: 'research', cwd: root, sandbox: 'read-only', model: 'fake', effort: 'high', workerModel: 'fake', workerEffort: 'high', command: ['fixture'], startedAt, timeoutMinutes: 1, state: 'RESEARCH', status: 'running', pid: 100001, processStartedAt: startedAt });
  await procs.registerProc(root, { pid: 100001, pgid: 100001, startedAt, runId, kind: 'codex' });
  vi.spyOn(ownership, 'codexOwnership').mockResolvedValue('owned');
  const actualKill = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === 100001 ? true : actualKill(pid, signal));
  let elapsed = 0; const base = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => base + elapsed);
  vi.mocked(delay).mockImplementation(async () => {
    elapsed += 100;
    if (elapsed === 8000) await finishRun(root, runId, { status: 'cancelled', exit: null });
  });
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner').mockRejectedValue(new Error('premature reclaim'));
  await cancel(root, runId);
  expect(elapsed).toBe(8000); expect(reap).not.toHaveBeenCalled(); expect((await readMeta(root, runId))?.status).toBe('cancelled');
});

it('N3: 중립 표본 뒤에도 critical 위임 거부를 유지하고 5분 회복에서 해제한다', async () => {
  const root = await setup('RESEARCH');
  const sample = (swapUsedGB: number) => async () => ({ freeMB: 100, swapUsedGB, pressure: 'normal' as const });
  await memoryTick(root, { now: 0, sample: sample(9) });
  await memoryTick(root, { now: 300000, sample: sample(9) });
  await memoryTick(root, { now: 301000, sample: sample(7) });
  expect((await readState(root)).lastPaused).toBeUndefined();
  await expect(startCodex(root, 'research', { spec: 'spec.md' })).rejects.toThrow('메모리 임계 상태입니다');
  expect(spawn).not.toHaveBeenCalled();
  await memoryTick(root, { now: 302000, sample: sample(5) });
  await memoryTick(root, { now: 601999, sample: sample(5) });
  await expect(startCodex(root, 'research', { spec: 'spec.md' })).rejects.toThrow('메모리 임계 상태입니다');
  expect((await memoryTick(root, { now: 602000, sample: sample(5) })).map(event => event.kind)).toEqual(['memory-recovered']);
  expect(await readJson(harnessPath(root, 'harness-watcher.json'), {})).toMatchObject({ watch: { memory: { critical: false } } });
  const child = Object.assign(new ChildProcess(), { pid: 100001, unref: vi.fn() });
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
  await expect(startCodex(root, 'research', { spec: 'spec.md' })).resolves.toMatchObject({ kind: 'research' });
  expect(spawn).toHaveBeenCalledOnce();
});
