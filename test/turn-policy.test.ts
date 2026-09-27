// OS 관찰이 제한된 환경에서도 정책 분기 자체를 검증한다. 실제 프로세스 검증은 provider/runner 테스트가 담당한다.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess, childEnv, type RunOptions, type ProcessResult } from '../src/provider/runner.ts';
import { setConfig } from '../src/core/config.ts';
import { streamClaude } from '../extensions/provider/stream.ts';
import { runTurn, buildPrompt } from '../src/provider/turn.ts';
import { doctor } from '../src/cli/doctor.ts';
import { readState, updateState } from '../src/core/state.ts';
import { appendLedger, readLedger } from '../src/core/ledger.ts';
import { addInbox } from '../src/core/inbox.ts';
import { readJudgment } from '../src/core/judgment.ts';
vi.mock('../src/provider/runner.ts', async original => ({
  ...await original<typeof import('../src/provider/runner.ts')>(), runProcess: vi.fn(),
}));
const roots: string[] = [];
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-policy-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ ui: { brainOutput: 'full' }, brain: { allowedModels: ['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet'],
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
  expect(vi.mocked(runProcess).mock.calls.filter(([call]) => call.kind === 'switch')).toHaveLength(0);
  emulate([init, { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'pending', name: 'Bash', input: { command: 'echo pending' } },
  ] } }, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', overageStatus: 'rejected' } }]);
  vi.mocked(runProcess).mockClear();
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root) })).toMatchObject({ classification: 'unknown' });
  expect(vi.mocked(runProcess).mock.calls).toHaveLength(1);
});
it('정책: rejected rate event는 계정 전환 없이 quota로 일시정지한다', async () => {
  const root = await project();
  emulate([init, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]);
  expect(await runTurn('검사', { root, model: 'haiku', env: environment(root) })).toMatchObject({ classification: 'quota' });
  expect(vi.mocked(runProcess).mock.calls.filter(([call]) => call.kind === 'switch')).toHaveLength(0);
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
    ...done, permission_denials: [
      { tool_name: 'Bash', tool_input: { command: 'printf FODH_DOCTOR_MARKER extra' } },
      { tool_name: 'Write', tool_input: { file_path: 'src/FODH_DOCTOR_MARKER.ts', content: 'export {}' } },
    ],
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
    input: { command: 'echo FORBIDDEN_MARKER' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result',
    tool_use_id: 'denied', is_error: true, content: 'PreToolUse hook error: 하네스 가드[승인]: 시험' }] } }]);
  await runTurn('검사', { root, model: 'haiku', env: environment(root) });
  expect((await readJudgment(root)).items).toHaveLength(1);
});

it('정책: 기본 fable과 config 변경을 다음 턴에 읽고 동일 세션으로 resume한다', async () => {
  const root = await project();
  emulate([{ ...init, model: 'claude-fable-5-1' }, done]);
  expect(await runTurn('기본', { root, env: environment(root) })).toMatchObject({ reason: 'stop' });
  const first = vi.mocked(runProcess).mock.calls.at(-1)![0];
  expect(first.args).toContain('claude-fable-5-1');
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
  expect(vi.mocked(runProcess).mock.calls.at(-1)![0].args).toContain('claude-fable-5-1');
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

it.each([undefined, '123456'])('두뇌 Bash timeout env 기본 주입 및 사용자 값 %s 보존', async timeout => {
  const root = await project(); emulate([init, done]);
  const env = { ...environment(root), BASH_DEFAULT_TIMEOUT_MS: timeout, BASH_MAX_TIMEOUT_MS: timeout };
  await runTurn('대기', { root, model: 'haiku', env });
  expect(vi.mocked(runProcess).mock.calls.at(-1)![0].env).toMatchObject({
    BASH_DEFAULT_TIMEOUT_MS: timeout ?? '600000', BASH_MAX_TIMEOUT_MS: timeout ?? '600000', FODH_PROJECT_ROOT: root,
  });
});
it('결과 없는 codex-done은 실패하는 result 호출 대신 재위임·판단을 안내한다', async () => {
  const root = await project();
  await addInbox(root, { kind: 'codex-done', codexRunId: 'missing', codexStatus: 'lost' });
  const prompt = await buildPrompt(root, '계속', 'brain');
  expect(prompt).toContain('결과 없음 — 위임을 다시 시작하거나 fodh judgment add 로 판단을 등록하라');
  expect(prompt).not.toContain('fodh codex result missing');
  await addInbox(root, { kind: 'codex-done', codexRunId: 'present', codexStatus: 'ok', resultDir: '/result' });
  expect(await buildPrompt(root, '계속', 'brain2')).toContain('fodh codex result present');
});

const doctorMarkers = { ...markerResult, permission_denials: [...markerResult.permission_denials,
  { tool_name: 'Write', tool_input: { file_path: 'src/FODH_DOCTOR_MARKER.ts' } }] };
it.each([false, true])('N1 doctor 플러그인 누출 경고 allowPlugins=%s', async allowPlugins => {
  const root = await project();
  const { setConfig } = await import('../src/core/config.ts');
  const { readLedger } = await import('../src/core/ledger.ts');
  await setConfig(root, 'notify.channels', '["ledger"]');
  await setConfig(root, 'brain.allowPlugins', JSON.stringify(allowPlugins));
  emulate([{ ...init, plugins: [{ name: 'safe', source: 'builtin' }, { name: 'codex', source: 'user' }],
    agents: ['general-purpose', 'codex:codex-rescue'], slash_commands: ['codex:task'],
    skills: ['fodh-judgment', 'fodh-review-checklist', 'fodh-spec-writing', 'fodh-workflow', 'codex:review'] }, doctorMarkers]);
  const result = await doctor(root, { env: environment(root) });
  expect(result.pluginsLeaked).toEqual(allowPlugins ? [] : ['user', 'codex:codex-rescue', 'codex:task', 'codex:review']);
  expect(result.skillsMissing).toEqual([]);
  const entries = await readLedger(root), notices = entries.filter(e => e.action === 'notify:doctor:plugins');
  expect(notices).toHaveLength(allowPlugins ? 0 : 1);
  if (!allowPlugins) expect(notices[0].evidence).toMatchObject({ level: 'warning', body: expect.stringContaining('codex:review') });
  const evidence = entries.find(e => e.action === 'system.init:0')?.evidence;
  expect(evidence).toMatchObject({ plugins: 2, agents: 2, commands: 1 });
  expect(JSON.stringify(evidence)).not.toContain('codex:codex-rescue');
});
it('N1 doctor builtin 플러그인은 누출 경고 없이 유지', async () => {
  const root = await project();
  emulate([{ ...init, plugins: [{ name: 'agents-md', source: 'builtin' }], agents: ['general-purpose'], slash_commands: [] }, doctorMarkers]);
  expect((await doctor(root, { env: environment(root) })).pluginsLeaked).toEqual([]);
});
it('F29 Agent 훅과 Task 결과 별칭은 경계 분류 1건으로 합친다', async () => {
  const root = await project(); const input = { subagent_type: 'codex:codex-rescue' };
  emulate([init,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'alias', input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'alias', is_error: true,
      content: 'PreToolUse hook error: 하네스 가드[경계]: 위임은 fodh codex task / Claude Agent 로만 한다' }] } },
    { ...done, permission_denials: [{ tool_name: 'Task', tool_input: input }] },
  ]);
  expect(await runTurn('별칭', { root, model: 'haiku', env: environment(root) })).toMatchObject({ reason: 'stop' });
  const { readLedger } = await import('../src/core/ledger.ts'); const entries = await readLedger(root);
  expect(entries.filter(e => e.action.startsWith('hook:'))).toEqual([expect.objectContaining({ action: 'hook:boundary:0:alias', evidence: expect.objectContaining({ kind: 'boundary' }) })]);
});

it.each([
  ['haiku', 'haiku', ['claude-opus-5-5', 'claude-fable-5-1']],
  ['claude-fable-5-1', 'claude-opus-5-5', ['claude-opus-5-5', 'claude-fable-5-1']],
])('P8 init 요청/허용 목록 불일치 %s → %s는 configError와 거부 원장', async (requested, actual, allowed) => {
  const root = await project(); await setConfig(root, 'brain.allowedModels', JSON.stringify(allowed));
  emulate([{ ...init, model: actual }, done]);
  expect(await runTurn('거부', { root, model: requested, env: environment(root) })).toMatchObject({ classification: 'configError' });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'brain:model-rejected', status: 'fail',
    evidence: { requested, actual, allowed } }));
});
it('P8 doctor haiku는 기본 허용 목록 밖이어도 훅 시험을 완료하고 모델 정보를 반환한다', async () => {
  const root = await project();
  const allowed = ['claude-opus-5-5', 'claude-fable-5-1'];
  await setConfig(root, 'brain.allowedModels', JSON.stringify(allowed));
  emulate([init, { ...done, permission_denials: [
    { tool_name: 'Bash', tool_input: { command: 'echo FODH_DOCTOR_MARKER' } },
    { tool_name: 'Write', tool_input: { file_path: 'src/FODH_DOCTOR_MARKER.ts' } },
  ] }]);
  expect(await doctor(root, { env: environment(root) })).toMatchObject({ ok: true, brainModel: 'claude-fable-5-1', allowedModels: allowed });
  expect((await readState(root)).brain).toMatchObject({ model: 'claude-fable-5-1' });
  expect((await readLedger(root)).some(entry => entry.action === 'brain:model-rejected')).toBe(false);
});

it.each(['claude-opus-5-5[1m]', 'claude-opus-5-5'])('P8-c [1m] 목록·요청은 actual %s init을 허용하고 모델 인자를 보존한다', async actual => {
  const root = await project(), model = 'claude-opus-5-5[1m]';
  await setConfig(root, 'brain', JSON.stringify({ model, allowedModels: [model],
    command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')] }));
  emulate([{ ...init, model: actual }, done]);
  expect(await runTurn('1m 모델', { root, env: environment(root) })).toMatchObject({ reason: 'stop' });
  const args = vi.mocked(runProcess).mock.calls.at(-1)![0].args!;
  expect(args[args.indexOf('--model') + 1]).toBe(model);
  expect((await readLedger(root)).some(entry => entry.action === 'brain:model-rejected')).toBe(false);
});

it.each([false, true])('A16 F33 @builtin은 제외하고 사용자 플러그인 혼재=%s만 경고한다', async user => {
  const root = await project(); await setConfig(root, 'notify.channels', '["ledger"]');
  const sources = ['agents-md@builtin', 'telemetry@builtin', ...(user ? ['foo@user'] : [])];
  emulate([{ ...init, plugins: sources.map(source => ({ name: source.split('@')[0], source })) }, doctorMarkers]);
  expect((await doctor(root, { env: environment(root) })).pluginsLeaked).toEqual(user ? ['foo@user'] : []);
  const notices = (await readLedger(root)).filter(entry => entry.action === 'notify:doctor:plugins');
  expect(notices).toHaveLength(user ? 1 : 0);
  if (user) expect(notices[0].evidence).toMatchObject({ body: '발견 항목: foo@user' });
});

it('A14-d doctor는 display=result에도 full 텍스트로 문서 표식을 보존한다', async () => {
  const root = await project(), onText = vi.fn(), onProgress = vi.fn();
  emulate([init,
    { type: 'assistant', message: { content: [{ type: 'text', text: '문서 확인 FODH-DOC-1234abcd' }] } },
    { ...done, result: '차단 확인', permission_denials: [
      { tool_name: 'Bash', tool_input: { command: 'echo FODH_DOCTOR_MARKER' } },
      { tool_name: 'Write', tool_input: { file_path: 'src/FODH_DOCTOR_MARKER.ts' } },
    ] },
  ]);
  expect(await runTurn('doctor 시험', { root, doctor: true, display: 'result', env: environment(root), onText, onProgress })).toMatchObject({ reason: 'stop' });
  expect(onText.mock.calls.map(([text]) => text).join('')).toContain('문서 확인 FODH-DOC-1234abcd');
  expect(onText.mock.calls.map(([text]) => text).join('')).not.toContain('— 도구'); expect(onProgress).not.toHaveBeenCalled();
});
