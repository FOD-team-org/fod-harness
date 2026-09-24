import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCleanup } from '../src/core/cleanup.ts';
import { cleanupReport } from '../src/core/reclaim.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { writeMeta, readMeta } from '../src/core/codex-record.ts';
import { readLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';
import * as identity from '../src/core/process-identity.ts';
import * as processTime from '../src/core/process-time.ts';
import * as runner from '../src/provider/runner.ts';
import * as tree from '../src/core/proc-tree.ts';
import * as reclaim from '../src/core/codex-reclaim.ts';
const roots: string[] = [], startedAt = '2026-09-24T00:00:00Z';
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fodh-cleanup-third-'))); roots.push(root);
  vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots')); await setConfig(root, 'notify.channels', '["ledger"]'); return root;
}
it.each(['owned', 'dead', 'foreign', 'unknown', 'missing'] as const)('N1: verify 소유 CLI %s일 때만 보호 조건을 판정한다', async ownerIdentity => {
  const root = await setup(), record = { pid: 100001, pgid: 100001, runId: 'verify', kind: 'verify', startedAt,
    ...(ownerIdentity === 'missing' ? {} : { ownerPid: 100002, ownerStartedAt: startedAt }) };
  await registerProc(root, record);
  vi.spyOn(identity, 'processIdentity').mockImplementation(async pid => pid === record.pid ? 'owned' : ownerIdentity === 'missing' ? 'unknown' : ownerIdentity);
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner').mockResolvedValue({ reclaimed: true, owner: 'owned', skippedGroups: [] });
  const report = await runCleanup(root, { scope: 'processes' });
  expect(report.ok).toBe(true); expect(report.processes?.residual).toEqual([]);
  if (ownerIdentity === 'owned') {
    expect(report.processes?.protected).toEqual([{ pid: record.pid, kind: 'verify' }]);
    expect(reap).not.toHaveBeenCalled(); expect(await listProcs(root)).toEqual([record]);
    expect(await cleanupReport(root)).toMatchObject({ remaining: 0, protected: [record] });
  } else {
    expect(report.processes?.protected).toEqual([]); expect(report.processes?.reclaimed).toEqual([{ pid: record.pid, kind: 'verify' }]);
    expect(reap).toHaveBeenCalledWith(record, { root, runId: record.runId }); expect(await listProcs(root)).toEqual([]);
  }
});
it('N1: 소유자가 죽고 자식 신원도 unknown이면 보호·신호 없이 unverified로 보존한다', async () => {
  const root = await setup(), record = { pid: 100001, pgid: 100001, runId: 'verify', kind: 'verify', startedAt, ownerPid: 100002, ownerStartedAt: startedAt };
  await registerProc(root, record);
  vi.spyOn(identity, 'processIdentity').mockImplementation(async pid => pid === record.pid ? 'unknown' : 'dead');
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner');
  expect(await runCleanup(root, { scope: 'processes' })).toMatchObject({ ok: false, processes: { protected: [], unverified: [{ pid: record.pid }] } });
  expect(reap).not.toHaveBeenCalled(); expect(await listProcs(root)).toEqual([record]);
});
async function codexFixture(toolGroups = true) {
  const root = await setup(), record = { pid: 100001, pgid: 100001, startedAt, runId: 'orphan', kind: 'codex' };
  await registerProc(root, record);
  await writeMeta(root, { runId: record.runId, kind: 'research', cwd: root, sandbox: 'read-only', command: ['fixture'],
    model: 'fake', effort: 'high', workerModel: 'fake', workerEffort: 'high', startedAt, timeoutMinutes: 1,
    status: 'running', state: 'RESEARCH', pid: record.pid, processStartedAt: startedAt,
    toolGroups: toolGroups ? [{ pgid: 100003, pid: 100003, startedAt }] : [] });
  vi.spyOn(runner, 'groupAlive').mockImplementation(pgid => pgid === 100003);
  vi.spyOn(processTime, 'processGroup').mockResolvedValue(100003);
  return { root, record };
}
async function clean(root: string, mode: string) {
  return mode === 'run' ? (await runCleanup(root, { scope: 'processes' })).processes! : await cleanupReport(root);
}
it.each(['run', 'report'])('N2: %s는 gone 도구 그룹 회수 성공을 확인한 뒤 stale로 마감한다', async mode => {
  const { root, record } = await codexFixture();
  vi.spyOn(identity, 'codexOwnership').mockResolvedValue('gone');
  vi.spyOn(identity, 'processIdentity').mockImplementation(async pid => pid === record.pid ? 'dead' : 'owned');
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockImplementation(async () => {
    expect((await readMeta(root, record.runId))?.finishedAt).toBeUndefined(); expect(await listProcs(root)).toEqual([record]); return true;
  });
  expect(await clean(root, mode)).toMatchObject({ ok: true, stale: [{ pid: record.pid }], residual: [] });
  expect(reap).toHaveBeenCalledExactlyOnceWith(0, [], [100003]);
  expect(await readMeta(root, record.runId)).toMatchObject({ status: 'lost', finishedAt: expect.any(String) });
  expect(await listProcs(root)).toEqual([]);
});
it.each(['run', 'report'])('N2: %s는 foreign의 검증된 별도 도구 그룹만 회수한다', async mode => {
  const { root, record } = await codexFixture();
  vi.spyOn(identity, 'codexOwnership').mockResolvedValue('foreign');
  vi.spyOn(identity, 'processIdentity').mockImplementation(async pid => pid === record.pid ? 'foreign' : 'owned');
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(true);
  expect(await clean(root, mode)).toMatchObject({ ok: true, stale: [{ pid: record.pid }], residual: [] });
  expect(reap).toHaveBeenCalledExactlyOnceWith(0, [], [100003]); expect(await listProcs(root)).toEqual([]);
});
it.each(['run', 'report'])('N2: %s는 foreign의 미검증 도구 그룹을 보고하고 기록·meta를 보존한다', async mode => {
  const { root, record } = await codexFixture();
  vi.spyOn(identity, 'codexOwnership').mockResolvedValue('foreign');
  vi.spyOn(identity, 'processIdentity').mockResolvedValue('foreign');
  const reap = vi.spyOn(tree, 'reclaimCodexTree');
  expect(await clean(root, mode)).toMatchObject({ ok: false, stale: [], residual: [{ pid: record.pid }] });
  expect(reap).not.toHaveBeenCalled(); expect(await listProcs(root)).toEqual([record]);
  expect((await readMeta(root, record.runId))?.finishedAt).toBeUndefined();
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'codex:residual', status: 'fail', evidence: { groups: [100003], reportOnly: true } }));
});
it.each(['run', 'report'])('N2: %s는 gone 도구 회수 실패를 stale 성공으로 처리하지 않는다', async mode => {
  const { root, record } = await codexFixture();
  vi.spyOn(identity, 'codexOwnership').mockResolvedValue('gone');
  vi.spyOn(identity, 'processIdentity').mockResolvedValue('owned');
  vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(false);
  expect(await clean(root, mode)).toMatchObject({ ok: false, stale: [], residual: [{ pid: record.pid }] });
  expect(await listProcs(root)).toEqual([record]); expect((await readMeta(root, record.runId))?.finishedAt).toBeUndefined();
});
it.each(['run', 'report'])('N2: %s는 도구 그룹 없는 죽은 codex를 기존 stale 경로로 제거한다', async mode => {
  const { root, record } = await codexFixture(false);
  vi.spyOn(identity, 'processIdentity').mockResolvedValue('dead');
  const reap = vi.spyOn(reclaim, 'reclaimCodexOwner');
  expect(await clean(root, mode)).toMatchObject({ ok: true, stale: [{ pid: record.pid }], residual: [] });
  expect(reap).not.toHaveBeenCalled(); expect(await listProcs(root)).toEqual([]);
  expect(await readMeta(root, record.runId)).toMatchObject({ status: 'lost' });
});
it('N2: report는 살아 있는 codex·도구 그룹에는 신호를 보내지 않는다', async () => {
  const { root, record } = await codexFixture();
  vi.spyOn(identity, 'codexOwnership').mockResolvedValue('owned');
  const reap = vi.spyOn(tree, 'reclaimCodexTree');
  expect(await cleanupReport(root)).toMatchObject({ ok: false, stale: [], residual: [record] });
  expect(reap).not.toHaveBeenCalled(); expect((await readMeta(root, record.runId))?.finishedAt).toBeUndefined();
});
