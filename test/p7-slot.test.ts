import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { project } from './p5-helpers.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { tick, pendingDecisions } from '../src/core/watcher.ts';
import { runPick, decidePick } from '../src/core/pick.ts';
import * as slots from '../src/core/slots.ts';
import * as runner from '../src/provider/runner.ts';
import { runTurn } from '../src/provider/turn.ts';
import orchestrator, { decideInbox } from '../extensions/orchestrator/index.ts';
import { autoResume } from '../extensions/orchestrator/resume.ts';

const waiting = { kind: 'codex' as const, since: '2026-09-24T00:00:00Z',
  owner: { root: '/fixture/other', runId: 'busy', pid: 99999999, startedAt: 'fixture', acquiredAt: 'fixture' } };
it.each([false, true])('F16 턴 종료 슬롯 대기: 활성 위임=%s', async delegated => {
  const root = await project('IMPLEMENT');
  await updateState(root, { taskId: 'T01', awaitingSlot: waiting,
    ...(delegated ? { delegation: { runId: 'real', kind: 'task', taskId: 'T01', startedAt: 'now' } } : {}) });
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    const sid = options.args![options.args!.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', permissionMode: 'bypassPermissions', model: 'haiku' });
    await options.onEvent?.({ type: 'result', is_error: false, result: '대기: 슬롯 codex' });
    return { code: 0, cleaned: true, stderr: '' };
  });
  expect((await runTurn('fixture', { root, model: 'haiku', env: { HOME: root } })).reason).toBe('stop');
  expect(await readState(root)).toMatchObject({ state: delegated ? 'IMPLEMENT' : 'paused(slot)', taskId: 'T01',
    ...(!delegated ? { resumeState: 'IMPLEMENT', lastPaused: 'slot' } : {}) });
});
it.each(['IMPLEMENT', 'REVIEW', 'FIX', 'RESEARCH', 'PROJECT_REVIEW'])('F16 %s 60초 감시→인박스→자동 PICK→RESUME', async stage => {
  const root = await project('PICK'), projectPhase = stage === 'RESEARCH' || stage === 'PROJECT_REVIEW';
  const original = stage === 'PROJECT_REVIEW' ? 'REVIEW' : stage;
  const task = projectPhase ? undefined : await addTask(root, { title: '대기', category: 'docs' });
  if (task) await setTask(root, task.id, { status: stage === 'FIX' ? 'fix' : stage === 'REVIEW' ? 'review' : 'doing' });
  await updateState(root, { state: original, taskId: task?.id, phase: projectPhase ? 'project' : 'task', awaitingSlot: waiting,
    doctor: { ok: true, checkedAt: new Date().toISOString() } });
  const reviewSince = (await readState(root)).reviewSince;
  await updateState(root, { state: 'paused(slot)' });
  const alive = vi.spyOn(slots, 'slotOwnerIdentity').mockResolvedValue('owned'), now = Date.now();
  expect((await tick(root, { now })).emitted).toEqual([]);
  alive.mockResolvedValue('gone');
  expect((await tick(root, { now: now + 59999 })).emitted).toEqual([]);
  expect(alive).toHaveBeenCalledTimes(1);
  const emitted = (await tick(root, { now: now + 60000 })).emitted;
  expect(emitted).toHaveLength(1); expect(emitted[0].kind).toBe('slot-free');
  expect(await pendingDecisions(root)).toContainEqual(emitted[0]);
  const sendMessage = vi.fn(), pi = { sendMessage } as unknown as ExtensionAPI;
  const ctx = { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } };
  await decideInbox(pi, ctx as never, root, emitted);
  expect(sendMessage).toHaveBeenCalledOnce();
  expect((await readState(root)).state).toBe('PICK');
  expect((await runPick(root)).outcome).toBe('RESUME');
  expect(await readState(root)).toMatchObject({ state: original, phase: projectPhase ? 'project' : 'task' });
  if (original === 'REVIEW') expect((await readState(root)).reviewSince).toBe(reviewSince);
  if (task) expect((await getTask(root, task.id)).status).not.toContain('blocked');
});
it('F16 paused(slot) 복귀·낡은 인박스 무시·대기 표지와 자동 턴 정지', async () => {
  const root = await project('RESEARCH');
  await updateState(root, { phase: 'project', awaitingSlot: waiting, autoTurns: 3 });
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>(), sendMessage = vi.fn();
  const pi = { registerCommand: vi.fn(), on: (name: string, fn: any) => handlers.set(name, fn), sendMessage } as unknown as ExtensionAPI;
  orchestrator(pi);
  const ctx = { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } };
  await handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '대기: 슬롯 codex\n상태: RESEARCH' }] }] }, ctx);
  expect((await readState(root)).autoTurns).toBe(0); expect(sendMessage).not.toHaveBeenCalled();
  vi.spyOn(slots, 'slotOwnerAlive').mockResolvedValue(true);
  expect(await autoResume(pi, root, { ...ctx, notify: vi.fn() }, 'stalled')).toEqual({ skipped: 'slot' });
  await updateState(root, { state: 'paused(slot)' });
  vi.spyOn(slots, 'slotOwnerIdentity').mockResolvedValue('gone');
  const records = (await tick(root)).emitted;
  await updateState(root, { awaitingSlot: { ...waiting, since: 'new-wait' } });
  await decideInbox(pi, ctx as never, root, records);
  expect((await readState(root)).state).toBe('paused(slot)');
  await updateState(root, { awaitingSlot: waiting });
  await decideInbox(pi, ctx as never, root, records);
  expect((await runPick(root)).next).toBe('RESEARCH');
});
it('M3 전이는 WAIT_JUDGMENT에도 슬롯 표지를 지우고 워처는 비-slot 잔존을 지운다', async () => {
  const root = await project('RESEARCH');
  await updateState(root, { awaitingSlot: waiting });
  await transitionState(root, 'WAIT_JUDGMENT');
  expect((await readState(root)).awaitingSlot).toBeUndefined();
  await updateState(root, { awaitingSlot: waiting });
  await tick(root);
  expect((await readState(root)).awaitingSlot).toBeUndefined();
});
it.each(['RESEARCH', 'paused(slot)'])('M3 %s 소유자가 사망하면 표지를 지우고 자동 재개한다', async stage => {
  const root = await project('RESEARCH');
  await updateState(root, { phase: 'project', awaitingSlot: waiting, state: stage });
  vi.spyOn(slots, 'slotOwnerAlive').mockResolvedValue(false);
  const sendMessage = vi.fn();
  expect(await autoResume({ sendMessage } as unknown as ExtensionAPI, root,
    { cwd: root, hasUI: true, isIdle: () => true, notify: vi.fn() }, 'stalled')).toEqual({ resumed: true });
  expect((await readState(root)).awaitingSlot).toBeUndefined();
  expect(sendMessage).toHaveBeenCalledOnce();
});
it('M3 unknown 연속 10회 알림은 기다리는 동안 딱 한 번이며 판단을 만들지 않는다', async () => {
  const { readLedger } = await import('../src/core/ledger.ts');
  const { readJudgment } = await import('../src/core/judgment.ts');
  const root = await project('RESEARCH');
  await updateState(root, { state: 'paused(slot)', awaitingSlot: waiting });
  const identity = vi.spyOn(slots, 'slotOwnerIdentity').mockResolvedValue('unknown');
  const now = Date.now();
  for (let i = 0; i < 9; i++) await tick(root, { now: now + i * 60000 });
  expect((await readLedger(root)).filter(e => e.action === 'notify:slot:unknown-owner')).toHaveLength(0);
  identity.mockResolvedValue('owned'); await tick(root, { now: now + 9 * 60000 });
  identity.mockResolvedValue('unknown');
  for (let i = 10; i < 25; i++) {
    expect((await tick(root, { now: now + i * 60000 })).emitted).toEqual([]);
    if (i === 18) expect((await readLedger(root)).filter(e => e.action === 'notify:slot:unknown-owner')).toHaveLength(0);
  }
  expect((await readLedger(root)).filter(e => e.action === 'notify:slot:unknown-owner' && e.status === 'ok')).toHaveLength(1);
  expect((await readJudgment(root)).items).toEqual([]);
  expect((await readState(root)).awaitingSlot).toEqual(waiting);
});

it.each([undefined, 'memory', 'error', 'billing', 'slot'])('L3 프로젝트 재개는 슬롯 중단만: %s', reason => {
  const result = decidePick([], { state: 'PICK', phase: 'project', lastPaused: reason,
    resumeTask: { resumeState: 'RESEARCH' } }, { slots: 'ok' });
  expect(result.outcome === 'RESUME').toBe(reason === 'slot');
  expect(result.reason.includes('슬롯 대기로')).toBe(reason === 'slot');
});
it('S2 paused(slot)→PICK→WAIT_RESOURCE 표지 유지 후 소유자 사망→slot-free→RESUME', async () => {
  const root = await project('RESEARCH');
  await updateState(root, { phase: 'project', awaitingSlot: waiting });
  await transitionState(root, 'paused(slot)', { system: true });
  expect((await readState(root)).awaitingSlot).toEqual(waiting);
  await transitionState(root, 'PICK');
  expect((await readState(root)).awaitingSlot).toEqual(waiting);
  const identity = vi.spyOn(slots, 'slotOwnerIdentity').mockResolvedValue('owned');
  const now = Date.now();
  expect((await tick(root, { now })).emitted).toEqual([]);
  expect((await readState(root)).awaitingSlot).toEqual(waiting);
  expect((await runPick(root)).outcome).toBe('WAIT_RESOURCE');
  expect((await readState(root)).awaitingSlot).toEqual(waiting);
  identity.mockResolvedValue('gone');
  const records = (await tick(root, { now: now + 60000 })).emitted;
  expect(records).toHaveLength(1); expect(records[0].kind).toBe('slot-free');
  const sendMessage = vi.fn(), ctx = { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } };
  await decideInbox({ sendMessage } as unknown as ExtensionAPI, ctx as never, root, records);
  expect((await readState(root)).awaitingSlot).toBeUndefined();
  expect((await runPick(root)).outcome).toBe('RESUME');
  expect((await readState(root)).state).toBe('RESEARCH');
});
