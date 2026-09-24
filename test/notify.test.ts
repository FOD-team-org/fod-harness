import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { notify } from '../src/core/notify.ts';
import { setConfig } from '../src/core/config.ts';
import { harnessPath } from '../src/core/storage.ts';
import { readLedger } from '../src/core/ledger.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'fodh-notify-')); roots.push(root); return root; }
const message = { key: 'notice', level: 'warning' as const, title: '제목 "둘"', body: '본문 "따옴표"\n다음\\줄' };
it('채널별 분기·osascript 단일 인자 이스케이프·원장 항상', async () => {
  const root = await setup(), exec = vi.fn().mockResolvedValue({}), tui = vi.fn();
  await notify(root, message, { notify: tui }, { exec, now: 0 });
  expect(tui).toHaveBeenCalledWith(message.body, 'warning');
  expect(exec).toHaveBeenCalledWith('osascript', ['-e', 'display notification "본문 \\"따옴표\\"\\n다음\\\\줄" with title "제목 \\"둘\\""']);
  expect((await readLedger(root))[0]).toMatchObject({ action: 'notify:notice', status: 'ok' });
});
it('print 모드에도 macos·slack은 skip만·동일 key 60초 제한', async () => {
  const root = await setup(), exec = vi.fn().mockResolvedValue({}), tui = vi.fn();
  await setConfig(root, 'notify.channels', '["macos","slack","tui"]');
  for (const now of [0, 59999, 60000]) await notify(root, message, { hasUI: false, notify: tui }, { exec, now });
  expect(exec).toHaveBeenCalledTimes(2); expect(tui).not.toHaveBeenCalled();
  const ledger = await readLedger(root);
  expect(ledger.filter(e => e.action === 'notify:notice').map(e => e.status)).toEqual(['ok', 'skip', 'ok']);
  expect(ledger.filter(e => e.action === 'notify:slack')).toHaveLength(3);
});
it('ledger-only, redact·200자 절단은 모든 채널과 원장에 적용', async () => {
  const root = await setup(), exec = vi.fn(); await setConfig(root, 'notify.channels', '["ledger"]');
  const body = 'sk-ant-FAKE_TEST_CREDENTIAL ' + 'x'.repeat(250);
  await notify(root, { ...message, body }, { notify: vi.fn() }, { exec });
  expect(exec).not.toHaveBeenCalled(); const text = JSON.stringify(await readLedger(root));
  expect(text).not.toContain('FAKE_TEST_CREDENTIAL');
  expect(((await readLedger(root))[0].evidence as any).body.length).toBeLessThanOrEqual(200);
});
it('disposed TUI·macos 실패는 원장에 남기며 알림 호출을 실패시키지 않는다', async () => {
  const root = await setup();
  await expect(notify(root, message, { notify: () => { throw new Error('disposed'); } }, { exec: async () => { throw new Error('osascript unavailable'); } })).resolves.toMatchObject({ sent: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:macos', status: 'fail' }));
});

it('L5: 프로세스 Map을 비워도 원장으로 60초 제한하며 skip은 창을 연장하지 않는다', async () => {
  const root = await setup(), exec = vi.fn().mockResolvedValue({}), tui = vi.fn();
  const clear = () => (Reflect.get(globalThis, Symbol.for('fod-harness.notify.last')) as Map<string, number>).clear();
  await notify(root, message, { notify: tui }, { exec, now: 1000 }); clear();
  expect(await notify(root, message, { notify: tui }, { exec, now: 60999 })).toEqual({ sent: false, limited: true }); clear();
  expect(await notify(root, message, { notify: tui }, { exec, now: 61000 })).toEqual({ sent: true, limited: false });
  expect(exec).toHaveBeenCalledTimes(2); expect(tui).toHaveBeenCalledTimes(2);
});

it('L5: 원장 마지막 200줄 밖의 성공과 손상된 끝줄은 제한 근거가 아니다', async () => {
  const root = await setup(), exec = vi.fn().mockResolvedValue({});
  await notify(root, message, undefined, { exec, now: 1000 });
  await appendFile(harnessPath(root, 'harness-ledger.jsonl'), '{}\n'.repeat(200) + '{partial');
  (Reflect.get(globalThis, Symbol.for('fod-harness.notify.last')) as Map<string, number>).clear();
  expect(await notify(root, message, undefined, { exec, now: 2000 })).toMatchObject({ limited: false });
  expect(exec).toHaveBeenCalledTimes(2);
});
