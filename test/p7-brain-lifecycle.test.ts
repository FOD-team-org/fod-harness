import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import provider from '../extensions/provider/index.ts';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { project, cli } from './p5-helpers.ts';
import { liveHarness } from './p7-brain-helpers.ts';
import orchestrator from '../extensions/orchestrator/index.ts';
import { readState, updateState } from '../src/core/state.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { readLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import { groupAlive, runProcess, getCurrentBrainGroup } from '../src/provider/runner.ts';
import { runCleanup } from '../src/core/cleanup.ts';
const children: ChildProcess[] = [], groups: number[] = [];
const testedGroups = new Set<number>();
afterAll(() => {
  const remaining = [...testedGroups].filter(groupAlive);
  expect(remaining).toEqual([]);
  console.log(`P8 sleep groups: tested=${testedGroups.size}, remaining=${remaining.length}`);
});
afterEach(async () => {
  const cleanupGroups = groups.splice(0);
  for (const pgid of cleanupGroups) testedGroups.add(pgid);
  for (const pgid of cleanupGroups) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
  }
  for (const pgid of cleanupGroups) await waitForGroupDeath(pgid);
});
async function deadHarness(root: string) {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const closed = once(child, 'close'); await once(child, 'spawn'); await closed;
  await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: child.pid, startedAt: '', token: 'dead-test' }));
}
it.each(['dead', 'missing', 'unreadable'])('F30 %s 잠금은 두뇌 쓰기만 코드 2 거부', async kind => {
  const root = await project('IDLE');
  if (kind === 'dead') await deadHarness(root);
  if (kind === 'unreadable') await writeFile(join(root, '.pi/harness.lock'), '{');
  vi.stubEnv('FODH_BRAIN', '1');
  const writes = [ ['state','transition','INTERVIEW'], ['backlog','add'], ['codex','task'], ['codex','review'], ['codex','research'], ['codex','cancel'], ['worktree','create'], ['verify','run'], ['judgment','add'], ['judgment','write-status'], ['docs','scaffold'], ['cleanup','run'], ['cleanup','report'], ['ledger','resolve'], ['interview','start'], ['pick'] ];
  for (const args of writes) expect(await cli(root, args), args.join(' ')).toEqual({ code: 2, value: { error: '하네스가 실행 중이 아닙니다(잠금 소유자 없음). 두뇌 명령을 거부합니다' } });
  expect((await cli(root, ['state','get'])).code).toBe(0);
  expect((await cli(root, ['backlog','list'])).code).toBe(0);
  expect((await cli(root, ['pick','--dry'])).code).toBe(0);
  expect((await readState(root)).state).toBe('IDLE');
});
it('F30 살아 있는 Pi 소유자는 두뇌 전이 허용', async () => {
  const root = await project('IDLE'); await liveHarness(root); vi.stubEnv('FODH_BRAIN','1');
  expect(await cli(root, ['state','transition','INTERVIEW'])).toMatchObject({ code: 0, value: { state: 'INTERVIEW' } });
});
it('F30 두뇌 환경이 없으면 잠금 없이 기존 전이 허용', async () => {
  const root = await project('IDLE'); vi.stubEnv('FODH_BRAIN','');
  expect((await cli(root, ['state','transition','INTERVIEW'])).code).toBe(0);
});
it.each([false,true])('F30 실제 Node SIGHUP·Pi 즉시 종료 처리기=%s도 손자 회수와 orphan 파일을 남긴다', async piHandler => {
  const root = await project();
  const module = pathToFileURL(resolve('src/provider/shutdown.ts')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawn} from 'node:child_process';
    import {installShutdownReclaim} from ${JSON.stringify(module)};
    ${piHandler ? `process.prependListener('SIGHUP', () => process.exit(129));` : ''}
    const brain = spawn('sleep', ['60'], {detached:true, stdio:'ignore'});
    brain.once('spawn', () => { installShutdownReclaim(() => brain.pid); console.log(JSON.stringify({pgid:brain.pid})); });
  `], { cwd: root, stdio: ['ignore','pipe','pipe'] });
  children.push(child); const closed = once(child, 'close');
  const line = await new Promise<string>((ok, fail) => { let text=''; child.stdout!.on('data', chunk => { text += chunk; if(text.includes('\n')) ok(text.split('\n')[0]); }); child.once('error',fail); child.once('close', () => fail(new Error('stub exited before ready'))); });
  const { pgid } = JSON.parse(line); groups.push(pgid);
  expect(groupAlive(pgid)).toBe(true); child.kill('SIGHUP'); await closed;
  for (let i=0; i<100 && groupAlive(pgid); i++) await delay(20);
  expect(groupAlive(pgid)).toBe(false);
  if (piHandler) expect(child.exitCode).toBe(129); else expect(child.signalCode).toBe('SIGHUP');
  const path = join(root, '.pi/harness-brain-orphan.json');
  expect(JSON.parse(await readFile(path,'utf8'))).toMatchObject({ pgid, signal:'SIGHUP', at:expect.any(String) });
  await sessionStart(root);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action:'brain:orphan-reclaimed', evidence:{ pgid, signal:'SIGHUP', at:expect.any(String), alive:false } }));
  await expect(readFile(path)).rejects.toMatchObject({code:'ENOENT'});
});
async function sleeper(root: string) {
  const child = spawn('sleep', ['60'], {detached:true, stdio:'ignore'}); children.push(child); await once(child,'spawn'); groups.push(child.pid!);
  const runId = `brain-${child.pid}`;
  await registerProc(root,{ pid:child.pid!,pgid:child.pid!,runId,kind:'brain',startedAt:await processStartedAt(child.pid!) ?? 'spawn:unavailable' });
  await updateState(root,{brainTurn:{runId,startedAt:new Date().toISOString()}});
  return {child,runId};
}
async function sessionStart(root: string) {
  const handlers = new Map<string, Function>(); const notify = vi.fn();
  orchestrator({ on:(name:string, fn:Function) => handlers.set(name,fn), registerCommand:vi.fn(), sendMessage:vi.fn() } as unknown as ExtensionAPI);
  await setConfig(root,'notify.channels','["tui","ledger"]');
  await handlers.get('session_start')!({}, {cwd:root,hasUI:true,isIdle:()=>true,ui:{notify}});
  return notify;
}
it('F30 session_start는 죽은 잠금의 실제 sleep 두뇌만 회수하고 한 번 알린다', async () => {
  const root = await project('IMPLEMENT'), {child,runId} = await sleeper(root); await deadHarness(root);
  const notify = await sessionStart(root);
  expect(groupAlive(child.pid!)).toBe(false); expect(await listProcs(root)).toEqual([]);
  expect(await readState(root)).toMatchObject({state:'recovering'});
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({action:'brain:orphan-reclaimed',evidence:{pgid:child.pid,runId,alive:true}}));
  expect(notify.mock.calls.filter(([text]) => text === '고아 두뇌 프로세스를 회수했습니다')).toHaveLength(1);
});
it('F30 session_start는 살아 있는 잠금의 두뇌를 회수하지 않는다', async () => {
  const root = await project('IMPLEMENT'), {child} = await sleeper(root); await liveHarness(root);
  await sessionStart(root); expect(groupAlive(child.pid!)).toBe(true);
  expect((await readLedger(root)).some(e=>e.action==='brain:orphan-reclaimed')).toBe(false);
});
it.each([true,false])('F30 cleanup brain은 잠금 생존 %s와 현재 run 일치로 보호·회수', async alive => {
  const root = await project('IMPLEMENT'), {child} = await sleeper(root);
  if(alive) await liveHarness(root); else await deadHarness(root);
  const result = await runCleanup(root,{scope:'processes'});
  expect(result.processes?.[alive?'protected':'reclaimed']).toHaveLength(1);
  expect(groupAlive(child.pid!)).toBe(alive);
});
it('F30 runner는 Node 두뇌 pgid와 kind를 공개하고 종료 후 비운다', async () => {
  const root = await project(); let observed = false;
  await runProcess({root,maxMs:5000,runId:'node-brain',command:process.execPath,args:['-e', 'console.log(JSON.stringify({type:"ready"}));setTimeout(()=>{},200)'],onEvent:async () => {
    const records = await listProcs(root); expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('brain'); expect(getCurrentBrainGroup()).toBe(records[0].pgid); observed=true;
  }});
  expect(observed).toBe(true); expect(getCurrentBrainGroup()).toBeUndefined();
});

it('F30 provider는 재시작마다 일회성 신호 가드를 다시 설치하고 shutdown에서 해제한다', async () => {
  const root = await project(), handlers = new Map<string, Function>();
  const count = process.listenerCount('SIGHUP');
  provider({on:(name:string, fn:Function)=>handlers.set(name,fn),registerProvider:vi.fn(),getActiveTools:()=>[],setActiveTools:vi.fn()} as unknown as ExtensionAPI);
  expect(process.listenerCount('SIGHUP')).toBe(count+1);
  const ctx = {cwd:root,hasUI:true,ui:{notify:vi.fn()}};
  try {
    for(let i=0;i<2;i++) {
      await handlers.get('session_start')!({},ctx);
      expect(process.listenerCount('SIGHUP')).toBe(count+1);
      await handlers.get('session_shutdown')!({},ctx);
      expect(process.listenerCount('SIGHUP')).toBe(count);
    }
  } finally { await handlers.get('session_shutdown')!({},ctx); }
});

it('P8 K2 Pi init 뒤 session_start 재설치는 SIGHUP·SIGTERM 첫 처리기를 복구한다', async () => {
  const { shutdownReclaimMarker } = await import('../src/provider/shutdown.ts');
  const root = await project(), handlers = new Map<string, Function>();
  const ctx = { cwd: root, hasUI: true, ui: { notify: vi.fn() } }, piHandler = () => {};
  const signals = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
  const before = signals.map(signal => process.rawListeners(signal));
  provider({ on: (name: string, fn: Function) => handlers.set(name, fn), registerProvider: vi.fn(),
    getActiveTools: () => [], setActiveTools: vi.fn() } as unknown as ExtensionAPI);
  try {
    for (const signal of ['SIGHUP', 'SIGTERM'] as const) process.prependListener(signal, piHandler);
    await handlers.get('session_start')!({}, ctx);
    for (const signal of signals) expect((process.rawListeners(signal)[0] as any)[shutdownReclaimMarker]).toBe(true);
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    for (const signal of signals) process.off(signal, piHandler);
  }
  signals.forEach((signal, i) => expect(process.rawListeners(signal)).toEqual(before[i]));
});

async function signalStub(root: string, body: string) {
  const module = pathToFileURL(resolve('src/provider/shutdown.ts')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { installShutdownReclaim } from ${JSON.stringify(module)};
    ${body}
  `], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const closed = once(child, 'close');
  const line = await new Promise<string>((ok, fail) => {
    let text = '';
    child.stdout!.on('data', chunk => { text += chunk; if (text.includes('\n')) ok(text.split('\n')[0]); });
    child.once('error', fail); child.once('close', () => fail(new Error('stub exited before ready')));
  });
  const { pgid } = JSON.parse(line);
  if (pgid) groups.push(pgid);
  return { child, pgid: pgid as number | undefined, closed };
}
async function waitForGroupDeath(pgid: number) {
  for (let i = 0; i < 100 && groupAlive(pgid); i++) await delay(20);
  expect(groupAlive(pgid)).toBe(false);
}
it.each([true, false])('P8 K2 실제 설치→Pi prepend→재설치=%s 대조', async reinstall => {
  const root = await project();
  const { child, pgid, closed } = await signalStub(root, `
    const brain = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    brain.once('spawn', () => {
      const uninstall = installShutdownReclaim(() => brain.pid);
      process.prependListener('SIGHUP', () => process.exit(129));
      ${reinstall ? 'uninstall(); installShutdownReclaim(() => brain.pid);' : ''}
      console.log(JSON.stringify({ pgid: brain.pid }));
    });
  `);
  try {
    child.kill('SIGHUP'); await closed;
    expect(child.exitCode).toBe(129);
    if (reinstall) {
      await waitForGroupDeath(pgid!);
      expect(JSON.parse(await readFile(join(root, '.pi/harness-brain-orphan.json'), 'utf8'))).toMatchObject({ pgid, signal: 'SIGHUP' });
    } else {
      expect(groupAlive(pgid!)).toBe(true);
      await expect(readFile(join(root, '.pi/harness-brain-orphan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    try { process.kill(-pgid!, 'SIGKILL'); } catch {}
    await waitForGroupDeath(pgid!);
  }
});
it.each([true, false])('P8 SIGINT 다른 처리기 없음, 두뇌=%s도 기본 SIGINT 종료 유지', async hasBrain => {
  const root = await project();
  const { child, pgid, closed } = await signalStub(root, hasBrain ? `
    const brain = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    brain.once('spawn', () => { installShutdownReclaim(() => brain.pid); console.log(JSON.stringify({ pgid: brain.pid })); });
  ` : `installShutdownReclaim(() => undefined); setInterval(() => {}, 1000); console.log('{}');`);
  child.kill('SIGINT'); await closed;
  expect(child.signalCode).toBe('SIGINT');
  if (hasBrain) {
    await waitForGroupDeath(pgid!);
    expect(JSON.parse(await readFile(join(root, '.pi/harness-brain-orphan.json'), 'utf8'))).toMatchObject({ pgid, signal: 'SIGINT', at: expect.any(String) });
  } else await expect(readFile(join(root, '.pi/harness-brain-orphan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('P8 Pi 멈춤 모사 SIGINT 무시 뒤 SIGTERM은 두뇌를 회수한다', async () => {
  const root = await project();
  const { child, pgid, closed } = await signalStub(root, `
    process.on('SIGINT', () => {});
    const brain = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    brain.once('spawn', () => { installShutdownReclaim(() => brain.pid); console.log(JSON.stringify({ pgid: brain.pid })); });
  `);
  child.kill('SIGINT'); await delay(300);
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(groupAlive(pgid!)).toBe(true);
  await expect(readFile(join(root, '.pi/harness-brain-orphan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  child.kill('SIGTERM'); await closed;
  expect(child.signalCode).toBe('SIGTERM'); await waitForGroupDeath(pgid!);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-brain-orphan.json'), 'utf8'))).toMatchObject({ pgid, signal: 'SIGTERM' });
});

function signalExitV3Module(): { path: string; source: string } {
  try {
    // Resolve the installed package link without Pi execution, package export restrictions or Vite import.meta.resolve.
    const piRequire = createRequire(realpathSync(resolve('node_modules/@earendil-works/pi-coding-agent/package.json')));
    const lockRequire = createRequire(piRequire.resolve('proper-lockfile'));
    const version = lockRequire('signal-exit/package.json').version;
    if (version !== '3.0.7') throw new Error(`signal-exit version ${version}, expected 3.0.7`);
    return { path: lockRequire.resolve('signal-exit'), source: `Pi proper-lockfile dependency: signal-exit ${version}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`P8-b real signal-exit unavailable: ${reason}; using v3 contract fixture (no test skipped)`);
    return { path: resolve('test/fixtures/signal-exit-v3.cjs'), source: 'signal-exit 3.0.7 contract fixture' };
  }
}
it.each([false, true])('P8-b signal-exit 선등록 + Pi 멈춤=%s의 실제 SIGINT 회수·양보', async suspended => {
  const root = await project(), signalExit = signalExitV3Module();
  console.log(`P8-b SIGINT suspended=${suspended}: ${signalExit.source}`);
  const { child, pgid, closed } = await signalStub(root, `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(signalExit.path)});
    require(${JSON.stringify(signalExit.path)})(() => {});
    if (process.__signal_exit_emitter__?.count !== 1 || process.listenerCount('SIGINT') !== 1) {
      throw new Error('signal-exit listener was not installed');
    }
    ${suspended ? `
      const ignore = () => {};
      process.on('SIGINT', ignore);
      process.once('SIGCONT', () => process.off('SIGINT', ignore));
    ` : ''}
    const brain = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    brain.once('spawn', () => { installShutdownReclaim(() => brain.pid); console.log(JSON.stringify({ pgid: brain.pid })); });
  `);
  child.kill('SIGINT');
  if (suspended) {
    await delay(300);
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(groupAlive(pgid!)).toBe(true);
    await expect(readFile(join(root, '.pi/harness-brain-orphan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    child.kill('SIGTERM');
  }
  await closed;
  expect(child.signalCode).toBe(suspended ? 'SIGTERM' : 'SIGINT');
  await waitForGroupDeath(pgid!);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-brain-orphan.json'), 'utf8')))
    .toMatchObject({ pgid, signal: suspended ? 'SIGTERM' : 'SIGINT', at: expect.any(String) });
});

it('P8-c signal-exit v3·v4가 공존하면 count 합으로 SIGINT를 회수한다', async () => {
  const root = await project();
  const { child, pgid, closed } = await signalStub(root, `
    process.__signal_exit_emitter__ = { count: 1 };
    globalThis[Symbol.for('signal-exit emitter')] = { count: 1 };
    const v3 = () => {};
    const v4 = () => {
      const count = process.__signal_exit_emitter__.count + globalThis[Symbol.for('signal-exit emitter')].count;
      if (process.listenerCount('SIGINT') !== count) return;
      process.off('SIGINT', v3); process.off('SIGINT', v4);
      process.__signal_exit_emitter__.count = 0;
      globalThis[Symbol.for('signal-exit emitter')].count = 0;
      process.kill(process.pid, 'SIGINT');
    };
    process.on('SIGINT', v3); process.on('SIGINT', v4);
    const brain = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    brain.once('spawn', () => { installShutdownReclaim(() => brain.pid); console.log(JSON.stringify({ pgid: brain.pid })); });
  `);
  child.kill('SIGINT'); await closed;
  expect(child.signalCode).toBe('SIGINT'); await waitForGroupDeath(pgid!);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-brain-orphan.json'), 'utf8'))).toMatchObject({ pgid, signal: 'SIGINT' });
});

function signalExitV4Module(): { path: string; source: string } {
  try {
    const npmRequire = createRequire(resolve(process.execPath, '../../lib/node_modules/npm/package.json'));
    const path = npmRequire.resolve('signal-exit');
    const version = JSON.parse(readFileSync(resolve(dirname(path), '../../package.json'), 'utf8')).version;
    if (!version.startsWith('4.')) throw new Error(`signal-exit version ${version}, expected 4.x`);
    return { path, source: `npm dependency: signal-exit ${version}` };
  } catch (error) {
    console.warn(`A16 real signal-exit v4 unavailable: ${String(error)}; using v4 contract fixture (no test skipped)`);
    return { path: resolve('test/fixtures/signal-exit-v4.cjs'), source: 'signal-exit v4 contract fixture' };
  }
}
it.each([false, true])('A16 signal-exit v4 실제 전역 위치와 SIGINT 종료(v3 공존=%s)', async withV3 => {
  const root = await project(), v4 = signalExitV4Module(), v3 = withV3 ? signalExitV3Module() : undefined;
  console.log(`A16 SIGINT: ${v4.source}${v3 ? ` + ${v3.source}` : ''}`);
  const { child, pgid, closed } = await signalStub(root, `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(v4.path)});
    ${v3 ? `require(${JSON.stringify(v3.path)})(() => {});` : ''}
    require(${JSON.stringify(v4.path)}).onExit(() => {});
    if (globalThis[Symbol.for('signal-exit emitter')]?.count !== 1) throw new Error('v4 global emitter missing');
    if (process.listenerCount('SIGINT') !== ${withV3 ? 2 : 1}) throw new Error('unexpected listener count');
    const brain = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    brain.once('spawn', () => { installShutdownReclaim(() => brain.pid); console.log(JSON.stringify({ pgid: brain.pid })); });
  `);
  child.kill('SIGINT'); await closed;
  expect(child.signalCode).toBe('SIGINT'); await waitForGroupDeath(pgid!);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-brain-orphan.json'), 'utf8'))).toMatchObject({ pgid, signal: 'SIGINT' });
});
