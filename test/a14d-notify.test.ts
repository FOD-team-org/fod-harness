import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { notify } from '../src/core/notify.ts';
import { readLedger } from '../src/core/ledger.ts';
const exec = vi.hoisted(() => vi.fn(async () => ({ stdout: '', stderr: '' })));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: exec }) };
});
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); exec.mockClear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(['off', 'injected', 'unset'])('macos 실행 경로 %s, TUI·원장 보존', async mode => {
  const root = await mkdtemp('/private/tmp/fodh-a14d-notify-'); roots.push(root);
  vi.stubEnv('FODH_NOTIFY_OS', mode === 'unset' ? undefined : 'off');
  const injected = vi.fn(async () => {}), tui = vi.fn();
  await notify(root, { key: 'test', level: 'info', title: '시험', body: '본문' }, { notify: tui }, mode === 'injected' ? { exec: injected } : {});
  const osCalls = exec.mock.calls.filter((call: unknown[]) => call[0] === 'osascript');
  expect(osCalls).toHaveLength(mode === 'unset' ? 1 : 0);
  expect(injected).toHaveBeenCalledTimes(mode === 'injected' ? 1 : 0);
  expect(tui).toHaveBeenCalledWith('본문', 'info');
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:test', status: 'ok' }));
  if (mode === 'off') expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:macos', status: 'skip', evidence: { reason: 'FODH_NOTIFY_OS=off' } }));
});
it('vitest와 가짜 자식이 상속하는 OS 알림 차단 환경', async () => {
  expect(process.env.FODH_NOTIFY_OS).toBe('off');
  expect(await readFile('vitest.config.ts', 'utf8')).toMatch(/env:\s*\{\s*FODH_NOTIFY_OS:\s*'off'/u);
});

it('Node 자식 프로세스에 FODH_NOTIFY_OS=off 상속', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.env.FODH_NOTIFY_OS ?? "missing")']);
  let stdout = ''; child.stdout.on('data', data => { stdout += data; });
  const code = await new Promise((ok, fail) => { child.once('close', ok); child.once('error', fail); });
  expect(code).toBe(0); expect(stdout).toBe('off');
});
