import { runCleanup } from '../src/core/cleanup.ts';
vi.mock('../src/core/cleanup.ts', () => ({ runCleanup: vi.fn().mockResolvedValue({ ok: true }) }));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFile, stat } from 'node:fs/promises';
import watcher from '../extensions/watcher/index.ts';
import { tick, memoryTick, detectRecovery, pendingDecisions, recordDecision } from '../src/core/watcher.ts';
import { decideInbox, clearDecisionTimers } from '../extensions/orchestrator/index.ts';
import { appendLedger } from '../src/core/ledger.ts';
import { loadConfig } from '../src/core/config.ts';
import { watch } from 'node:fs';
vi.mock('../src/core/watcher.ts', () => ({ tick: vi.fn(), memoryTick: vi.fn(), detectRecovery: vi.fn(), pendingDecisions: vi.fn(), recordDecision: vi.fn() }));
vi.mock('../extensions/orchestrator/index.ts', () => ({ decideInbox: vi.fn(), clearDecisionTimers: vi.fn() }));
vi.mock('../src/core/ledger.ts', () => ({ appendLedger: vi.fn() }));
vi.mock('../src/core/config.ts', () => ({ loadConfig: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), stat: vi.fn() }));
vi.mock('node:fs', () => ({ watch: vi.fn() }));
const record = { id: 'event', kind: 'recover', status: 'queued' as const, at: 'now' };
const close = vi.fn(), on = vi.fn();
const sessions: { stop: () => Promise<void> }[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(tick).mockResolvedValue({ emitted: [], status: { lastTickAt: null, judgment: { observedHash: null, expectedHash: null, stableFor: 0 }, childTimeouts: 0 } });
  vi.mocked(detectRecovery).mockResolvedValue([record]);
  vi.mocked(memoryTick).mockResolvedValue([]);
  vi.mocked(decideInbox).mockResolvedValue({ deferred: [] });
  vi.mocked(pendingDecisions).mockResolvedValue([]).mockResolvedValueOnce([record]);
  vi.mocked(recordDecision).mockResolvedValue(undefined);
  vi.mocked(appendLedger).mockImplementation(async (_root, entry) => entry);
  vi.mocked(loadConfig).mockResolvedValue({ judgment: { file: 'docs/판단대기.md' },
    watch: { pollSeconds: 5, tickSeconds: 30, stableSeconds: 10, stallMinutes: 10, childTimeoutMinutes: 30 } } as any);
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
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
  expect(decideInbox).toHaveBeenCalledWith(t.pi, expect.objectContaining({ cwd: t.ctx.cwd, isIdle: expect.any(Function) }), t.ctx.cwd, [record], expect.objectContaining({ retry: expect.any(Function) }));
  expect(vi.mocked(detectRecovery).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(decideInbox).mock.invocationCallOrder[0]);
  expect(watch).toHaveBeenCalledWith('/test-project/docs', { persistent: false }, expect.any(Function));
});
it('세 타이머 unref·poll/전체 tick 구분·동일 시각 전체 tick 우선·신규 이벤트 결정', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval'); const t = await setup(); await t.start();
  expect(interval).toHaveBeenCalledTimes(3);
  for (const call of interval.mock.results) expect(call.value.hasRef()).toBe(false);
  vi.mocked(tick).mockResolvedValueOnce({ emitted: [{ ...record, kind: 'judgment-changed' }], status: {} as any });
  vi.mocked(pendingDecisions).mockResolvedValueOnce([{ ...record, kind: 'judgment-changed' }]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenLastCalledWith(t.ctx.cwd, { ctx: expect.objectContaining({ cwd: t.ctx.cwd, isIdle: expect.any(Function) }), judgmentOnly: true });
  expect(decideInbox).toHaveBeenLastCalledWith(t.pi, expect.objectContaining({ cwd: t.ctx.cwd, isIdle: expect.any(Function) }), t.ctx.cwd, [expect.objectContaining({ kind: 'judgment-changed' })], expect.objectContaining({ retry: expect.any(Function) }));
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
  const calls = vi.mocked(tick).mock.calls.length, failures = vi.mocked(appendLedger).mock.calls.length;
  vi.mocked(tick).mockResolvedValue({ emitted: [], status: {} as any }); await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenCalledTimes(calls + 1); expect(appendLedger).toHaveBeenCalledTimes(failures);
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
  vi.mocked(loadConfig).mockResolvedValue({ judgment: { file: 'new/판단.md' }, watch: { pollSeconds: 5, tickSeconds: 30 } } as any);
  await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenLastCalledWith(t.ctx.cwd, { ctx: expect.objectContaining({ cwd: next.cwd, isIdle: expect.any(Function) }), judgmentOnly: true });
  expect(vi.mocked(tick).mock.calls.at(-1)![1]!.ctx && (vi.mocked(tick).mock.calls.at(-1)![1]!.ctx as any).isIdle()).toBe(false);
  expect(watch).toHaveBeenLastCalledWith('/test-project/new', { persistent: false }, expect.any(Function)); expect(close).toHaveBeenCalledTimes(1);
});
it('M2: 새 emitted가 없어도 이전 CLI/세션의 미결정 항목을 시작과 다음 tick에 처리', async () => {
  const t = await setup(); const previous = { ...record, id: 'cli-event', kind: 'judgment-changed' };
  vi.mocked(pendingDecisions).mockReset().mockResolvedValue([]).mockResolvedValueOnce([previous]);
  await t.start(); expect(decideInbox).toHaveBeenCalledWith(t.pi, expect.any(Object), t.ctx.cwd, [previous], expect.any(Object));
  expect(recordDecision).toHaveBeenCalledWith(t.ctx.cwd, previous);
  const later = { ...previous, id: 'shutdown-event' }; vi.mocked(pendingDecisions).mockResolvedValueOnce([later]);
  await vi.advanceTimersByTimeAsync(5000); expect(recordDecision).toHaveBeenLastCalledWith(t.ctx.cwd, later);
});
it('M2: 결정 예외는 완료로 기록하지 않고 다음 tick에 재시도, deferred는 완료 보류', async () => {
  const t = await setup(); const failure = new Error('decision');
  vi.mocked(decideInbox).mockRejectedValueOnce(failure); await t.start();
  expect(recordDecision).toHaveBeenCalledWith(t.ctx.cwd, record, failure);
  vi.mocked(pendingDecisions).mockResolvedValueOnce([record]); await vi.advanceTimersByTimeAsync(5000);
  expect(recordDecision).toHaveBeenLastCalledWith(t.ctx.cwd, record);
  vi.mocked(pendingDecisions).mockResolvedValueOnce([record]); vi.mocked(decideInbox).mockResolvedValueOnce({ deferred: [record.id] });
  const completed = vi.mocked(recordDecision).mock.calls.length; await vi.advanceTimersByTimeAsync(5000);
  expect(recordDecision).toHaveBeenCalledTimes(completed);
});
it('M3: 복구 감지가 실패해도 잔여 결정·타이머·다음 tick을 계속한다', async () => {
  const t = await setup(); vi.mocked(detectRecovery).mockRejectedValueOnce(new Error('recovery'));
  await t.start(); expect(vi.getTimerCount()).toBe(3); expect(decideInbox).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(tick).toHaveBeenCalledTimes(1);
});
it('M3: 시작 설정 실패는 5/30초 기본 폴링, 복구 후 설정 주기를 재로드', async () => {
  const t = await setup(); vi.mocked(loadConfig).mockRejectedValue(new Error('bad json'));
  await t.start(); expect(vi.getTimerCount()).toBe(3);
  vi.mocked(loadConfig).mockResolvedValue({ judgment: { file: 'docs/판단대기.md' }, watch: { pollSeconds: 2, tickSeconds: 20 } } as any);
  await vi.advanceTimersByTimeAsync(5000); expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000); expect(tick).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(3);
});
it('L1: 실행 중 전체 tick 요청은 합쳐서 한 번 더 실행', async () => {
  const t = await setup(); await t.start(); let finish!: (result: any) => void;
  vi.mocked(tick).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(60000); expect(tick).toHaveBeenCalledTimes(1);
  finish({ emitted: [], status: {} }); await vi.advanceTimersByTimeAsync(0);
  expect(tick).toHaveBeenCalledTimes(2); expect(vi.mocked(tick).mock.calls[1][1]?.judgmentOnly).toBe(false);
});
it.each(['sync', 'async'])('L4: fs.watch %s 실패 뒤 다음 tick에서 감시 재시도', async mode => {
  const t = await setup();
  if (mode === 'sync') vi.mocked(watch).mockImplementationOnce(() => { throw new Error('EMFILE'); });
  await t.start(); if (mode === 'async') on.mock.calls[0][1](new Error('EMFILE'));
  await vi.advanceTimersByTimeAsync(5000); expect(watch).toHaveBeenCalledTimes(2);
});
it('L4: ENOENT는 warning 없이 원장만, 부모가 생기면 감시 재시도', async () => {
  const t = await setup(); vi.mocked(watch).mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  await t.start(); expect(t.ctx.ui.notify).not.toHaveBeenCalled();
  expect(appendLedger).toHaveBeenCalledWith(t.ctx.cwd, expect.objectContaining({ action: 'watcher:fs-watch', status: 'fail' }));
  await vi.advanceTimersByTimeAsync(5000); expect(watch).toHaveBeenCalledTimes(2);
});
it('L6/M5: 결정 도중 shutdown이면 live ctx가 busy, 종료 전후 지연 타이머 해제', async () => {
  const t = await setup(); await t.start(); let finish!: () => void;
  vi.mocked(pendingDecisions).mockResolvedValueOnce([record]);
  vi.mocked(decideInbox).mockImplementationOnce(async (pi, context) => {
    await new Promise<void>(resolve => { finish = resolve; });
    if (context.isIdle()) pi.sendMessage({ customType: 'test', content: 'should not send', display: true });
    return { deferred: [] };
  });
  await vi.advanceTimersByTimeAsync(5000); const stop = t.stop(); finish(); await stop;
  expect(t.pi.sendMessage).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  expect(clearDecisionTimers).toHaveBeenCalledWith(t.ctx.cwd);
  const guarded = vi.mocked(decideInbox).mock.calls.at(-1)![1]; expect(guarded.isIdle()).toBe(false);
});
it('N1: ENOENT 원장은 디렉터리당 세션 1회, stat으로 생성 확인 뒤 watch 재시도', async () => {
  const t = await setup(); const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  vi.mocked(watch).mockImplementationOnce(() => { throw missing; });
  vi.mocked(stat).mockRejectedValue(missing);
  await t.start(); expect(watch).toHaveBeenCalledTimes(1); expect(appendLedger).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(25000);
  expect(watch).toHaveBeenCalledTimes(1); expect(appendLedger).toHaveBeenCalledTimes(1);
  expect(stat).toHaveBeenCalledWith('/test-project/docs'); expect(t.ctx.ui.notify).not.toHaveBeenCalled();
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
  await vi.advanceTimersByTimeAsync(5000); expect(watch).toHaveBeenCalledTimes(1);
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
  await vi.advanceTimersByTimeAsync(5000); expect(watch).toHaveBeenCalledTimes(2);
  expect(appendLedger).toHaveBeenCalledTimes(1);
  on.mock.calls.at(-1)![1](missing); await Promise.resolve();
  expect(appendLedger).toHaveBeenCalledTimes(1); // The same directory disappearing again is still one session notice.
  await t.stop(); vi.mocked(watch).mockImplementationOnce(() => { throw missing; });
  await t.start(); expect(appendLedger).toHaveBeenCalledTimes(2);
});
it('N1: 같은 세션의 다른 누락 디렉터리는 각각 한 번 기록', async () => {
  const t = await setup(); const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  vi.mocked(watch).mockImplementation(() => { throw missing; }); vi.mocked(stat).mockRejectedValue(missing);
  await t.start();
  vi.mocked(loadConfig).mockResolvedValue({ judgment: { file: 'other/판단.md' }, watch: { pollSeconds: 5, tickSeconds: 30 } } as any);
  await vi.advanceTimersByTimeAsync(15000);
  expect(watch).toHaveBeenCalledTimes(2); expect(appendLedger).toHaveBeenCalledTimes(2);
});

it('P4: 60초 메모리 표본과 세션 소유 정리, shutdown 후 표본 없음', async () => {
  const t = await setup(); await t.start();
  await vi.advanceTimersByTimeAsync(59999); expect(memoryTick).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(memoryTick).toHaveBeenCalledWith(t.ctx.cwd);
  await t.stop(); expect(runCleanup).toHaveBeenCalledWith(t.ctx.cwd, { scope: 'processes', sessionId: expect.any(String) });
  await vi.advanceTimersByTimeAsync(120000); expect(memoryTick).toHaveBeenCalledTimes(1);
});

it('P4 M3: 같은 틱의 poll·memory가 한 인박스 레코드를 중복 결정하지 않는다', async () => {
  const t = await setup(); await t.start();
  vi.mocked(decideInbox).mockClear();
  await vi.advanceTimersByTimeAsync(59999);
  let release!: () => void, decided = false;
  vi.mocked(pendingDecisions).mockImplementation(async () => decided ? [] : [record]);
  vi.mocked(decideInbox).mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; }); return { deferred: [] };
  });
  vi.mocked(recordDecision).mockImplementation(async () => { decided = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(memoryTick).toHaveBeenCalledTimes(1); expect(decideInbox).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(decideInbox).toHaveBeenCalledTimes(1); expect(decided).toBe(true);
});
