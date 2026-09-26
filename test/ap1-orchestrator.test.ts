import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { project, cli } from './p5-helpers.ts';
import orchestrator, { runAutopilot, applyAndResume, decideInbox, instruction } from '../extensions/orchestrator/index.ts';
import { resumeContext } from '../extensions/orchestrator/resume.ts';
import { autopilotOn, autopilotOff, readAutopilot, autopilotChat } from '../src/core/autopilot.ts';
import { addJudgment, readJudgment, answerJudgment } from '../src/core/judgment.ts';
import { readState, updateState, stopForJudgment } from '../src/core/state.ts';
import { addTask, getTask } from '../src/core/backlog.ts';
import { runPick } from '../src/core/pick.ts';
import { setConfig } from '../src/core/config.ts';
import { addInbox } from '../src/core/inbox.ts';
import { runTurn } from '../src/provider/turn.ts';
import * as runner from '../src/provider/runner.ts';
import { substitute, todayKst } from '../src/core/template-values.ts';
import { readLedger } from '../src/core/ledger.ts';
// Same fake Pi registration/event pattern as orchestrator.test.ts; no model is run.
async function setup(state = 'PLANNING') {
  const root = await project(state); let time = Date.parse('2026-09-27T00:00:00Z');
  const now = () => new Date(time);
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const sendMessage = vi.fn();
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage } as unknown as ExtensionAPI;
  const ctx = { cwd: root, hasUI: true, isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), ui: { notify: vi.fn(), setStatus: vi.fn() } };
  orchestrator(pi, { now });
  return { root, now, pi, ctx, sendMessage, advance: () => { time += 30000; },
    tick: () => runAutopilot(pi, ctx as unknown as ExtensionContext, root, now),
    command: (name: string, args = '') => commands.get(name)!.handler(args, ctx),
    end: (text = '대기: 사용자', stopReason = 'stop') => handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason, content: [{ type: 'text', text }] }] }, ctx) };
}
const input = { title: '색상 선택', background: '', options: ['파랑', '초록'], recommend: '① 파랑', blocks: '-', origin: { kind: 'brain' as const } };
it('PLANNING의 실제 phase=task에서도 2회 회신, 세 번째 대기, 진척 후 초기화', async () => {
  const t = await setup(); await updateState(t.root, { phase: 'task' }); await autopilotOn(t.root, { now: t.now() });
  await t.end(); await t.end(); await t.end();
  expect(t.sendMessage).toHaveBeenCalledTimes(2);
  expect(t.sendMessage.mock.calls[0][0].content).toContain('--source default');
  expect((await readState(t.root)).awaitingUser).toBe(true);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('오토파일럿: 두뇌가 사용자 답을 계속 기다립니다', 'warning');
  expect((await readAutopilot(t.root)).chat?.count).toBe(2);
  await updateState(t.root, { state: 'ARCH', phase: 'project', awaitingUser: false }); await t.end();
  expect(t.sendMessage).toHaveBeenCalledTimes(3); expect((await readAutopilot(t.root)).chat?.count).toBe(1);
});
it.each(['RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PLANNING'])('기획 자동 회신 %s', async state => {
  const t = await setup(state); await autopilotOn(t.root, { now: t.now() }); await t.end();
  expect(t.sendMessage.mock.calls[0][0].content).toContain('[오토파일럿]');
});
it.each([false, true])('INTERVIEW 옵트인 %s', async interview => {
  const t = await setup('INTERVIEW'); await autopilotOn(t.root, { now: t.now(), interview }); await t.end();
  expect(t.sendMessage).toHaveBeenCalledTimes(interview ? 1 : 0);
});
it.each(['SPEC', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'PICK', 'PROJECT_READY', 'WAIT_JUDGMENT', 'RECLAIM'])('채팅 자동 회신 제외 %s', async state => {
  const t = await setup(state); await updateState(t.root, { phase: 'task', taskId: state === 'REVIEW' ? 'T01' : undefined });
  await autopilotOn(t.root, { now: t.now() }); const send = vi.fn(async () => true);
  expect(await autopilotChat(t.root, t.now(), send)).toBe('skip'); expect(send).not.toHaveBeenCalled();
});
it.each(['hold', 'aborted', 'headless', 'pending', 'eligible'])('agent_end 자동 회신 안전 조건 %s', async mode => {
  const t = await setup(); await autopilotOn(t.root, { now: t.now() });
  if (mode === 'hold') await updateState(t.root, { userHold: true });
  if (mode === 'aborted') await updateState(t.root, { userAborted: true });
  if (mode === 'headless') t.ctx.hasUI = false;
  if (mode === 'pending') t.ctx.hasPendingMessages.mockReturnValue(true);
  if (mode === 'eligible') await addJudgment(t.root, input);
  await t.end(); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('판단 적용으로 chat 계수 초기화, decideInbox도 공용 경로 사용', async () => {
  const t = await setup(); await autopilotOn(t.root, { now: t.now() }); await t.end(); await t.end();
  const { item } = await addJudgment(t.root, input); await answerJudgment(t.root, item.id, '1');
  const record = await addInbox(t.root, { kind: 'judgment-changed' });
  expect(await decideInbox(t.pi, t.ctx as unknown as ExtensionContext, t.root, [record])).toEqual({ deferred: [] });
  expect((await readAutopilot(t.root)).chat?.count).toBe(0);
  expect((await readState(t.root)).awaitingUser).toBe(false);
});
it.each(['tick', 'on'])('PROJECT_READY 자동 개발 시작 %s', async mode => {
  const t = await setup('PROJECT_READY'); await updateState(t.root, { awaitingUser: true });
  if (mode === 'on') await t.command('autopilot', 'on --for 8h --max 10');
  else { await autopilotOn(t.root, { now: t.now() }); await t.tick(); }
  expect(await readState(t.root)).toMatchObject({ state: 'PLANNING', awaitingUser: false });
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('오토파일럿: 기획 완료 → 개발 시작', 'info');
  expect(t.ctx.ui.setStatus).toHaveBeenLastCalledWith('fodh-autopilot', mode === 'on' ? '오토 0/10' : '오토 0/30');
  await t.command('autopilot', 'off'); expect(t.ctx.ui.setStatus).toHaveBeenLastCalledWith('fodh-autopilot', undefined);
});
it.each(['userHold', 'userAborted'])('PROJECT_READY 명시적 중단 %s', async field => {
  const t = await setup('PROJECT_READY'); await updateState(t.root, { [field]: true }); await t.command('autopilot', 'on');
  expect((await readState(t.root)).state).toBe('PROJECT_READY'); expect(t.sendMessage).not.toHaveBeenCalled();
});
it('DONE_ALL 알림 한 번, 진행하지 않는다', async () => {
  const t = await setup('DONE_ALL'); await autopilotOn(t.root, { now: t.now() }); await t.tick(); t.advance(); await t.tick();
  expect(t.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).state).toBe('DONE_ALL');
  expect((await readLedger(t.root)).filter(e => e.action === 'notify:autopilot:done-all')).toHaveLength(1);
});
it('instruction 꺼짐 바이트 회귀, 켜면 정확히 한 줄 추가', async () => {
  const t = await setup('ARCH'); const state = await readState(t.root);
  const base = substitute(await readFile('templates/prompts/ARCH.md', 'utf8'), { docsRoot: 'docs', today: todayKst(), interviewSummary: '', taskId: '', judgmentFile: 'docs/판단대기.md', backlogFile: 'docs/backlog.md' }, false);
  expect(await instruction(t.root, state)).toBe(base);
  await autopilotOn(t.root, { now: t.now() }); expect((await instruction(t.root, state)).split('\n').slice(1).join('\n')).toBe(base);
  await autopilotOff(t.root); expect(await instruction(t.root, state)).toBe(base);
});
it('꺼짐 answerJudgment 옵션 없음과 CLI add 출력·판단 파일·판단기록 바이트 회귀', async () => {
  const t = await setup('ARCH'), other = await project('ARCH');
  const args = ['judgment', 'add', '--title', '색상', '--background', '', '--options', '파랑|초록', '--recommend', '① 파랑', '--blocks', '-'];
  const cliResult = await cli(t.root, args);
  const plain = await addJudgment(other, { title: '색상', background: '', options: ['파랑', '초록'], recommend: '① 파랑', blocks: '-', dedupeKey: JSON.stringify(['색상', '-']) });
  expect(JSON.stringify(cliResult.value)).toBe(JSON.stringify(plain));
  const before = plain.item.raw;
  const expectedRaw = before.replace(/^- 답:[^\r\n]*$/mu, '- 답: 1').trimEnd() + '\n- 답 기준 rev: 1\n\n';
  const answered = await answerJudgment(t.root, 'A1', '1'); expect(answered.item.raw).toBe(expectedRaw);
  await answerJudgment(other, 'A1', '1');
  expect(await readFile(join(t.root, 'docs/판단대기.md'), 'utf8')).toBe(await readFile(join(other, 'docs/판단대기.md'), 'utf8'));
  const expected = { A1: answered.item.raw };
  await applyAndResume(t.pi, resumeContext(t.ctx as unknown as ExtensionContext), t.root, ['A1'], expected, 'judgment-changed');
  await applyAndResume(t.pi, resumeContext({ ...t.ctx, cwd: other } as unknown as ExtensionContext), other, ['A1'], expected, 'judgment-changed');
  const a = (await readJudgment(t.root)).completed[0], b = (await readJudgment(other)).completed[0];
  expect(await readFile(join(t.root, 'docs', a.path!), 'utf8')).toBe(await readFile(join(other, 'docs', b.path!), 'utf8'));
});
it('가짜 두뇌 turn의 judgment add --reclaim → 유예 → 적용·awaitingUser 해제 → PICK 재선택', async () => {
  const t = await setup('SPEC'); const task = await addTask(t.root, { title: '화면', category: 'docs' });
  await updateState(t.root, { state: 'SPEC', taskId: task.id, phase: 'task' });
  await mkdir(join(t.root, '.claude')); await writeFile(join(t.root, '.claude/settings.json'), '{}');
  await autopilotOn(t.root, { now: t.now() });
  // Reuse p7-turn's fake runner event contract; execute the real CLI from its tool turn.
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', permissionMode: 'bypassPermissions', model: 'claude-fable-5-1' });
    vi.stubEnv('FODH_BRAIN', '1');
    try { expect(await cli(t.root, ['judgment', 'add', '--title', '색상', '--background', '화면', '--options', '파랑|초록', '--recommend', '① 파랑', '--blocks', task.id, '--reclaim'])).toMatchObject({ code: 0, value: { reclaimed: true } }); }
    finally { vi.unstubAllEnvs(); }
    await options.onEvent?.({ type: 'assistant', message: { content: [{ type: 'text', text: '대기: 사용자\n상태: PICK' }] } });
    await options.onEvent?.({ type: 'result', is_error: false });
    return { code: 0, cleaned: true, stderr: '' };
  });
  expect((await runTurn('fixture', { root: t.root, env: { HOME: t.root } })).reason).toBe('stop');
  await t.end('대기: 사용자\n상태: PICK');
  expect((await readState(t.root)).awaitingUser).toBe(true);
  expect((await getTask(t.root, task.id)).status).toBe('blocked(A1)');
  t.advance(); await t.tick();
  expect((await readState(t.root)).awaitingUser).toBe(false);
  expect(t.sendMessage).toHaveBeenCalledTimes(1);
  expect((await runPick(t.root)).task?.id).toBe(task.id);
  expect((await readJudgment(t.root)).completed[0].answerSource).toBe('오토파일럿');
});
it('task 정체도 같은 scope에서 한 번만 재개', async () => {
  const t = await setup('SPEC'); const task = await addTask(t.root, { title: '화면', category: 'docs' });
  await updateState(t.root, { taskId: task.id, phase: 'task' }); await autopilotOn(t.root, { now: t.now() });
  await stopForJudgment(t.root); await t.tick(); t.advance(); await t.tick(); await runPick(t.root);
  await stopForJudgment(t.root); await t.tick(); t.advance(); await t.tick();
  expect((await readAutopilot(t.root)).stallResumed).toEqual({ [`SPEC:task:${task.id}`]: true });
  expect((await readJudgment(t.root)).items[0].answer).toBe('');
});
it('CLI 판단 적용도 chat 진척으로 인식, maxChatReplies=0은 회신하지 않는다', async () => {
  const t = await setup(); await autopilotOn(t.root, { now: t.now() }); await t.end(); await t.end();
  const { item } = await addJudgment(t.root, input); await answerJudgment(t.root, item.id, '1');
  expect((await cli(t.root, ['judgment', 'apply', item.id])).code).toBe(0);
  await t.end(); expect((await readAutopilot(t.root)).chat?.count).toBe(1);
  await setConfig(t.root, 'autopilot.maxChatReplies', '0'); t.sendMessage.mockClear(); await t.end();
  expect(t.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).awaitingUser).toBe(true);
});
it('전송 실패는 chat 회수를 소비하지 않는다', async () => {
  const t = await setup(); await autopilotOn(t.root, { now: t.now() }); t.sendMessage.mockImplementation(() => { throw new Error('disposed'); });
  await t.end(); expect((await readAutopilot(t.root)).chat?.count).toBe(0);
  expect((await readState(t.root)).awaitingUser).toBe(true);
});

it('검수 L2: Pi off는 미적용 자동 답 경고와 JSON을 표시', async () => {
  const t = await setup('ARCH'); await setConfig(t.root, 'notify.channels', '["tui"]');
  await autopilotOn(t.root, { now: t.now() }); await addJudgment(t.root, input);
  await answerJudgment(t.root, 'A1', '1', { source: 'autopilot' });
  await t.command('autopilot', 'off');
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('오토파일럿이 꺼졌습니다 — A1 는 자동 답이 적혀 있지만 아직 적용되지 않았습니다. 확인 뒤 /judged A1 또는 답을 고치세요', 'warning');
  const result = JSON.parse(t.ctx.ui.notify.mock.calls.find(call => call[0].startsWith('{'))![0]);
  expect(result).toMatchObject({ enabled: false, unappliedAutoAnswers: ['A1'] });
});
