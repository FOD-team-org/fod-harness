import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTurn } from '../src/provider/turn.ts';
import { TurnDisplay } from '../src/provider/display.ts';
import { streamClaude } from '../extensions/provider/stream.ts';
import { loadConfig, setConfig } from '../src/core/config.ts';
import { main } from '../src/cli/index.ts';
import { childEnv } from '../src/provider/runner.ts';
import { readLedger } from '../src/core/ledger.ts';
import type { Model } from '@earendil-works/pi-ai';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const model = { id: 'haiku', api: 'claude-code', provider: 'claude-code' } as Model<any>;
async function setup(scenario = 'normal') {
  const root = await mkdtemp('/private/tmp/fodh-a14d-output-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  const script = join(root, 'fake.mjs');
  await writeFile(script, `const args = process.argv; const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
for await (const _ of process.stdin) {}
const emit = event => process.stdout.write(JSON.stringify({ parent_tool_use_id: null, ...event }) + '\\n');
const init = () => emit({type:'system',subtype:'init',session_id:sid,model:'claude-haiku-4-5-20251001',permissionMode:'bypassPermissions',apiKeySource:'none'});
const assistant = (content, parent = null) => emit({type:'assistant',parent_tool_use_id:parent,message:{content}});
const text = value => ({type:'text',text:value});
const tool = (id,name,input) => ({type:'tool_use',id,name,input});
const result = (id,content,parent = null,error = false) => emit({type:'user',parent_tool_use_id:parent,message:{content:[{type:'tool_result',tool_use_id:id,content,is_error:error}]}});
init();
assistant([tool('agent','Agent',{description:'파일 목록 확인',prompt:'내부 프롬프트'})]);
emit({type:'system',subtype:'task_started',task_id:'t1',tool_use_id:'agent',description:'보조',subagent_type:'Explore',is_backgrounded:true});
result('agent','launched');
assistant([tool('sub','Bash',{command:'echo * \\\\ '+String.fromCharCode(96).repeat(3)}),text('보조 텍스트')],'agent');
result('sub','보조 결과 '+String.fromCharCode(96).repeat(3),'agent');
emit({type:'system',subtype:'task_progress',task_id:'t1',usage:{tool_uses:1},last_tool_name:'Bash'});
assistant([text('Agent launched. Waiting…')]);
${scenario === 'normal' || scenario === 'deny' ? "emit({type:'result',result:'Agent launched. Waiting for it to complete.',is_error:false});" : ''}
emit({type:'system',subtype:'task_updated',task_id:'t1',patch:{status:'completed'}});
emit({type:'system',subtype:'task_notification',task_id:'t1',status:'completed',summary:'done'});
init();
${scenario === 'deny' ? "assistant([tool('deny','Write',{file_path:'src/a.ts',content:'x'})]); result('deny','PreToolUse hook error: [경계] blocked',null,true); result('deny','PreToolUse hook error: [경계] blocked',null,true);" : ''}
emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'중간 델타'}}});
assistant([text('최종 메인 본문'),text('두 번째 블록')]);
assistant([text('마지막 보조 본문')],'agent');
${scenario === 'normal' || scenario === 'deny' ? "emit({type:'result',result:'최종 결과',is_error:false}); await new Promise(r => setTimeout(r,1200));" : scenario === 'abort' ? 'setInterval(() => {},1000);' : 'process.exitCode = 1;'}
`);
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: { command: [process.execPath, script], model: 'haiku', allowedModels: ['haiku'], maxTurnMinutes: 0.1 } }));
  return { root, env: { ...childEnv(), HOME: root } };
}
it('실측 백그라운드 순서: onText 한 번·마지막 result·진행 보조 1/1·원장 유지', async () => {
  const options = await setup(), onText = vi.fn(), onProgress = vi.fn();
  expect(await runTurn('시험', { ...options, display: 'result', onText, onProgress })).toMatchObject({ reason: 'stop' });
  expect(onText).toHaveBeenCalledOnce(); const text = onText.mock.calls[0][0];
  expect(text).toMatch(/^최종 결과\n\n— 도구 1회 · 보조 에이전트 1개 ·/u);
  for (const hidden of ['[tool]', '[도구 결과]', 'Agent launched', '보조 본문', '중간 델타']) expect(text).not.toContain(hidden);
  expect(onProgress.mock.calls.some(([line]) => /도구 1 · 보조 1\/1 · 보조 도구 1/u.test(line))).toBe(true);
  expect((await readLedger(options.root)).filter(entry => entry.action.startsWith('tool_result:'))).toHaveLength(2);
});
it('훅 차단 문구 중복 제거·본문 뒤 1회·끝줄 N건, 원장 유지', async () => {
  const options = await setup('deny'), onText = vi.fn();
  await runTurn('시험', { ...options, display: 'result', onText });
  expect(onText).toHaveBeenCalledOnce(); const text = onText.mock.calls[0][0];
  expect(text.match(/\[훅 차단\]/gu)).toHaveLength(1); expect(text).toContain('· 훅 차단 1건');
  expect(text.indexOf('[훅 차단]')).toBeGreaterThan(text.indexOf('최종 결과'));
  expect((await readLedger(options.root)).some(entry => entry.action.startsWith('hook:boundary:'))).toBe(true);
});
it.each(['error', 'abort'])('%s 시 마지막 메인 메시지와 중단 분류', async scenario => {
  const options = await setup(scenario), onText = vi.fn(), controller = new AbortController();
  const result = await runTurn('시험', { ...options, display: 'result', onText, signal: controller.signal,
    onProgress: line => { if (scenario === 'abort' && line.includes('보조 1/1')) controller.abort(); } });
  expect(result.reason).toBe(scenario === 'error' ? 'error' : 'aborted');
  expect(onText).toHaveBeenCalledOnce(); expect(onText.mock.calls[0][0]).toContain('최종 메인 본문\n두 번째 블록');
  expect(onText.mock.calls[0][0]).not.toContain('마지막 보조 본문'); expect(onText.mock.calls[0][0]).toContain(`중단: ${result.classification}`);
});
it('사전 설정 오류도 반환 직전 한 번 요약', async () => {
  const options = await setup(), onText = vi.fn(); await rm(join(options.root, '.claude/settings.json'));
  await expect(runTurn('시험', { ...options, display: 'result', onText })).rejects.toThrow('configError');
  expect(onText).toHaveBeenCalledOnce(); expect(onText.mock.calls[0][0]).toContain('중단: configError');
});
it('display 생략은 full: 보조 접두어·백틱보다 긴 펜스·명령 보존', async () => {
  const options = await setup(), onText = vi.fn(); await runTurn('시험', { ...options, onText });
  const text = onText.mock.calls.map(([value]) => value).join('');
  expect(text).toContain('↳ 보조 텍스트'); expect(text).toContain('\n````\n↳ [tool] Bash:');
  expect(text).toContain('\n````\n↳ [도구 결과] 보조 결과 ```\n````\n'); expect(text).toContain('echo *');
});
it('provider result text_delta 1회·작업 메시지 설정/복원·다음 턴 설정 재로드', async () => {
  const options = await setup(), setWorkingMessage = vi.fn();
  const stream = streamClaude(model, { messages: [] }, undefined, { ...options, ui: { setWorkingMessage } });
  const events = []; for await (const event of stream) events.push(event);
  expect(events.filter(event => event.type === 'text_delta')).toHaveLength(1);
  expect(setWorkingMessage.mock.calls.some(([line]) => line?.startsWith('작업 중'))).toBe(true);
  expect(setWorkingMessage.mock.calls.at(-1)).toEqual([undefined]);
  await setConfig(options.root, 'ui.brainOutput', 'full'); setWorkingMessage.mockClear();
  const full = streamClaude(model, { messages: [] }, undefined, { ...options, ui: { setWorkingMessage } });
  const next = []; for await (const event of full) next.push(event);
  expect(next.filter(event => event.type === 'text_delta').length).toBeGreaterThan(1); expect(setWorkingMessage).not.toHaveBeenCalled();
});
it('disposed UI 예외도 정상 결과·복원', async () => {
  const options = await setup(); const ui = { setWorkingMessage: vi.fn(() => { throw new Error('disposed'); }) };
  const stream = streamClaude(model, { messages: [] }, undefined, { ...options, ui });
  for await (const _ of stream) {}
  expect((await stream.result()).stopReason).toBe('stop'); expect(ui.setWorkingMessage.mock.calls.at(-1)).toEqual([undefined]);
});
it('설정 기본 result·허용값·잘못된 값 거부·CLI 승인 없이 변경', async () => {
  const { root } = await setup(); expect((await loadConfig(root)).ui.brainOutput).toBe('result');
  for (const value of ['full', 'result']) {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try { await main(['config', 'set', 'ui.brainOutput', value], root); expect(process.exitCode ?? 0).toBe(0); } finally { write.mockRestore(); }
    expect((await loadConfig(root)).ui.brainOutput).toBe(value);
  }
  for (const value of ['verbose', 'null', 'false', '1']) await expect(setConfig(root, 'ui.brainOutput', value)).rejects.toThrow('ui.brainOutput');
});
it('진행 throttle 1초·경과 5초·fallback Agent/Task·완료 중복·타이머 해제·redact', () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const text = vi.fn(), progress = vi.fn(); const display = new TurnDisplay('result', text, progress);
  const assistant = (id: string, name: string) => display.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { description: 'x'.repeat(80) } }] } });
  assistant('a', 'Agent'); assistant('b', 'Task'); expect(progress).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(999); expect(progress).toHaveBeenCalledTimes(1); vi.advanceTimersByTime(1); expect(progress).toHaveBeenCalledTimes(2);
  expect(progress.mock.calls[1][0]).toContain('보조 0/2'); expect(progress.mock.calls[1][0].split(' · ').at(-1)).toHaveLength(60);
  vi.advanceTimersByTime(3999); expect(progress).toHaveBeenCalledTimes(2); vi.advanceTimersByTime(1); expect(progress.mock.calls.at(-1)![0]).toContain('작업 중 5초');
  display.observe({ type: 'result', result: 'sk-ant-FAKE_TEST_CREDENTIAL' }); display.finish();
  expect(text.mock.calls[0][0]).not.toContain('FAKE_TEST_CREDENTIAL'); const count = progress.mock.calls.length; vi.advanceTimersByTime(20000); expect(progress).toHaveBeenCalledTimes(count);
});
it.each(['', '   ', undefined])('마지막 result 본문 %s가 비면 마지막 메인 text 블록 사용', value => {
  const text = vi.fn(); const display = new TurnDisplay('result', text);
  display.observe({ type: 'result', result: '이전 결과' });
  display.observe({ type: 'assistant', message: { content: [{ type: 'text', text: '메인' }, { type: 'text', text: '두 블록' }] } });
  display.observe({ type: 'assistant', parent_tool_use_id: 'agent', message: { content: [{ type: 'text', text: '보조' }] } });
  display.observe({ type: 'result', result: value }); display.finish();
  expect(text).toHaveBeenCalledOnce(); expect(text.mock.calls[0][0]).toMatch(/^메인\n두 블록\n\n— 도구/u);
});
it.each(['completed', 'failed', 'killed'])('보조 종료 %s는 updated/notification 중복 없이 1건', status => {
  vi.useFakeTimers(); const onProgress = vi.fn(); const display = new TurnDisplay('result', undefined, onProgress);
  display.observe({ type: 'system', subtype: 'task_started', task_id: 'one' });
  display.observe({ type: 'system', subtype: 'task_updated', task_id: 'one', patch: { status } });
  display.observe({ type: 'system', subtype: 'task_notification', task_id: 'one', status });
  vi.advanceTimersByTime(1000); expect(onProgress.mock.calls.at(-1)![0]).toContain('보조 1/1'); display.finish();
});
