import { afterEach, expect, it, vi } from 'vitest';
import { lockOwnerAlive } from '../src/core/lock.ts';
import { processStartedAt } from '../src/core/process-time.ts';

const ps = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: ps }) };
});

const cTime = 'Thu Sep 24 05:39:36 2026';
const koTime = '2026년  9월 24일 목요일 05시 39분 36초';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); ps.mockReset(); });

it('한국어 부모 로케일에서도 ps에 C 로케일을 전달해 startedAt을 파싱한다 (ps mock)', async () => {
  vi.stubEnv('LC_ALL', 'ko_KR.UTF-8');
  vi.stubEnv('LANG', 'ko_KR.UTF-8');
  ps.mockImplementation(async (_command, _args, options) => ({
    stdout: ` ${options.env.LC_ALL === 'C' && options.env.LANG === 'C' ? cTime : koTime}\n`, stderr: '',
  }));
  const startedAt = await processStartedAt(process.pid);
  expect(startedAt).toBe(cTime);
  expect(Number.isFinite(Date.parse(startedAt!))).toBe(true);
  expect(ps).toHaveBeenCalledWith('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
    timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  expect(process.env.LC_ALL).toBe('ko_KR.UTF-8');
  expect(process.env.LANG).toBe('ko_KR.UTF-8');
});

it.each([
  [koTime, koTime, true],
  [koTime, '2026년  9월 24일 목요일 05시 39분 26초', false],
  [cTime, koTime, false],
  ['', koTime, true],
  [cTime, '', true],
])('시각 파싱 불가 시 원문 비교, 비교 불가 시 alive 유지: %s / %s', async (actual, expected, alive) => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  ps.mockResolvedValue({ stdout: actual, stderr: '' });
  await expect(lockOwnerAlive({ pid: process.pid, token: 'locale', startedAt: expected })).resolves.toBe(alive);
});

it('ps 제한은 시작 시각 미확인으로 남기며 살아 있는 잠금 소유자를 회수하지 않는다 (ps mock)', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  ps.mockRejectedValue(Object.assign(new Error('시험용 ps 제한'), { code: 'EPERM' }));
  await expect(processStartedAt(process.pid)).resolves.toBeUndefined();
  await expect(lockOwnerAlive({ pid: process.pid, token: 'locale', startedAt: cTime })).resolves.toBe(true);
});
