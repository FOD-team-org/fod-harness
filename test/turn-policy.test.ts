// OS 관찰이 제한된 환경에서도 정책 분기 자체를 검증한다. 실제 프로세스 검증은 provider/runner 테스트가 담당한다.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess, childEnv, type RunOptions, type ProcessResult } from '../src/provider/runner.ts';
import { setConfig } from '../src/core/config.ts';
import { streamClaude } from '../extensions/provider/stream.ts';
import { runTurn } from '../src/provider/turn.ts';
import { doctor } from '../src/cli/doctor.ts';
import { readState, updateState } from '../src/core/state.ts';
import { appendLedger, readLedger } from '../src/core/ledger.ts';
import { readJudgment } from '../src/core/judgment.ts';
vi.mock('../src/provider/runner.ts', async original => ({
  ...await original<typeof import('../src/provider/runner.ts')>(), runProcess: vi.fn(),
}));
const roots: string[] = [];
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-policy-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: {
    command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')],
  } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  return root;
}
const environment = (root: string) => ({ ...childEnv(), HOME: root });
function emulate(events: Record<string, any>[], cleaned = true, terminal: Partial<ProcessResult> = {}) {
  vi.mocked(runProcess).mockImplementation(async (options: RunOptions) => {
    if (options.kind === 'switch') return { code: 0, stderr: '', cleaned: true };
    const args = options.args!;
    const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
    for (const event of events) {
      const emitted = event.subtype === 'init' ? { ...event, session_id: sid } : event;
      const abortKind = await options.onEvent?.(emitted);
      if (abortKind) return { code: null, stderr: '', abortKind, cleaned };
    }
    return { code: 0, stderr: '', cleaned, ...terminal };
  });
}
const init = { type: 'system', subtype: 'init', model: 'haiku', permissionMode: 'bypassPermissions', apiKeySource: 'none' };
const done = { type: 'result', is_error: false, usage: {}, permission_denials: [] };
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('정책: 이전 run unknown은 전환 허용, 현재 run unknown은 전환 금지', async () => {
  const root = await project();
  await appendLedger(root, { runId: 'previous', action: 'effect', status: 'unknown' });
  emulate([init, { type: 'result', is_error: true, result: 'usage limit reached' }]);
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root) })).toMatchObject({ classification: 'quota' });
  expect(vi.mocked(runProcess).mock.calls.filter(([call]) => call.kind === 'switch')).toHaveLength(1);
  emulate([init, { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'pending', name: 'Bash', input: { command: 'echo pending' } },
  ] } }, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', overageStatus: 'rejected' } }]);
  vi.mocked(runProcess).mockClear();
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root) })).toMatchObject({ classification: 'unknown' });
  expect(vi.mocked(runProcess).mock.calls).toHaveLength(1);
});
it('정책: rejected rate event는 과금 중단 대신 quota 전환을 시도한다', async () => {
  const root = await project();
  emulate([init, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]);
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root) })).toMatchObject({ classification: 'quota' });
  expect(vi.mocked(runProcess).mock.calls.filter(([call]) => call.kind === 'switch')).toHaveLength(1);
});
it('정책: API 과금 신호는 회수 확인 실패와 함께 발생해도 billing을 유지한다', async () => {
  const root = await project(); emulate([{ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }], false);
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root) })).toMatchObject({ classification: 'billing' });
  expect((await readState(root)).state).toBe('paused(billing)');
});
it.each(['success', 'quota'])('정책: doctor %s는 짧은 deadline과 상태 보존, 마커 부분 일치를 따른다', async scenario => {
  const root = await project();
  const original = { state: 'IMPLEMENT', sessionId: 'saved', actualModel: 'saved-model', rateLimitInfo: { saved: true } };
  await updateState(root, original);
  emulate([init, scenario === 'quota' ? { type: 'result', is_error: true, result: 'limit reached' } : {
    ...done, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'printf FODH_DOCTOR_MARKER extra' } }],
  }]);
  if (scenario === 'success') expect(await doctor(root, { env: environment(root) })).toMatchObject({ ok: true });
  else await expect(doctor(root, { env: environment(root) })).rejects.toThrow('configError: quota');
  expect(await readState(root)).toMatchObject(original);
  expect(vi.mocked(runProcess).mock.calls).toHaveLength(1);
  expect(vi.mocked(runProcess).mock.calls[0][0].maxMs).toBe(180000);
});
it('정책: PEM 제거와 도구 결과 요약 및 마지막 호출 usage를 함께 보존한다', async () => {
  const root = await project(); let text = '';
  emulate([init, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't',
    content: '-----BEGIN PRIVATE KEY-----\nsynthetic', is_error: false }] } }, {
    ...done, usage: { input_tokens: 900000, iterations: [{ input_tokens: 4 }, { input_tokens: 2 }] },
  }]);
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root), onText: value => { text += value; } }))
    .toMatchObject({ reason: 'stop', contextUsage: true, usage: { input_tokens: 2 } });
  expect(text).toContain('[비밀값 제거]');
  const evidence = (await readLedger(root)).find(entry => entry.action.startsWith('tool_result:'))?.evidence;
  expect(Object.keys(evidence as object).sort()).toEqual(['is_error', 'length', 'sha256', 'tool_use_id']);
});
it('정책: result 없이 종료돼도 이미 수집한 훅 denial을 저장한다', async () => {
  const root = await project();
  emulate([init, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'denied', name: 'Bash',
    input: { command: 'codex exec test' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result',
    tool_use_id: 'denied', is_error: true, content: 'PreToolUse hook error' }] } }]);
  await runTurn('검사', { root, model: 'haiku', env: environment(root) });
  expect((await readJudgment(root)).items).toHaveLength(1);
});

it('정책: 기본 fable과 config 변경을 다음 턴에 읽고 동일 세션으로 resume한다', async () => {
  const root = await project();
  emulate([{ ...init, model: 'claude-fable-5-1' }, done]);
  expect(await runTurn('기본', { root, env: environment(root) })).toMatchObject({ reason: 'stop' });
  const first = vi.mocked(runProcess).mock.calls.at(-1)![0];
  expect(first.args).toContain('fable');
  const sid = (await readState(root)).sessionId;
  await setConfig(root, 'brain.model', 'haiku');
  emulate([init, done]);
  const model = { id: 'fable', name: '시험', api: 'claude-code', provider: 'claude-code', baseUrl: 'local://claude-code',
    reasoning: false, input: ['text' as const], contextWindow: 1000000, maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = streamClaude(model, { messages: [] }, undefined, { root, env: environment(root), useConfiguredModel: true });
  expect(await stream.result()).toMatchObject({ stopReason: 'stop', model: 'haiku' });
  const next = vi.mocked(runProcess).mock.calls.at(-1)![0];
  expect(next.args).toContain('--resume'); expect(next.args).toContain(sid); expect(next.args).toContain('haiku');
  expect((await readState(root)).brain).toMatchObject({ model: 'haiku' });
  const path = join(root, '.pi/harness.json'), raw = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...raw, brain: { ...raw.brain, model: 'fable' } }));
  emulate([{ ...init, model: 'claude-fable-5-1' }, done]);
  expect(await runTurn('직접 편집', { root, env: environment(root) })).toMatchObject({ reason: 'stop' });
  expect(vi.mocked(runProcess).mock.calls.at(-1)![0].args).toContain('fable');
  expect((await readState(root)).sessionId).toBe(sid);
});
const markerResult = { ...done, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'echo FODH_DOCTOR_MARKER' } }] };
it.each([
  ['quota', { abortKind: 'quota' }, 'error', 'configError: quota'],
  ['billing', { abortKind: 'billing' }, 'aborted', 'billing'],
  ['config', { abortKind: 'configError' }, 'error', 'configError'],
  ['deadline', { abortKind: 'deadline' }, 'aborted', 'deadline'],
  ['user', { abortKind: 'user' }, 'aborted', 'user'],
  ['protocol', { abortKind: 'protocolError' }, 'error', 'protocolError'],
  ['cleanup', { cleaned: false }, 'error', 'cleanupFailed'],
] as const)('F8: doctor 차단 관측 뒤에도 %s 중단/실패 판정을 유지한다', async (_name, terminal, reason, classification) => {
  const root = await project(); emulate([init, markerResult], true, terminal);
  expect(await runTurn('doctor 시험', { root, doctor: true, env: environment(root) })).toMatchObject({ reason, classification });
  expect(vi.mocked(runProcess).mock.calls).toHaveLength(1);
});
it('F8: 일반 턴은 marker 차단을 관측해도 max_turns 실패를 성공으로 바꾸지 않는다', async () => {
  const root = await project();
  emulate([init, { ...markerResult, subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }], true, { code: 1 });
  expect(await runTurn('일반 턴', { root, model: 'haiku', env: environment(root) })).toMatchObject({ reason: 'error', classification: 'processError' });
});
it.each([
  { tool_name: 'Read', tool_input: { command: 'FODH_DOCTOR_MARKER' } },
  { tool_name: 'Bash', tool_input: { command: 'echo OTHER_MARKER' } },
])('F8: 다른 도구 또는 다른 마커 차단으로 doctor를 통과시키지 않는다 (%#)', async denial => {
  const root = await project(); emulate([init, { ...done, permission_denials: [denial] }]);
  expect(await runTurn('doctor 시험', { root, doctor: true, env: environment(root) })).toMatchObject({ reason: 'error', classification: 'configError' });
});
