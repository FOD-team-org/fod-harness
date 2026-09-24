import * as memory from '../src/core/memory.ts';
import { setConfig, loadConfig } from '../src/core/config.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVmStat, parseSwapUsage, sampleMemory, judgeMemory, type MemoryWatch } from '../src/core/memory.ts';
import { memoryStatus, memoryTick, pendingDecisions, reportUnregistered } from '../src/core/watcher.ts';
import { readLedger } from '../src/core/ledger.ts';
import { readJson, harnessPath } from '../src/core/storage.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               2048.\nPages active: 100.\nPages inactive:                           4096.\n';
const swap = 'total = 8192.00M  used = 5734.50M  free = 2457.50M  (encrypted)';
it('실제 macOS 형식의 free+inactive·M/G 파서, 손상 출력 거부', () => {
  expect(parseVmStat(vm)).toBe(96); expect(parseSwapUsage(swap)).toBe(5734.5 / 1024);
  expect(parseSwapUsage('total = 10.0G used = 8.25G free = 1.75G')).toBe(8.25);
  expect(parseVmStat('free 10')).toBeUndefined(); expect(parseSwapUsage('used = ?')).toBeUndefined();
});
it('표본은 vm_stat/sysctl만 사용하며 실패면 undefined', async () => {
  const run = vi.fn(async (file: string) => ({ stdout: file === 'vm_stat' ? vm : swap }));
  expect(await sampleMemory(8, run)).toMatchObject({ freeMB: 96, swapUsedGB: 5734.5 / 1024, pressure: 'normal' });
  expect(run.mock.calls.map(c => c[0])).toEqual(['vm_stat', 'sysctl']);
  expect(await sampleMemory(8, async () => { throw new Error('denied'); })).toBeUndefined();
});
it('pressure → 연속 5분 critical → 낮은 스왑 연속 5분 recovered, 중복 없음', () => {
  let watch: MemoryWatch | undefined;
  const step = (swapUsedGB: number, now: number) => { const result = judgeMemory(watch, { swapUsedGB, freeMB: 12, pressure: 'normal' }, 8, now); watch = result.watch; return result.events; };
  expect(step(8, 0)).toEqual([]);
  const pressure = step(9, 1000); expect(pressure[0].kind).toBe('memory-pressure');
  expect(step(10, 300999)).toEqual([]); expect(step(10, 301000)[0].kind).toBe('memory-critical');
  expect(step(10, 601000)).toEqual([]); expect(step(5, 602000)).toEqual([]);
  expect(step(6, 702000)).toEqual([]); expect(step(5, 703000)).toEqual([]);
  expect(step(5, 1002999)).toEqual([]); expect(step(5, 1003000)[0].kind).toBe('memory-recovered');
  expect(step(5, 1303000)).toEqual([]); expect(step(9, 1304000)[0].dedupeKey).not.toBe(pressure[0].dedupeKey);
});
it('중립 구간은 초과 5분 연속 관측을 끊는다', () => {
  let watch = judgeMemory(undefined, { swapUsedGB: 9, freeMB: 1, pressure: 'warning' }, 8, 0).watch;
  watch = judgeMemory(watch, { swapUsedGB: 7, freeMB: 1, pressure: 'normal' }, 8, 200000).watch;
  expect(judgeMemory(watch, { swapUsedGB: 9, freeMB: 1, pressure: 'warning' }, 8, 300000).events[0].kind).toBe('memory-pressure');
});
it('워처 영속 표본·인박스 dedupe, 실패 원장 1회', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fodh-memory-')); roots.push(root);
  const sample = async () => ({ swapUsedGB: 9, freeMB: 20, pressure: 'warning' as const });
  expect(await memoryTick(root, { now: 0, sample })).toHaveLength(1);
  expect(await memoryTick(root, { now: 0, sample })).toHaveLength(0);
  expect(await memoryTick(root, { now: 300000, sample })).toHaveLength(1);
  expect(await memoryTick(root, { now: 600000, sample })).toHaveLength(0);
  expect((await pendingDecisions(root)).map(r => r.kind)).toEqual(['memory-pressure', 'memory-critical']);
  expect(await readJson(harnessPath(root, 'harness-watcher.json'), {})).toMatchObject({ watch: { memory: { over: true, swapUsedGB: 9 } } });
  await memoryTick(root, { sample: async () => undefined }); await memoryTick(root, { sample: async () => undefined });
  expect((await readLedger(root)).filter(e => e.action === 'memory:sample')).toHaveLength(1);
});

it('P4 R5: 등록 밖 orphan은 보고만 하고 신호 없이 10분 제한', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fodh-orphan-report-')); roots.push(root);
  const kill = vi.spyOn(process, 'kill');
  const run = async () => ({ stdout: '10001 1 10001 jest orphan\n10002 7 10002 jest child\n', stderr: '' });
  await reportUnregistered(root, ['jest'], 0, run); await reportUnregistered(root, ['jest'], 1000, run);
  const reports = (await readLedger(root)).filter(e => e.action === 'memory:residual');
  expect(reports).toHaveLength(1); expect(reports[0].evidence).toEqual({ reportOnly: true, processes: [{ pid: 10001, pgid: 10001, cmd: 'jest orphan' }] });
  expect(kill.mock.calls.filter(call => call[1] !== 0)).toEqual([]);
});

it('L4: swapWarnGB 최소 3과 설정값 pressure 경계를 적용한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fodh-memory-config-')); roots.push(root);
  for (const value of ['0', '2', '2.999']) await expect(setConfig(root, 'cleanup.swapWarnGB', value)).rejects.toThrow('cleanup.swapWarnGB');
  await setConfig(root, 'cleanup.swapWarnGB', '3'); expect((await loadConfig(root)).cleanup.swapWarnGB).toBe(3);
  const run = async (file: string) => ({ stdout: file === 'vm_stat' ? vm : 'used = 5G' });
  expect(await sampleMemory(3, run)).toMatchObject({ pressure: 'warning' });
  expect(await sampleMemory(5, run)).toMatchObject({ pressure: 'normal' });
});
it('L9: 미등록 명령은 redact 후 200자로 잘라 원장에 기록한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fodh-memory-redact-')); roots.push(root);
  await reportUnregistered(root, ['jest'], 0, async () => ({ stdout: '10001 1 10001 jest sk-ant-FAKE_TEST_CREDENTIAL ' + 'x'.repeat(250) }));
  const ledger = await readLedger(root), body = JSON.stringify(ledger);
  expect(body).not.toContain('FAKE_TEST_CREDENTIAL');
  const evidence = ledger[0].evidence as { processes: { cmd: string }[] };
  expect(evidence.processes[0].cmd).toHaveLength(200); expect(evidence.processes[0].cmd).toContain('[비밀값 제거]');
});

it('L4: CLI memory status와 워처 기본 표본 호출에 설정 threshold를 전달한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fodh-memory-threshold-')); roots.push(root);
  await setConfig(root, 'cleanup.swapWarnGB', '4');
  const sample = vi.spyOn(memory, 'sampleMemory').mockResolvedValue({ freeMB: 100, swapUsedGB: 5, pressure: 'warning' });
  expect(await memoryStatus(root)).toMatchObject({ sample: { pressure: 'warning' } });
  await memoryTick(root);
  expect(sample.mock.calls).toEqual([[4], [4]]);
});

it('N3: critical은 중립·재초과에도 유지하고 5분 연속 회복에서만 해제한다', () => {
  let watch: MemoryWatch | undefined;
  const step = (swapUsedGB: number, now: number) => {
    const result = judgeMemory(watch, { swapUsedGB, freeMB: 100, pressure: 'normal' }, 8, now); watch = result.watch; return result;
  };
  step(9, 0); expect(step(9, 300000).events.map(e => e.kind)).toEqual(['memory-critical']);
  expect(step(7, 301000)).toMatchObject({ watch: { critical: true }, events: [] });
  expect(watch?.overSince).toBeUndefined();
  expect(step(9, 302000)).toMatchObject({ watch: { critical: true, overSince: new Date(302000).toISOString() } });
  expect(step(9, 602000).events).toEqual([]);
  step(5, 603000); expect(step(5, 902999).watch.critical).toBe(true);
  expect(step(5, 903000)).toMatchObject({ watch: { critical: false, over: false }, events: [{ kind: 'memory-recovered' }] });
  expect(step(5, 1203000).events).toEqual([]);
  step(9, 1204000); expect(step(9, 1504000).events.map(e => e.kind)).toEqual(['memory-critical']);
});
