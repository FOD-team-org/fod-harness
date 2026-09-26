import * as judgmentModule from '../src/core/judgment.ts';
import { todayKst } from '../src/core/template-values.ts';
import * as cleanupModule from '../src/core/cleanup.ts';
import * as notifyModule from '../src/core/notify.ts';
import * as configModule from '../src/core/config.ts';
import { runPick } from '../src/core/pick.ts';
import * as pickModule from '../src/core/pick.ts';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import orchestrator, { instruction, decideInbox, clearDecisionTimers, resumeHint } from '../extensions/orchestrator/index.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { addJudgment, answerJudgment, readJudgment, applyJudgments, beginJudgmentSnapshot, finishJudgmentSnapshot, writeJudgmentStatus } from '../src/core/judgment.ts';
import { addInbox, listInbox } from '../src/core/inbox.ts';
import { appendLedger, readLedger } from '../src/core/ledger.ts';
import { tick } from '../src/core/watcher.ts';
import { setConfig } from '../src/core/config.ts';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { clearDecisionTimers(root); await rm(root, { recursive: true, force: true }); } });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-orchestrator-')); roots.push(root);
  await setConfig(root, 'notify.channels', '["tui","ledger"]');
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const sendMessage = vi.fn();
  orchestrator({ registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler), sendMessage } as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: true, isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), signal: undefined as AbortSignal | undefined, ui: { notify: vi.fn() } };
  await handlers.get('session_start')!({}, ctx);
  return { root, commands, handlers, ctx, sendMessage,
    decide: async (kinds: string[]) => decideInbox({ sendMessage } as unknown as ExtensionAPI, ctx as any, root,
      await Promise.all(kinds.map(kind => addInbox(root, { kind, pid: 201 })))),
    command: (name: string, args = '') => commands.get(name)!.handler(args, ctx),
    end: (stopReason = 'stop', text = '') => handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason, content: [{type:'text',text}] }] }, ctx) };
}

it('Pi 명령 6종과 orchestrator 확장 등록', async () => {
  const test = await setup();
  expect([...test.commands.keys()]).toEqual(['hold', 'project-start', 'develop-start', 'status', 'judged', 'cleanup', 'autopilot']);
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
  if (!resumes) expect(t.ctx.ui.notify).toHaveBeenCalledWith(`이전 세션 상태: ${state} /T01 — ${resumeHint(String(state), [])}`, 'info');
});
it('P2: /status는 아직 tick하지 않은 워처도 안정된 요약 필드를 표시', async () => {
  const t = await setup(); await t.command('status');
  expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0]).watcher).toEqual({ lastTickAt: null,
    judgment: { observedHash: null, stableFor: 0, expectedHash: null }, childTimeouts: 0 });
});
it.each([['stalled', 'agent_end'], ['agent_end', 'stalled']])('M1/L8: %s 먼저 → %s busy, 모듈이 달라도 전송 1회·autoTurns +1', async (leading, following) => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  const first = await import('../extensions/orchestrator/resume.ts');
  vi.resetModules(); const second = await import('../extensions/orchestrator/resume.ts');
  expect(first.autoResume).not.toBe(second.autoResume);
  t.sendMessage.mockImplementation(() => { t.ctx.isIdle.mockReturnValue(false); });
  const pi = { sendMessage: t.sendMessage } as unknown as ExtensionAPI;
  const ctx = first.resumeContext(t.ctx as any); // Both invocations belong to the original idle run.
  const results = [await first.autoResume(pi, t.root, ctx, leading), await second.autoResume(pi, t.root, ctx, following)];
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
  await writeFile(path, (await readFile(path, 'utf8')).replace(/^- 답:/mu, '- 답: 1'));
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
it('F23 완료된 위임의 표지는 marker skip 후 정상 재개한다', async () => {
  const t = await setup(); await delegationFixture(t.root, 'delegated', true);
  await t.end('stop', '대기: 위임 delegated');
  expect(t.sendMessage).toHaveBeenCalledOnce(); expect((await readState(t.root)).awaitingDelegation).toBe(false);
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'delegation:marker', status: 'skip' }));
});
it.each([null, 'different'])('F23 살아 있는 위임은 표지 %s에도 자동 재개하지 않는다', async marker => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', marker ? `대기: 위임 ${marker}` : '작업 시작');
  expect(await readState(t.root)).toMatchObject({ awaitingDelegation: true, autoTurns: 0 });
  expect(t.sendMessage).not.toHaveBeenCalled();
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'delegation:implied', evidence: { marker, runId: 'delegated' } }));
  const done = await addInbox(t.root, { kind: 'codex-done', codexRunId: 'delegated', codexStatus: 'ok' });
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, [done]);
  expect((await readState(t.root)).awaitingDelegation).toBe(false);
  expect(t.sendMessage).toHaveBeenCalledOnce();
});
it('F23 위임이 없는 잘못된 표지는 skip 후 정상 재개한다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'RESEARCH' });
  await t.end('stop', '대기: 위임 nonexistent');
  expect(t.sendMessage).toHaveBeenCalledOnce();
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'delegation:marker', status: 'skip' }));
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
it('F23 본문 표지가 인식되지 않아도 살아 있는 위임과 사용자 대기는 보존한다', async () => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', '대기: 위임 delegated\n대기: 사용자\n본문1\n본문2\n상태: RESEARCH');
  expect((await readState(t.root)).awaitingDelegation).toBe(true);
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

it.each(['normal', 'past-mtime', 'status-rewrite'])('S1 %s 답 변경은 내용으로 held, 번호 명시 후 적용', async kind => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '확인', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await updateState(t.root, { state: 'WAIT_JUDGMENT' });
  await beginJudgmentSnapshot(t.root, { runId: 'brain-content', startedAt: new Date().toISOString() });
  await answerJudgment(t.root, item.id, '1');
  if (kind === 'past-mtime') await utimes(join(t.root, 'docs/판단대기.md'), new Date(0), new Date(0));
  await finishJudgmentSnapshot(t.root);
  if (kind === 'status-rewrite') await writeJudgmentStatus(t.root, '상태 갱신');
  await t.decide(['judgment-changed']); await t.decide(['judgment-changed']);
  expect((await readJudgment(t.root)).items[0]).toMatchObject({ id: item.id, held: { reason: 'brain-turn', runId: 'brain-content' } });
  expect((await readJudgment(t.root)).completed).toHaveLength(0);
  expect(t.sendMessage).not.toHaveBeenCalled();
  expect(t.ctx.ui.notify.mock.calls.filter(([message]) => String(message).includes('판단 답이 두뇌 턴 중'))).toHaveLength(1);
  expect((await readLedger(t.root)).filter(entry => entry.action === 'judgment:held')).toHaveLength(1);
  expect((await listInbox(t.root)).every(item => item.status === 'applied')).toBe(true);
  await t.command('judged');
  expect(t.ctx.ui.notify).toHaveBeenCalledWith(`held: ${item.id}="1"(두뇌 턴 brain-co)`, 'info');
  expect((await readJudgment(t.root)).completed).toHaveLength(0);
  await t.command('judged', item.id);
  expect((await readJudgment(t.root)).completed[0].id).toBe(item.id);
  expect(JSON.parse(t.ctx.ui.notify.mock.calls.at(-1)![0]).released).toEqual([{ id: item.id, answer: '1' }]);
  expect(JSON.parse(await readFile(join(t.root, '.pi/harness-judgment-held.json'), 'utf8'))).toEqual([]);
  await expect(readFile(join(t.root, '.pi/harness-judgment-snapshot.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('S1 턴 전 사용자 답은 write-status와 새 빈 판단에도 held 없이 자동 적용', async () => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '사용자 답', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await answerJudgment(t.root, item.id, '1');
  await beginJudgmentSnapshot(t.root, { runId: 'brain', startedAt: new Date().toISOString() });
  await writeJudgmentStatus(t.root, '진행 중');
  const empty = await addJudgment(t.root, { title: '새 빈 판단', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await finishJudgmentSnapshot(t.root);
  await t.decide(['judgment-changed']);
  expect((await readJudgment(t.root)).completed[0].id).toBe(item.id);
  expect((await readJudgment(t.root)).items.find(item => item.id === empty.item.id)?.held).toBeUndefined();
  expect((await readLedger(t.root)).filter(entry => entry.action === 'judgment:held')).toEqual([]);
});
it('S1 턴 밖에서 새로 쓴 답은 자동 적용', async () => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '사용자 답', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await beginJudgmentSnapshot(t.root, { runId: 'brain', startedAt: new Date().toISOString() });
  await finishJudgmentSnapshot(t.root);
  await answerJudgment(t.root, item.id, '1'); await t.decide(['judgment-changed']);
  expect((await readJudgment(t.root)).completed[0].id).toBe(item.id);
});
it('S1 진행 중 인박스는 지연하고 타이머 재시도는 종료 뒤 held를 보존', async () => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '변경', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await beginJudgmentSnapshot(t.root, { runId: 'brain', startedAt: new Date().toISOString() });
  await answerJudgment(t.root, item.id, '1');
  const record = await addInbox(t.root, { kind: 'judgment-changed', pid: 201 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const result = await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, [record]);
    expect(result.deferred).toEqual([record.id]);
    expect((await readJudgment(t.root)).completed).toEqual([]);
    expect((await listInbox(t.root))[0].status).not.toBe('applied');
    await finishJudgmentSnapshot(t.root);
    await vi.advanceTimersByTimeAsync(5000);
    // The timer callback starts async filesystem work; await the same decision path to settle it.
    await vi.waitFor(async () => expect((await listInbox(t.root))[0].status).toBe('applied'));
    expect((await readJudgment(t.root)).items[0].held?.runId).toBe('brain');
    expect((await readJudgment(t.root)).completed).toEqual([]);
  } finally { clearDecisionTimers(t.root); vi.useRealTimers(); }
});
it.each(['session_start', 'recovering'])('S3 %s는 잔존 스냅숏을 held 처리하고 lastEventAt으로 턴을 닫는다', async kind => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '잔존', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await beginJudgmentSnapshot(t.root, { runId: 'crashed', startedAt: '2026-01-01T00:00:00.000Z' });
  await answerJudgment(t.root, item.id, '1');
  await updateState(t.root, { lastEventAt: '2026-01-01T00:01:00.000Z' });
  if (kind === 'session_start') await t.handlers.get('session_start')!({}, t.ctx);
  else await updateState(t.root, { state: 'recovering' });
  expect((await readState(t.root)).brainTurn?.endedAt).toBe('2026-01-01T00:01:00.000Z');
  expect((await readJudgment(t.root)).items[0].held?.runId).toBe('crashed');
  await t.decide(['judgment-changed']);
  expect((await readJudgment(t.root)).completed).toEqual([]);
});
it('참고 implied는 같은 run에서 한 번만, 다음 run에서는 새로 기록한다', async () => {
  const t = await setup(); await delegationFixture(t.root);
  await t.end('stop', '작업 중'); await t.end('stop', '대기: 위임 wrong');
  expect((await readLedger(t.root)).filter(item => item.action === 'delegation:implied')).toHaveLength(1);
  expect((await readState(t.root)).delegation?.implied).toBe('delegated');
  await delegationFixture(t.root, 'second'); await t.end('stop', '작업 중');
  expect((await readLedger(t.root)).filter(item => item.action === 'delegation:implied')).toHaveLength(2);
});
it('F25 PICK 후보의 사용자 대기는 거부하고 3턴 뒤 정체 판단으로 멈춘다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'PICK' });
  const task = await addTask(t.root, { title: '실행', category: 'docs' });
  await t.end('stop', '대기: 사용자');
  expect(await readState(t.root)).toMatchObject({ awaitingUser: false, autoTurns: 1 });
  expect(t.sendMessage.mock.calls[0][0].content).toContain(`[PICK 에서는 사용자를 기다리지 않는다. fodh pick 을 실행해 결과(SPEC)를 확정하라: ${task.id}]`);
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'pick:user-wait-rejected', evidence: { taskIds: [task.id] } }));
  for (let i = 0; i < 3; i++) await t.end('stop', '대기: 사용자');
  expect(t.sendMessage).toHaveBeenCalledTimes(3);
  expect((await readState(t.root)).state).toBe('WAIT_JUDGMENT');
});
it.each(['empty', 'blocked', 'done'])('F25 PICK %s는 기존 사용자 대기를 유지한다', async kind => {
  const t = await setup(); await updateState(t.root, { state: 'PICK' });
  if (kind === 'blocked') {
    const task = await addTask(t.root, { title: '차단', category: 'docs' });
    const { item } = await addJudgment(t.root, { title: '사용자 결정', background: '', options: ['진행'], recommend: '', blocks: task.id });
    await setTask(t.root, task.id, { status: `blocked(${item.id})` });
  }
  if (kind === 'done') {
    const done = await addTask(t.root, { title: '완료', category: 'docs' });
    await setTask(t.root, done.id, { status: 'done', verify: { ok: true }, review: { high: 0, commit: 'none' }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } });
  }
  await t.end('stop', '대기: 사용자');
  expect((await readState(t.root)).awaitingUser).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
});

it('R1 held 답의 자동 적용 차단·번호별 확인·다음 사용자 변경의 워처 감지 유지', async () => {
  const t = await setup(), now = Date.now(), path = join(t.root, 'docs/판단대기.md');
  const first = (await addJudgment(t.root, { title: '첫 답', background: '', options: ['진행', '다른 방식'], recommend: '', blocks: '-' })).item;
  const second = (await addJudgment(t.root, { title: '둘째 답', background: '', options: ['진행', '다른 방식'], recommend: '', blocks: '-' })).item;
  await tick(t.root, { now, judgmentOnly: true });
  const expectedHash = JSON.parse(await readFile(join(t.root, '.pi/harness-watcher.json'), 'utf8')).judgment.expectedHash;
  await updateState(t.root, { state: 'WAIT_JUDGMENT' });
  await beginJudgmentSnapshot(t.root, { runId: 'brain', startedAt: new Date(now - 1000).toISOString() });
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll(/^- 답:/gmu, '- 답: 1'));
  await finishJudgmentSnapshot(t.root);
  await utimes(path, new Date(now), new Date(now));
  await tick(t.root, { now: now + 1, judgmentOnly: true });
  const changed = await tick(t.root, { now: now + 10001, judgmentOnly: true });
  expect(changed.emitted).toHaveLength(1);
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, changed.emitted);
  expect((await applyJudgments(t.root)).applied).toEqual([]);
  expect(JSON.parse(await readFile(join(t.root, '.pi/harness-watcher.json'), 'utf8')).judgment.expectedHash).toBe(expectedHash);
  await t.command('judged', first.id);
  expect((await readJudgment(t.root)).items[0]).toMatchObject({ id: second.id, held: { reason: 'brain-turn' } });
  await writeFile(path, (await readFile(path, 'utf8')).replace('- 답: 1', '- 답: 2'));
  await utimes(path, new Date(now + 4000), new Date(now + 4000));
  await tick(t.root, { now: now + 20000, judgmentOnly: true });
  const next = await tick(t.root, { now: now + 30000, judgmentOnly: true });
  expect(next.emitted).toHaveLength(1);
  await decideInbox({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.ctx as any, t.root, next.emitted);
  expect((await readJudgment(t.root)).completed.map(item => item.id)).toEqual([first.id, second.id]);
});
it('F25 PICK의 복귀 후보도 사용자에게 떠넘기지 않는다', async () => {
  const t = await setup(), task = await addTask(t.root, { title: '복귀', category: 'docs' });
  await setTask(t.root, task.id, { status: 'doing', resume: { status: 'doing', state: 'IMPLEMENT', at: new Date().toISOString() } });
  await updateState(t.root, { state: 'PICK' });
  await t.end('stop', '대기: 사용자');
  expect((await readState(t.root)).awaitingUser).toBe(false);
  expect(t.sendMessage.mock.calls[0][0].content).toContain(task.id);
});

it.each(['seed', 'propagation'])('F26 done task는 판단 차단의 %s에서 제외한다', async kind => {
  const t = await setup();
  const upstream = kind === 'propagation' ? await addTask(t.root, { title: '판단 대기', category: 'docs' }) : undefined;
  const done = await addTask(t.root, { title: '완료된 선행 작업', category: 'docs' });
  await setTask(t.root, done.id, { status: 'done', depends: upstream ? [upstream.id] : [],
    verify: { ok: true }, review: { high: 0, commit: 'none' }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } });
  const ready = await addTask(t.root, { title: '실행 가능한 후속 작업', category: 'docs', depends: [done.id] });
  const { item } = await addJudgment(t.root, { title: '남아 있는 판단', background: '', options: ['진행'], recommend: '', blocks: upstream?.id ?? done.id });
  if (upstream) await setTask(t.root, upstream.id, { status: `blocked(${item.id})` });
  await updateState(t.root, { state: 'PICK' });
  await t.end('stop', '대기: 사용자');
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'pick:user-wait-rejected', evidence: { taskIds: [ready.id] } }));
  expect((await readState(t.root)).awaitingUser).toBe(false);
  expect(t.sendMessage).toHaveBeenCalledOnce();
});

it.each(['SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'REVIEW', 'MERGE', 'DOCS', 'CLEANUP'])('F28 %s task 진행 중 무판단 사용자 대기는 원장·재개', async state => {
  const t = await setup(), task = await addTask(t.root, { title: '진행', category: 'docs' });
  await updateState(t.root, { state, taskId: task.id });
  await t.end('stop', '대기: 사용자');
  expect(await readState(t.root)).toMatchObject({ awaitingUser: false, autoTurns: 1 });
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'turn:user-wait-rejected', evidence: { state, taskId: task.id } }));
  expect(t.sendMessage.mock.calls[0][0].content).toContain('[task 진행 중에는 사용자를 기다리지 않는다. 사용자 결정이 필요하면 fodh judgment add --title … --blocks <taskId> --reclaim 으로 등록하고(RECLAIM→PICK 으로 간다), 아니면 계속 진행하라]');
});
it.each(['blocks', 'status'])('F28 현재 task 판단 차단(%s)이 있으면 사용자 대기 유지', async kind => {
  const t = await setup(), task = await addTask(t.root, { title: '진행', category: 'docs' });
  const { item } = await addJudgment(t.root, { title: '결정', background: '', options: ['진행'], recommend: '', blocks: kind === 'blocks' ? task.id : '-' });
  if (kind === 'status') await setTask(t.root, task.id, { status: `blocked(${item.id})` });
  await updateState(t.root, { state: 'IMPLEMENT', taskId: task.id });
  await t.end('stop', '대기: 사용자');
  expect((await readState(t.root)).awaitingUser).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('F28 무판단 사용자 대기 반복은 재개 3회 뒤 정체 판단으로 멈춤', async () => {
  const t = await setup(), task = await addTask(t.root, { title: '진행', category: 'docs' });
  await updateState(t.root, { state: 'IMPLEMENT', taskId: task.id });
  for (let i = 0; i < 4; i++) await t.end('stop', '대기: 사용자');
  expect(t.sendMessage).toHaveBeenCalledTimes(3);
  expect((await readState(t.root)).state).toBe('WAIT_JUDGMENT');
  expect((await readJudgment(t.root)).items).toHaveLength(1);
});

it('S1 스냅숏은 raw 답 줄을 보존하고 기존 답 변경·새 답만 함께 held 처리', async () => {
  const t = await setup();
  const first = (await addJudgment(t.root, { title: '기존 답', background: '', options: ['진행', '보류'], recommend: '', blocks: '-' })).item;
  await answerJudgment(t.root, first.id, '1');
  await beginJudgmentSnapshot(t.root, { runId: 'content', startedAt: new Date().toISOString() });
  expect(JSON.parse(await readFile(join(t.root, '.pi/harness-judgment-snapshot.json'), 'utf8')).answers).toEqual({ [first.id]: '- 답: 1' });
  await answerJudgment(t.root, first.id, '2');
  const second = (await addJudgment(t.root, { title: '새 답', background: '', options: ['진행'], recommend: '', blocks: '-' })).item;
  await answerJudgment(t.root, second.id, '1');
  await finishJudgmentSnapshot(t.root);
  expect((await readJudgment(t.root)).items.map(item => [item.id, item.answer, item.held?.runId])).toEqual([[first.id, '2', 'content'], [second.id, '1', 'content']]);
  expect((await readLedger(t.root)).filter(entry => entry.action === 'judgment:held')).toEqual([
    expect.objectContaining({ evidence: { ids: [first.id, second.id] } }),
  ]);
});

it('S1 워처가 읽은 뒤 턴이 시작돼도 적용 잠금 안에서 재확인한다', async () => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '경합', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await answerJudgment(t.root, item.id, '1');
  const answered = (await readJudgment(t.root)).items[0];
  await beginJudgmentSnapshot(t.root, { runId: 'racing', startedAt: new Date().toISOString() });
  await expect(applyJudgments(t.root, [item.id], { [item.id]: answered.raw })).rejects.toMatchObject({ name: 'JudgmentConflict' });
  expect((await readJudgment(t.root)).completed).toEqual([]);
  await finishJudgmentSnapshot(t.root);
  await t.decide(['judgment-changed']);
  expect((await readJudgment(t.root)).completed[0].id).toBe(item.id);
});

it('N3 턴 중 무인자 적용은 변경 답을 미적용으로 남기고 종료 뒤 번호 확인', async () => {
  const t = await setup();
  const { item } = await addJudgment(t.root, { title: '진행 중 답', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await beginJudgmentSnapshot(t.root, { runId: 'active', startedAt: new Date().toISOString() });
  await answerJudgment(t.root, item.id, '1');
  expect(await applyJudgments(t.root)).toMatchObject({ applied: [], unapplied: [{ id: item.id, reason: '두뇌 턴 진행 중(턴 종료 뒤 held 로 확인)' }] });
  await t.command('judged');
  expect((await readJudgment(t.root)).items[0].id).toBe(item.id);
  await finishJudgmentSnapshot(t.root);
  expect((await readJudgment(t.root)).items[0].held?.runId).toBe('active');
  await t.command('judged', item.id);
  expect((await readJudgment(t.root)).completed[0].id).toBe(item.id);
});
it('N3 턴 중에도 번호 명시 적용과 턴 전의 무변경 답 적용은 유지', async () => {
  const t = await setup();
  const a = (await addJudgment(t.root, { title: '기존 답', background: '', options: ['진행'], recommend: '', blocks: '-' })).item;
  const b = (await addJudgment(t.root, { title: '새 답', background: '', options: ['진행'], recommend: '', blocks: '-' })).item;
  await answerJudgment(t.root, a.id, '1');
  await beginJudgmentSnapshot(t.root, { runId: 'active', startedAt: new Date().toISOString() });
  await answerJudgment(t.root, b.id, '1');
  expect((await applyJudgments(t.root)).applied.map(item => item.id)).toEqual([a.id]);
  expect((await applyJudgments(t.root, [b.id])).applied.map(item => item.id)).toEqual([b.id]);
  await finishJudgmentSnapshot(t.root);
});
it.each(['IMPLEMENT', 'PICK'])('N4 사용자 입력 %s 대기는 수용하고 턴 표지를 지운다', async state => {
  const t = await setup(), task = await addTask(t.root, { title: '작업', category: 'docs' });
  await updateState(t.root, { state, taskId: task.id });
  await t.handlers.get('input')!({ source: 'interactive', text: '잠깐' }, t.ctx);
  expect((await readState(t.root)).userHold).toBe(true);
  await t.end('stop', '대기: 사용자');
  expect(await readState(t.root)).toMatchObject({ awaitingUser: true, userHold: false });
  expect(t.sendMessage).not.toHaveBeenCalled();
  expect((await readLedger(t.root)).filter(e => e.action === 'turn:user-wait-accepted')).toEqual([
    expect.objectContaining({ evidence: { state, taskId: task.id, hold: 'input' } }),
  ]);
});
it('M2 /hold 뒤 extension 턴은 명시적 대기를 수락한다', async () => {
  const t = await setup(), task = await addTask(t.root, { title: '작업', category: 'docs' });
  await updateState(t.root, { state: 'IMPLEMENT', taskId: task.id });
  await t.command('hold');
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('다음 두뇌 턴의 대기: 사용자 를 받습니다', 'info');
  await t.handlers.get('input')!({ source: 'extension', text: '자동' }, t.ctx);
  await t.end('stop', '대기: 사용자');
  expect(await readState(t.root)).toMatchObject({ awaitingUser: true, userHold: false });
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'turn:user-wait-accepted', evidence: { state: 'IMPLEMENT', taskId: task.id, hold: 'command' } }));
});
it.each([['IMPLEMENT', '진행해', 'turn:user-wait-rejected'], ['PICK', '계속', 'pick:user-wait-rejected']])('M2 %s 진행 넛지 %s는 무판단 대기를 거부한다', async (state, text, action) => {
  const t = await setup(), task = await addTask(t.root, { title: '작업', category: 'docs' });
  await updateState(t.root, { state, taskId: task.id });
  await t.handlers.get('input')!({ source: 'interactive', text }, t.ctx);
  await t.end('stop', '대기: 사용자');
  expect((await readState(t.root)).awaitingUser).toBe(false);
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action }));
  expect(t.sendMessage).toHaveBeenCalled();
});
it.each(['잠깐 멈춰, 내가 확인할게', '진행해, 잠깐 확인하고', 'WAIT', 'pause please'])('M2 멈춤 어휘 %s는 진행보다 우선한다', async text => {
  const t = await setup(); await updateState(t.root, { state: 'IMPLEMENT', taskId: 'T01' });
  await t.handlers.get('input')!({ source: 'interactive', text }, t.ctx);
  await t.end('stop', '대기: 사용자');
  expect(await readState(t.root)).toMatchObject({ awaitingUser: true, userHold: false });
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'turn:user-wait-accepted', evidence: { state: 'IMPLEMENT', taskId: 'T01', hold: 'input' } }));
});
it('M2 다음 입력은 잔존 hold를 지우고 정상 종료도 hold를 소비한다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'PROJECT_READY' });
  await t.command('hold');
  await t.handlers.get('input')!({ source: 'interactive', text: 'go' }, t.ctx);
  expect((await readState(t.root)).userHold).toBe(false);
  await t.command('hold'); await t.end('stop', '대기: 없음');
  expect((await readState(t.root)).userHold).toBe(false);
  expect((await readLedger(t.root)).some(e => e.action === 'turn:user-wait-accepted')).toBe(false);
});
it.each(['error', 'aborted'])('N4 %s로 끝나도 userHold 잔존 없음', async stop => {
  const t = await setup(); await t.handlers.get('input')!({ source: 'interactive', text: '멈춰' }, t.ctx);
  await t.end(stop);
  expect((await readState(t.root)).userHold).toBe(false);
});

it('참고 무인자 /judged 검사 직후 held가 생겨도 해제하지 않는다', async () => {
  const t = await setup();
  const {item} = await addJudgment(t.root,{title:'경합',background:'',options:['진행'],recommend:'',blocks:'-'});
  await beginJudgmentSnapshot(t.root,{runId:'racing',startedAt:new Date().toISOString()});
  await answerJudgment(t.root,item.id,'1');
  const apply = judgmentModule.applyJudgments;
  vi.spyOn(judgmentModule,'applyJudgments').mockImplementationOnce(async (...args) => {
    await finishJudgmentSnapshot(t.root);
    return apply(...args);
  });
  await t.command('judged');
  expect((await readJudgment(t.root)).items[0]).toMatchObject({id:item.id,held:{runId:'racing'}});
  expect((await readJudgment(t.root)).completed).toEqual([]);
  await t.command('judged',item.id);
  expect((await readJudgment(t.root)).completed[0].id).toBe(item.id);
});

it.each([true, false])('P8 recovering 수동 develop-start는 자동 재개 한도=%s와 무관하게 복구 턴만 시작', async recoveryAutoResumed => {
  const t = await setup();
  await updateState(t.root, { state: 'recovering', userAborted: true, awaitingUser: true, autoTurns: 3, recoveryAutoResumed });
  await updateState(t.root, { recoveryAutoResumed });
  const beforeLedger = await readLedger(t.root);
  await appendLedger(t.root, { runId: 'unfinished', action: 'fixture', status: 'unknown' });
  await t.command('develop-start');
  expect(await readState(t.root)).toMatchObject({ state: 'recovering', userAborted: false, awaitingUser: false, autoTurns: 0, recoveryAutoResumed });
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect(t.sendMessage.mock.calls[0][0].content).toContain('# recovering');
  expect((await readLedger(t.root)).filter(entry => entry.action.startsWith('state:'))).toEqual(beforeLedger.filter(entry => entry.action.startsWith('state:')));
});
it.each(['recover', 'stalled'])('P8 %s 안내는 상태와 답 존재에 맞는 명령만 표시', async kind => {
  for (const state of ['recovering', 'IMPLEMENT', 'IDLE']) for (const answered of [false, true]) {
    const t = await setup();
    await updateState(t.root, { state, awaitingUser: true, userAborted: true });
    const { item } = await addJudgment(t.root, { title: '결정', background: '', options: ['진행'], recommend: '', blocks: '-' });
    if (answered) await answerJudgment(t.root, item.id, '1');
    t.ctx.ui.notify.mockClear(); await t.decide([kind]);
    const message = t.ctx.ui.notify.mock.calls.map(([message]) => message).join('\n');
    expect(message.includes('/develop-start')).toBe(state !== 'IMPLEMENT');
    expect(message.includes('복구 턴')).toBe(state === 'recovering');
    expect(message.includes('/judged <번호>')).toBe(answered);
    expect(t.sendMessage).not.toHaveBeenCalled();
  }
});

it.each([false, true])('A16 agent_end는 idle=%s에서도 followUp 재개 1회', async idle => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  t.ctx.isIdle.mockReturnValue(idle);
  await t.end();
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect(t.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'harness-orchestrator' }), { triggerTurn: true, deliverAs: 'followUp' });
  expect((await readState(t.root)).autoTurns).toBe(1);
});
it('A16 agent_end의 큐 입력은 pending-input 원장, 자동 재개 없음', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  t.ctx.isIdle.mockReturnValue(false); t.ctx.hasPendingMessages.mockReturnValue(true);
  await t.end();
  expect(t.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).autoTurns).toBe(0);
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'orchestrator:resume', status: 'skip', evidence: { reason: 'agent_end', skipped: 'pending-input' } }));
});
it.each([1, 2, 3])('A16 agent_end 큐 입력 검사 %s번째에서 멈춰도 카운터를 보존한다', async check => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  const { autoResume, resumeContext } = await import('../extensions/orchestrator/resume.ts');
  let n = 0; t.ctx.hasPendingMessages.mockImplementation(() => ++n >= check);
  t.ctx.isIdle.mockReturnValue(false);
  expect(await autoResume({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.root, resumeContext(t.ctx as any), 'agent_end')).toEqual({ skipped: 'pending-input' });
  expect(t.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).autoTurns).toBe(0);
});
it.each(['stalled', 'judgment-changed', 'codex-done', 'slot-free', 'recover'])('A16 워처 %s는 active run을 여전히 busy로 거부한다', async reason => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  const { autoResume, resumeContext } = await import('../extensions/orchestrator/resume.ts');
  t.ctx.isIdle.mockReturnValue(false);
  expect(await autoResume({ sendMessage: t.sendMessage } as unknown as ExtensionAPI, t.root, resumeContext(t.ctx as any), reason)).toEqual({ skipped: 'busy' });
  expect(t.sendMessage).not.toHaveBeenCalled();
});

it.each([1, 2, 3])('A16 보정 1: agent_end의 %s번째 검사에서 Esc면 전송·카운터 증가 없이 userAborted', async check => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  const controller = new AbortController(); let reads = 0;
  if (check === 1) controller.abort();
  t.ctx.isIdle.mockReturnValue(false);
  Object.defineProperty(t.ctx, 'signal', { get: () => {
    if (++reads === check) controller.abort();
    return controller.signal;
  } });
  await t.end();
  expect(t.sendMessage).not.toHaveBeenCalled();
  expect(await readState(t.root)).toMatchObject({ autoTurns: 0, userAborted: true });
});
it('A16 보정 1: agent_end 처리 중 새 /hold는 finally 뒤에도 보존한다', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  const original = configModule.getConfig;
  vi.spyOn(configModule, 'getConfig').mockImplementationOnce(async (...args) => {
    await t.command('hold'); return original(...args);
  });
  await t.end();
  expect(await readState(t.root)).toMatchObject({ userHold: true, userHoldSource: 'command' });
});
it.each(['none', 'open', 'pending'])('F34 RECLAIM %s 판단은 사용자 대기를 거부하고 정식 회수를 안내한다', async mode => {
  const t = await setup(), task = await addTask(t.root, { title: '회수 대상', category: 'docs' });
  const first = mode === 'none' ? undefined : (await addJudgment(t.root, { title: '판단', background: '', options: ['진행'], recommend: '1', blocks: task.id })).item;
  const retry = mode === 'pending' ? (await addJudgment(t.root, { title: '회수 재시도', background: '', options: ['진행'], recommend: '1', blocks: task.id })).item : undefined;
  const judgment = retry?.id ?? first?.id;
  await updateState(t.root, { state: 'RECLAIM', taskId: task.id, ...(retry ? { pendingReclaim: { taskId: task.id, judgmentId: retry.id } } : {}) });
  t.ctx.isIdle.mockReturnValue(false);
  await t.end('stop', '대기: 사용자');
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect(t.sendMessage.mock.calls[0][0].content).toContain(judgment
    ? `[RECLAIM 에서는 기다리지 않는다. fodh reclaim --task ${task.id} --judgment ${judgment} 를 실행하라]`
    : `[RECLAIM 에서는 기다리지 않는다. fodh judgment add --blocks ${task.id} --reclaim 으로 판단을 등록하라]`);
  expect(await readState(t.root)).toMatchObject({ awaitingUser: false, autoTurns: 1 });
  expect(await readLedger(t.root)).toContainEqual(expect.objectContaining({ action: 'turn:user-wait-rejected', evidence: { state: 'RECLAIM', taskId: task.id, judgment: judgment ?? null } }));
});
it('F34 RECLAIM 대기 반복은 3회 재개 뒤 기존 정체 안전망으로 멈춘다', async () => {
  const t = await setup(), task = await addTask(t.root, { title: '회수 대상', category: 'docs' });
  await updateState(t.root, { state: 'RECLAIM', taskId: task.id });
  t.ctx.isIdle.mockReturnValue(false);
  for (let n = 0; n < 4; n++) await t.end('stop', '대기: 사용자');
  expect(t.sendMessage).toHaveBeenCalledTimes(3);
  expect((await readState(t.root)).state).toBe('WAIT_JUDGMENT');
  expect((await readJudgment(t.root)).items).toContainEqual(expect.objectContaining({ title: `진행 정체: RECLAIM/${task.id}` }));
});
it.each(['command', 'input'])('F34 RECLAIM에서도 M2 명시적 %s 멈춤은 먼저 수락한다', async source => {
  const t = await setup(), task = await addTask(t.root, { title: '회수 대상', category: 'docs' });
  await updateState(t.root, { state: 'RECLAIM', taskId: task.id });
  if (source === 'command') await t.command('hold');
  else await t.handlers.get('input')!({ source: 'interactive', text: '잠깐 멈춰' }, t.ctx);
  await t.end('stop', '대기: 사용자');
  expect(t.sendMessage).not.toHaveBeenCalled();
  expect(await readState(t.root)).toMatchObject({ awaitingUser: true, userHold: false });
});

it('A14-d 2회차 result 표시 줄을 제외한 위임 표식은 implied 없이 인식한다', async () => {
  const t = await setup(); await delegationFixture(t.root, 'X');
  await updateState(t.root, { state: 'IMPLEMENT' });
  await t.end('stop', '완료한 작업\n대기: 위임 X\n상태: IMPLEMENT\n[훅 차단] 승인 필요: 판단대기 항목을 확인하세요.\n\n— 도구 3회 · 보조 에이전트 0개 · 1초 · 훅 차단 1건');
  expect(await readState(t.root)).toMatchObject({ awaitingDelegation: true, state: 'IMPLEMENT' });
  expect((await readLedger(t.root)).filter(entry => entry.action === 'delegation:implied')).toHaveLength(0);
  expect(t.sendMessage).not.toHaveBeenCalled();
});
it('A14-d 2회차 result 표시 줄이 있어도 사용자 대기 표식 유지', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  await t.end('stop', '질문\n대기: 사용자\n상태: INTERVIEW\n[훅 차단] 보호: 이 동작은 포기하세요.\n— 도구 1회 · 보조 에이전트 0개 · 1초');
  expect((await readState(t.root)).awaitingUser).toBe(true); expect(t.sendMessage).not.toHaveBeenCalled();
});
