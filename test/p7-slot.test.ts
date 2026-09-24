import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { project } from './p5-helpers.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { tick, pendingDecisions } from '../src/core/watcher.ts';
import { runPick } from '../src/core/pick.ts';
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
  const alive = vi.spyOn(slots, 'slotOwnerAlive').mockResolvedValue(true), now = Date.now();
  expect((await tick(root, { now })).emitted).toEqual([]);
  alive.mockResolvedValue(false);
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
it('F16 WAIT_RESOURCE 복귀·낡은 인박스 무시·대기 표지와 자동 턴 정지', async () => {
  const root = await project('RESEARCH');
  await updateState(root, { phase: 'project', awaitingSlot: waiting, autoTurns: 3 });
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>(), sendMessage = vi.fn();
  const pi = { registerCommand: vi.fn(), on: (name: string, fn: any) => handlers.set(name, fn), sendMessage } as unknown as ExtensionAPI;
  orchestrator(pi);
  const ctx = { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } };
  await handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '대기: 슬롯 codex\n상태: RESEARCH' }] }] }, ctx);
  expect((await readState(root)).autoTurns).toBe(0); expect(sendMessage).not.toHaveBeenCalled();
  expect(await autoResume(pi, root, { ...ctx, notify: vi.fn() }, 'stalled')).toEqual({ skipped: 'slot' });
  await updateState(root, { state: 'paused(slot)' });
  await updateState(root, { state: 'WAIT_RESOURCE' });
  vi.spyOn(slots, 'slotOwnerAlive').mockResolvedValue(false);
  const records = (await tick(root)).emitted;
  await updateState(root, { awaitingSlot: { ...waiting, since: 'new-wait' } });
  await decideInbox(pi, ctx as never, root, records);
  expect((await readState(root)).state).toBe('WAIT_RESOURCE');
  await updateState(root, { awaitingSlot: waiting });
  await decideInbox(pi, ctx as never, root, records);
  expect((await runPick(root)).next).toBe('RESEARCH');
});
