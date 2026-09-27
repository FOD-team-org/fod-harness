import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rateLimitVerdict } from '../src/provider/rate-limit.ts';
import { runTurn, packageRoot } from '../src/provider/turn.ts';
import { childEnv } from '../src/provider/runner.ts';
import { readState } from '../src/core/state.ts';
import { readLedger, unknownEntries } from '../src/core/ledger.ts';
import { listProcs } from '../src/core/procs.ts';
import { decidePick } from '../src/core/pick.ts';
import { doctor, doctorFailureMessage } from '../src/cli/doctor.ts';

const roots: string[] = [];
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-rl2-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ ui: { brainOutput: 'full' }, brain: {
    allowedModels: ['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet'],
    command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')],
    model: 'haiku', maxTurnMinutes: 0.2,
  } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', autoTurns: 0 }));
  return root;
}
const environment = (root: string, scenario: string) => ({
  ...childEnv(), HOME: root, FAKE_CLAUDE_SCENARIO: scenario, FODH_PACKAGE_ROOT: packageRoot, FODH_NOTIFY_OS: 'off',
});
async function expectNoSwitchAndOneCall(root: string) {
  await expect(readFile(join(root, '.pi/fake-switch.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  const calls = (await readFile(join(root, '.pi/fake-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toHaveLength(1);
  expect((await readLedger(root)).filter(entry => entry.action === 'switch')).toEqual([]);
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    try { expect(await listProcs(root)).toEqual([]); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

const missing = Symbol('키 없음');
const grid = [missing, 'allowed', 'allowed_warning', 'rejected', 'weird'].flatMap(status =>
  [missing, 'rejected', 'allowed', 'allowed_warning', null].flatMap(overageStatus =>
    [missing, true, false].map(isUsingOverage => ({
      info: {
        ...(status === missing ? {} : { status }),
        ...(overageStatus === missing ? {} : { overageStatus }),
        ...(isUsingOverage === missing ? {} : { isUsingOverage }),
      },
      expected: status === 'rejected' ? 'quota' : 'continue',
    }))));

describe('RL2 rate_limit_event', () => {
  it.each(grid)('75칸 격자 %#: $info → $expected', ({ info, expected }) => {
    expect(rateLimitVerdict(info)).toBe(expected);
  });
  it.each([undefined, null, 'not-an-object', false, 0, []])('비객체·배열 %j는 계속한다', info => {
    expect(rateLimitVerdict(info)).toBe('continue');
  });
  it('실제 allowed_warning 이벤트는 사용률 정보와 무관하게 계속한다', () => {
    expect(rateLimitVerdict({
      status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.79,
      isUsingOverage: false, surpassedThreshold: 0.75,
      unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.79 } },
    })).toBe('continue');
  });
  it.each([undefined, null, false, 0, {}, []])('overageStatus=%j도 판정에 관여하지 않는다', overageStatus => {
    expect(rateLimitVerdict({ status: 'allowed_warning', isUsingOverage: false, overageStatus })).toBe('continue');
    expect(rateLimitVerdict({ status: 'rejected', overageStatus })).toBe('quota');
  });
  it.each([null, 0, '', 'false'])('isUsingOverage=%j도 판정에 관여하지 않는다', isUsingOverage => {
    expect(rateLimitVerdict({ status: 'allowed_warning', isUsingOverage })).toBe('continue');
    expect(rateLimitVerdict({ status: 'rejected', isUsingOverage })).toBe('quota');
  });
  it.each(['overage', 'overage-status', 'overage-warning', 'overage-warning-unknown'])('%s는 stop·알림 0회·사용량 기록', async scenario => {
    const root = await project(), notify = vi.fn();
    expect(await runTurn('진행', { root, env: environment(root, scenario), notify })).toMatchObject({ reason: 'stop' });
    const state = await readState(root);
    expect(state.state).not.toBe('paused(billing)');
    expect(notify).not.toHaveBeenCalled();
    if (scenario.startsWith('overage-warning')) {
      expect(state.rateLimitInfo).toMatchObject({ status: 'allowed_warning' });
      expect(state.rateLimitInfo).not.toHaveProperty('overageStatus');
      expect(state.rateLimitInfo).not.toHaveProperty('overageDisabledReason');
      if (scenario === 'overage-warning') expect(state.rateLimitInfo).toHaveProperty('isUsingOverage', false);
      else expect(state.rateLimitInfo).not.toHaveProperty('isUsingOverage');
    } else if (scenario === 'overage') expect(state.rateLimitInfo).toMatchObject({ isUsingOverage: true });
    else expect(state.rateLimitInfo).toMatchObject({ overageStatus: 'allowed' });
    await expectNoSwitchAndOneCall(root);
  });
  it.each(['rate-limited', 'stderr-limit', 'rate-limited-text', 'rate-rejected'])('%s는 전환·즉시 재시도 없이 paused(quota), PICK은 5분 뒤 재시도', async scenario => {
    const root = await project(), notify = vi.fn();
    expect(await runTurn('진행', { root, env: environment(root, scenario), notify }))
      .toMatchObject({ reason: 'error', classification: 'quota' });
    const state = await readState(root);
    expect(state.state).toBe('paused(quota)');
    expect(notify).not.toHaveBeenCalled();
    await expectNoSwitchAndOneCall(root);
    expect(await unknownEntries(root)).toEqual([]);
    if (scenario === 'rate-rejected') expect(state.rateLimitInfo).toMatchObject({ status: 'rejected', overageStatus: 'rejected' });
    const now = Date.parse('2026-09-27T00:00:00.000Z');
    expect(decidePick([], state, { slots: 'ok', now })).toMatchObject({
      outcome: 'WAIT_RETRY', retry: { count: 1, nextAt: '2026-09-27T00:05:00.000Z' },
    });
  });
  it('이번 run의 unknown은 quota 일시정지보다 복구가 우선이다', async () => {
    const root = await project();
    const result = await runTurn('진행', { root, env: environment(root, 'quota-tool') });
    expect(result).toMatchObject({ reason: 'error', classification: 'unknown' });
    expect((await readState(root)).state).toBe('recovering');
    expect(await unknownEntries(root)).toContainEqual(expect.objectContaining({ runId: result.runId, action: 'brain:0' }));
    await expectNoSwitchAndOneCall(root);
  });
  it('API 키 경로는 여전히 billing·일시정지·새 알림 1회', async () => {
    const root = await project(), notify = vi.fn();
    expect(await runTurn('진행', { root, env: environment(root, 'api-key'), notify }))
      .toMatchObject({ reason: 'aborted', classification: 'billing' });
    expect((await readState(root)).state).toBe('paused(billing)');
    expect(notify).toHaveBeenCalledExactlyOnceWith('API 키 과금 경로를 감지해 두뇌를 멈췄습니다. 구독 로그인으로 실행되는지 확인하세요(apiKeySource).');
    await expectNoSwitchAndOneCall(root);
  });
});

describe('RL2 doctor 오류 문구', () => {
  it('billing은 API 키 과금 경로를 안내한다', () => {
    expect(doctorFailureMessage('billing')).toBe('configError: billing — 두뇌가 구독 로그인이 아니라 API 키로 실행됐습니다. API 키 환경변수·apiKeyHelper 를 확인하세요');
  });
  it.each(['quota', 'configError: quota'])('%s는 기존 사용 한도 문구를 유지한다', classification => {
    expect(doctorFailureMessage(classification)).toBe('configError: quota — 사용 한도에 걸려 doctor 두뇌 호출을 끝내지 못했습니다');
  });
  it.each([undefined, 'configError', 'deadline', 'cleanupFailed'])('그 밖 %s는 기존 문구를 보존한다', classification => {
    expect(doctorFailureMessage(classification)).toBe(`configError: 훅 실제 차단 시험에 실패했습니다(${classification}).`);
  });
  it.each(['api-key', 'rate-limited', 'stderr-limit', 'rate-limited-text', 'rate-rejected'])('doctor %s도 분류별 문구를 전달하고 전환하지 않는다', async scenario => {
    const root = await project();
    await expect(doctor(root, { env: environment(root, scenario) }))
      .rejects.toThrow(doctorFailureMessage(scenario === 'api-key' ? 'billing' : 'quota'));
    expect(await readState(root)).toMatchObject({ state: 'IDLE', doctor: { ok: false } });
    await expectNoSwitchAndOneCall(root);
  });
});
