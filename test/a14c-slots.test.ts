import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { acquireSlot, slotsStatus, slotOwnerIdentity, slotOwnerAlive, type SlotOwner } from '../src/core/slots.ts';
import { commandSnapshot, parseCommandSnapshot, externalCodex, type ProcessSnapshotRow } from '../src/core/proc-tree.ts';
import * as procTree from '../src/core/proc-tree.ts';
import * as processTime from '../src/core/process-time.ts';
import * as lock from '../src/core/lock.ts';
import { readLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState, readState } from '../src/core/state.ts';
import { tick } from '../src/core/watcher.ts';
import { cancel } from '../src/core/codex.ts';
import { decideInbox } from '../extensions/orchestrator/index.ts';
const stamp = 'Sat Sep 26 20:00:00 2026';
const row = (pid: number, ppid: number, command: string): ProcessSnapshotRow => ({ pid, ppid, command, startedAt: stamp });
async function setup() {
  const root = await project('RESEARCH'); vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(stamp);
  vi.spyOn(lock, 'isProcessAlive').mockReturnValue(true);
  const owner: SlotOwner = { root, pid: process.pid, runId: 'harness', acquiredAt: stamp, startedAt: stamp };
  return { root, owner };
}
it.each(['node /plugins/codex-companion.mjs task --cwd /project/other', '/opt/bin/codex exec -C /project/other', 'codex exec task'])('P4 외부 감지 및 슬롯 기록: %s', async command => {
  const { root, owner } = await setup();
  const result = await acquireSlot('codex', owner, { snapshot: async () => [row(701, 1, command)] });
  expect(result).toMatchObject({ acquired: false, owner: { external: true, runId: 'external-701', pid: 701, startedAt: stamp } });
  expect((await slotsStatus()).codex?.external).toBe(true);
  await expect(cancel(root, 'external-701')).rejects.toThrow('취소 대상이 아닙니다');
});
it.each(['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', '/Applications/Codex.app/Contents/MacOS/Codex', 'node /bin/fodh-codex-supervisor'])
('P4 제외 조상 %s', async ancestor => {
  const { owner } = await setup();
  expect(await acquireSlot('codex', owner, { snapshot: async () => [row(801, 1, ancestor), row(802, 801, '/bin/codex exec')] })).toEqual({ acquired: true });
});
it('P4 현재 프로세스 조상·자손, 유휴 broker/app-server 제외 및 lstart 파싱', () => {
  expect(externalCodex([row(900, 1, 'codex exec'), row(901, 900, 'node fodh'), row(902, 901, 'codex exec')], 901)).toBeUndefined();
  expect(externalCodex([row(903, 1, 'codex app-server'), row(904, 1, 'app-server-broker')])).toBeUndefined();
  expect(parseCommandSnapshot(` 701 1 ${stamp} /opt/codex exec -C /tmp/proj\n`)).toEqual([row(701, 1, '/opt/codex exec -C /tmp/proj')]);
});
it('P4 외부 pid 사망→slot-free→PICK 자동 재개→다음 획득 및 stale', async () => {
  const { root, owner } = await setup();
  const held = await acquireSlot('codex', owner, { snapshot: async () => [row(701, 1, 'codex exec')] });
  if (held.acquired) throw new Error('expected external');
  await updateState(root, { state: 'paused(slot)', awaitingSlot: { kind: 'codex', since: stamp, owner: held.owner }, phase: 'project' });
  expect((await tick(root, { now: Date.now() })).emitted).toEqual([]);
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid !== 701);
  expect(await slotOwnerIdentity(held.owner)).toBe('gone');
  const emitted = (await tick(root, { now: Date.now() + 60001 })).emitted;
  expect(emitted).toContainEqual(expect.objectContaining({ kind: 'slot-free', ownerRunId: 'external-701' }));
  const sendMessage = vi.fn();
  await decideInbox({ sendMessage } as never, { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } } as never, root, emitted);
  expect((await readState(root)).state).toBe('PICK'); expect(sendMessage).toHaveBeenCalledOnce();
  expect(await acquireSlot('codex', owner, { snapshot: async () => [] })).toEqual({ acquired: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'slot:stale', status: 'ok' }));
});
it('P4 externalGuard false 검사 생략, 스냅샷 실패는 원장만 남기고 획득', async () => {
  const { root, owner } = await setup();
  const snapshot = vi.fn(async () => { throw new Error('ps unavailable'); });
  await setConfig(root, 'delegate.codex.externalGuard', 'false');
  expect(await acquireSlot('codex', owner, { snapshot })).toEqual({ acquired: true }); expect(snapshot).not.toHaveBeenCalled();
  const { releaseSlot } = await import('../src/core/slots.ts'); await releaseSlot('codex', owner.runId);
  await setConfig(root, 'delegate.codex.externalGuard', 'true');
  const spy = vi.spyOn(procTree, 'commandSnapshot').mockImplementation(snapshot);
  expect(await acquireSlot('codex', owner)).toEqual({ acquired: true });
  expect(spy).toHaveBeenCalledOnce(); expect(snapshot).toHaveBeenCalledOnce();
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'slot:external-scan', status: 'fail' }));
});
it('P4 외부 PID 재사용은 foreign, 시작 시각 확인 불가는 유지', async () => {
  const { owner } = await setup(), external = { ...owner, external: true, pid: 701, runId: 'external-701' };
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('Sat Sep 26 21:00:00 2026');
  expect(await slotOwnerAlive(external)).toBe(false);
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(undefined);
  expect(await slotOwnerAlive(external)).toBe(true);
});

it('P4 프로세스 스냅샷·cwd 조회는 C 로케일 및 주입 실행 함수 사용', async () => {
  const run = vi.fn(async (file: string) => ({ stdout: file === '/bin/ps' ? `701 1 ${stamp} /opt/codex exec\n` : 'p701\nn/project/other\n' }));
  expect(await commandSnapshot(run)).toEqual([{ ...row(701, 1, '/opt/codex exec'), root: '/project/other' }]);
  expect(run).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C' }) }));
  expect(run).toHaveBeenCalledWith('/usr/sbin/lsof', ['-a', '-p', '701', '-d', 'cwd', '-Fn'], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }));
});
