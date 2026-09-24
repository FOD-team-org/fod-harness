import provider from '../extensions/provider/index.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
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
afterEach(async () => {
  for (const pgid of groups.splice(0)) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
  }
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
