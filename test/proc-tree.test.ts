import { afterEach, expect, it, vi } from 'vitest';
const system = vi.hoisted(() => ({ execute: vi.fn(), alive: vi.fn(), groupAlive: vi.fn(), clock: 0 }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: (...args: unknown[]) => {
    const promise = Promise.resolve().then(() => system.execute(...args));
    return Object.assign(promise, { child: { pid: 990 } });
  } });
  return { ...actual, execFile };
});
vi.mock('../src/core/lock.ts', () => ({ isProcessAlive: system.alive }));
vi.mock('../src/provider/runner.ts', () => ({ groupAlive: system.groupAlive }));
vi.mock('node:timers/promises', () => ({ setTimeout: async (ms: number) => { system.clock += ms; } }));
import { processTreeSnapshot, reclaimCodexTree } from '../src/core/proc-tree.ts';
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); system.clock = 0; });
it('ps 한 번으로 별도 그룹 폐쇄·재부모화 구성원을 찾고 조회 ps와 자신을 제외한다', async () => {
  system.execute.mockResolvedValue({ stdout: `${process.pid} 1 100\n990 ${process.pid} 100\n200 ${process.pid} 100\n300 200 300\n301 1 300\n`, stderr: '' });
  expect(await processTreeSnapshot(100, [])).toEqual({ pids: [200, 300, 301], toolGroups: [300] });
  expect(system.execute).toHaveBeenCalledTimes(1);
  expect(system.execute).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 1000 });
});
it('TERM 뒤 죽었다가 재사용된 PID와 그 자식은 KILL 대상에 다시 넣지 않는다', async () => {
  let term = false, observedDead = false, killed = false;
  vi.spyOn(Date, 'now').mockImplementation(() => system.clock);
  system.alive.mockImplementation((pid: number) => {
    if (pid === 200 && term && !observedDead) { observedDead = true; return false; }
    return pid === 200 || pid === 300 && !killed;
  });
  system.groupAlive.mockImplementation((pgid: number) => pgid === 100 ? !term : pgid === 300 && !killed);
  system.execute.mockImplementation(() => ({ stdout: !term ? '200 100 100\n300 200 300\n'
    : `200 999 200\n201 200 201\n${killed ? '' : '300 1 300\n'}`, stderr: '' }));
  const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
    if (pid === 200 && name === 'SIGTERM') term = true;
    if (pid === 300 && name === 'SIGKILL') killed = true;
    return true;
  });
  expect(await reclaimCodexTree(100)).toBe(true);
  expect(observedDead).toBe(true); expect(signal).toHaveBeenCalledWith(300, 'SIGKILL');
  expect(signal).not.toHaveBeenCalledWith(200, 'SIGKILL');
  expect(signal.mock.calls.some(([pid]) => pid === 201)).toBe(false);
});
it('기록된 도구 그룹이 남으면 회수 성공을 반환하지 않는다', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => system.clock);
  system.alive.mockReturnValue(true); system.groupAlive.mockImplementation((pgid: number) => pgid === 300);
  system.execute.mockResolvedValue({ stdout: '301 1 300\n', stderr: '' });
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await reclaimCodexTree(0, [], [300])).toBe(false);
  expect(signal).toHaveBeenCalledWith(301, 'SIGTERM'); expect(signal).toHaveBeenCalledWith(301, 'SIGKILL');
});
