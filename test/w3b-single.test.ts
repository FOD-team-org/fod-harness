import { expect, it, vi } from 'vitest';
import { addTask, listBacklog } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { decidePick, runPick } from '../src/core/pick.ts';
import { notify } from '../src/core/notify.ts';
import { readLedger } from '../src/core/ledger.ts';
import { refreshTaskStatus } from '../extensions/orchestrator/task-status.ts';
import { cli } from './p5-helpers.ts';
import { single, ui, now } from './w3b-helpers.ts';

it('state get with a task is exactly readState, without display keys', async () => {
  const { root } = await single(); const task = await addTask(root, { title: '문서', category: 'docs' });
  await updateState(root, { taskId: task.id });
  expect(await cli(root, ['state', 'get'])).toEqual({ code: 0, value: await readState(root) });
});
it.each(['run', 'dry'])('single pick %s equals the prior pure decision, without warnings or label', async mode => {
  const { root } = await single(); await addTask(root, { title: '문서', category: 'docs' });
  const expected = decidePick(await listBacklog(root), await readState(root), { slots: 'ok', now });
  expect(expected.outcome).toBe('SPEC');
  const actual = mode === 'run' ? await runPick(root, { slots: 'ok', now }) : (await cli(root, ['pick', '--dry'])).value;
  expect(actual).toEqual(expected); expect('taskLabel' in actual).toBe(false); expect('warnings' in actual).toBe(false);
});
it('single task notification keeps exact OS argument, evidence and TUI body', async () => {
  const { root } = await single(); await addTask(root, { title: '문서', category: 'docs' });
  const exec = vi.fn(async () => undefined), tui = vi.fn();
  await notify(root, { taskId: 'T01', key: 'w3b-single', title: '하네스 상태', body: '같은 본문', level: 'info' }, { notify: tui }, { exec, now });
  expect(exec).toHaveBeenCalledExactlyOnceWith('osascript', ['-e', 'display notification "같은 본문" with title "하네스 상태"']);
  expect((await readLedger(root)).find(e => e.action === 'notify:w3b-single')?.evidence).toEqual({ title: '하네스 상태', body: '같은 본문', level: 'info' });
  expect(tui).toHaveBeenCalledExactlyOnceWith('같은 본문', 'info');
});
it('single refresh, status, startup, agent_end and develop-start never set fodh-task', async () => {
  const { root } = await single(); const task = await addTask(root, { title: '문서', category: 'docs' });
  await updateState(root, { taskId: task.id }); const t = ui(root);
  await refreshTaskStatus(t.context); expect(t.ctx.ui.setStatus).not.toHaveBeenCalled();
  await t.command('status');
  const value = JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0]);
  expect(value).toEqual({ delegation: null, state: 'PICK', task: task.id, inbox: [], unknown: [], watcher: value.watcher, rateLimit: null });
  expect('taskLabel' in value).toBe(false);
  await t.start(); await t.end(); await t.command('develop-start');
  expect(t.ctx.ui.setStatus.mock.calls.filter(([key]) => key === 'fodh-task')).toEqual([]);
});

it('M-1 single state transition keeps the original notification title', async () => {
  const { root } = await single(); const task = await addTask(root, { title: '문서', category: 'docs' });
  await updateState(root, { state: 'WAIT_JUDGMENT', taskId: task.id });
  const notices = (await readLedger(root)).filter(e => e.action === 'notify:state:WAIT_JUDGMENT');
  expect(notices).toHaveLength(1);
  expect(notices[0].evidence).toMatchObject({ title: '하네스 상태' });
});
