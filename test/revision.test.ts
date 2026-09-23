import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { main } from '../src/cli/index.ts';
import { doctor } from '../src/cli/doctor.ts';
import { acquireLock, lockOwnerAlive } from '../src/core/lock.ts';
import * as state from '../src/core/state.ts';
import { appendLedger, readLedger, unknownEntries } from '../src/core/ledger.ts';
import { addInbox, listInbox } from '../src/core/inbox.ts';
import { addJudgment, answerJudgment, readJudgment, completeJudgment, classifyAnswer } from '../src/core/judgment.ts';
import { childEnv } from '../src/provider/runner.ts';
import { checkBillingEnvironment, billingEnvKeys } from '../src/provider/preflight.ts';
import { redact, safeValue } from '../src/provider/privacy.ts';
import { runTurn, lastCallUsage, turnDeadlineMs, packageRoot } from '../src/provider/turn.ts';
import { streamClaude } from '../extensions/provider/stream.ts';
import { listProcs } from '../src/core/procs.ts';

const roots: string[] = [];
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-revision-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: {
    command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')],
    model: 'haiku', maxTurnMinutes: 0.015,
  } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  return root;
}
const env = (root: string, scenario = 'first') => ({ ...childEnv(), HOME: root, FAKE_CLAUDE_SCENARIO: scenario });
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const root of roots.splice(0)) {
    expect(await listProcs(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  }
});
async function cli(root: string, args: string[]) {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += chunk; return true; });
  process.exitCode = 0;
  try { await main(args, root); return { code: process.exitCode, value: JSON.parse(output) }; }
  finally { write.mockRestore(); }
}
it('잠금 중 IMPLEMENT/MERGE는 저장된 doctor만 확인하고 doctor CLI는 즉시 실패한다', async () => {
  const root = await project(), release = await acquireLock(join(root, '.pi/harness.lock'));
  try {
    for (const target of ['IMPLEMENT', 'MERGE']) {
      for (const hours of [0, 13]) {
        await state.updateState(root, { doctor: { ok: true, checkedAt: new Date(Date.now() - hours * 3600000).toISOString() } });
        const start = Date.now(), result = await cli(root, ['state', 'transition', target]);
        expect(Date.now() - start).toBeLessThan(1000);
        expect(result.code).toBe(hours ? 1 : 0);
        if (hours) expect(result.value.error).toBe('doctor 검증이 없거나 오래되었습니다. Pi 세션을 재시작하거나 fodh doctor 를 실행하세요.');
      }
    }
    const start = Date.now(), result = await cli(root, ['doctor']);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toEqual({ code: 1, value: { error: 'Pi 세션이 잠금을 보유 중입니다. 세션에서 doctor 가 수행됩니다.' } });
    await expect(readFile(join(root, '.pi/fake-calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await release(); }
});
it('ledger CLI는 unknown을 나열하고 원문을 보존하며 증거와 함께 append 종결한다', async () => {
  const root = await project();
  await appendLedger(root, { runId: 'old', action: 'effect', status: 'unknown' });
  const before = await readFile(join(root, '.pi/harness-ledger.jsonl'), 'utf8');
  expect((await cli(root, ['ledger', 'list', '--unknown'])).value).toHaveLength(1);
  expect((await cli(root, ['ledger', 'resolve', 'old', 'effect', 'ok', '--evidence', '결과 파일 확인'])).value)
    .toMatchObject({ status: 'ok', evidence: { resolvedBy: 'fodh', note: '결과 파일 확인' } });
  expect(await unknownEntries(root)).toEqual([]);
  expect((await readFile(join(root, '.pi/harness-ledger.jsonl'), 'utf8')).startsWith(before)).toBe(true);
  expect((await cli(root, ['ledger', 'list'])).value).toHaveLength(2);
});
it.each(billingEnvKeys)('과금 변수 %s는 프로세스와 settings.env 모두 거부하고 자식에서 제거', async key => {
  const root = await project();
  await expect(checkBillingEnvironment(root, { ...env(root), [key]: '' })).rejects.toThrow('configError');
  expect(childEnv({ [key]: '' })).toEqual({ PATH: join(packageRoot, 'bin') });
  for (const path of ['settings.json', 'settings.local.json']) {
    await writeFile(join(root, '.claude', path), JSON.stringify({ env: { [key]: '' } }));
    await expect(checkBillingEnvironment(root, env(root))).rejects.toThrow('settings.env');
    await writeFile(join(root, '.claude', path), '{}');
  }
});
it('apiKeySource가 none이 아니면 billing 중단과 원장 증거를 남긴다', async () => {
  const root = await project();
  expect(await runTurn('검사', { root, model: 'haiku', env: env(root, 'api-key') })).toMatchObject({ classification: 'billing' });
  expect((await state.readState(root)).state).toBe('paused(billing)');
  expect((await readLedger(root)).find(entry => entry.action.startsWith('system.init'))?.evidence)
    .toMatchObject({ apiKeySource: 'ANTHROPIC_API_KEY' });
});
it('미종료 PEM 도구 결과는 정상 종료하고 전문 대신 요약만 저장한다', async () => {
  const root = await project(); let text = '';
  expect(await runTurn('검사', { root, model: 'haiku', env: env(root, 'pem-result'), onText: value => { text += value; } }))
    .toMatchObject({ reason: 'stop' });
  expect(text).toContain('[비밀값 제거]');
  const results = (await readLedger(root)).filter(entry => entry.action.startsWith('tool_result:'));
  expect(results.length).toBeGreaterThan(0);
  for (const entry of results) expect(Object.keys(entry.evidence as object).sort())
    .toEqual(['is_error', 'length', 'sha256', 'tool_use_id']);
  expect(JSON.stringify(results)).not.toContain('not-a-real-key');
  expect(safeValue({ text: '-----BEGIN PRIVATE KEY-----\nsynthetic', nested: ['정상'], absent: undefined }))
    .toEqual({ text: '[비밀값 제거]', nested: ['정상'], absent: undefined });
  expect(redact('AKIA_short')).toBe('AKIA_short');
  expect(redact('AKIA' + '0'.repeat(16))).toBe('[비밀값 제거]');
  expect(redact('ghp_' + 'x'.repeat(36))).toBe('[비밀값 제거]');
  expect(redact('github_pat_' + 'synthetic')).toBe('[비밀값 제거]');
});
it('긴 도구 결과는 400자와 생략 수로 표시한다', async () => {
  const root = await project(); let text = '';
  await runTurn('검사', { root, model: 'haiku', env: env(root, 'long-result'), onText: value => { text += value; } });
  expect(text).toContain('[도구 결과] ' + 'x'.repeat(400) + '… (600자 생략)');
  expect(text).not.toContain('x'.repeat(401));
});
it('usage 마지막 호출의 문맥 크기를 Pi에 보고하고 없으면 누적 usage/0로 대체한다', async () => {
  const root = await project();
  const model = { id: 'haiku', name: '시험', api: 'claude-code', provider: 'claude-code', baseUrl: 'local://claude-code',
    reasoning: false, input: ['text' as const], contextWindow: 1000000, maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = streamClaude(model, { messages: [] }, undefined, { root, env: env(root, 'iterations') });
  expect((await stream.result()).usage.totalTokens).toBe(33);
  expect(lastCallUsage({ modelUsage: { haiku: { inputTokens: 4, cacheReadInputTokens: 6 } } }))
    .toMatchObject({ contextUsage: true, usage: { input_tokens: 4, cache_read_input_tokens: 6 } });
  expect(lastCallUsage({ usage: { input_tokens: 7 } })).toMatchObject({ contextUsage: false, usage: { input_tokens: 7 } });
  expect(lastCallUsage({}).usage.input_tokens).toBe(0);
});
it.each(['first', 'rate-limited-text', 'api-key'])('doctor %s는 doctor 외 상태 및 inbox를 보존하며 switch하지 않는다', async scenario => {
  const root = await project();
  const original = { state: 'IMPLEMENT', sessionId: 'original', actualModel: 'original-model',
    runId: 'original-run', lastEventAt: 'original-time', rateLimitInfo: { saved: true } };
  await state.updateState(root, original); await addInbox(root, { kind: 'notice' });
  if (scenario === 'first') await doctor(root, { env: env(root, scenario) });
  else await expect(doctor(root, { env: env(root, scenario) })).rejects.toThrow(scenario === 'api-key' ? 'billing' : 'quota');
  expect(await state.readState(root)).toMatchObject(original);
  expect((await listInbox(root))[0].status).toBe('detected');
  expect((await readLedger(root)).filter(entry => entry.action === 'switch')).toHaveLength(0);
  expect(turnDeadlineMs(45, true)).toBe(180000); expect(turnDeadlineMs(1, true)).toBe(60000);
});
it('현재 run의 미해결 tool 이후 quota는 전환을 금지한다', async () => {
  const root = await project();
  expect(await runTurn('검사', { root, model: 'haiku', env: env(root, 'quota-tool') })).toMatchObject({ classification: 'unknown' });
  expect((await readLedger(root)).filter(entry => entry.action === 'switch')).toHaveLength(0);
});
it.each(['deadline', 'user'])('%s 중단 전 훅 denial을 판단대기와 원장에 보존한다', async kind => {
  const root = await project(); const controller = new AbortController();
  const timer = kind === 'user' ? setTimeout(() => controller.abort(), 600) : undefined;
  try {
    expect(await runTurn('검사', { root, model: 'haiku', env: env(root, 'denial-hang'), signal: controller.signal }))
      .toMatchObject({ classification: kind });
  } finally { clearTimeout(timer); }
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await readLedger(root)).some(entry => entry.action.startsWith('hook:'))).toBe(true);
});
it('heartbeat는 연속 이벤트마다 저장하지 않고 마지막 이벤트는 저장한다', async () => {
  const root = await project(), spy = vi.spyOn(state, 'updateState');
  await runTurn('검사', { root, model: 'haiku', env: env(root) });
  const heartbeats = spy.mock.calls.filter(([, patch]) => typeof patch === 'object' && 'lastEventAt' in patch);
  expect(heartbeats).toHaveLength(2);
  expect((await state.readState(root)).lastEventAt).toBe((heartbeats.at(-1)![1] as any).lastEventAt);
  const calls = (await readFile(join(root, '.pi/fake-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls[0].projectRoot).toBe(root);
});
it('src import 그래프에는 Pi 패키지 참조가 없다', async () => {
  async function scan(path: string): Promise<void> {
    for (const file of await readdir(path, { withFileTypes: true })) {
      const next = join(path, file.name);
      if (file.isDirectory()) await scan(next);
      else if (file.name.endsWith('.ts')) expect(await readFile(next, 'utf8')).not.toContain('@mariozechner');
    }
  }
  await scan('src');
});
it('판단 답의 치환 문자 보존, 문항 직접 편집 rev 증가, KST 날짜 및 전체 번호 최대값', async () => {
  const root = await project(), input = { title: '원래 질문', background: '', options: ['유지', '변경'], recommend: '', blocks: '' };
  const added = await addJudgment(root, input);
  const answer = "1 조건 $' $& $` $$";
  expect((await answerJudgment(root, added.item.id, answer)).item.answer).toBe(answer);
  const path = join(root, 'docs/판단대기.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('원래 질문', '수정한 질문'));
  const read = await readJudgment(root, { answered: true });
  expect(read.items[0]).toMatchObject({ rev: 2, classification: { kind: 'revision-mismatch' } });
  expect((await readJudgment(root)).items[0].rev).toBe(2);
  await answerJudgment(root, added.item.id, '1');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-24T16:00:00Z'));
  try {
    expect((await completeJudgment(root, added.item.id, { interpretation: '유지', commit: 'test-proof' })).completed.date).toBe('2026-09-25');
  } finally { vi.useRealTimers(); }
  await writeFile(path, (await readFile(path, 'utf8')) + '\n## 보류\n### A42 — 나중에\n');
  expect((await addJudgment(root, input)).item.id).toBe('A43');
});
it.each(['1 모두 적용', '1 전부 처리', '1 제외 조건'])('단일 번호 문맥 %s는 확정한다', answer => {
  expect(classifyAnswer(answer, ['첫째', '둘째']).applicable).toBe(true);
});
it.each(['모두', '전부', '1과 2 제외'])('다중 선택 문맥 %s는 모호 처리한다', answer => {
  expect(classifyAnswer(answer, ['첫째', '둘째']).applicable).toBe(false);
});
it('잠금 소유자의 실제 프로세스 시작 시각이 다르면 PID가 살아 있어도 stale이다', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  expect(Number.isFinite(Date.parse(stdout.trim()))).toBe(true);
  const startedAt = new Date(Date.parse(stdout.trim()));
  expect(await lockOwnerAlive({ pid: process.pid, token: 'test', startedAt: startedAt.toISOString() })).toBe(true);
  expect(await lockOwnerAlive({ pid: process.pid, token: 'test', startedAt: new Date(startedAt.getTime() - 10000).toISOString() })).toBe(false);
});
