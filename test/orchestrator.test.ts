import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import orchestrator, { instruction } from '../extensions/orchestrator/index.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { addJudgment, answerJudgment, readJudgment } from '../src/core/judgment.ts';
import { addInbox } from '../src/core/inbox.ts';
import { appendLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp('/private/tmp/fodh-orchestrator-'); roots.push(root);
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const sendMessage = vi.fn();
  orchestrator({ registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler), sendMessage } as unknown as ExtensionAPI);
  const ctx = { cwd: root, ui: { notify: vi.fn() } };
  return { root, commands, handlers, ctx, sendMessage,
    command: (name: string, args = '') => commands.get(name)!.handler(args, ctx),
    end: (stopReason = 'stop') => handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason }] }, ctx) };
}

it('Pi 명령 5종과 orchestrator 확장 등록', async () => {
  const test = await setup();
  expect([...test.commands.keys()]).toEqual(['project-start', 'develop-start', 'status', 'judged', 'cleanup']);
  expect(JSON.parse(await readFile('package.json', 'utf8')).pi.extensions).toContain('./extensions/orchestrator/index.ts');
});
it('project-start는 없는 문서 생성·INTERVIEW 전이·프로젝트 이름 저장·턴 시작', async () => {
  const test = await setup();
  await test.command('project-start', '새 프로젝트');
  expect(await readState(test.root)).toMatchObject({ state: 'INTERVIEW', projectName: '새 프로젝트', autoTurns: 0 });
  for (const name of ['backlog.md', '판단대기.md', '작업일지.md']) expect(await readFile(join(test.root, 'docs', name), 'utf8')).not.toBe('');
  expect(test.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'harness-orchestrator',
    content: expect.stringContaining('18 영역') }), { triggerTurn: true });
});
it('project-start는 기존 초기 문서와 사용자 답을 보존한다', async () => {
  const test = await setup();
  await test.command('project-start');
  const paths = ['backlog.md', '작업일지.md', '판단대기.md'].map(name => join(test.root, 'docs', name));
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await updateState(test.root, { state: 'IDLE' });
  await test.command('project-start');
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
});
it('project-start는 이미 진행 중인 상태를 덮어쓰지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'IMPLEMENT', taskId: 'T01' });
  await expect(test.command('project-start')).rejects.toThrow('IDLE');
  expect(test.sendMessage).not.toHaveBeenCalled();
  expect((await readState(test.root)).state).toBe('IMPLEMENT');
});
it('develop-start에 백로그가 없으면 빈 템플릿 뒤 PLANNING 지시문만 보낸다', async () => {
  const test = await setup(); await test.command('develop-start');
  expect((await readState(test.root)).state).toBe('PLANNING');
  expect(test.sendMessage.mock.calls[0][0].content).toContain('# PLANNING');
});
it.each(['IDLE', 'PROJECT_READY', 'DONE_ALL', 'paused(error)'])('develop-start는 %s에서 기존 백로그 PICK을 실행한다', async state => {
  const test = await setup(); const task = await addTask(test.root, { title: '우선 작업', category: 'docs' });
  await updateState(test.root, { state }); await test.command('develop-start');
  expect(await readState(test.root)).toMatchObject({ state: 'SPEC', taskId: task.id });
  expect((await getTask(test.root, task.id)).status).toBe('doing');
  expect(test.sendMessage.mock.calls[0][0].content).toContain(`# SPEC`);
});
it('develop-start의 빈 기존 백로그는 완료 표시만 하고 턴을 시작하지 않는다', async () => {
  const test = await setup(); await test.command('develop-start');
  test.sendMessage.mockClear(); await test.command('develop-start');
  expect((await readState(test.root)).state).toBe('DONE_ALL');
  expect(test.sendMessage).not.toHaveBeenCalled();
  expect(test.ctx.ui.notify).toHaveBeenCalled();
});
it('develop-start 재실행은 활동 작업을 다른 작업으로 바꾸지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'VERIFY', taskId: 'T01' });
  await expect(test.command('develop-start')).rejects.toThrow('현재 상태');
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('status는 상태·task·인박스 미적용·원장 unknown·최근 rateLimit을 턴 없이 표시한다', async () => {
  const test = await setup();
  await updateState(test.root, { state: 'VERIFY', taskId: 'T02', rateLimitInfo: { status: 'allowed' } });
  await addInbox(test.root, { kind: 'answer' });
  await appendLedger(test.root, { runId: 'check', action: 'test', status: 'pre' });
  await test.command('status');
  const status = JSON.parse(test.ctx.ui.notify.mock.calls[0][0]);
  expect(status).toMatchObject({ state: 'VERIFY', task: 'T02', rateLimit: { status: 'allowed' } });
  expect(status.inbox).toHaveLength(1); expect(status.unknown).toHaveLength(1);
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('cleanup은 보고만 표시하며 두뇌 턴을 시작하지 않는다', async () => {
  const test = await setup(); await test.command('cleanup');
  expect(JSON.parse(test.ctx.ui.notify.mock.calls[0][0])).toMatchObject({ ok: true, remaining: 0 });
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('judged는 답 적용·blocked 해제 후 WAIT_JUDGMENT에서 PICK 지시문을 보낸다', async () => {
  const test = await setup(); const task = await addTask(test.root, { title: '판단 작업', category: 'docs' });
  const { item } = await addJudgment(test.root, { title: '진행 방식', background: '범위 결정', options: ['첫 번째', '두 번째'], recommend: '첫 번째', blocks: task.id });
  await setTask(test.root, task.id, { status: `blocked(${item.id})`, judgment: item.id });
  await answerJudgment(test.root, item.id, '1');
  await updateState(test.root, { state: 'WAIT_JUDGMENT', resumeState: 'PICK' });
  await test.command('judged', item.id);
  expect((await getTask(test.root, task.id)).status).toBe('ready');
  expect(test.sendMessage.mock.calls[0][0].content).toContain('# PICK');
  expect(JSON.parse(test.ctx.ui.notify.mock.calls[0][0]).applied).toHaveLength(1);
});
it('judged는 적용 항목이 없으면 WAIT_JUDGMENT에서도 보내지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'WAIT_JUDGMENT' });
  await test.command('judged'); expect(test.sendMessage).not.toHaveBeenCalled();
});
it('judged는 WAIT_JUDGMENT 밖에서 답을 적용해도 자동으로 시작하지 않는다', async () => {
  const test = await setup();
  const { item } = await addJudgment(test.root, { title: '진행 방식', background: '', options: ['첫 번째'], recommend: '첫 번째', blocks: '' });
  await answerJudgment(test.root, item.id, '1'); await test.command('judged');
  expect(JSON.parse(test.ctx.ui.notify.mock.calls[0][0]).applied).toHaveLength(1);
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('judged의 프로젝트 재개 지시문은 resumeState 먼저 복귀하도록 안내한다', async () => {
  const test = await setup();
  const { item } = await addJudgment(test.root, { title: '목표', background: '', options: ['첫 번째'], recommend: '', blocks: '' });
  await answerJudgment(test.root, item.id, '1');
  await updateState(test.root, { state: 'WAIT_JUDGMENT', resumeState: 'INTERVIEW', phase: 'project' });
  await test.command('judged');
  expect(test.sendMessage.mock.calls[0][0].content).toContain('fodh state transition INTERVIEW');
  expect((await readState(test.root)).state).toBe('WAIT_JUDGMENT');
});
it('judged는 잘못된 ID를 답 적용 전에 거부한다', async () => {
  const test = await setup(); await expect(test.command('judged', 'T01')).rejects.toThrow('판단 번호');
});
it.each(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PLANNING', 'PICK', 'SPEC',
  'IMPLEMENT', 'VERIFY', 'FIX', 'MERGE', 'DOCS', 'CLEANUP', 'RECLAIM', 'recovering'])('%s 정상 턴 종료는 followUp 자동 지시문을 보낸다', async state => {
  const test = await setup(); await updateState(test.root, { state, taskId: 'T02' }); await test.end();
  expect(test.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(`# ${state}`) }),
    { triggerTurn: true, deliverAs: 'followUp' });
  expect((await readState(test.root)).autoTurns).toBe(1);
  expect(test.sendMessage.mock.calls[0][0].content).not.toMatch(/\{\{\w+\}\}/u);
});
it.each(['IDLE', 'PROJECT_READY', 'WAIT_JUDGMENT', 'WAIT_RETRY', 'WAIT_RESOURCE', 'DONE_ALL', 'DEADLOCK',
  'CLEANUP_FAILED', 'READY', 'paused(billing)', 'paused(quota)', 'paused(error)', 'paused(memory)', 'paused(budget)', 'paused(cleanup)'])('%s 정지 상태에는 자동 지시문을 보내지 않는다', async state => {
  const test = await setup(); await updateState(test.root, { state }); await test.end();
  expect(test.sendMessage).not.toHaveBeenCalled(); expect((await readState(test.root)).autoTurns).toBe(0);
});
it.each(['error', 'aborted'])('%s 종료는 recovering에서도 자동 재개하지 않는다', async reason => {
  const test = await setup(); await updateState(test.root, { state: 'recovering' }); await test.end(reason);
  expect(test.sendMessage).not.toHaveBeenCalled(); expect((await readState(test.root)).autoTurns).toBe(0);
});
it('recovering은 확장 재로딩에도 한 진입당 자동 재개 1회만 허용한다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'recovering' });
  await test.end(); await test.end();
  orchestrator({ registerCommand: vi.fn(), on: (name: string, handler: any) => test.handlers.set(name, handler), sendMessage: test.sendMessage } as unknown as ExtensionAPI);
  await test.end(); expect(test.sendMessage).toHaveBeenCalledTimes(1);
  await transitionState(test.root, 'IDLE'); await updateState(test.root, { state: 'recovering' });
  await test.end(); expect(test.sendMessage).toHaveBeenCalledTimes(2);
});
it('기본 3회 자동 턴 정체는 판단 생성 후 WAIT_JUDGMENT로 중단한다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'SPEC', taskId: 'T01' });
  for (let i = 0; i < 4; i++) await test.end();
  expect(test.sendMessage).toHaveBeenCalledTimes(3);
  expect(await readState(test.root)).toMatchObject({ state: 'WAIT_JUDGMENT', resumeState: 'PICK', autoTurns: 0 });
  expect((await readJudgment(test.root)).items[0].title).toBe('진행 정체: SPEC/T01');
  await test.end(); expect((await readJudgment(test.root)).items).toHaveLength(1);
});
it('겹친 agent_end 이벤트는 자동 턴을 중복 예약하지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'INTERVIEW' });
  await Promise.all([test.end(), test.end(), test.end()]);
  expect(test.sendMessage).toHaveBeenCalledTimes(1); expect((await readState(test.root)).autoTurns).toBe(1);
});
it('maxAutoTurns 사용자 설정과 프로젝트 resumeState를 보존한다', async () => {
  const test = await setup(); await setConfig(test.root, 'maxAutoTurns', '1');
  await updateState(test.root, { state: 'INTERVIEW' }); await test.end(); await test.end();
  expect(test.sendMessage).toHaveBeenCalledTimes(1);
  expect(await readState(test.root)).toMatchObject({ state: 'WAIT_JUDGMENT', resumeState: 'INTERVIEW' });
});
it('상태와 task 변화는 정체 횟수를 초기화한다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'SPEC', taskId: 'T01' });
  await test.end(); await test.end(); await test.end();
  await updateState(test.root, { taskId: 'T02' }); await test.end();
  expect(await readState(test.root)).toMatchObject({ state: 'SPEC', taskId: 'T02', autoTurns: 1 });
  await updateState(test.root, { state: 'VERIFY' }); await test.end();
  expect((await readState(test.root)).autoTurns).toBe(1);
  expect((await readJudgment(test.root)).items).toHaveLength(0);
});
it('지시문은 설정된 판단 문서와 작업 ID를 치환하고 경로 주입을 거부한다', async () => {
  const test = await setup(); await setConfig(test.root, 'judgment.file', 'docs/결정할것.md');
  const text = await instruction(test.root, { state: 'IMPLEMENT', taskId: 'T42' });
  expect(text).toContain('docs/결정할것.md'); expect(text).toContain('--blocks T42 --reclaim');
  await expect(instruction(test.root, { state: '../../package' })).rejects.toThrow('자동 진행');
});
