import { expect, it, vi } from 'vitest';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, git } from './w2-helpers.ts';
import { cli } from './p5-helpers.ts';
import { ui, now } from './w3b-helpers.ts';
import { addTask, listBacklog } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { loadConfig, setConfig } from '../src/core/config.ts';
import { runPick, decidePick } from '../src/core/pick.ts';
import { notify } from '../src/core/notify.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addInbox } from '../src/core/inbox.ts';
import { taskLabel, formatTaskLabel } from '../src/core/task-label.ts';
import * as storage from '../src/core/storage.ts';
import { refreshTaskStatus } from '../extensions/orchestrator/task-status.ts';
import { autoResume, resumeContext } from '../extensions/orchestrator/resume.ts';
import { decideInbox } from '../extensions/orchestrator/index.ts';
async function setup() {
  const f = await workspace(['web']); const task = await addTask(f.root, { repo: 'web', title: '문서', category: 'docs' });
  return { ...f, task };
}
it('D1 state label is additive; D2 missing member keeps successful original state', async () => {
  const f = await setup(); await updateState(f.root, { taskId: f.task.id }); const state = await readState(f.root);
  expect(await cli(f.root, ['state', 'get'])).toEqual({ code: 0, value: { ...state, taskLabel: 'T01·web' } });
  await rename(f.member(), f.member() + '-moved');
  expect(await cli(f.root, ['state', 'get'])).toEqual({ code: 0, value: state });
});
it('D3 runPick keeps workspace warnings alongside the label', async () => {
  const f = await setup(); await git(f.member(), 'checkout', '-b', 'other');
  const result = await runPick(f.root, { slots: 'ok', now });
  expect(result).toMatchObject({ outcome: 'SPEC', taskLabel: 'T01·web', task: f.task,
    warnings: ['멤버 web 체크아웃이 main가 아닙니다(현재 other) — 이 체크아웃을 읽는 다른 레포 검증이 틀릴 수 있습니다'] });
});
it('D4 dry pick is exactly pure decision plus label', async () => {
  const f = await setup(); const expected = decidePick(await listBacklog(f.root), await readState(f.root), { slots: 'ok', now });
  expect(await cli(f.root, ['pick', '--dry'])).toEqual({ code: 0, value: { ...expected, taskLabel: 'T01·web' } });
});
it('D5 only a task notification title is prefixed; body/key/deduplication stay unchanged', async () => {
  const f = await setup(); await setConfig(f.root, 'notify.channels', '["tui","macos"]');
  const exec = vi.fn(async () => undefined), tui = vi.fn();
  for (const [key, taskId, title] of [['w3b-d5-a', 'T01', 'T01·web 하네스 상태'], ['w3b-d5-b', undefined, '하네스 상태']] as const) {
    const message = { key, taskId, title: '하네스 상태', body: '같은 본문', level: 'info' as const };
    expect(await notify(f.root, message, { notify: tui }, { exec, now })).toEqual({ sent: true, limited: false });
    expect(exec).toHaveBeenLastCalledWith('osascript', ['-e', `display notification "같은 본문" with title "${title}"`]);
    expect((await readLedger(f.root)).find(e => e.action === `notify:${key}`)?.evidence).toEqual({ title, body: '같은 본문', level: 'info' });
    expect(await notify(f.root, message, { notify: tui }, { exec, now })).toEqual({ sent: false, limited: true });
  }
  expect(exec).toHaveBeenCalledTimes(2); expect(tui.mock.calls).toEqual([['같은 본문', 'info'], ['같은 본문', 'info']]);
});
it('D6 resume WAIT_JUDGMENT notification carries task label', async () => {
  const f = await setup(), t = ui(f.root);
  // Isolate resume's fallback notification; M-1 below covers the real transition and shared dedupe key.
  await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: 'WAIT_JUDGMENT', taskId: f.task.id }));
  expect(await autoResume(t.pi, f.root, resumeContext(t.context), 'test')).toEqual({ skipped: 'inactive' });
  expect((await readLedger(f.root)).find(e => e.action === 'notify:state:WAIT_JUDGMENT')?.evidence).toMatchObject({ title: 'T01·web 하네스 상태' });
});
it('M-1 state transition labels the first notification before resume deduplication', async () => {
  const f = await setup(), t = ui(f.root);
  await updateState(f.root, { state: 'WAIT_JUDGMENT', taskId: f.task.id });
  const notices = () => readLedger(f.root).then(entries => entries.filter(e => e.action === 'notify:state:WAIT_JUDGMENT'));
  expect(await notices()).toHaveLength(1);
  expect((await notices())[0].evidence).toMatchObject({ title: 'T01·web 하네스 상태' });
  expect(await autoResume(t.pi, f.root, resumeContext(t.context), 'test')).toEqual({ skipped: 'inactive' });
  expect((await notices()).map(e => e.status)).toEqual(['ok', 'skip']);
});
it('progress stall notification carries task label', async () => {
  const f = await setup(), t = ui(f.root);
  await updateState(f.root, { taskId: f.task.id });
  await updateState(f.root, { autoTurns: 3 });
  expect(await autoResume(t.pi, f.root, resumeContext(t.context), 'test')).toEqual({ stopped: true });
  expect((await readLedger(f.root)).find(e => e.action === 'notify:stopForJudgment')?.evidence).toMatchObject({ title: 'T01·web 진행 정체' });
});
it.each([false, true])('D7 delegation failed/supervisorLost=%s notification uses record taskId', async supervisorLost => {
  const f = await setup(), t = ui(f.root);
  await updateState(f.root, { state: 'SPEC', taskId: f.task.id, delegation: { runId: 'w3b-done', taskId: f.task.id, kind: 'task', startedAt: new Date(now).toISOString() } });
  const record = await addInbox(f.root, { kind: 'codex-done', codexRunId: 'w3b-done', taskId: f.task.id, codexStatus: 'fail', supervisorLost });
  await decideInbox(t.pi, t.context, f.root, [record]);
  expect((await readLedger(f.root)).find(e => e.action === 'notify:codex:w3b-done')?.evidence).toMatchObject({ title: `T01·web 위임 ${supervisorLost ? '완료' : '실패'}` });
});
it('D8 status sets, clears and tolerates missing members and disposed UI', async () => {
  const f = await setup(), t = ui(f.root); await updateState(f.root, { taskId: f.task.id });
  await refreshTaskStatus(t.context); expect(t.ctx.ui.setStatus).toHaveBeenLastCalledWith('fodh-task', 'T01·web');
  await updateState(f.root, { taskId: undefined }); await refreshTaskStatus(t.context);
  expect(t.ctx.ui.setStatus).toHaveBeenLastCalledWith('fodh-task', undefined);
  t.ctx.ui.setStatus.mockImplementation(() => { throw new Error('disposed'); });
  await expect(refreshTaskStatus(t.context)).resolves.toBeUndefined();
  t.ctx.ui.setStatus.mockClear(); await rename(f.member(), f.member() + '-moved');
  await expect(refreshTaskStatus(t.context)).resolves.toBeUndefined(); expect(t.ctx.ui.setStatus).not.toHaveBeenCalled();
});
it('D9 status JSON and all four refresh entry points use the workspace label', async () => {
  const f = await setup(), t = ui(f.root); await updateState(f.root, { taskId: f.task.id });
  await t.command('status'); expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0])).toMatchObject({ task: f.task.id, taskLabel: 'T01·web' });
  expect(t.ctx.ui.setStatus).toHaveBeenLastCalledWith('fodh-task', 'T01·web');
  for (const act of [() => t.start(), () => t.end('aborted'), () => t.end('error'), () => t.command('develop-start')]) {
    t.ctx.ui.setStatus.mockClear(); await act(); expect(t.ctx.ui.setStatus).toHaveBeenCalledExactlyOnceWith('fodh-task', 'T01·web');
  }
});
it('previous session recover text carries label', async () => {
  const f = await setup(), t = ui(f.root); await updateState(f.root, { taskId: f.task.id, userAborted: true });
  await decideInbox(t.pi, t.context, f.root, [await addInbox(f.root, { kind: 'recover' })]);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('이전 세션 상태: PICK /T01·web'), 'info');
});
it('taskLabel performs no I/O without mode/task and tolerates missing/malformed backlog', async () => {
  const f = await setup(), config = await loadConfig(f.root), read = vi.spyOn(storage, 'readJson');
  expect(formatTaskLabel('T03', 'app')).toBe('T03·app'); expect(formatTaskLabel('T03')).toBe('T03');
  expect(await taskLabel(f.root, {}, 'T01')).toBeUndefined(); expect(await taskLabel(f.root, config)).toBeUndefined(); expect(read).not.toHaveBeenCalled();
  expect(await taskLabel(f.root, config, 'T99')).toBe('T99'); expect(read).toHaveBeenCalled();
  await writeFile(join(f.root, '.pi/harness-backlog.json'), '{');
  expect(await taskLabel(f.root, config, 'T01')).toBe('T01');
  read.mockRestore();
});
it('display-only configuration reads neither warn nor write diagnostic state', async () => {
  const f = await setup(), t = ui(f.root); await updateState(f.root, { taskId: f.task.id });
  const path = join(f.root, '.pi/harness.json');
  const { readFile } = await import('node:fs/promises');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), w3bUnknown: true }));
  const ledger = await readLedger(f.root);
  expect((await cli(f.root, ['state', 'get'])).value.taskLabel).toBe('T01·web');
  expect((await cli(f.root, ['pick', '--dry'])).value.taskLabel).toBe('T01·web');
  await t.command('status'); await refreshTaskStatus(t.context);
  expect(await readLedger(f.root)).toEqual(ledger);
  await expect(readFile(join(f.root, '.pi/harness-config-warned.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('unreadable display config and corrupt state are best effort', async () => {
  const f = await setup(), t = ui(f.root); await updateState(f.root, { taskId: f.task.id });
  const state = await readState(f.root);
  await writeFile(join(f.root, '.pi/harness.json'), '{');
  expect(await cli(f.root, ['state', 'get'])).toEqual({ code: 0, value: state });
  await t.command('status'); expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0])).not.toHaveProperty('taskLabel');
  expect(t.ctx.ui.setStatus).not.toHaveBeenCalled();
  await writeFile(join(f.root, '.pi/harness.json'), JSON.stringify(f.candidate));
  await writeFile(join(f.root, '.pi/harness-state.json'), '{');
  await expect(refreshTaskStatus(t.context)).resolves.toBeUndefined(); expect(t.ctx.ui.setStatus).not.toHaveBeenCalled();
});
