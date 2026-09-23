import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { groupAlive, reclaimOwnedGroup, runProcess } from '../src/provider/runner.ts';
import { listProcs, removeProc } from '../src/core/procs.ts';

const psMode = vi.hoisted(() => ({ unavailable: false, delayMs: 0 }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execAsync = promisify(actual.execFile);
  return { ...actual,
    execFileSync: vi.fn((...args: Parameters<typeof actual.execFileSync>) => {
      if (args[0] === '/bin/ps' && psMode.unavailable) throw Object.assign(new Error('ps mock'), { code: 'EPERM' });
      return actual.execFileSync(...args);
    }),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: vi.fn(async (...args: Parameters<typeof execAsync>) => {
      if (args[0] === '/bin/ps') {
        if (psMode.delayMs) await new Promise(resolve => setTimeout(resolve, psMode.delayMs));
        if (psMode.unavailable) throw Object.assign(new Error('ps mock'), { code: 'EPERM' });
      }
      return execAsync(...args);
    }) }),
  };
});

const pgid = 123456789;
const errorWithCode = (code: string) => Object.assign(new Error('시험용 프로세스 오류'), { code });
afterEach(() => {
  psMode.unavailable = false; psMode.delayMs = 0;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('groupAlive는 EPERM을 살아 있는 그룹으로 처리하며 ps를 호출하지 않는다', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw errorWithCode('EPERM'); });
  expect(groupAlive(pgid)).toBe(true);
  expect(execFileSync).not.toHaveBeenCalled();
});
it.each(['EACCES', 'EIO'])('groupAlive는 %s를 ps 그룹 목록으로 재확인한다', code => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw errorWithCode(code); });
  vi.mocked(execFileSync).mockReturnValueOnce(`123 ${pgid}\n456 999\n`);
  expect(groupAlive(pgid)).toBe(true);
  expect(execFileSync).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  vi.mocked(execFileSync).mockReturnValueOnce('123 999\n');
  expect(groupAlive(pgid)).toBe(false);
});
it('groupAlive는 ps도 실패하면 예외 없이 살아 있음으로 처리한다', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw errorWithCode('EACCES'); });
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw errorWithCode('EPERM'); });
  expect(groupAlive(pgid)).toBe(true);
});
it.each(['EPERM', 'EIO'])('회수 중 %s 오류가 발생하면 throw 대신 false를 반환한다', async code => {
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) return true;
    throw errorWithCode(code);
  });
  await expect(reclaimOwnedGroup(pgid)).resolves.toBe(false);
});
it('ESRCH는 ps 없이 부재로 확정하고 추가 신호 없이 회수를 완료한다', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw errorWithCode('ESRCH'); });
  await expect(reclaimOwnedGroup(pgid)).resolves.toBe(true);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith(-pgid, 0);
  expect(execFileSync).not.toHaveBeenCalled();
});
it('종료 경합의 SIGTERM EPERM 뒤에도 커널이 부재를 확인하면 회수 성공이다', async () => {
  let probes = 0;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal !== 0) throw errorWithCode('EPERM');
    if (++probes <= 2) return true;
    throw errorWithCode('ESRCH');
  });
  await expect(reclaimOwnedGroup(pgid)).resolves.toBe(true);
  expect(kill).toHaveBeenCalledWith(-pgid, 'SIGTERM');
  expect(execFileSync).not.toHaveBeenCalled();
});
it('SIGTERM EPERM 뒤 생존 조회도 EPERM이면 회수 성공으로 오판하지 않는다', async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw errorWithCode('EPERM'); });
    const reclaimed = reclaimOwnedGroup(pgid);
    await vi.runAllTimersAsync();
    await expect(reclaimed).resolves.toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it('SIGTERM EPERM 뒤 다른 생존 조회 오류는 ps로 성공을 추정하지 않는다', async () => {
  let probes = 0;
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal !== 0) throw errorWithCode('EPERM');
    if (++probes === 1) return true;
    throw errorWithCode('EIO');
  });
  await expect(reclaimOwnedGroup(pgid)).resolves.toBe(false);
  expect(execFileSync).not.toHaveBeenCalled();
});
it('분리 자손이 stdout을 유지해도 10초 내 반환하고 cleaned:false로 남긴다', async () => {
  const root = await mkdtemp('/private/tmp/fodh-runner-');
  const runId = 'hang-orphan-test';
  await mkdir(join(root, '.pi'));
  try {
    const start = Date.now();
    const result = await runProcess({
      root, runId, command: resolve('test/fake-claude/claude'),
      args: ['--verbose', '--session-id', 'runner-orphan-session'], maxMs: 900,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'hang-orphan' },
      onEvent: () => {},
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(3900);
    expect(elapsed).toBeLessThan(10000);
    expect(result).toMatchObject({ cleaned: false, abortKind: 'deadline' });
    expect(await listProcs(root)).toEqual([expect.objectContaining({ pid: result.pid, runId })]);
    const pids = (await readFile(join(root, '.pi/fake-pids.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { pid: number });
    expect(pids).toHaveLength(2);
    const orphan = pids.find(record => record.pid !== result.pid);
    expect(orphan).toBeDefined();
    expect(() => process.kill(orphan!.pid, 0)).not.toThrow();
  } finally {
    // 이 테스트가 직접 생성해 기록한 프로세스만 정리한다. P4 이전의 잔존 자손은 자동 회수하지 않는다.
    let pids: { pid: number }[] = [];
    try {
      pids = (await readFile(join(root, '.pi/fake-pids.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
    } catch { /* spawn 이전 실패일 수 있다. */ }
    for (const { pid } of pids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    for (const record of await listProcs(root)) await removeProc(root, record.pid, runId);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it.each([
  ['first', 0, false], ['no-verbose', 1, false], ['first', 0, true], ['no-verbose', 1, true],
] as const)('%s 종료 code=%s, ps 거부=%s: 출력 소비 후 cleaned:true 및 빈 레지스트리', async (scenario, code, denied) => {
  const root = await mkdtemp('/private/tmp/fodh-runner-close-');
  psMode.unavailable = denied;
  // 이전 50ms 휴리스틱보다 등록이 늦어도 즉시 오류 종료를 오판하지 않아야 한다.
  psMode.delayMs = 100;
  try {
    const events: Record<string, any>[] = [];
    const result = await runProcess({
      root, runId: 'close-regression', command: resolve('test/fake-claude/claude'),
      args: ['--verbose', '--session-id', 'close-regression'], maxMs: 5000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario }, onEvent: event => { events.push(event); },
    });
    expect(result).toMatchObject({ code, cleaned: true });
    expect(await listProcs(root)).toEqual([]);
    if (scenario === 'first') expect(events.at(-1)?.type).toBe('result');
    else expect(result.stderr).toContain('requires --verbose');
    if (denied) {
      const { promisify } = await import('node:util');
      expect(vi.mocked((execFile as any)[promisify.custom])).toHaveBeenCalled();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('stdout EOF만으로 회수하지 않고 실제 정상 종료까지 기다린다', async () => {
  const root = await mkdtemp('/private/tmp/fodh-runner-eof-');
  try {
    const result = await runProcess({
      root, runId: 'eof-regression', command: resolve('test/fake-claude/claude'),
      args: ['--verbose', '--session-id', 'eof-regression'], maxMs: 5000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'eof-before-exit' }, onEvent: () => {},
    });
    expect(result).toMatchObject({ code: 0, cleaned: true });
    expect(result.stderr).toContain('EOF 뒤 정상 종료');
    expect(await listProcs(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
