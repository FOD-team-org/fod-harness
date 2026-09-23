// Provider event 경계만 mock하고 판단·회수·상태·백로그는 실제 임시 프로젝트에서 검증한다.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess, childEnv, groupAlive, reclaimOwnedGroup, type ProcessResult, type RunOptions } from '../src/provider/runner.ts';
import { runTurn } from '../src/provider/turn.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readJudgment } from '../src/core/judgment.ts';
import { readLedger } from '../src/core/ledger.ts';
import { listProcs, registerProc } from '../src/core/procs.ts';
vi.mock('../src/provider/runner.ts', async original => ({
  ...await original<typeof import('../src/provider/runner.ts')>(),
  runProcess: vi.fn(), groupAlive: vi.fn(), reclaimOwnedGroup: vi.fn(),
}));
vi.mock('../src/core/process-time.ts', () => ({ processStartedAt: vi.fn() }));
const roots: string[] = [];
const init = { type: 'system', subtype: 'init', model: 'haiku', permissionMode: 'bypassPermissions', apiKeySource: 'none' };
const denial = { tool_name: 'Bash', tool_input: { command: 'sensitive-action fixture' } };
const done = { type: 'result', is_error: false, usage: {}, permission_denials: [] };
const deniedEvents = [init,
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'denied', name: 'Bash', input: denial.tool_input }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'denied', is_error: true, content: 'PreToolUse hook error' }] } },
  { ...done, permission_denials: [denial] },
];
function emulate(events: Record<string, unknown>[], terminal: Partial<ProcessResult> = {}) {
  vi.mocked(runProcess).mockImplementation(async (options: RunOptions) => {
    if (options.kind === 'switch') return { code: 0, stderr: '', cleaned: true };
    const args = options.args!;
    const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
    for (const event of events) {
      const abortKind = await options.onEvent?.(event.subtype === 'init' ? { ...event, session_id: sid } : event);
      if (abortKind) return { code: null, stderr: '', cleaned: true, abortKind };
    }
    return { code: 0, stderr: '', cleaned: true, ...terminal };
  });
}
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-provider-revision-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: {
    command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')],
  } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  return root;
}
const options = (root: string) => ({ root, model: 'haiku', env: { ...childEnv(), HOME: root } });
async function activeTask() {
  const root = await project(), task = await addTask(root, { title: '진행 중 task', category: 'docs' });
  await setTask(root, task.id, { status: 'doing', spec: { rev: 1 } });
  await setTask(root, task.id, { worktree: 'wt-preserved', verify: { ok: true }, review: { commit: 'review-sha', high: 0 } });
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id, phase: 'task' });
  return { root, task };
}
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('M8: task 훅 denial 정상종료는 판단 한 개와 RECLAIM을 거쳐 blocked·PICK, 기존 증거를 보존한다', async () => {
  const { root, task } = await activeTask(); emulate(deniedEvents);
  expect(await runTurn('진행', options(root))).toMatchObject({ reason: 'stop' });
  const { items } = await readJudgment(root);
  expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ blocks: task.id, requiresApproval: true });
  expect(await getTask(root, task.id)).toMatchObject({ status: `blocked(${items[0].id})`, judgment: items[0].id,
    worktree: 'wt-preserved', spec: { rev: 1 }, verify: { ok: true }, review: { commit: 'review-sha', high: 0 } });
  const state = await readState(root);
  expect(state.state).toBe('PICK'); expect(state.taskId).toBeUndefined(); expect(state.pendingReclaim).toBeUndefined();
  const actions = (await readLedger(root)).map(entry => entry.action);
  expect(actions).toContain('state:IMPLEMENT→RECLAIM'); expect(actions).toContain('state:RECLAIM→PICK');
  expect(reclaimOwnedGroup).not.toHaveBeenCalled();
});
it('M8: 프로젝트 훅 denial은 항목만 생성하고 프로젝트 상태를 유지한다', async () => {
  const root = await project(); await updateState(root, { state: 'INTERVIEW', phase: 'project' }); emulate(deniedEvents);
  expect(await runTurn('질문', options(root))).toMatchObject({ reason: 'stop' });
  const { items } = await readJudgment(root);
  expect(items).toHaveLength(1); expect(items[0].blocks).toBe('');
  expect(await readState(root)).toMatchObject({ state: 'INTERVIEW', phase: 'project' });
  expect((await readState(root)).taskId).toBeUndefined();
  expect((await readLedger(root)).some(entry => entry.action.includes('RECLAIM'))).toBe(false);
});
it('H2: denial 없는 quota의 전환 재시도 소진은 taskId와 IMPLEMENT 재개 상태를 보존한다', async () => {
  const { root, task } = await activeTask(); emulate([init, { ...done, is_error: true, result: 'usage limit reached' }]);
  expect(await runTurn('진행', options(root))).toMatchObject({ reason: 'error', classification: 'quota' });
  expect(await readState(root)).toMatchObject({ state: 'paused(quota)', taskId: task.id, resumeState: 'IMPLEMENT', lastPaused: 'quota' });
  expect((await getTask(root, task.id)).status).toBe('doing'); expect((await readJudgment(root)).items).toHaveLength(0);
  expect(vi.mocked(runProcess).mock.calls.filter(([call]) => call.kind === 'switch')).toHaveLength(1);
});
it('H2: deadline 복구는 taskId와 IMPLEMENT 재개 상태 및 unknown 원장을 보존한다', async () => {
  const { root, task } = await activeTask(); emulate([init], { code: null, abortKind: 'deadline' });
  expect(await runTurn('진행', options(root))).toMatchObject({ reason: 'aborted', classification: 'deadline' });
  expect(await readState(root)).toMatchObject({ state: 'recovering', taskId: task.id, resumeState: 'IMPLEMENT' });
  expect((await getTask(root, task.id)).status).toBe('doing');
  expect((await readLedger(root)).findLast(entry => entry.action === 'brain:0')?.status).toBe('unknown');
  expect((await readJudgment(root)).items).toHaveLength(0);
});
it('H2: paused 뒤 recovering으로 바뀌어도 최초 활동 상태를 재개 대상으로 유지한다', async () => {
  const { root, task } = await activeTask();
  await updateState(root, { state: 'paused(error)' }); await updateState(root, { state: 'recovering' });
  expect(await readState(root)).toMatchObject({ state: 'recovering', taskId: task.id, resumeState: 'IMPLEMENT' });
});
it('M8·M4: 훅 회수 연속 실패는 CLEANUP_FAILED 다음 paused(cleanup)·잔존 판단을 남긴다', async () => {
  const { root, task } = await activeTask();
  const record = { pid: 987654, pgid: 987654, startedAt: 'Thu Sep 24 00:00:00 2026', runId: 'worker-run', kind: 'worker', taskId: task.id };
  await registerProc(root, record); vi.mocked(groupAlive).mockReturnValue(true);
  vi.mocked(processStartedAt).mockResolvedValue(record.startedAt); vi.mocked(reclaimOwnedGroup).mockResolvedValue(false);
  emulate(deniedEvents); await runTurn('진행', options(root));
  const firstItems = (await readJudgment(root)).items;
  expect(firstItems).toHaveLength(1);
  expect(await readState(root)).toMatchObject({ state: 'CLEANUP_FAILED', taskId: task.id, cleanupFailures: 1,
    pendingReclaim: { taskId: task.id, judgmentId: firstItems[0].id } });
  expect(await listProcs(root)).toEqual([record]);
  await runTurn('정리 재시도', options(root));
  expect(await readState(root)).toMatchObject({ state: 'paused(cleanup)', taskId: task.id, cleanupFailures: 2 });
  const items = (await readJudgment(root)).items;
  expect(items.filter(item => item.title.startsWith('Bash:'))).toHaveLength(1);
  expect(items.find(item => item.title === `정리 실패: 잔존 프로세스 ${record.pid}`)).toMatchObject({
    blocks: task.id, options: ['사용자가 정리했음 → PICK', '보류'],
  });
  expect(await listProcs(root)).toEqual([record]); expect(reclaimOwnedGroup).toHaveBeenCalledTimes(2);
  expect(await getTask(root, task.id)).toMatchObject({ worktree: 'wt-preserved', review: { commit: 'review-sha', high: 0 } });
});
