import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateState, readState } from '../src/core/state.ts';
import * as cleanup from '../src/core/cleanup.ts';
import * as notification from '../src/core/notify.ts';
import { setConfig } from '../src/core/config.ts';
import { readLedger } from '../src/core/ledger.ts';
import { harnessPath } from '../src/core/storage.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-state-cleanup-')); roots.push(root);
  await setConfig(root, 'notify.channels', '["ledger"]'); await updateState(root, { state: 'PICK' }); return root;
}
it('M2: 정리가 throw해도 WAIT 전이 커밋·state 원장·cleanup fail을 보존한다', async () => {
  const root = await setup();
  const clean = vi.spyOn(cleanup, 'runCleanup').mockImplementation(async () => {
    expect((await readState(root)).state).toBe('WAIT_RESOURCE'); throw new Error('cleanup lock failed');
  });
  const notice = vi.spyOn(notification, 'notify');
  expect(await updateState(root, { state: 'WAIT_RESOURCE' })).toMatchObject({ state: 'WAIT_RESOURCE' });
  expect(clean).toHaveBeenCalledOnce();
  expect(await readLedger(root)).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'state:PICK→WAIT_RESOURCE', status: 'ok' }),
    expect.objectContaining({ action: 'cleanup:processes', status: 'fail', evidence: { error: 'cleanup lock failed' } }),
  ]));
  expect(notice.mock.calls[0][1].body).toBe('하네스 상태: WAIT_RESOURCE');
});
it('M2: notify throw는 호출자에게 전파되지 않고 fail 원장을 남긴다', async () => {
  const root = await setup(); vi.spyOn(notification, 'notify').mockRejectedValue(new Error('notify unavailable'));
  await expect(updateState(root, { state: 'paused(error)' })).resolves.toMatchObject({ state: 'paused(error)' });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:state:paused(error)', status: 'fail', evidence: { error: 'notify unavailable' } }));
});
it('M2/L11: CAS 충돌 5회면 오류를 내고 정리·알림은 실행하지 않는다', async () => {
  const root = await setup(), clean = vi.spyOn(cleanup, 'runCleanup'), notice = vi.spyOn(notification, 'notify');
  const patch = vi.fn(async current => {
    await writeFile(harnessPath(root, 'harness-state.json'), JSON.stringify({ ...current, collision: Number(current.collision ?? 0) + 1 }));
    return { state: 'WAIT_RESOURCE' };
  });
  await expect(updateState(root, patch)).rejects.toThrow('상태 갱신 경합이 계속됩니다');
  expect(patch).toHaveBeenCalledTimes(5); expect(clean).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled();
  expect((await readState(root)).state).toBe('PICK');
});
it('L11: CAS 재시도 후 커밋된 전이에만 정리·알림을 한 번 실행한다', async () => {
  const root = await setup(), clean = vi.spyOn(cleanup, 'runCleanup'), notice = vi.spyOn(notification, 'notify'); let tries = 0;
  await updateState(root, async current => {
    if (++tries < 5) await writeFile(harnessPath(root, 'harness-state.json'), JSON.stringify({ ...current, collision: tries }));
    return { state: 'WAIT_RESOURCE' };
  });
  expect(tries).toBe(5); expect(clean).toHaveBeenCalledOnce(); expect(notice).toHaveBeenCalledOnce();
  expect((await readState(root)).state).toBe('WAIT_RESOURCE');
});
