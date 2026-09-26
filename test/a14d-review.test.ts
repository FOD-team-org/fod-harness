import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runTurn } from '../src/provider/turn.ts';
import { TurnDisplay, isHarnessDisplayLine } from '../src/provider/display.ts';
import { runProcess, childEnv, type RunOptions, type ProcessResult } from '../src/provider/runner.ts';
vi.mock('../src/provider/runner.ts', async original => ({ ...await original<typeof import('../src/provider/runner.ts')>(), runProcess: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const assistant = (content: object[], parent_tool_use_id: string | null = null) => ({ type: 'assistant', parent_tool_use_id, message: { content } });
const text = (text: string) => ({ type: 'text', text });
const tool = (id: string, command = id) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const blocked = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'PreToolUse hook error: [경계] blocked' }] } });
const permission = (id?: string, command = id ?? 'same') => ({ tool_name: 'Bash', tool_input: { command }, ...(id ? { tool_use_id: id } : {}) });
const done = (permission_denials: object[]) => ({ type: 'result', is_error: false, result: '최종 답', permission_denials });
const delta = (value: string, parent_tool_use_id: string | null = null) => ({ type: 'stream_event', parent_tool_use_id, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } });
const start = (parent_tool_use_id: string | null = null) => ({ type: 'stream_event', parent_tool_use_id, event: { type: 'message_start' } });
async function turn(events: object[], terminal: Partial<ProcessResult> = {}) {
  const root = await mkdtemp('/private/tmp/fodh-a14d-review-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ notify: { channels: ['ledger'] }, brain: { model: 'haiku', allowedModels: ['haiku'] } }));
  vi.mocked(runProcess).mockImplementation(async (options: RunOptions) => {
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, model: 'haiku', permissionMode: 'bypassPermissions', apiKeySource: 'none' });
    for (const event of events) await options.onEvent?.(event);
    return { code: 0, cleaned: true, stderr: '', ...terminal };
  });
  const onText = vi.fn();
  const result = await runTurn('fixture', { root, display: 'result', onText, env: { ...childEnv(), HOME: root } });
  expect(onText).toHaveBeenCalledOnce(); return { output: onText.mock.calls[0][0] as string, result };
}
it.each(['deadline', 'user', 'processError'])('2회차 %s: thinking/tool-only 뒤에도 마지막 비어 있지 않은 메인 본문 유지', async kind => {
  const { output, result } = await turn([
    assistant([text('유지할 본문')]), assistant([{ type: 'thinking', thinking: 'internal' }]),
    assistant([tool('later')]), assistant([text('  ')]), assistant([text('보조 텍스트')], 'parent'),
  ], kind === 'processError' ? { code: 1 } : { code: null, abortKind: kind as 'deadline' | 'user' });
  expect(output).toMatch(/^유지할 본문\n\n— 도구/u); expect(output).toContain(`중단: ${kind}`);
  expect(result.reason).toBe(kind === 'processError' ? 'error' : 'aborted');
});
it('2회차 delta-only 중단은 현재 메인 메시지 조각만 합치고 보조 delta 제외', async () => {
  const { output } = await turn([start(), delta('이전 조각'), start(), delta('현재 '), start('child'), delta('보조', 'child'), delta('조각')], { code: null, abortKind: 'user' });
  expect(output).toMatch(/^현재 조각\n\n— 도구/u); expect(output).not.toContain('이전 조각'); expect(output).not.toContain('보조현재');
});
it.each([false, true])('2회차 본문 우선순위 result=%s → 완성 메인 → delta', async hasResult => {
  const { output } = await turn([
    assistant([text('완성 메인')]), start(), delta('진행 중 조각'), ...(hasResult ? [done([])] : []),
  ], { code: null, abortKind: 'user' });
  expect(output.startsWith(hasResult ? '최종 답\n' : '완성 메인\n')).toBe(true);
});
it.each(['tool_result', 'permission_denials', 'both', 'canonical'])('2회차 %s: 서로 다른 거부 3건·문구 1줄·반복 이벤트 중복 제거', async mode => {
  const ids = ['a', 'b', 'c'];
  const events: object[] = [];
  if (mode === 'tool_result' || mode === 'both') for (const id of ids) events.push(assistant([tool(id)]), blocked(id), blocked(id));
  const denials = mode === 'tool_result' ? [] : ids.map(id => permission(mode === 'canonical' ? undefined : id, id));
  events.push(done([...denials, ...denials]));
  const { output } = await turn(events);
  expect(output).toContain('훅 차단 3건'); expect(output.match(/\[훅 차단\]/gu)).toHaveLength(1);
});
it.each([true, false])('2회차 tool_result와 result 요약 id=%s 중복을 1건으로 집계', async hasId => {
  const denial = permission(hasId ? 'one' : undefined, 'same');
  const { output } = await turn([assistant([tool('one', 'same')]), blocked('one'), blocked('one'), done([denial, denial])]);
  expect(output).toContain('훅 차단 1건'); expect(output.match(/\[훅 차단\]/gu)).toHaveLength(1);
});
it('2회차 같은 입력이라도 서로 다른 tool_use_id는 3건', async () => {
  const { output } = await turn([done(['a', 'b', 'c'].map(id => permission(id, 'same')))]);
  expect(output).toContain('훅 차단 3건'); expect(output.match(/\[훅 차단\]/gu)).toHaveLength(1);
});
it('2회차 id 없는 입력 canonical은 속성 순서에 무관하고 다른 입력은 구별', async () => {
  const { output } = await turn([done([
    { tool_name: 'Bash', tool_input: { command: 'same', description: 'fixture' } },
    { tool_name: 'Bash', tool_input: { description: 'fixture', command: 'same' } },
  ])]); expect(output).toContain('훅 차단 1건');
});
it('2회차 하네스 줄 접두어는 숫자 끝줄·훅 줄에만 적용', () => {
  for (const value of ['— 도구 1회', '[훅 차단] 보호']) expect(isHarnessDisplayLine(value)).toBe(true);
  for (const value of ['— 도구 설명', '본문 [훅 차단] 안내', '대기: 위임 X', '상태: IMPLEMENT']) expect(isHarnessDisplayLine(value)).toBe(false);
  const onText = vi.fn(), display = new TurnDisplay('full', onText);
  display.denial('one', '↳ [훅 차단] 보호'); expect(onText).toHaveBeenCalledWith('\n↳ [훅 차단] 보호\n');
});
