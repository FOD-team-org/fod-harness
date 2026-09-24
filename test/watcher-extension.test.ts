import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import watcher from '../extensions/watcher/index.ts';
import { tick, detectRecovery } from '../src/core/watcher.ts';
import { decideInbox } from '../extensions/orchestrator/index.ts';
import { appendLedger } from '../src/core/ledger.ts';
import { loadConfig } from '../src/core/config.ts';
import { watch } from 'node:fs';
vi.mock('../src/core/watcher.ts', () => ({ tick: vi.fn(), detectRecovery: vi.fn() }));
vi.mock('../extensions/orchestrator/index.ts', () => ({ decideInbox: vi.fn() }));
vi.mock('../src/core/ledger.ts', () => ({ appendLedger: vi.fn() }));
vi.mock('../src/core/config.ts', () => ({ loadConfig: vi.fn() }));
vi.mock('node:fs', () => ({ watch: vi.fn() }));
const record = { id: 'event', kind: 'recover', status: 'queued' as const, at: 'now' };
const close = vi.fn(), on = vi.fn();
const sessions: { stop: () => Promise<void> }[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(tick).mockResolvedValue({ emitted: [], status: { lastTickAt: null, judgment: { observedHash: null, expectedHash: null, stableFor: 0 }, childTimeouts: 0 } });
  vi.mocked(detectRecovery).mockResolvedValue([record]);
  vi.mocked(decideInbox).mockResolvedValue(undefined);
  vi.mocked(appendLedger).mockImplementation(async (_root, entry) => entry);
  vi.mocked(loadConfig).mockResolvedValue({ judgment: { file: 'docs/판단대기.md' },
    watch: { pollSeconds: 5, tickSeconds: 30, stableSeconds: 10, stallMinutes: 10, childTimeoutMinutes: 30 } } as any);
  vi.mocked(watch).mockReturnValue({ close, on } as any);
});
afterEach(async () => { for (const t of sessions.splice(0)) await t.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(hasUI = true) {
  const handlers = new Map<string, any>();
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  watcher(pi);
  const ctx = { cwd: '/test-project', hasUI, isIdle: () => true, ui: { notify: vi.fn() } };
  const t = { pi, ctx, handlers, start: () => handlers.get('session_start')({}, ctx), stop: () => handlers.get('session_shutdown')({}, ctx) };
  sessions.push(t); return t;
}
it('등록 순서 provider → orchestrator → watcher', async () => {
  expect(JSON.parse(await readFile('package.json', 'utf8')).pi.extensions).toEqual([
    './extensions/provider/index.ts', './extensions/orchestrator/index.ts', './extensions/watcher/index.ts',
  ]);
});
it('session_start는 복구 기록 뒤 자신의 pi와 ctx로 결정하고 부모 폴더 감시', async () => {
  const t = await setup(); await t.start();
  expect(detectRecovery).toHaveBeenCalledWith(t.ctx.cwd, expect.any(String));
  expect(decideInbox).toHaveBeenCalledWith(t.pi, t.ctx, t.ctx.cwd, [record]);
  expect(vi.mocked(detectRecovery).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(decideInbox).mock.invocationCallOrder[0]);
  expect(watch).toHaveBeenCalledWith('/test-project/docs', { persistent: false }, expect.any(Function));
});
it('두 타이머 unref·poll/전체 tick 구분·동일 시각 전체 tick 우선·신규 이벤트 결정', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval'); const t = await setup(); await t.start();
  expect(interval).toHaveBeenCalledTimes(2);
  for (const call of interval.mock.results) expect(call.value.hasRef()).toBe(false);
  vi.mocked(tick).mockResolvedValueOnce({ emitted: [{ ...record, kind: 'judgment-changed' }], status: {} as any });
  await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenLastCalledWith(t.ctx.cwd, { ctx: t.ctx, judgmentOnly: true });
  expect(decideInbox).toHaveBeenLastCalledWith(t.pi, t.ctx, t.ctx.cwd, [expect.objectContaining({ kind: 'judgment-changed' })]);
  await vi.advanceTimersByTimeAsync(25000);
  expect(vi.mocked(tick).mock.calls.some(([, opts]) => opts?.judgmentOnly === false)).toBe(true);
});
it('print 모드는 복구 기록만 남기며 결정·타이머·fs.watch 없음', async () => {
  const t = await setup(false); await t.start();
  expect(detectRecovery).toHaveBeenCalledTimes(1); expect(decideInbox).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); expect(watch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000); expect(tick).not.toHaveBeenCalled();
});
it('fs.watch는 500ms 디바운스하고 shutdown은 타이머와 감시를 정리한다', async () => {
  const t = await setup(); await t.start(); const [, , callback] = vi.mocked(watch).mock.calls[0] as unknown as [string, object, (event: string, file: string) => void];
  callback('rename', '판단대기.md'); await vi.advanceTimersByTimeAsync(400); callback('change', '판단대기.md');
  await vi.advanceTimersByTimeAsync(499); expect(tick).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(1);
  callback('rename', '판단대기.md'); await t.stop();
  expect(close).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60000); expect(tick).toHaveBeenCalledTimes(1);
});
it('동시 tick 건너뜀·shutdown이 진행 중 작업 완료를 기다리고 종료 뒤 결정 없음', async () => {
  const t = await setup(); await t.start();
  let finish!: (value: any) => void;
  vi.mocked(tick).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(30000); expect(tick).toHaveBeenCalledTimes(1);
  let stopped = false; const shutdown = t.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish({ emitted: [record], status: {} }); await shutdown;
  expect(stopped).toBe(true); expect(decideInbox).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it('콜백 예외는 원장 fail·warning 분당 1회, 복구된 다음 tick은 계속한다', async () => {
  const t = await setup(); await t.start(); vi.mocked(tick).mockRejectedValue(new Error('tick exploded'));
  await expect(vi.advanceTimersByTimeAsync(60000)).resolves.toBe(vi);
  expect(appendLedger).toHaveBeenCalledWith(t.ctx.cwd, expect.objectContaining({ action: 'watcher:tick', status: 'fail', evidence: { message: 'tick exploded' } }));
  expect(t.ctx.ui.notify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(t.ctx.ui.notify).toHaveBeenCalledTimes(2);
  vi.mocked(tick).mockResolvedValue({ emitted: [], status: {} as any }); await vi.advanceTimersByTimeAsync(5000);
});
it.each(['sync', 'async'])('fs.watch %s 실패는 원장에 남기고 폴링 지속', async mode => {
  const t = await setup();
  if (mode === 'sync') vi.mocked(watch).mockImplementationOnce(() => { throw new Error('EMFILE'); });
  await t.start();
  if (mode === 'async') { on.mock.calls[0][1](new Error('EMFILE')); await Promise.resolve(); }
  expect(appendLedger).toHaveBeenCalledWith(t.ctx.cwd, expect.objectContaining({ action: 'watcher:fs-watch', status: 'fail' }));
  await vi.advanceTimersByTimeAsync(5000); expect(tick).toHaveBeenCalledTimes(1);
});
it('원장·UI도 실패해도 타이머 예외를 Pi로 전파하지 않는다', async () => {
  const t = await setup(); await t.start(); vi.mocked(tick).mockRejectedValue(new Error('io'));
  vi.mocked(appendLedger).mockRejectedValue(new Error('ledger io')); t.ctx.ui.notify.mockImplementation(() => { throw new Error('disposed'); });
  await expect(vi.advanceTimersByTimeAsync(5000)).resolves.toBe(vi);
});
it('최신 ctx 전달·설정 경로 변경 때 부모 디렉터리 감시 교체', async () => {
  const t = await setup(); await t.start(); const next = { ...t.ctx, isIdle: () => false };
  await t.handlers.get('agent_start')({}, next);
  vi.mocked(loadConfig).mockResolvedValue({ judgment: { file: 'new/판단.md' } } as any);
  await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenLastCalledWith(t.ctx.cwd, { ctx: next, judgmentOnly: true });
  expect(watch).toHaveBeenLastCalledWith('/test-project/new', { persistent: false }, expect.any(Function)); expect(close).toHaveBeenCalledTimes(1);
});
