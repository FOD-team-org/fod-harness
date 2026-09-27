import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rateLimitVerdict } from '../src/provider/rate-limit.ts';
import { runTurn, packageRoot } from '../src/provider/turn.ts';
import { childEnv } from '../src/provider/runner.ts';
import { readState } from '../src/core/state.ts';
import { listProcs } from '../src/core/procs.ts';
import { doctor, doctorFailureMessage } from '../src/cli/doctor.ts';

// RL1 이전 turn.ts의 두 조건을 그대로 보존한 비교 기준.
function legacyVerdict(info: any): 'continue' | 'quota' | 'billing' {
  if (info?.status === 'rejected' && info?.isUsingOverage !== true
    && (info?.overageStatus === undefined || info.overageStatus === 'rejected')) return 'quota';
  if (info?.isUsingOverage === true || info?.overageStatus !== 'rejected') return 'billing';
  return 'continue';
}

const roots: string[] = [];
const fake = resolve('test/fake-claude/claude');
const fakeSwitch = resolve('test/fake-claude/switch');
async function project(maxTurnMinutes = 0.2) {
  const root = await mkdtemp('/private/tmp/fodh-rl1-'); roots.push(root);
  await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ ui: { brainOutput: 'full' }, brain: {
    allowedModels: ['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet'],
    command: fake, switchCommand: [fakeSwitch], model: 'haiku', maxTurnMinutes,
  } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', autoTurns: 0 }));
  return root;
}
const environment = (root: string, scenario = 'first') => ({
  ...childEnv(), HOME: root, FAKE_CLAUDE_SCENARIO: scenario, FODH_PACKAGE_ROOT: packageRoot, FODH_NOTIFY_OS: 'off',
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    try { expect(await listProcs(root)).toEqual([]); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

describe('RL1 rate_limit_event', () => {
  it('75칸 격자와 비객체 3건 중 행 5의 정확히 2칸만 billing → continue', () => {
    const missing = Symbol('키 없음');
    const statuses = [missing, 'allowed', 'allowed_warning', 'rejected', 'weird'];
    const overages = [missing, 'rejected', 'allowed', 'allowed_warning', null];
    const usingOverages = [missing, true, false];
    const changed: Record<string, unknown>[] = [];
    let cells = 0;
    for (const status of statuses) for (const overageStatus of overages) for (const isUsingOverage of usingOverages) {
      const info = {
        ...(status === missing ? {} : { status }),
        ...(overageStatus === missing ? {} : { overageStatus }),
        ...(isUsingOverage === missing ? {} : { isUsingOverage }),
      };
      const before = legacyVerdict(info), after = rateLimitVerdict(info);
      const row5 = overageStatus === missing && isUsingOverage === false
        && (status === 'allowed' || status === 'allowed_warning');
      expect(after, JSON.stringify(info)).toBe(row5 ? 'continue' : before);
      if (row5) expect(before).toBe('billing');
      if (after !== before) changed.push(info);
      cells++;
    }
    expect(cells).toBe(75);
    for (const info of [undefined, null, 'not-an-object']) {
      expect(rateLimitVerdict(info)).toBe(legacyVerdict(info));
      expect(rateLimitVerdict(info)).toBe('billing');
      cells++;
    }
    expect(cells).toBe(78);
    expect(changed).toHaveLength(2);
    expect(changed).toEqual([
      { status: 'allowed', isUsingOverage: false },
      { status: 'allowed_warning', isUsingOverage: false },
    ]);
  });

  it('실제 allowed_warning 이벤트는 초과 사용 필드가 없어도 계속한다', () => {
    const event = { type: 'rate_limit_event', rate_limit_info: {
      status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.79,
      isUsingOverage: false, surpassedThreshold: 0.75,
      unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.79 } },
    } };
    expect(rateLimitVerdict(event.rate_limit_info)).toBe('continue');
  });

  it.each([undefined, null, false, 0, {}, []])('존재하는 overageStatus=%j는 키 없음으로 취급하지 않는다', overageStatus => {
    expect(rateLimitVerdict({ status: 'allowed_warning', isUsingOverage: false, overageStatus })).toBe('billing');
  });
  it.each([null, 0, '', 'false'])('isUsingOverage=%j는 정확한 false가 아니다', isUsingOverage => {
    expect(rateLimitVerdict({ status: 'allowed_warning', isUsingOverage })).toBe('billing');
  });

  it('overage-warning은 stop, 과금 일시정지·알림 없이 rateLimitInfo를 저장한다', async () => {
    const root = await project(), notify = vi.fn();
    expect(await runTurn('진행', { root, model: 'haiku', env: environment(root, 'overage-warning'), notify }))
      .toMatchObject({ reason: 'stop' });
    const state = await readState(root);
    expect(state.state).not.toBe('paused(billing)');
    expect(notify).not.toHaveBeenCalled();
    expect(state.rateLimitInfo).toMatchObject({ status: 'allowed_warning', isUsingOverage: false });
    expect(state.rateLimitInfo).not.toHaveProperty('overageStatus');
    expect(state.rateLimitInfo).not.toHaveProperty('overageDisabledReason');
  });

  it.each(['overage-warning-unknown', 'overage'])('%s는 aborted·billing·paused(billing)·알림 1회', async scenario => {
    const root = await project(), notify = vi.fn();
    expect(await runTurn('진행', { root, model: 'haiku', env: environment(root, scenario), notify }))
      .toMatchObject({ reason: 'aborted', classification: 'billing' });
    const state = await readState(root);
    expect(state.state).toBe('paused(billing)');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('추가 사용 과금 가능성을 감지하여 두뇌를 중단했습니다.');
    if (scenario === 'overage-warning-unknown') {
      expect(state.rateLimitInfo).toMatchObject({ status: 'allowed_warning' });
      expect(state.rateLimitInfo).not.toHaveProperty('overageStatus');
      expect(state.rateLimitInfo).not.toHaveProperty('overageDisabledReason');
      expect(state.rateLimitInfo).not.toHaveProperty('isUsingOverage');
    } else expect(state.rateLimitInfo).toMatchObject({ isUsingOverage: true });
  });
});

describe('RL1 doctor 오류 문구', () => {
  // fake doctor 분기는 overage의 rate_limit_event를 재생하지 않으므로 §3.4 대체 경로를 쓴다.
  it('billing은 과금 보호 원인과 확인 경로를 안내한다', () => {
    const message = doctorFailureMessage('billing');
    expect(message).toBe('configError: billing — 과금 보호로 doctor 두뇌 호출이 멈췄습니다. 초과 사용 신호를 확인하세요(/status 의 rateLimit)');
    expect(message).not.toContain('훅 실제 차단 시험');
  });
  it.each(['quota', 'configError: quota'])('%s는 사용 한도를 안내한다', classification => {
    expect(doctorFailureMessage(classification)).toBe('configError: quota — 사용 한도에 걸려 doctor 두뇌 호출을 끝내지 못했습니다');
  });
  it.each([undefined, 'configError', 'deadline', 'cleanupFailed'])('그 밖 %s는 기존 문구를 보존한다', classification => {
    expect(doctorFailureMessage(classification)).toBe(`configError: 훅 실제 차단 시험에 실패했습니다(${classification}).`);
  });
  it('doctor 호출도 가짜 api-key 시나리오의 billing을 과금 보호 문구로 전달한다', async () => {
    const root = await project();
    await expect(doctor(root, { env: environment(root, 'api-key') })).rejects.toThrow(doctorFailureMessage('billing'));
    expect((await readState(root)).doctor).toMatchObject({ ok: false });
  });
});
