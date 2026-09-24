import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slotOwnerAlive, acquireSlot, releaseSlot, slotsStatus, slotsPath, updateSlot, type SlotOwner } from '../src/core/slots.ts';
import { atomicWrite } from '../src/core/storage.ts';
import { readLedger } from '../src/core/ledger.ts';
import * as processTime from '../src/core/process-time.ts';
import * as runner from '../src/provider/runner.ts';
import * as lock from '../src/core/lock.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-slots-')); roots.push(root); vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  const owner: SlotOwner = { root, runId: 'a', pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), acquiredAt: new Date().toISOString() };
  return { root, owner };
}
it('획득·다른 runId 해제 거부·갱신·소유자만 해제', async () => {
  const { owner } = await setup(); expect(await acquireSlot('codex', owner)).toEqual({ acquired: true });
  expect(await acquireSlot('codex', { ...owner, runId: 'b' })).toEqual({ acquired: false, owner });
  await releaseSlot('codex', 'b'); expect((await slotsStatus()).codex).toEqual(owner);
  await updateSlot('codex', 'a', { pid: process.pid, startedAt: owner.startedAt });
  await expect(updateSlot('codex', 'b', owner)).rejects.toThrow('소유권');
  await releaseSlot('codex', 'a'); expect(await slotsStatus()).toEqual({ codex: null, claude: null, alive: { codex: false, claude: false } });
});
it('죽은 슬롯은 stale 원장을 남기고 회수한다', async () => {
  const { root, owner } = await setup();
  await atomicWrite(slotsPath(), JSON.stringify({ codex: { ...owner, pid: 99999999, runId: 'dead' }, claude: null }));
  expect(await acquireSlot('codex', owner)).toEqual({ acquired: true });
  expect(await readLedger(root)).toEqual([expect.objectContaining({ action: 'slot:stale', status: 'ok' })]);
});
it('실제 파일 잠금 경합에서 하나만 획득한다', async () => {
  const { owner } = await setup();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireSlot('codex', { ...owner, runId: `r${i}` })));
  expect(results.filter(item => item.acquired)).toHaveLength(1);
});
it('PID 재사용과 ±2초 경계, ps 불가 시 살아 있는 슬롯 보존', async () => {
  const { owner } = await setup(); const start = Date.parse(owner.startedAt);
  const observed = vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(new Date(start + 2000).toISOString());
  await atomicWrite(slotsPath(), JSON.stringify({ codex: owner, claude: null }));
  expect((await acquireSlot('codex', { ...owner, runId: 'b' })).acquired).toBe(false);
  observed.mockResolvedValue(undefined);
  expect((await acquireSlot('codex', { ...owner, runId: 'b' })).acquired).toBe(false);
  observed.mockResolvedValue(new Date(start + 2001).toISOString());
  expect((await acquireSlot('codex', { ...owner, runId: 'b' })).acquired).toBe(true);
});

it('죽은 감독의 그룹이 살아 있으면 슬롯을 계속 점유한다', async () => {
  const { owner } = await setup(); const orphan = { ...owner, pid: 99999999, childPid: 99999998, childStartedAt: owner.startedAt };
  await atomicWrite(slotsPath(), JSON.stringify({ codex: orphan, claude: null }));
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid !== orphan.pid);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(owner.startedAt);
  vi.spyOn(processTime, 'processGroup').mockResolvedValue(orphan.pid);
  expect(await slotOwnerAlive(orphan)).toBe(true);
  expect(await acquireSlot('codex', { ...owner, runId: 'replacement' })).toEqual({ acquired: false, owner: orphan });
  expect((await readLedger(owner.root)).filter(entry => entry.action === 'slot:stale')).toEqual([]);
});

it('리더 사망 뒤 생존 그룹의 자식 신원이 불일치하면 슬롯을 stale로 회수한다', async () => {
  const { owner } = await setup(); const orphan = { ...owner, pid: 99999999, childPid: 99999998, childStartedAt: '2026-09-24T00:00:00Z' };
  await atomicWrite(slotsPath(), JSON.stringify({ codex: orphan, claude: null }));
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid !== orphan.pid);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('2026-09-24T01:00:00Z');
  expect(await slotOwnerAlive(orphan)).toBe(false);
  expect((await acquireSlot('codex', { ...owner, runId: 'replacement' })).acquired).toBe(true);
});

it.each(['start', 'group'] as const)('죽은 리더의 자식 %s 조회 실패는 unknown으로 슬롯을 보존한다', async failed => {
  const { owner } = await setup(); const orphan = { ...owner, pid: 99999999, childPid: 99999998, childStartedAt: owner.startedAt };
  await atomicWrite(slotsPath(), JSON.stringify({ codex: orphan, claude: null }));
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || pid === orphan.childPid);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(failed === 'start' ? undefined : owner.startedAt);
  vi.spyOn(processTime, 'processGroup').mockResolvedValue(failed === 'group' ? undefined : orphan.pid);
  expect(await slotOwnerAlive(orphan)).toBe(true);
  expect(await acquireSlot('codex', { ...owner, runId: 'replacement' })).toEqual({ acquired: false, owner: orphan });
  expect(await readLedger(owner.root)).toEqual([]);
});
