import { todayKst } from '../src/core/template-values.ts';
import * as cleanupModule from '../src/core/cleanup.ts';
import * as notifyModule from '../src/core/notify.ts';
import { runPick } from '../src/core/pick.ts';
import * as pickModule from '../src/core/pick.ts';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import orchestrator, { instruction, decideInbox } from '../extensions/orchestrator/index.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { addJudgment, answerJudgment, readJudgment } from '../src/core/judgment.ts';
import { addInbox } from '../src/core/inbox.ts';
import { appendLedger, readLedger } from '../src/core/ledger.ts';
import { tick } from '../src/core/watcher.ts';
import { setConfig } from '../src/core/config.ts';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-orchestrator-')); roots.push(root);
  await setConfig(root, 'notify.channels', '["tui","ledger"]');
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const sendMessage = vi.fn();
  orchestrator({ registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler), sendMessage } as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: true, isIdle: vi.fn(() => true), ui: { notify: vi.fn() } };
  await handlers.get('session_start')!({}, ctx);
  return { root, commands, handlers, ctx, sendMessage,
    decide: async (kinds: string[]) => decideInbox({ sendMessage } as unknown as ExtensionAPI, ctx as any, root,
      await Promise.all(kinds.map(kind => addInbox(root, { kind, pid: 201 })))),
    command: (name: string, args = '') => commands.get(name)!.handler(args, ctx),
    end: (stopReason = 'stop', text = '') => handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason, content: [{type:'text',text}] }] }, ctx) };
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
  expect(JSON.parse(await readFile(join(test.root, '.pi/harness-interview.json'), 'utf8')).round).toBe(0);
  expect(await readFile(join(test.root, 'CLAUDE.md'), 'utf8')).toContain('# 새 프로젝트');
  expect(await readFile(join(test.root, '.claude/skills/fodh-workflow/SKILL.md'), 'utf8')).toContain('name: fodh-workflow');
  for (const name of ['backlog.md', '판단대기.md', `작업일지/${todayKst()}.md`]) expect(await readFile(join(test.root, 'docs', name), 'utf8')).not.toBe('');
  expect(test.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'harness-orchestrator',
    content: expect.stringContaining('18 영역') }), { triggerTurn: true });
});
it('project-start는 기존 초기 문서와 사용자 답을 보존한다', async () => {
  const test = await setup();
  await test.command('project-start');
  const paths = ['backlog.md', `작업일지/${todayKst()}.md`, '판단대기.md'].map(name => join(test.root, 'docs', name));
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
  for (const name of ['backlog.md', '판단대기.md', `작업일지/${todayKst()}.md`]) expect(await readFile(join(test.root, 'docs', name), 'utf8')).not.toBe('');
});
it.each(['IDLE', 'PROJECT_READY', 'DONE_ALL'])('develop-start는 %s에서 기존 백로그 PICK을 실행한다', async state => {
  const test = await setup(); const task = await addTask(test.root, { title: '우선 작업', category: 'docs' });
  await updateState(test.root, { state, awaitingUser: state === 'PROJECT_READY' }); await test.command('develop-start');
  expect(await readState(test.root)).toMatchObject({ state: 'SPEC', taskId: task.id });
  expect((await readState(test.root)).awaitingUser).toBe(false);
  expect((await getTask(test.root, task.id)).status).toBe('doing');
  expect(test.sendMessage.mock.calls[0][0].content).toContain(`# SPEC`);
});
it('develop-start의 PICK 결과 EMPTY는 알림 후 턴을 시작하지 않는다', async () => {
  const test = await setup(); await addTask(test.root, { title: '선택 전 등록 작업', category: 'docs' });
  await updateState(test.root, { state: 'PICK' });
  vi.spyOn(pickModule, 'runPick').mockResolvedValueOnce({ outcome: 'EMPTY', reason: '백로그가 비어 있습니다' });
  await test.command('develop-start');
  expect((await readState(test.root)).state).toBe('PICK');
  expect(test.ctx.ui.notify).toHaveBeenCalledWith('백로그가 비어 있습니다', 'info');
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('develop-start의 빈 기존 백로그는 PLANNING을 유지하고 반복 호출 알림만 표시한다', async () => {
  const test = await setup(); await test.command('develop-start');
  test.sendMessage.mockClear(); await test.command('develop-start');
  expect((await readState(test.root)).state).toBe('PLANNING');
  expect(test.sendMessage).not.toHaveBeenCalled();
  expect(test.ctx.ui.notify).toHaveBeenCalledWith('백로그가 비어 있습니다. PLANNING 을 계속합니다','info');
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
it('cleanup은 실제 정리 결과를 표시하며 두뇌 턴을 시작하지 않는다', async () => {
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
  expect(JSON.parse(test.ctx.ui.notify.mock.calls.at(-1)![0]).applied).toHaveLength(1);
});
it('judged는 적용 항목이 없으면 WAIT_JUDGMENT에서도 보내지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'WAIT_JUDGMENT' });
  await test.command('judged'); expect(test.sendMessage).not.toHaveBeenCalled();
});
it('judged는 WAIT_JUDGMENT 밖에서 답을 적용해도 자동으로 시작하지 않는다', async () => {
  const test = await setup();
  const { item } = await addJudgment(test.root, { title: '진행 방식', background: '', options: ['첫 번째'], recommend: '첫 번째', blocks: '' });
  await answerJudgment(test.root, item.id, '1'); await test.command('judged');
  expect(JSON.parse(test.ctx.ui.notify.mock.calls.at(-1)![0]).applied).toHaveLength(1);
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('judged의 프로젝트 재개 지시문은 resumeState 먼저 복귀하도록 안내한다', async () => {
  const test = await setup();
  const { item } = await addJudgment(test.root, { title: '목표', background: '', options: ['첫 번째'], recommend: '', blocks: '' });
  await answerJudgment(test.root, item.id, '1');
  await updateState(test.root, { state: 'WAIT_JUDGMENT', resumeState: 'INTERVIEW', phase: 'project', pickJudgment:item.id });
  await test.command('judged');
  expect(test.sendMessage.mock.calls[0][0].content).toContain('# INTERVIEW');
  expect(test.sendMessage.mock.calls[0][0].content).not.toContain('# PICK');
  expect((await readState(test.root)).state).toBe('INTERVIEW');
  expect((await readState(test.root)).resumeState).toBeUndefined();
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
  const test = await setup(); await addTask(test.root,{title:'정체 task',category:'docs'});
  await updateState(test.root, { state: 'SPEC', taskId: 'T01' });
  for (let i = 0; i < 4; i++) await test.end();
  expect(test.sendMessage).toHaveBeenCalledTimes(3);
  expect(await readState(test.root)).toMatchObject({ state: 'WAIT_JUDGMENT', resumeState: 'PICK', autoTurns: 0 });
  expect((await readJudgment(test.root)).items[0].title).toBe('진행 정체: SPEC/T01');
  expect((await getTask(test.root,'T01')).status).toMatch(/^blocked\(A\d+\)$/u);
  await test.end(); expect((await readJudgment(test.root)).items).toHaveLength(1);
});
it('겹친 agent_end 이벤트는 자동 턴을 중복 예약하지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'INTERVIEW' });
  test.sendMessage.mockImplementation(() => { test.ctx.isIdle.mockReturnValue(false); });
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
it('H1 project-start→PROJECT_READY→develop-start는 빈 템플릿을 PLANNING으로 안내한다',async()=>{
  const test=await setup();await test.command('project-start');
  await updateState(test.root,{state:'PROJECT_READY'});test.sendMessage.mockClear();await test.command('develop-start');
  expect((await readState(test.root)).state).toBe('PLANNING');
  expect(test.sendMessage).toHaveBeenCalledTimes(1);expect(test.sendMessage.mock.calls[0][0].content).toContain('# PLANNING');
});
it('M1 INTERVIEW 사용자 대기 표지·awaitingUser는 자동 턴과 정체 횟수를 멈춘다',async()=>{
  const test=await setup();await updateState(test.root,{state:'INTERVIEW',autoTurns:2});
  await test.end('stop','어떤 플랫폼인가요?\n대기: 사용자\n상태: INTERVIEW');
  expect(test.sendMessage).not.toHaveBeenCalled();expect(await readState(test.root)).toMatchObject({awaitingUser:true,autoTurns:0});
  await test.end();expect(test.sendMessage).not.toHaveBeenCalled();
  await test.handlers.get('input')!({source:'extension',text:'자동 지시'},test.ctx);
  expect((await readState(test.root)).awaitingUser).toBe(true);
  await test.handlers.get('input')!({source:'interactive',text:'웹으로 해줘'},test.ctx);
  expect(await readState(test.root)).toMatchObject({awaitingUser:false,autoTurns:0});
  await test.end();expect(test.sendMessage).toHaveBeenCalledTimes(1);
});
it('M5 error 후 ready가 있어도 기다리고 WAIT_RETRY 만료 뒤 사용자 명령으로 재개한다',async()=>{
  const test=await setup();const task=await addTask(test.root,{title:'준비',category:'docs'});
  await updateState(test.root,{state:'paused(error)'});await test.command('develop-start');
  expect((await readState(test.root)).state).toBe('WAIT_RETRY');expect((await getTask(test.root,task.id)).status).toBe('ready');
  await test.command('develop-start');expect(test.ctx.ui.notify.mock.calls.at(-1)![0]).toContain('분 뒤 재시도 예정');
  expect(test.sendMessage).not.toHaveBeenCalled();
  await updateState(test.root,{retry:{count:1,nextAt:new Date(Date.now()-1000).toISOString()}});
  await test.command('develop-start');expect((await readState(test.root)).state).toBe('SPEC');
  expect((await readState(test.root)).retry).toBeUndefined();
});
it('M5 WAIT_RESOURCE 사용자 명령은 오래된 retry도 해제한다',async()=>{
  const test=await setup();await addTask(test.root,{title:'준비',category:'docs'});
  await updateState(test.root,{state:'WAIT_RESOURCE',lastPaused:'memory',retry:{count:1,nextAt:new Date(Date.now()+600000).toISOString()}});
  await test.command('develop-start');expect((await readState(test.root)).state).toBe('SPEC');
  expect((await readState(test.root)).retry).toBeUndefined();expect((await readState(test.root)).lastPaused).toBeUndefined();
});
it('F22 정체 판단①→doing→PICK→IMPLEMENT 복귀',async()=>{
  const test=await setup();const task=await addTask(test.root,{title:'정체',category:'docs'});
  await updateState(test.root,{state:'IMPLEMENT',taskId:task.id,doctor:{ok:true,checkedAt:new Date().toISOString()}});await setTask(test.root,task.id,{status:'doing'});
  for(let i=0;i<4;i++)await test.end();const item=(await readJudgment(test.root)).items[0];
  expect((await getTask(test.root,task.id)).status).toBe(`blocked(${item.id})`);
  await answerJudgment(test.root,item.id,'1');await test.command('judged',item.id);
  expect((await getTask(test.root,task.id)).status).toBe('doing');expect((await readState(test.root)).state).toBe('PICK');
  await test.command('develop-start');expect((await readState(test.root)).state).toBe('IMPLEMENT');
});
it.each(['WAIT_JUDGMENT','DONE_ALL'])('L10: %s 종료는 알리고 자동 턴을 만들지 않는다',async state=>{
  const test=await setup();await updateState(test.root,{state});await test.end();
  expect(test.ctx.ui.notify).toHaveBeenCalledWith(`하네스 상태: ${state}${state === 'WAIT_JUDGMENT' ? ' — 프로세스 0개 회수, 잔존 0개' : ''}`,'info');
  expect(test.sendMessage).not.toHaveBeenCalled();
});
it('L10: task 정체 회수 뒤 WAIT 판단 문서에 번호와 요약을 쓴다',async()=>{
  const test=await setup();const task=await addTask(test.root,{title:'정체',category:'docs'});
  await updateState(test.root,{state:'SPEC',taskId:task.id});await updateState(test.root,{autoTurns:3});await test.end();
  const item=(await readJudgment(test.root)).items[0];
  expect(await readFile(join(test.root,'docs/판단대기.md'),'utf8')).toContain(`${item.id} 답 대기 — 진행 정체: SPEC/${task.id}`);
  expect((await getTask(test.root,task.id)).status).toBe(`blocked(${item.id})`);
});
it.each([
  { state: 'SPEC', autoTurns: 2, awaitingUser: false, text: '' },
  { state: 'SPEC', autoTurns: 3, awaitingUser: false, text: '' },
  { state: 'INTERVIEW', autoTurns: 2, awaitingUser: true, text: '' },
  { state: 'INTERVIEW', autoTurns: 2, awaitingUser: false, text: '질문\n대기: 사용자\n상태: INTERVIEW' },
  { state: 'recovering', autoTurns: 2, awaitingUser: false, text: '' },
])('F7: hasUI:false는 상태 파일을 바꾸지 않고 자동 재개를 건너뛴다 (%#)', async input => {
  const test = await setup(); test.ctx.hasUI = false;
  await updateState(test.root, { state: input.state });
  await updateState(test.root, { autoTurns: input.autoTurns, awaitingUser: input.awaitingUser });
  const path = join(test.root, '.pi/harness-state.json'), before = await readFile(path, 'utf8');
  await expect(test.end('stop', input.text)).resolves.toBeUndefined();
  expect(test.sendMessage).not.toHaveBeenCalled(); expect(test.ctx.ui.notify).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(before);
});
it.each(['SPEC', 'recovering'])('F7: %s followUp 전송 실패는 카운터를 원복하고 이후 재개를 허용한다', async state => {
  const test = await setup(); await updateState(test.root, { state });
  await updateState(test.root, { autoTurns: 2 });
  const before = await readState(test.root);
  test.sendMessage.mockImplementationOnce(() => { throw new Error('This extension ctx is stale'); });
  await expect(test.end()).resolves.toBeUndefined();
  const after = await readState(test.root);
  expect(after.autoTurns).toBe(2); expect(after.state).toBe(state);
  expect(after.recoveryAutoResumed).toBe(before.recoveryAutoResumed);
  expect(test.ctx.ui.notify).toHaveBeenCalledWith('자동 재개 전송에 실패했습니다. This extension ctx is stale 다음 사용자 입력에서 다시 진행합니다.', 'warning');
  await test.end();
  expect(test.sendMessage).toHaveBeenCalledTimes(2); expect((await readState(test.root)).autoTurns).toBe(3);
  if (state === 'recovering') expect((await readState(test.root)).recoveryAutoResumed).toBe(true);
});
it('F7: 전송과 warning 알림 모두 stale 예외여도 핸들러는 reject하지 않는다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'INTERVIEW' });
  await updateState(test.root, { autoTurns: 1 });
  test.sendMessage.mockImplementationOnce(() => { throw new Error('stale send'); });
  test.ctx.ui.notify.mockImplementationOnce(() => { throw new Error('stale notify'); });
  await expect(test.end()).resolves.toBeUndefined();
  expect((await readState(test.root)).autoTurns).toBe(1);
  expect(test.ctx.ui.notify).toHaveBeenCalledTimes(1);
  await test.end(); expect(test.sendMessage).toHaveBeenCalledTimes(2);
});
it('F7: warning UI가 없어도 전송 실패 카운터를 원복한다', async () => {
  const test = await setup(); await updateState(test.root, { state: 'INTERVIEW' });
  test.sendMessage.mockImplementationOnce(() => { throw new Error('stale send'); });
  await expect(test.handlers.get('agent_end')!({ messages: [] }, { cwd: test.root, hasUI: true })).resolves.toBeUndefined();
  expect((await readState(test.root)).autoTurns).toBe(0); expect(test.sendMessage).toHaveBeenCalledTimes(1);
});

it('P2: 판단 문서 답 적용은 blocked 해제·완료 표·WAIT 복귀·awaitingUser 해제·재개·원장', async () => {
  const t = await setup(); const task = await addTask(t.root, { title: '문서 답', category: 'docs' });
  const { item } = await addJudgment(t.root, { title: '방식', background: '', options: ['진행'], recommend: '', blocks: task.id });
  await setTask(t.root, task.id, { status: `blocked(${item.id})`, judgment: item.id });
  await updateState(t.root, { state: 'WAIT_JUDGMENT', resumeState: 'PICK' });
  await updateState(t.root, { awaitingUser: true, autoTurns: 3 }); await answerJudgment(t.root, item.id, '1');
  await t.decide(['judgment-changed']);
  expect(await readState(t.root)).toMatchObject({ state: 'PICK', awaitingUser: false, autoTurns: 1 });
  expect((await getTask(t.root, task.id)).status).toBe('ready');
  expect((await readJudgment(t.root)).completed).toEqual([expect.objectContaining({ id: item.id, answer: '1' })]);
  expect(t.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('# PICK') }), { triggerTurn: true, deliverAs: 'followUp' });
  expect((await readLedger(t.root)).at(-1)).toMatchObject({ action: 'watcher:decide:judgment-changed', status: 'ok', evidence: { applied: [item.id], resumed: true, ids: [expect.any(String)] } });
});
it('P2: 활동 상태에서 문서로 답하면 대기를 풀고 autoTurns를 초기화한다', async () => {
  const t = await setup(); const { item } = await addJudgment(t.root, { title: '플랫폼', background: '', options: ['웹'], recommend: '', blocks: '' });
  await answerJudgment(t.root, item.id, '1'); await updateState(t.root, { state: 'INTERVIEW' });
  await updateState(t.root, { awaitingUser: true, autoTurns: 3 }); await t.decide(['judgment-changed']);
  expect(await readState(t.root)).toMatchObject({ state: 'INTERVIEW', awaitingUser: false, autoTurns: 1 });
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
});
it('P2: 답 없는 변경은 알림만, 인박스와 상태를 유지한다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW', awaitingUser: true });
  await t.decide(['judgment-changed']);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('판단대기 변경 감지 — 적용할 답 없음', 'info');
  expect(t.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).awaitingUser).toBe(true);
  expect((await readLedger(t.root)).at(-1)).toMatchObject({ status: 'skip', evidence: { applied: [], resumed: false } });
});
it('P2: 부정·모호 답은 /judged 경로로 재질문하며 결과 알림에 포함한다', async () => {
  const t = await setup(); const { item } = await addJudgment(t.root, { title: '방식', background: '', options: ['진행'], recommend: '', blocks: '' });
  await answerJudgment(t.root, item.id, '하지 마'); await updateState(t.root, { state: 'WAIT_JUDGMENT', pickJudgment: item.id });
  await t.decide(['judgment-changed']);
  const document = await readJudgment(t.root);
  expect(document.items).toHaveLength(2); expect(document.items[0].followup).toBe(document.items[1].id);
  expect(document.items[1].reaskOf).toBe(item.id);
  expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0]).unapplied).toEqual([{ id: item.id, reason: '부정 또는 유보가 포함되어 있습니다' }]);
  expect(t.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).state).toBe('WAIT_JUDGMENT');
});
it('P2: busy stalled는 카운터·상태를 바꾸지 않고 skip 원장·warning', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' }); t.ctx.isIdle.mockReturnValue(false);
  const before = await readState(t.root); await t.decide(['stalled']);
  expect(await readState(t.root)).toEqual(before); expect(t.sendMessage).not.toHaveBeenCalled();
  expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('busy'), 'warning');
  expect((await readLedger(t.root)).at(-1)).toMatchObject({ status: 'skip', evidence: { resumed: false } });
});
it('P2: stalled는 idle에서 재개하고 상한이면 판단 생성 후 warning', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  await t.decide(['stalled']); expect(t.sendMessage).toHaveBeenCalledTimes(1);
  await updateState(t.root, { autoTurns: 3 }); await t.decide(['stalled']);
  expect(t.sendMessage).toHaveBeenCalledTimes(1); expect((await readState(t.root)).state).toBe('WAIT_JUDGMENT');
  expect((await readJudgment(t.root)).items).toHaveLength(1);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('진행 정체를 판단대기에 등록했습니다.', 'warning');
});
it.each(['child-timeout', 'child-gone'])('P2: %s는 warning만 남기며 상태·프로세스를 회수하지 않는다', async kind => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' }); const before = await readState(t.root);
  await t.decide([kind]); expect(t.sendMessage).not.toHaveBeenCalled(); expect(await readState(t.root)).toEqual(before);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('201'), 'warning');
  expect((await readLedger(t.root)).at(-1)).toMatchObject({ action: `watcher:decide:${kind}`, status: 'ok', evidence: { resumed: false } });
});
it.each([
  ['INTERVIEW', true, false, true], ['INTERVIEW', false, false, false], ['INTERVIEW', true, true, false],
  ['recovering', true, false, false], ['paused(error)', true, false, false], ['WAIT_JUDGMENT', true, false, false],
])('P2: recover %s doctor=%s awaiting=%s → 재개=%s', async (state, fresh, awaitingUser, resumes) => {
  const t = await setup(); await updateState(t.root, { state: 'SPEC', taskId: 'T01' });
  await updateState(t.root, { state: String(state), taskId: 'T01', awaitingUser: Boolean(awaitingUser),
    doctor: { ok: true, checkedAt: new Date(Date.now() - (fresh ? 0 : 13 * 3600000)).toISOString() } });
  await t.decide(['recover']); expect(t.sendMessage).toHaveBeenCalledTimes(resumes ? 1 : 0);
  if (!resumes) expect(t.ctx.ui.notify).toHaveBeenCalledWith(`이전 세션 상태: ${state} /T01 — /develop-start 또는 /judged 로 이어갑니다`, 'info');
});
it('P2: /status는 아직 tick하지 않은 워처도 안정된 요약 필드를 표시', async () => {
  const t = await setup(); await t.command('status');
  expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0]).watcher).toEqual({ lastTickAt: null,
    judgment: { observedHash: null, stableFor: 0, expectedHash: null }, childTimeouts: 0 });
});
it('M1/L8: 서로 다른 resume 모듈에서도 전송 직전 idle 확인으로 1회·autoTurns +1', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  const first = await import('../extensions/orchestrator/resume.ts');
  vi.resetModules(); const second = await import('../extensions/orchestrator/resume.ts');
  expect(first.autoResume).not.toBe(second.autoResume);
  t.sendMessage.mockImplementation(() => { t.ctx.isIdle.mockReturnValue(false); });
  const pi = { sendMessage: t.sendMessage } as unknown as ExtensionAPI;
  const ctx = { cwd: t.root, hasUI: true, isIdle: t.ctx.isIdle, notify: t.ctx.ui.notify };
  const results = await Promise.all([first.autoResume(pi, t.root, ctx, 'agent_end'), second.autoResume(pi, t.root, ctx, 'stalled')]);
  expect(t.sendMessage).toHaveBeenCalledTimes(1); expect((await readState(t.root)).autoTurns).toBe(1);
  expect(results).toContainEqual({ resumed: true }); expect(results).toContainEqual({ skipped: 'busy' });
});
it('P2: 같은 종류의 여러 인박스는 묶어서 한 번 재개하고 모든 ID를 원장에 남긴다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' }); await t.decide(['stalled', 'stalled']);
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect(((await readLedger(t.root)).at(-1)!.evidence as any).ids).toHaveLength(2);
});
it('P2: 실제 문서 직접 편집 → 안정화 tick → decideInbox → 프로젝트 재개', async () => {
  const t = await setup(); const { item } = await addJudgment(t.root, { title: '플랫폼', background: '', options: ['웹'], recommend: '', blocks: '' });
  await updateState(t.root, { state: 'WAIT_JUDGMENT', resumeState: 'INTERVIEW', pickJudgment: item.id, awaitingUser: true });
  const now = Date.now(); await tick(t.root, { now });
  const path = join(t.root, 'docs/판단대기.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('- 답:', '- 답: 1'));
  expect((await tick(t.root, { now: now + 1000 })).emitted).toEqual([]);
  const { emitted } = await tick(t.root, { now: now + 11000 }); expect(emitted).toHaveLength(1);
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, emitted);
  expect(await readState(t.root)).toMatchObject({ state: 'INTERVIEW', awaitingUser: false, autoTurns: 1 });
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect((await tick(t.root, { now: now + 12000 })).emitted).toEqual([]);
  expect((await readJudgment(t.root)).items).toEqual([]);
});

async function delegationFixture(root: string, runId = 'delegated', finished = false) {
  const { writeMeta } = await import('../src/core/codex-record.ts');
  const startedAt = new Date().toISOString();
  await updateState(root, { state: 'RESEARCH', delegation: { runId, kind: 'research', startedAt, title: '조사' } });
  await writeMeta(root, { runId, kind: 'research', startedAt, cwd: root, sandbox: 'read-only', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh', command: ['fake'], timeoutMinutes: 90, state: 'RESEARCH', status: finished ? 'ok' : 'running', ...(finished ? { finishedAt: startedAt, exit: 0 } : {}) });
}
it('P3 위임 대기 표지는 재개를 멈추고 recover/stalled도 재개하지 않는다', async () => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', '대기: 위임 delegated\n상태: RESEARCH');
  expect((await readState(t.root)).awaitingDelegation).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
  await t.decide(['stalled', 'recover']); expect(t.sendMessage).not.toHaveBeenCalled();
});
it.each(['wrong', 'finished'])('P3 %s 위임 표지를 무시하고 marker skip 후 정상 재개', async scenario => {
  const t = await setup(); await delegationFixture(t.root, 'delegated', scenario === 'finished');
  await t.end('stop', `대기: 위임 ${scenario === 'wrong' ? 'different' : 'delegated'}\n상태: RESEARCH`);
  expect(t.sendMessage).toHaveBeenCalledTimes(1); expect((await readState(t.root)).awaitingDelegation).toBe(false);
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'delegation:marker', status: 'skip' }));
});
it('P3 표지 누락 시 다음 프롬프트 안내는 run당 1회', async () => {
  const t = await setup(); await delegationFixture(t.root); await t.end(); await t.end();
  expect(t.sendMessage.mock.calls[0][0].content).toContain('[위임 진행 중 delegated');
  expect(t.sendMessage.mock.calls[1][0].content).not.toContain('[위임 진행 중 delegated');
});
it.each(['ok', 'fail', 'timeout', 'lost'])('P3 codex-done %s → 대기 해제·재개·실패 경고·인박스 전달 유지', async status => {
  const t = await setup(); await delegationFixture(t.root); await updateState(t.root, { awaitingDelegation: true, autoTurns: 3 });
  const record = await addInbox(t.root, { kind: 'codex-done', runId: 'delegated', codexRunId: 'delegated', codexStatus: status });
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, [record]);
  const state = await readState(t.root); expect(state.delegation).toBeUndefined(); expect(state.awaitingDelegation).toBe(false); expect(state.autoTurns).toBe(1);
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect(t.ctx.ui.notify).toHaveBeenCalledTimes(status === 'ok' ? 0 : 1);
  const { listInbox } = await import('../src/core/inbox.ts'); expect((await listInbox(t.root))[0].status).not.toBe('applied');
});
it('P3 다른 run·이미 해제된 완료 인박스는 applied만, busy 일치 완료는 다음 프롬프트에 유지', async () => {
  const t = await setup(); await delegationFixture(t.root);
  const { listInbox, deliverInbox } = await import('../src/core/inbox.ts');
  const old = await addInbox(t.root, { kind: 'codex-done', runId: 'old', codexRunId: 'old', codexStatus: 'fail' });
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, [old]);
  expect((await listInbox(t.root))[0].status).toBe('applied'); expect(t.ctx.ui.notify).not.toHaveBeenCalled(); expect(t.sendMessage).not.toHaveBeenCalled();
  const matching = await addInbox(t.root, { kind: 'codex-done', runId: 'delegated', codexRunId: 'delegated', codexStatus: 'ok' });
  await deliverInbox(t.root, [matching.id], 'brain-turn'); t.ctx.isIdle.mockReturnValue(false);
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, [(await listInbox(t.root))[1]]);
  expect((await readState(t.root)).delegation).toBeUndefined(); expect(t.sendMessage).not.toHaveBeenCalled();
  expect((await listInbox(t.root))[1].status).toBe('delivered');
});
it('P3 /status 위임 요약 및 buildPrompt 결과 조회 지시', async () => {
  const t = await setup(); await delegationFixture(t.root); await t.command('status');
  expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0]).delegation).toMatchObject({ runId: 'delegated', kind: 'research', title: '조사', status: 'running', minutes: expect.any(Number) });
  const { buildPrompt } = await import('../src/provider/turn.ts');
  await addInbox(t.root, { kind: 'codex-done', runId: 'delegated', codexRunId: 'delegated', codexStatus: 'ok', resultDir: '/result' });
  expect(await buildPrompt(t.root, 'next', 'brain-1')).toContain('fodh codex result delegated');
  expect(await buildPrompt(t.root, 'next', 'brain-2')).toContain('fodh codex result delegated');
});

it.each(['`대기: 위임 delegated`', '대기: 위임 <delegated>', '대기: 위임 `delegated`', '<대기: 위임 delegated>'])('P3 표지 경계 장식 허용: %s', async marker => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', `본문\n${marker}\n\n상태: RESEARCH\n`);
  expect((await readState(t.root)).awaitingDelegation).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('P3 본문의 위임 표지는 무시하고 사용자 표지는 보존한다', async () => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', '대기: 위임 delegated\n대기: 사용자\n본문1\n본문2\n상태: RESEARCH');
  expect((await readState(t.root)).awaitingDelegation).not.toBe(true);
  expect((await readState(t.root)).awaitingUser).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('P3 사용자·위임 표지가 함께 있으면 두 대기를 기록한다', async () => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', '대기: 위임 delegated\n대기: 사용자\n상태: RESEARCH');
  expect(await readState(t.root)).toMatchObject({ awaitingDelegation: true, awaitingUser: true });
  expect(t.sendMessage).not.toHaveBeenCalled();
});

it.each(['**대기: 사용자**', '_대기: 사용자_', '`대기: 사용자`'])('본문 중간 사용자 표지는 뒤에 5줄이 있어도 대기한다: %s', async marker => {
  const t = await setup();
  await t.end('stop', `${marker}\n질문1\n질문2\n질문3\n질문4\n질문5`);
  expect((await readState(t.root)).awaitingUser).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('감독 유실로 추정한 성공은 codex-done에서 경고한다', async () => {
  const t = await setup(); await delegationFixture(t.root);
  const record = await addInbox(t.root, { kind: 'codex-done', codexRunId: 'delegated', codexStatus: 'ok', supervisorLost: true });
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, [record]);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('감독 사망 뒤 추정한 성공 — 결과를 직접 확인', 'warning');
});

it('P4: memory pressure 정리·critical 보존·recovered PICK 및 RESUME', async () => {
  const t = await setup(), task = await addTask(t.root, { title: 'memory', category: 'docs' });
  await setTask(t.root, task.id, { status: 'doing' }); await updateState(t.root, { state: 'IMPLEMENT', taskId: task.id, doctor: { ok: true, checkedAt: new Date().toISOString() } });
  const clean = vi.spyOn(cleanupModule, 'runCleanup'), notices = vi.spyOn(notifyModule, 'notify');
  await t.decide(['memory-pressure']); expect(clean).toHaveBeenCalledWith(t.root, { scope: 'processes' });
  await t.decide(['memory-critical']); expect(await readState(t.root)).toMatchObject({ state: 'paused(memory)', taskId: task.id, resumeState: 'IMPLEMENT' });
  await t.decide(['memory-recovered']); expect(await readState(t.root)).toMatchObject({ state: 'PICK', resumeTask: { taskId: task.id, resumeState: 'IMPLEMENT' } });
  expect(t.sendMessage).toHaveBeenCalled(); expect((await runPick(t.root)).outcome).toBe('RESUME');
  expect(notices.mock.calls.map(call => call[1].key)).toEqual(expect.arrayContaining(['memory-pressure', 'memory-critical', 'memory-recovered']));
});
it('P4: WAIT 진입 커밋 후 정리를 끝내고 notify 경유, cleanup dry는 보고서 생성', async () => {
  const t = await setup(); await updateState(t.root, { state: 'PICK' });
  let during: string | undefined;
  const actual = cleanupModule.runCleanup;
  const clean = vi.spyOn(cleanupModule, 'runCleanup').mockImplementation(async (root, options) => { during = (await readState(root)).state; return actual(root, options); });
  const notices = vi.spyOn(notifyModule, 'notify');
  await transitionState(t.root, 'WAIT_JUDGMENT'); expect(during).toBe('WAIT_JUDGMENT');
  expect(clean).toHaveBeenCalledWith(t.root, { scope: 'processes' });
  expect(notices).toHaveBeenCalledWith(t.root, expect.objectContaining({ key: 'state:WAIT_JUDGMENT', body: expect.stringContaining('회수') }));
  await t.command('cleanup', 'dry'); expect(clean).toHaveBeenCalledWith(t.root, { scope: 'all', dryRun: true });
  expect(JSON.parse(await readFile(join(t.root, '.pi/cleanup-last.json'), 'utf8'))).toMatchObject({ dryRun: true });
});

it('P4: 두뇌 오류 3회는 notify 경유 error, 성공 턴은 연속 횟수 초기화', async () => {
  const t = await setup(), notices = vi.spyOn(notifyModule, 'notify');
  await t.end('error'); await t.end('error');
  expect(notices.mock.calls.filter(call => call[1].key === 'brain-errors')).toHaveLength(0);
  await t.end('error'); expect(notices).toHaveBeenCalledWith(t.root, expect.objectContaining({ key: 'brain-errors', level: 'error' }), expect.any(Object));
  await t.end(); expect((await readState(t.root)).brainErrors).toBe(0);
});

it('P4: 정리 중 상태 기록이 잠금에 막히지 않고 최신 필드를 보존한다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'PICK' });
  const actual = cleanupModule.runCleanup; let once = false;
  vi.spyOn(cleanupModule, 'runCleanup').mockImplementation(async (root, options) => {
    if (!once) { once = true; await updateState(root, { heartbeatDuringCleanup: true }); }
    return actual(root, options);
  });
  await transitionState(t.root, 'WAIT_JUDGMENT');
  expect(await readState(t.root)).toMatchObject({ state: 'WAIT_JUDGMENT', heartbeatDuringCleanup: true });
});

it('M4: WAIT_RESOURCE 메모리 회복은 lastPaused 해제·PICK·자동 재개', async () => {
  const t = await setup(); await updateState(t.root, { state: 'WAIT_RESOURCE', lastPaused: 'memory', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await t.decide(['memory-recovered']);
  expect(await readState(t.root)).toMatchObject({ state: 'PICK' }); expect((await readState(t.root)).lastPaused).toBeUndefined();
  expect(t.sendMessage).toHaveBeenCalledOnce();
});
it('M4: READY 메모리 회복은 상태 유지·lastPaused만 해제', async () => {
  const t = await setup(); await updateState(t.root, { state: 'READY', lastPaused: 'memory' });
  await t.decide(['memory-recovered']);
  expect((await readState(t.root)).state).toBe('READY'); expect((await readState(t.root)).lastPaused).toBeUndefined(); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('F1: cleanup dry 직후 cleanup도 별도 결과 알림을 표시한다', async () => {
  const t = await setup(); t.ctx.ui.notify.mockClear();
  await t.command('cleanup', 'dry'); await t.command('cleanup');
  const bodies = t.ctx.ui.notify.mock.calls.map(([body]) => JSON.parse(body));
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(body).toMatchObject({ ok: true, remaining: 0, stale: 0, protected: 0 });
  const entries = (await readLedger(t.root)).filter(e => e.action.startsWith('notify:cleanup:'));
  expect(entries.map(e => e.status)).toEqual(['ok', 'ok']); expect(entries[0].action).not.toBe(entries[1].action);
});
it('L6: 비활성 상태 memory-critical은 위임 거부 안내를 표시한다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'READY' });
  await t.decide(['memory-critical']);
  expect((await readState(t.root)).state).toBe('READY');
  expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('회복 전까지 새 위임을 거부합니다'), 'error');
});

it('P5 시작 준비 실패는 warning만 남기고 두뇌 턴을 시작한다', async () => {
  const test = await setup();
  await writeFile(join(test.root, 'CLAUDE.md'), '<!-- fodh:managed:begin v1 -->');
  await test.command('project-start');
  expect(test.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('준비에 실패'), 'warning');
  expect((await readState(test.root)).state).toBe('INTERVIEW');
  expect(test.sendMessage).toHaveBeenCalledTimes(1);
  expect(await readFile(join(test.root,'CLAUDE.md'),'utf8')).toBe('<!-- fodh:managed:begin v1 -->');
});
it('P5 develop-start도 스킬과 CLAUDE.md를 설치한다', async () => {
  const test=await setup();await test.command('develop-start');
  expect(await readFile(join(test.root,'CLAUDE.md'),'utf8')).toContain('fodh-workflow');
  expect(await readFile(join(test.root,'.claude/skills/fodh-workflow/.fodh-managed'),'utf8')).toContain('fod-harness');
});

it('M3 추가 은행 형식 오류는 IDLE 유지·file:line 알림·실패 원장',async()=>{
  const t=await setup();await writeFile(join(t.root,'.pi/interview-bank.md'),'잘못된 줄\n');await t.command('project-start');
  expect((await readState(t.root)).state).toBe('IDLE');expect(t.sendMessage).not.toHaveBeenCalled();
  expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('인터뷰 시작 불가: 인터뷰 은행 형식 오류:'),'error');
  expect(t.ctx.ui.notify.mock.calls.at(-1)![0]).toContain('interview-bank.md:1');
  expect((await readLedger(t.root)).at(-1)).toMatchObject({action:'project-start',status:'fail'});
  await writeFile(join(t.root,'.pi/interview-bank.md'),'');await t.command('project-start');expect((await readState(t.root)).state).toBe('INTERVIEW');
});
it('M3 INTERVIEW 은행 오류여도 instruction·자동 전송은 수정 요청을 포함한다',async()=>{
  const t=await setup();await updateState(t.root,{state:'INTERVIEW'});await writeFile(join(t.root,'.pi/interview-bank.md'),'잘못된 줄\n');
  const text=await instruction(t.root,await readState(t.root));expect(text).toContain('인터뷰 은행 오류:');expect(text).toContain('interview-bank.md:1');expect(text).toContain('사용자에게 파일 수정을 요청하고 대기: 사용자');
  await t.end();expect(t.sendMessage).toHaveBeenCalledWith(expect.objectContaining({content:expect.stringContaining('인터뷰 은행 오류:')}),expect.anything());
});
it('M1 답 없는 사용자 입력은 openRound를 유지한다',async()=>{
  const {nextInterview,readInterview}=await import('../src/core/interview.ts');const t=await setup();await t.command('project-start');
  const first=await nextInterview(t.root);await t.handlers.get('input')!({source:'interactive',text:'잠깐만'},t.ctx);
  expect((await readInterview(t.root))?.openRound).toMatchObject({round:1,ids:first.questions.map(q=>q.id)});
  expect(await nextInterview(t.root)).toMatchObject({round:1,repeated:true,questions:first.questions});
});
it('L6 develop-start에서 문서가 변경될 때만 커밋 필요 알림',async()=>{
  const t=await setup();await t.command('develop-start');expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('커밋 필요'),'info');
  t.ctx.ui.notify.mockClear();await t.command('develop-start');expect(t.ctx.ui.notify.mock.calls.some(c=>String(c[0]).includes('커밋 필요'))).toBe(false);
});
it('M3 자동 전송 예외는 원인 앞 120자를 알린다',async()=>{
  const t=await setup();await updateState(t.root,{state:'INTERVIEW'});t.sendMessage.mockImplementation(()=>{throw new Error('전송 실패 원인 '+ 'x'.repeat(200));});await t.end();
  const warning=t.ctx.ui.notify.mock.calls.find(c=>String(c[0]).includes('전송 실패 원인'));
  expect(warning).toBeTruthy();expect(warning![0]).toContain('전송 실패 원인');expect(warning![0]).not.toContain('x'.repeat(121));
});
