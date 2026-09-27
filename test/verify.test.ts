import * as procs from '../src/core/procs.ts';
import * as processTime from '../src/core/process-time.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVerify } from '../src/core/verify.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState } from '../src/core/state.ts';
import { slotsStatus, acquireSlot, releaseSlot } from '../src/core/slots.ts';
import { listProcs } from '../src/core/procs.ts';
import { readLedger } from '../src/core/ledger.ts';
import * as tree from '../src/core/proc-tree.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function setup(state = 'VERIFY') {
  const root = await mkdtemp(join(tmpdir(), 'fodh-verify-')); roots.push(root);
  await setConfig(root, 'notify.channels', '["ledger"]'); await updateState(root, { state }); return root;
}
async function script(root: string, name: string, code: string) { const path = join(root, name); await writeFile(path, code); return `${process.execPath} ${path}`; }
it('명령 순차 실행·실패 중단·redact tail 4KB·레지스트리 및 원장', async () => {
  const root = await setup();
  const first = await script(root, 'first.cjs', 'require("fs").writeFileSync("order", "first"); console.log("x".repeat(5000)); console.log("sk-ant-FAKE_TEST_CREDENTIAL");');
  const second = await script(root, 'second.cjs', 'if(require("fs").readFileSync("order", "utf8") !== "first") process.exit(2); process.exit(1);');
  const third = await script(root, 'third.cjs', 'require("fs").writeFileSync("not-run", "bad");');
  await setConfig(root, 'verify.commands', JSON.stringify([first, second, third]));
  const result = await runVerify(root); if (!('commands' in result)) throw new Error(result.error);
  expect(result.ok).toBe(false); expect(result.commands).toHaveLength(2); expect(result.commands?.map(c => c.exit)).toEqual([0, 1]);
  expect(result.commands?.[0].tailLog.length).toBeLessThanOrEqual(4096); expect(result.commands?.[0].tailLog).not.toContain('FAKE_TEST_CREDENTIAL');
  expect(await readdir(root)).not.toContain('not-run'); expect(await listProcs(root)).toEqual([]);
  expect((await readLedger(root)).filter(e => e.action === 'verify:run').map(e => e.status)).toEqual(['pre', 'fail']);
});
it('상태·빈 설정·cwd 경계 검사', async () => {
  const root = await setup('IMPLEMENT'); expect(await runVerify(root)).toMatchObject({ ok: false, error: expect.stringContaining('VERIFY') });
  await updateState(root, { state: 'FIX' }); expect(await runVerify(root)).toMatchObject({ ok: false, error: 'verify.commands 가 비어 있습니다' });
  await setConfig(root, 'verify.commands', '["node --version"]'); await expect(runVerify(root, { cwd: '/' })).rejects.toThrow('--cwd');
});
it('heavy·codex 양방향 배타, 종료 후 슬롯 해제', async () => {
  const root = await setup(), owner = { root, runId: 'codex', pid: process.pid, startedAt: 'spawn:unknown', acquiredAt: 'now' };
  await acquireSlot('codex', owner); await setConfig(root, 'verify.heavy', JSON.stringify([await script(root, 'heavy.cjs', 'console.log("heavy");')]));
  expect(await runVerify(root, { heavy: true })).toMatchObject({ ok: false, error: '위임 실행 중에는 무거운 검증을 시작할 수 없습니다', owner });
  await releaseSlot(root, 'codex', 'codex'); await acquireSlot('heavy', { ...owner, runId: 'heavy' });
  expect(await acquireSlot('codex', owner)).toMatchObject({ acquired: false, owner: { runId: 'heavy' } });
  await releaseSlot(root, 'heavy', 'heavy'); expect((await runVerify(root, { heavy: true })).ok).toBe(true);
  expect((await slotsStatus(root)).heavy).toBeNull();
});
it('타임아웃은 등록된 프로세스 트리만 회수하고 뒤 명령을 실행하지 않는다', async () => {
  const root = await setup(); await setConfig(root, 'verify.timeoutMinutes', '0.002');
  await setConfig(root, 'verify.commands', JSON.stringify([await script(root, 'slow.cjs', 'setInterval(()=>{},1000);'), 'node --version']));
  const reap = vi.spyOn(tree, 'reclaimCodexTree');
  const report = await runVerify(root); if (!('commands' in report)) throw new Error(report.error); expect(report.ok).toBe(false); expect(report.commands).toHaveLength(1);
  expect(report.commands?.[0]).toMatchObject({ timedOut: true, residual: false });
  expect(reap).toHaveBeenCalledWith(expect.any(Number), [expect.any(Number)]); expect(await listProcs(root)).toEqual([]);
}, 15000);

it.each(['SIGTERM', 'SIGINT'])('M5: 외부 %s 종료는 코드 실패 대신 interrupted를 결과·원장에 남긴다', async signal => {
  const root = await setup();
  await setConfig(root, 'verify.commands', JSON.stringify([await script(root, 'signal.cjs', `process.kill(process.pid, '${signal}');`), 'node --version']));
  const report = await runVerify(root);
  expect(report).toMatchObject({ ok: false, interrupted: 'signal', commands: [{ interrupted: 'signal', timedOut: false, exit: null }] });
  expect((await readLedger(root)).findLast(e => e.action === 'verify:run')).toMatchObject({ status: 'fail', evidence: { interrupted: 'signal' } });
});

it.each([false, true])('N1: verify heavy=%s 등록에 소유 CLI 신원과 fallback을 저장한다', async heavy => {
  const root = await setup(), startedAt = '2026-09-24T00:00:00Z';
  await setConfig(root, heavy ? 'verify.heavy' : 'verify.commands', JSON.stringify([await script(root, 'owner.cjs', 'console.log("owner fixture");')]));
  const actual = processTime.processStartedAt;
  vi.spyOn(processTime, 'processStartedAt').mockImplementation(async pid => pid === process.pid ? (heavy ? undefined : startedAt) : actual(pid));
  const register = vi.spyOn(procs, 'registerProc');
  expect((await runVerify(root, { heavy })).ok).toBe(true);
  expect(register).toHaveBeenCalledWith(await realpath(root), expect.objectContaining({ kind: 'verify', ownerPid: process.pid,
    ownerStartedAt: heavy ? expect.stringMatching(/^spawn:/u) : startedAt }));
  expect(await listProcs(root)).toEqual([]);
});
