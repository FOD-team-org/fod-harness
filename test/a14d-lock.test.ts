import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock, lockOwnerAlive, ownerAt } from '../src/core/lock.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import * as time from '../src/core/process-time.ts';
import { recoverOrphanBrain } from '../src/core/brain-lifecycle.ts';
import { withFileLock } from '../src/core/storage.ts';
import { startPlan } from '../src/cli/start.ts';
import provider from '../extensions/provider/index.ts';
import orchestrator from '../extensions/orchestrator/index.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const roots: string[] = [], releases: (() => Promise<void>)[] = [];
const startedKey = Symbol.for('fodh.lock.selfStartedAt');
beforeEach(() => { Reflect.deleteProperty(globalThis, startedKey); });
afterEach(() => { Reflect.deleteProperty(globalThis, startedKey); });
afterEach(async () => { vi.restoreAllMocks(); for (const release of releases.splice(0)) await release(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp('/private/tmp/fodh-a14d-lock-'); roots.push(root); await mkdir(join(root, '.pi')); return root; }
it('4초 이른 lstart 저장·같은 프로세스 ps 우회·해제 후 token 제거', async () => {
  const root = await setup(), path = join(root, '.pi/harness.lock');
  const stamp = new Date(Date.now() - process.uptime() * 1000 - 4000).toString();
  const release = await acquireLock(path, { startedAt: async () => stamp }); releases.push(release);
  const owner = (await ownerAt(path))!, ps = vi.fn(async () => undefined);
  expect(owner.startedAt).toBe(new Date(stamp).toISOString()); expect(await lockOwnerAlive(owner, { startedAt: ps })).toBe(true); expect(ps).not.toHaveBeenCalled();
  await recoverOrphanBrain(root); expect(await ownerAt(path)).toEqual(owner);
  await release(); expect(await lockOwnerAlive(owner)).toBe(false);
});
it('집합에 없는 같은 PID token은 회수, ps 불가면 ISO fallback', async () => {
  const root = await setup(), path = join(root, '.pi/harness.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: 'old', token: 'not-held' }));
  const release = await acquireLock(path, { waitMs: 0, startedAt: async () => undefined }); releases.push(release);
  expect((await ownerAt(path))!.token).not.toBe('not-held'); expect((await ownerAt(path))!.startedAt).toMatch(/^\d{4}-.*Z$/u);
});
it('옛 ISO·새 lstart를 다른 PID의 주입 시각으로 비교', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const stamp = 'Thu Sep 24 05:39:36 2026', startedAt = vi.fn(async () => stamp);
  for (const value of [stamp, new Date(stamp).toISOString()]) expect(await lockOwnerAlive({ pid: 876543, token: 'legacy', startedAt: value }, { startedAt })).toBe(true);
  expect(await lockOwnerAlive({ pid: 876543, token: 'legacy', startedAt: new Date(Date.parse(stamp) - 4000).toISOString() }, { startedAt })).toBe(false);
});
it('storage 파일 잠금에도 보유 token·경합·해제가 적용된다', async () => {
  const root = await setup(), path = join(root, '.pi/data');
  await withFileLock(path, async () => {
    expect(await lockOwnerAlive((await ownerAt(path + '.lock'))!)).toBe(true);
    await expect(withFileLock(path, async () => {}, { waitMs: 0 })).rejects.toThrow('잠금');
  });
  expect(await ownerAt(path + '.lock')).toBeUndefined();
});
it('provider → orchestrator session_start가 같은 잠금 보존, start는 이미 실행 중 거부', async () => {
  const root = await setup();
  await writeFile(join(root, '.pi/harness.json'), '{}'); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  vi.spyOn(time, 'processStartedAt').mockResolvedValue('Thu Sep 24 05:39:36 2026');
  const handlers = new Map<string, ((...args: any[]) => Promise<void>)[]>();
  const api = { registerProvider() {}, registerCommand() {}, on(name: string, fn: (...args: any[]) => Promise<void>) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, getActiveTools: () => [], setActiveTools() {} } as unknown as ExtensionAPI;
  provider(api); orchestrator(api);
  const ctx = { cwd: root, hasUI: false, model: { provider: 'other' }, ui: { notify() {} } };
  try {
    await handlers.get('session_start')![0]({}, ctx);
    const owner = await ownerAt(join(root, '.pi/harness.lock'));
    await handlers.get('session_start')![1]({}, ctx);
    expect(await ownerAt(join(root, '.pi/harness.lock'))).toEqual(owner);
    await expect(startPlan({ cwd: root, env: { PATH: '', HOME: '/private/tmp/no-home' } })).rejects.toThrow('이미 이 프로젝트');
  } finally { for (const shutdown of handlers.get('session_shutdown')!) await shutdown({}, ctx); }
});
const psAvailable = !!await processStartedAt(process.pid);
it.skipIf(!psAvailable)('sh sleep 2.5 → exec node 뒤 잠금과 고아 복구 통합', async () => {
  const root = await setup(), script = join(root, 'lock.mjs');
  await writeFile(script, `import { acquireLock, ownerAt, lockOwnerAlive } from ${JSON.stringify(resolve('src/core/lock.ts'))};
import { recoverOrphanBrain } from ${JSON.stringify(resolve('src/core/brain-lifecycle.ts'))};
const path = ${JSON.stringify(join(root, '.pi/harness.lock'))};
const release = await acquireLock(path); const owner = await ownerAt(path);
if (!await lockOwnerAlive(owner)) process.exit(2);
await recoverOrphanBrain(${JSON.stringify(root)});
if ((await ownerAt(path))?.token !== owner.token) process.exit(3);
await release();`);
  await expect(promisify(execFile)('/bin/sh', ['-c', 'sleep 2.5; exec "$1" "$2"', 'fixture', process.execPath, script], { env: { ...process.env, FODH_NOTIFY_OS: 'off' } })).resolves.toMatchObject({ stderr: '' });
});
it('독립 모듈 인스턴스도 globalThis token 집합 공유 (Node 24)', async () => {
  const root = await setup();
  const module = new URL('../src/core/lock.ts', import.meta.url).href;
  const script = `const first = await import(${JSON.stringify(module + '?first')});
const second = await import(${JSON.stringify(module + '?second')});
const release = await first.acquireLock(${JSON.stringify(join(root, '.pi/harness.lock'))}, { startedAt: async () => 'fixture' });
const owner = await second.ownerAt(${JSON.stringify(join(root, '.pi/harness.lock'))});
if (!await second.lockOwnerAlive(owner)) process.exit(2);
await release(); if (await second.lockOwnerAlive(owner)) process.exit(3);`;
  await expect(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])).resolves.toMatchObject({ stderr: '' });
});

it('2회차 기본 ps는 연속 획득에 1회, 이후 실패해도 최초 ISO 유지', async () => {
  const root = await setup(), path = join(root, '.pi/harness.lock');
  const stamp = 'Thu Sep 24 05:39:36 2026';
  const ps = vi.spyOn(time, 'processStartedAt').mockResolvedValueOnce(stamp).mockResolvedValue(undefined);
  for (let i = 0; i < 2; i++) {
    const release = await acquireLock(path); releases.push(release);
    expect((await ownerAt(path))!.startedAt).toBe(new Date(stamp).toISOString()); await release();
  }
  expect(ps).toHaveBeenCalledExactlyOnceWith(process.pid);
  expect(Reflect.get(globalThis, startedKey)).toBe(new Date(stamp).toISOString());
});
it('2회차 ps undefined는 캐시하지 않고 다음 획득에 재시도', async () => {
  const root = await setup(), path = join(root, '.pi/harness.lock'), stamp = 'Thu Sep 24 05:39:36 2026';
  const ps = vi.spyOn(time, 'processStartedAt').mockResolvedValueOnce(undefined).mockResolvedValue(stamp);
  const first = await acquireLock(path); releases.push(first);
  expect(Reflect.get(globalThis, startedKey)).toBeUndefined(); await first();
  for (let i = 0; i < 2; i++) { const release = await acquireLock(path); releases.push(release); await release(); }
  expect(ps).toHaveBeenCalledTimes(2); expect(Reflect.get(globalThis, startedKey)).toBe(new Date(stamp).toISOString());
});
it('2회차 주입은 캐시 읽기·쓰기 모두 우회하고 파싱 불가 원문 보존', async () => {
  const root = await setup(), path = join(root, '.pi/harness.lock');
  Reflect.set(globalThis, startedKey, 'cached');
  const ps = vi.spyOn(time, 'processStartedAt'), injected = vi.fn(async () => 'unparseable-start');
  const release = await acquireLock(path, { startedAt: injected }); releases.push(release);
  expect((await ownerAt(path))!.startedAt).toBe('unparseable-start');
  expect(injected).toHaveBeenCalledOnce(); expect(ps).not.toHaveBeenCalled(); expect(Reflect.get(globalThis, startedKey)).toBe('cached');
});
it('2회차 ISO 저장은 다른 TZ reader의 동등한 lstart와 alive 비교', async () => {
  const root = await setup(), path = join(root, '.pi/harness.lock');
  // Separate Node processes make writer/reader TZ explicit without changing the test worker.
  const module = new URL('../src/core/lock.ts', import.meta.url).href;
  const writer = `import { acquireLock } from ${JSON.stringify(module)};
await acquireLock(${JSON.stringify(path)}, { startedAt: async () => 'Thu Sep 24 05:39:36 2026' });`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', writer], { env: { ...process.env, TZ: 'Asia/Seoul' } });
  const owner = (await ownerAt(path))!;
  expect(owner.startedAt).toBe('2026-09-23T20:39:36.000Z');
  const reader = `import { lockOwnerAlive } from ${JSON.stringify(module)};
process.kill = () => true;
const owner = ${JSON.stringify({ ...owner, pid: 876543 })};
if (!await lockOwnerAlive(owner, { startedAt: async () => 'Wed Sep 23 20:39:36 2026' })) process.exit(2);`;
  await expect(promisify(execFile)(process.execPath, ['--input-type=module', '-e', reader], { env: { ...process.env, TZ: 'UTC' } })).resolves.toMatchObject({ stderr: '' });
});
