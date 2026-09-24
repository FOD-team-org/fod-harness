import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCodex, cancel, readMeta, resultDir } from '../src/core/codex.ts';
import { requestCancel } from '../src/core/codex-record.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';

const roots: string[] = [], pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  await delay(100);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function until(check: () => Promise<boolean>, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error('stub supervisor condition timed out');
}
async function running() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-supervisor-life-')); roots.push(root);
  vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  // The shell consumes Codex arguments; only sleep runs as the delegated command.
  await setConfig(root, 'delegate.codex.command', JSON.stringify(['/bin/sh', '-c', 'exec sleep 60', 'stub']));
  await updateState(root, { state: 'RESEARCH' });
  await writeFile(join(root, 'spec.md'), 'sleep stub');
  const run = await startCodex(root, 'research', { spec: 'spec.md' });
  if (!('pid' in run)) throw new Error('non-wait start must return supervisor pid');
  const pid = run.pid; pids.push(pid);
  await until(async () => !!(await readMeta(root, run.runId))?.childPid);
  return { root, runId: run.runId, pid };
}
async function ignoredTerm(root: string, runId: string, pid: number) {
  process.kill(pid, 'SIGTERM');
  await until(async () => (await readLedger(root)).some(item => item.action === 'codex:signal'));
  process.kill(pid, 'SIGTERM');
  await delay(150);
  expect(process.kill(pid, 0)).toBe(true);
  expect((await readMeta(root, runId))?.finishedAt).toBeUndefined();
  expect((await readLedger(root)).filter(item => item.action === 'codex:signal')).toEqual([
    expect.objectContaining({ runId, status: 'skip', evidence: { signal: 'SIGTERM', ignored: true } }),
  ]);
  expect((await readFile(join(resultDir(root, runId), 'supervisor.log'), 'utf8')).match(/SIGTERM ignored/g)).toHaveLength(1);
}
it('F23 실제 2단 런처: 감독 ppid=1, pgid=pid (실제 ps 필요)', async () => {
  const { pid } = await running();
  const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'ppid=,pgid=', '-p', String(pid)]);
  expect(stdout.trim().split(/\s+/u).map(Number)).toEqual([1, pid]);
});
it('F23 실제 표지 없는 SIGTERM은 무시하고 run당 로그·원장 1회', async () => {
  const { root, runId, pid } = await running();
  await ignoredTerm(root, runId, pid);
});
it('F23 실제 무표지 TERM 뒤 cancel()은 표지를 쓰고 cancelled (실제 ps 필요)', async () => {
  const { root, runId, pid } = await running();
  await ignoredTerm(root, runId, pid);
  expect(await cancel(root, runId)).toMatchObject({ status: 'cancelled' });
  expect(JSON.parse(await readFile(join(resultDir(root, runId), 'cancel.json'), 'utf8')))
    .toMatchObject({ by: 'cancel', at: expect.any(String) });
});
it('F23 실제 감독은 하네스 취소 표지가 있는 TERM만 cancelled로 마감', async () => {
  const { root, runId, pid } = await running();
  await requestCancel(root, runId, 'cleanup');
  process.kill(pid, 'SIGTERM');
  await until(async () => !!(await readMeta(root, runId))?.finishedAt, 15000);
  expect(await readMeta(root, runId)).toMatchObject({ status: 'cancelled' });
  expect((await readLedger(root)).filter(item => item.action === 'codex:signal')).toEqual([]);
});
