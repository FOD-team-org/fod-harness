import { addTask } from '../src/core/backlog.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Model, AssistantMessageEvent } from '@mariozechner/pi-ai';
import { streamClaude } from '../extensions/provider/stream.ts';
import { runTurn, buildPrompt, latestMessage, packageRoot } from '../src/provider/turn.ts';
import { groupAlive, commandParts, childEnv } from '../extensions/provider/runner.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readLedger, appendLedger, unknownEntries } from '../src/core/ledger.ts';
import { readJudgment } from '../src/core/judgment.ts';
import { listProcs } from '../src/core/procs.ts';
import { addInbox, queueInbox, ackInbox, listInbox } from '../src/core/inbox.ts';
import { doctor } from '../src/cli/doctor.ts';
const exec = promisify(execFile);
const roots: string[] = [];
const fake = resolve('test/fake-claude/claude');
const fakeSwitch = resolve('test/fake-claude/switch');
const model: Model<'claude-code'> = { id: 'haiku', name: '시험', api: 'claude-code', provider: 'claude-code', baseUrl: 'local://claude-code', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function project(maxTurnMinutes = 0.2) {
  const root = await mkdtemp('/private/tmp/fodh-provider-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: { command: fake, switchCommand: [fakeSwitch], model: 'haiku', maxTurnMinutes } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', autoTurns: 0 }));
  return root;
}
const environment = (root: string, scenario = 'first') => ({ ...childEnv(), HOME: root, FAKE_CLAUDE_SCENARIO: scenario, FODH_PACKAGE_ROOT: packageRoot });
const records = async (root: string, file: string) => (await readFile(join(root, '.pi', file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(await listProcs(root)).toEqual([]);
    let pids: { pid: number }[] = [];
    try { pids = await records(root, 'fake-pids.jsonl'); } catch {}
    for (const { pid } of pids) expect(() => process.kill(pid, 0)).toThrow();
    await rm(root, { recursive: true, force: true });
  }
});
describe('프로바이더 실물 픽스처', () => {
  it('최초 스트림: 순서 보존, 표시용 도구, stop, 세션·모델·usage·denial 기록과 중복 병합', async () => {
    const root = await project();
    const stream = streamClaude(model, { messages: [{ role: 'user', content: '첫 지시', timestamp: 0 }] }, undefined, { root, env: environment(root) });
    const events: AssistantMessageEvent[] = []; for await (const event of stream) events.push(event);
    const fixture = (await readFile('test/fixtures/claude-stream-json/first-run-hook-deny.jsonl', 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const deltas = fixture.filter(event => event.type === 'stream_event' && event.event.delta?.type === 'text_delta').map(event => event.event.delta.text);
    expect(events.filter(event => event.type.startsWith('toolcall'))).toHaveLength(0);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).filter(text => !text.startsWith('\n['))).toEqual(deltas);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
    expect((await stream.result()).content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('[tool] Bash:') })]);
    const state = await readState(root); expect(state.sessionId).toMatch(/^[a-f\d-]{36}$/);
    const ledger = await readLedger(root);
    expect(ledger.find(entry => entry.action.startsWith('system.init'))?.evidence).toMatchObject({ model: 'claude-haiku-4-5-20251001' });
    expect(ledger.find(entry => entry.action.startsWith('result'))?.evidence).toMatchObject({ usage: { input_tokens: 26 }, permission_denials: [expect.objectContaining({ tool_name: 'Bash' })] });
    expect((await readJudgment(root)).items).toHaveLength(1);
    expect((await readJudgment(root)).items[0].title).toContain('Bash: echo FORBIDDEN_MARKER upload');
    await runTurn('다시', { root, model: 'haiku', env: environment(root) });
    expect((await readJudgment(root)).items).toHaveLength(1);
    expect(await unknownEntries(root)).toHaveLength(0);
  });
  it('두 번째 턴 resume 인자·동일 sid·델타 없는 assistant 텍스트 표시', async () => {
    const root = await project();
    await runTurn('첫 턴', { root, model: 'haiku', env: environment(root) });
    const sid = (await readState(root)).sessionId;
    let text = '';
    expect(await runTurn('기억 확인', { root, model: 'haiku', env: { ...environment(root, 'resume'), FAKE_EXPECT_SID: sid }, onText: delta => { text += delta; } })).toMatchObject({ reason: 'stop' });
    const calls = await records(root, 'fake-calls.jsonl');
    expect(calls[0].args).toContain('--session-id'); expect(calls[1].args).toContain('--resume'); expect(calls[1].args).toContain(sid);
    expect(text).toContain('store-upload');
  });
  it('인박스 3개 순차 전달·ack·재시작 재전달', async () => {
    const root = await project(); const ids: string[] = [];
    for (const fact of ['첫 사실','둘째 사실','셋째 사실']) { const item = await addInbox(root, { kind: 'judgment-changed', fact }); ids.push(item.id); await queueInbox(root, item.id); }
    await runTurn('마지막 지시', { root, model: 'haiku', env: environment(root) });
    const prompt = (await records(root, 'fake-calls.jsonl'))[0].prompt;
    expect(prompt.indexOf('첫 사실')).toBeLessThan(prompt.indexOf('둘째 사실')); expect(prompt.indexOf('둘째 사실')).toBeLessThan(prompt.indexOf('셋째 사실'));
    expect(prompt.endsWith('마지막 지시')).toBe(true);
    await ackInbox(root, [ids[0], ids[2]]);
    const next = await buildPrompt(root, '재시작', randomUUID());
    expect(next).toContain('둘째 사실'); expect(next).not.toContain('첫 사실'); expect(next).not.toContain('셋째 사실');
    expect((await listInbox(root)).map(item => item.status)).toEqual(['applied','delivered','applied']);
  });
  it.each(['overage', 'overage-status'])('과금 %s 감지 시 중단·billing·알림 1회', async scenario => {
    const root = await project(); const notices: string[] = [];
    expect(await runTurn('진행', { root, model: 'haiku', env: environment(root, scenario), notify: message => { notices.push(message); } })).toMatchObject({ reason: 'aborted', classification: 'billing' });
    expect((await readState(root)).state).toBe('paused(billing)'); expect(notices).toHaveLength(1);
    expect((await readState(root)).rateLimitInfo).toBeTruthy();
  });
  it('가짜 두뇌가 PATH로 fodh inbox ack 및 state get을 실행하고 인박스를 applied로 바꾼다', async () => {
    const root = await project();
    const items = [await addInbox(root, { kind: '사실', fact: '첫 사실' }), await addInbox(root, { kind: '사실', fact: '둘째 사실' })];
    // 부모 테스트가 미리 fodh 경로를 넣지 않아도 실제 runner에서 추가해야 한다.
    const env = { ...environment(root, 'ack'), PATH: dirname(process.execPath) };
    expect(await runTurn('인박스 반영', { root, model: 'haiku', env })).toMatchObject({ reason: 'stop' });
    const ids = items.map(item => item.id);
    expect((await listInbox(root)).map(item => ({ id: item.id, status: item.status })))
      .toEqual(ids.map(id => ({ id, status: 'applied' })));
    const calls = await records(root, 'fake-ack.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ids, ack: ids.map(id => ({ id, status: 'applied' })), state: { state: 'IDLE' } });
    expect(await buildPrompt(root, '다음 턴', randomUUID())).not.toContain('[인박스 ');
  });
  it.each(['rate-limited', 'stderr-limit', 'rate-limited-text', 'rate-rejected'])('%s: switch 1회·재시도 1회 후 quota', async scenario => {
    const root = await project();
    expect(await runTurn('진행', { root, model: 'haiku', env: environment(root, scenario) })).toMatchObject({ reason: 'error', classification: 'quota' });
    expect((await readState(root)).state).toBe('paused(quota)');
    expect(await records(root, 'fake-switch.jsonl')).toHaveLength(1); expect(await records(root, 'fake-calls.jsonl')).toHaveLength(2);
    expect(await unknownEntries(root)).toHaveLength(0);
  });
  it('이전 run unknown은 복구 안내에만 포함하고 이번 quota 전환을 허용', async () => {
    const root = await project(); await appendLedger(root, { runId: '이전실행', action: 'side-effect', status: 'pre' });
    expect(await runTurn('진행', { root, model: 'haiku', env: environment(root, 'rate-limited') })).toMatchObject({ classification: 'quota' });
    expect((await readState(root)).state).toBe('paused(quota)');
    expect(await records(root, 'fake-calls.jsonl')).toHaveLength(2);
    expect(await records(root, 'fake-switch.jsonl')).toHaveLength(1);
    const prompt = (await records(root, 'fake-calls.jsonl'))[0].prompt;
    expect(prompt).toContain('이전실행'); expect(prompt).toContain('side-effect');
    expect(prompt).toContain('fodh ledger resolve');
  });
  it('deadline은 손자까지 회수하고 다음 프롬프트를 복구 모드로 시작', async () => {
    const root = await project(0.015);
    expect(await runTurn('멈춤', { root, model: 'haiku', env: environment(root, 'hang') })).toMatchObject({ reason: 'aborted', classification: 'deadline' });
    const pids = await records(root, 'fake-pids.jsonl'); expect(pids).toHaveLength(3);
    expect(groupAlive(pids[0].pid)).toBe(false); for (const { pid } of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect((await readState(root)).state).toBe('recovering'); expect(await unknownEntries(root)).toHaveLength(1);
    expect(await buildPrompt(root, '다음', randomUUID())).toMatch(/^복구 모드/);
  }, 15000);
  it('TERM 무시 그룹은 5초 뒤 KILL로 손자까지 회수', async () => {
    const root = await project(0.015); const start = Date.now();
    expect(await runTurn('강제 회수', { root, model: 'haiku', env: environment(root, 'hang-stubborn') })).toMatchObject({ classification: 'deadline' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(5900);
    const pids = await records(root, 'fake-pids.jsonl'); expect(pids).toHaveLength(3);
    for (const { pid } of pids) expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
  it('부모 정상 종료 뒤 출력 파이프를 상속한 자손도 즉시 회수', async () => {
    const root = await project(0.05);
    expect(await runTurn('상속 파이프', { root, model: 'haiku', env: environment(root, 'inherited-pipe') })).toMatchObject({ reason: 'stop' });
    expect(await records(root, 'fake-pids.jsonl')).toHaveLength(3);
  });
  it('과금 알림 실패도 billing 상태를 유지', async () => {
    const root = await project();
    expect(await runTurn('과금', { root, model: 'haiku', env: environment(root, 'overage'), notify: async () => { throw new Error('알림 실패'); } })).toMatchObject({ classification: 'billing' });
    expect((await readState(root)).state).toBe('paused(billing)');
  });
  it('사용자 abort도 그룹을 회수', async () => {
    const root = await project(); const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try { expect(await runTurn('중단', { root, model: 'haiku', env: environment(root, 'hang'), signal: controller.signal })).toMatchObject({ reason: 'aborted', classification: 'user' }); }
    finally { clearTimeout(timer); }
  }, 15000);
  it.each(['no-verbose', 'bad-init'])('%s는 configError, 재시도 없음', async scenario => {
    const root = await project();
    expect(await runTurn('진행', { root, model: 'haiku', env: environment(root, scenario) })).toMatchObject({ classification: 'configError' });
    expect((await readLedger(root)).filter(entry => entry.action === 'switch')).toHaveLength(0);
  });
  it('가짜 claude 자체도 --verbose가 없으면 실물 오류문', async () => {
    const root = await project();
    await expect(exec(fake, ['-p','--output-format','stream-json'], { cwd: root, env: environment(root) })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('requires --verbose') });
  });
  it('5종 환경변수 제거와 shell 없는 명령 인자 처리', () => {
    const env = childEnv({ CLAUDECODE: '시험', CLAUDE_CODE_ENTRYPOINT: '시험', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', KEEP: '유지' });
    expect(env).toEqual({ KEEP: '유지', PATH: join(packageRoot, 'bin') }); expect(commandParts('"/a b/command" switch')).toEqual(['/a b/command','switch']);
  });
  it('childEnv는 패키지 bin을 PATH 선두에 넣고 기존 경로와 입력을 보존한다', () => {
    const bin = join(packageRoot, 'bin');
    const original = { PATH: ['/a path/bin', '/usr/bin', bin].join(delimiter), KEEP: '유지' };
    const before = { ...original };
    const env = childEnv(original);
    expect(env).toEqual({ ...original, PATH: bin + delimiter + original.PATH });
    expect(original).toEqual(before);
    expect(childEnv(env)).toEqual(env);
    expect(childEnv({ PATH: '' }).PATH).toBe(bin);
    expect(childEnv().PATH?.split(delimiter)[0]).toBe(bin);
  });
  it('마지막 user만 전달하고 이전 대화는 반복하지 않음', () => {
    expect(latestMessage({ messages: [{ role: 'user', content: '이전', timestamp: 0 }, { role: 'user', content: [{ type: 'text', text: '마지막' }], timestamp: 1 }] })).toBe('마지막');
  });
});
describe('doctor와 CLI', () => {
  it('API 환경변수는 값 노출 없이 실패하고 실행하지 않음', async () => {
    const root = await project();
    await expect(doctor(root, { env: { ...environment(root), ANTHROPIC_API_KEY: '' } })).rejects.toThrow('ANTHROPIC_API_KEY');
    await expect(readFile(join(root, '.pi/fake-calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('실제 훅 차단 검증 성공, 훅이 빠지면 실패', async () => {
    const root = await project(); expect(await doctor(root, { env: environment(root) })).toMatchObject({ ok: true, hookDenials: 2 });
    await writeFile(join(root, '.claude/settings.json'), '{}');
    await expect(doctor(root, { env: environment(root) })).rejects.toThrow('configError');
    expect((await readState(root)).doctor).toMatchObject({ ok: false });
    expect((await readLedger(root)).findLast(entry => entry.action === 'brain:0')?.evidence).toMatchObject({ code: 0, cleaned: true });
  });
  it.each(['doctor-max-turns', 'doctor-max-turns-tool-result'])('F8: %s 차단→다른 도구 성공→max_turns/exit 1도 doctor 성공', async scenario => {
    const root = await project();
    expect(await doctor(root, { env: environment(root, scenario) })).toMatchObject({ ok: true, hookDenials: 2 });
    expect((await readState(root)).doctor).toMatchObject({ ok: true });
    const ledger = await readLedger(root);
    expect(ledger.find(entry => entry.action === 'hook:0:doctor-marker')?.evidence).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'echo FODH_DOCTOR_MARKER' } });
    expect(ledger.find(entry => entry.action === 'tool_result:0:doctor-followup')?.evidence).toMatchObject({ is_error: false });
    expect(ledger.find(entry => entry.action === 'result:0')?.evidence).toMatchObject({ is_error: true, terminal_reason: 'max_turns',
      permission_denials: scenario.endsWith('tool-result') ? [] : [expect.objectContaining({ tool_name: 'Bash' })] });
    expect(ledger.findLast(entry => entry.action === 'brain:0')?.evidence).toMatchObject({ code: 1, cleaned: true });
    expect((await readJudgment(root)).items).toHaveLength(0);
  });
  it('F8: max_turns 자체는 차단 증거가 아니므로 훅 없으면 configError', async () => {
    const root = await project(); await writeFile(join(root, '.claude/settings.json'), '{}');
    await expect(doctor(root, { env: environment(root, 'doctor-max-turns') })).rejects.toThrow('configError');
    expect((await readState(root)).doctor).toMatchObject({ ok: false });
    expect((await readLedger(root)).some(entry => entry.action.startsWith('hook:'))).toBe(false);
  });
  it('F8: doctor만 brain-rules를 제외하고 max-turns 3과 전용 프롬프트를 사용한다', async () => {
    const root = await project(); await doctor(root, { env: environment(root) });
    await runTurn('일반 턴', { root, model: 'haiku', env: environment(root) });
    const [check, normal] = await records(root, 'fake-calls.jsonl');
    expect(check.args).not.toContain('--append-system-prompt-file');
    expect(check.args).not.toContain(join(packageRoot, 'templates/brain-rules.md'));
    expect(check.args[check.args.indexOf('--max-turns') + 1]).toBe('3');
    expect(check.args[check.args.indexOf('--settings') + 1]).toBe(join(root, '.claude/settings.json'));
    expect(check.prompt).toContain('차단되면 다른 도구를 쓰지 말고 `차단 확인` 한 줄을 답하고');
    expect(check.prompt).toContain('CLAUDE.md의 `doctor 표식` 값을 `문서 확인 <값>` 한 줄로 답하라');
    expect(normal.args[normal.args.indexOf('--append-system-prompt-file') + 1]).toBe(join(packageRoot, 'templates/brain-rules.md'));
    expect(normal.args).not.toContain('--max-turns');
  });
  it('apiKeyHelper가 있으면 실행 전 실패', async () => {
    const root = await project(); await writeFile(join(root, '.claude/settings.json'), '{"apiKeyHelper":"사용하지않음"}');
    await expect(doctor(root, { env: environment(root) })).rejects.toThrow('apiKeyHelper');
  });
  it('CLI judgment 전체 명령과 inbox ack·proc list 경로', async () => {
    const root = await project(); const cli = resolve('bin/fodh'); const env = environment(root);
    await addTask(root, { title: 'CLI 판단', category: 'docs' });
    const call = async (...args: string[]) => JSON.parse((await exec(cli, args, { cwd: root, env })).stdout);
    const added = await call('judgment','add','--title','시험 판단','--background','시험 배경','--options','유지|변경','--recommend','유지','--blocks','T01');
    const id = added.item.id;
    expect((await call('judgment','read','--answered')).items).toHaveLength(0);
    expect((await call('judgment','answer',id,'2')).item.answer).toBe('2');
    expect((await call('judgment','read','--answered')).items).toHaveLength(1);
    expect((await call('judgment','write-status','답 확인 중')).expectedHash).toMatch(/^[a-f0-9]{64}$/);
    const item = await addInbox(root, { kind: '사실' }); await buildPrompt(root, '지시', 'test-run');
    expect((await call('inbox','list'))[0].status).toBe('delivered');
    expect((await call('inbox','ack',item.id))[0].status).toBe('applied');
    expect(await call('proc','list')).toEqual([]);
  });
  it('CLI는 성공·실패에서 stdout JSON 한 덩어리', async () => {
    const root = await project(); const cli = resolve('bin/fodh'); const env = environment(root);
    expect(JSON.parse((await exec(cli, ['state','get'], { cwd: root, env })).stdout)).toEqual({ state: 'IDLE', autoTurns: 0 });
    await addTask(root, { title: 'CLI 상태', category: 'docs' });
    await updateState(root, { state: 'PICK' });
    expect(JSON.parse((await exec(cli, ['state','transition','SPEC','--task','T01'], { cwd: root, env })).stdout)).toMatchObject({ state: 'SPEC', taskId: 'T01' });
    expect(JSON.parse((await exec(cli, ['doctor'], { cwd: root, env })).stdout)).toMatchObject({ ok: true });
    await expect(exec(cli, ['doctor'], { cwd: root, env: { ...env, ANTHROPIC_API_KEY: '' } })).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/^\{"error":.*\}\n$/) });
    await expect(exec(cli, ['unknown'], { cwd: root, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/^\{"error":.*\}\n$/) });
  });
});
