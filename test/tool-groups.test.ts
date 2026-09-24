import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identity from '../src/core/process-time.ts';
import * as lock from '../src/core/lock.ts';
import * as runner from '../src/provider/runner.ts';
import * as tree from '../src/core/proc-tree.ts';
import { sampleToolGroups, verifiedToolGroups, reportToolResidual, type ToolGroup } from '../src/core/tool-groups.ts';
import { reclaimCodexOwner } from '../src/core/codex-reclaim.ts';
import { readLedger } from '../src/core/ledger.ts';
const startedAt = '2026-09-24T00:00:00Z', roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// A fake ps table supplies every PID's identity and group; no host PID can affect these cases.
function psTable(table: { pid: number; pgid: number; startedAt?: string }[], liveGroups: number[]) {
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || table.some(row => row.pid === pid));
  vi.spyOn(identity, 'processStartedAt').mockImplementation(async pid => table.find(row => row.pid === pid)?.startedAt);
  vi.spyOn(identity, 'processGroup').mockImplementation(async pid => table.find(row => row.pid === pid)?.pgid);
  vi.spyOn(runner, 'groupAlive').mockImplementation(pgid => liveGroups.includes(pgid));
}
async function context() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-tools-')); roots.push(root); return { root, runId: 'tools' };
}
it.each(['foreign', 'unverified', 'gone'] as const)('%s: 다른 신원의 도구 그룹을 건너뛰고 원장에 남긴다', async scenario => {
  const ctx = await context();
  psTable([{ pid: 300, pgid: 300, startedAt: '2000-01-01T00:00:00Z' },
    ...(scenario === 'foreign' ? [{ pid: 100, pgid: 100, startedAt: '2000-01-01T00:00:00Z' }] : [])], scenario === 'gone' ? [300] : [100, 300]);
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(true);
  expect(await reclaimCodexOwner({ pid: 100, pgid: 100, startedAt, toolGroups: [{ pid: 300, pgid: 300, startedAt }] }, ctx))
    .toMatchObject({ reclaimed: true, owner: scenario, skippedGroups: [300] });
  expect(reap).not.toHaveBeenCalled();
  expect(await readLedger(ctx.root)).toContainEqual(expect.objectContaining({ status: 'skip', evidence: { reason: 'tool-group-unverified', skippedGroups: [300] } }));
});
it.each(['foreign', 'unverified'] as const)('%s: 도구 그룹 신원이 맞아도 어떤 회수 신호도 허용하지 않는다', async scenario => {
  const ctx = await context();
  psTable([{ pid: 300, pgid: 300, startedAt }, ...(scenario === 'foreign' ? [{ pid: 100, pgid: 100, startedAt: '2000-01-01' }] : [])], [100, 300]);
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(true);
  expect(await reclaimCodexOwner({ pid: 100, pgid: 100, startedAt, toolGroups: [{ pid: 300, pgid: 300, startedAt }] }, ctx)).toMatchObject({ skippedGroups: [300] });
  expect(reap).not.toHaveBeenCalled();
});
it.each(['owned', 'gone', 'orphan'] as const)('%s: 시작 시각 ±2초 및 pgid가 맞는 도구 그룹만 회수한다', async scenario => {
  const ctx = await context();
  psTable([{ pid: 300, pgid: 300, startedAt: '2026-09-24T00:00:02Z' }, { pid: 301, pgid: 400, startedAt },
    ...(scenario === 'owned' ? [{ pid: 100, pgid: 100, startedAt }] : []),
    ...(scenario === 'orphan' ? [{ pid: 200, pgid: 100, startedAt }] : [])], scenario === 'gone' ? [300, 400] : [100, 300, 400]);
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(true);
  expect(await reclaimCodexOwner({ pid: 100, pgid: 100, startedAt, childPid: 200, childStartedAt: startedAt,
    toolGroups: [{ pid: 300, pgid: 300, startedAt }, { pid: 301, pgid: 300, startedAt }, 400] }, ctx))
    .toMatchObject({ reclaimed: true, owner: scenario, skippedGroups: [300, 400] });
  expect(reap).toHaveBeenCalledWith(scenario === 'gone' ? 0 : 100, scenario === 'owned' ? [100] : [], [300]);
});
it.each(['unknown', 'dead', 'moved', 'reused'] as const)('gone: %s 구성원과 숫자 형식은 회수 권한이 없다', async scenario => {
  const ctx = await context();
  psTable(scenario === 'dead' ? [] : [{ pid: 301, pgid: scenario === 'moved' ? 400 : 300,
    startedAt: scenario === 'unknown' ? undefined : scenario === 'reused' ? '2026-09-24T00:00:02.001Z' : startedAt }], [300, 400]);
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(true);
  expect(await reclaimCodexOwner({ pid: 100, pgid: 100, startedAt, toolGroups: [{ pid: 301, pgid: 300, startedAt }, 400] }, ctx))
    .toMatchObject({ owner: 'gone', skippedGroups: [300, 400] });
  expect(reap).not.toHaveBeenCalled();
});
it('표본은 죽은 그룹을 제거하고 현재 자손의 신원만 저장하며 살아 있는 그룹도 최대 64개다', async () => {
  const table = Array.from({ length: 70 }, (_, i) => ({ pid: 300 + i, pgid: 300 + i, startedAt }));
  psTable(table, table.map(row => row.pgid));
  const old: ToolGroup[] = [{ pid: 200, pgid: 200, startedAt }];
  const sampled = await sampleToolGroups(old, { pids: table.map(row => row.pid), toolGroups: table.map(row => row.pgid) });
  expect(sampled).toHaveLength(64); expect(sampled).toEqual(table.slice(0, 64).map(row => ({ ...row, observedAt: expect.any(String) })));
  expect(sampled).not.toContainEqual(old[0]);
  vi.mocked(runner.groupAlive).mockImplementation(pgid => pgid === 363);
  expect(await sampleToolGroups(sampled, { pids: [], toolGroups: [] })).toEqual([{ ...table[63], observedAt: expect.any(String) }]);
});
it('ps로 시작 시각이나 그룹을 읽지 못하면 표본 신원을 만들지 않는다', async () => {
  psTable([{ pid: 300, pgid: 300 }], [300]);
  expect(await sampleToolGroups([], { pids: [300, 301], toolGroups: [300] })).toEqual([]);
});

it('P4 S1: 도구 셸이 먼저 끝나면 살아 있는 그룹 구성원으로 표본 신원 갱신', async () => {
  psTable([{ pid: 301, pgid: 300, startedAt }], [300]);
  vi.spyOn(tree, 'processTreeSnapshot').mockResolvedValue({ pids: [301], toolGroups: [300] });
  expect(await sampleToolGroups([{ pid: 300, pgid: 300, startedAt }], { pids: [], toolGroups: [] })).toEqual([{ pid: 301, pgid: 300, startedAt, observedAt: expect.any(String) }]);
});
it('P4 S2: 미확인 도구 그룹 원장은 run별 첫 1건과 10분 간격만', async () => {
  const ctx = await context();
  for (const now of [0, 1000, 599999, 600000]) await reportToolResidual(ctx, [300], now);
  expect((await readLedger(ctx.root)).filter(e => e.action === 'codex:tool-groups')).toHaveLength(2);
  expect((await readLedger(ctx.root)).filter(e => e.action === 'codex:residual')).toHaveLength(2);
});

it('L2: 이전 표본 뒤 시작한 witness는 재사용된 pgid로 간주해 채택하지 않는다', async () => {
  const old = { pid: 300, pgid: 300, startedAt, observedAt: '2026-09-24T00:01:00Z' };
  psTable([{ pid: 301, pgid: 300, startedAt: '2026-09-24T00:01:01Z' }], [300]);
  vi.spyOn(tree, 'processTreeSnapshot').mockResolvedValue({ pids: [301], toolGroups: [300] });
  expect(await sampleToolGroups([old], { pids: [], toolGroups: [] })).toEqual([old]);
});
