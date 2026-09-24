import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billingEnvKeys } from './preflight.ts';
import { registerProc, removeProc } from '../core/procs.ts';
import { processStartedAt } from '../core/process-time.ts';

const brainGroupKey = Symbol.for('fodh.currentBrainGroup');
const sharedBrain = globalThis as typeof globalThis & { [brainGroupKey]?: { pgid?: number } };
const currentBrainGroup = sharedBrain[brainGroupKey] ??= {};
export const getCurrentBrainGroup = (): number | undefined => currentBrainGroup.pgid;
const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// turn.ts의 packageRoot와 같은 패키지 위치를 기준으로 하며 호출자의 cwd에 의존하지 않는다.
const packageBin = fileURLToPath(new URL('../../bin', import.meta.url));
export const strippedEnvKeys = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', ...billingEnvKeys];
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of strippedEnvKeys) delete clean[key];
  if (clean.PATH?.split(delimiter)[0] !== packageBin) {
    clean.PATH = packageBin + (clean.PATH ? delimiter + clean.PATH : '');
  }
  return clean;
}
export function commandParts(command: string | string[]): string[] {
  if (Array.isArray(command)) {
    if (!command.length || command.some(value => !value)) throw new Error('실행 명령이 비어 있습니다.');
    return command;
  }
  const parts: string[] = [];
  let current = '', quote = '', escaped = false;
  for (const char of command) {
    if (escaped) { current += char; escaped = false; }
    else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) { if (char === quote) quote = ''; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { parts.push(current); current = ''; } }
    else current += char;
  }
  if (quote || escaped) throw new Error('실행 명령의 따옴표가 닫히지 않았습니다.');
  if (current) parts.push(current);
  if (!parts.length) throw new Error('실행 명령이 비어 있습니다.');
  return parts;
}
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    try {
      const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], {
        encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      return output.split('\n').some(line => Number(line.trim().split(/\s+/)[1]) === pgid);
    } catch { return true; }
  }
}
function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
// 호출자가 방금 생성해 핸들을 보유한 그룹만 회수한다. 영속 레지스트리의 오래된 PID는 사용하지 않는다.
export async function reclaimOwnedGroup(pgid: number): Promise<boolean> {
  try {
    if (!groupAlive(pgid)) return true;
    // 신호 직전에 그룹이 종료된 경우 커널의 부재 판정을 다시 확인한다.
    if (!signalGroup(pgid, 'SIGTERM')) return !groupAlive(pgid);
    const deadline = Date.now() + 5000;
    while (groupAlive(pgid) && Date.now() < deadline) await delay(25);
    if (groupAlive(pgid) && !signalGroup(pgid, 'SIGKILL')) return !groupAlive(pgid);
    const killDeadline = Date.now() + 2000;
    while (groupAlive(pgid) && Date.now() < killDeadline) await delay(25);
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid='], {
        timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      if (stdout.split('\n').some(line => Number(line.trim().split(/\s+/)[1]) === pgid)) return false;
    } catch { /* ps 잔존 검사는 보조 증거다. 실패하면 커널의 그룹 생존 판정을 사용한다. */ }
    return !groupAlive(pgid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
    // 종료와 신호가 경합하면 EPERM 뒤에도 자식이 곧 소멸할 수 있다.
    // 권한 오류 자체를 성공으로 간주하지 않고 커널의 부재 판정만 기다린다.
    const deadline = Date.now() + 2000;
    for (;;) {
      try { process.kill(-pgid, 0); }
      catch (probeError) {
        const code = (probeError as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code !== 'EPERM') return false;
      }
      if (Date.now() >= deadline) return false;
      await delay(25);
    }
  }
}
// 분리된 자손의 ppid 트리 잔존 검사는 P4에서 추가한다.
export type AbortKind = 'deadline' | 'user' | 'billing' | 'configError' | 'protocolError' | 'quota';
export interface ProcessResult {
  code: number | null; stderr: string; abortKind?: AbortKind; cleaned: boolean; pid?: number;
}
export interface RunOptions {
  root: string; command: string | string[]; args?: string[]; input?: string;
  runId: string; kind?: string; maxMs: number; closeGraceMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
  onEvent?: (event: Record<string, any>) => Promise<AbortKind | void> | AbortKind | void;
}
export async function runProcess(options: RunOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return { code: null, stderr: '', abortKind: 'user', cleaned: true };
  const [command, ...prefix] = commandParts(options.command);
  const child = spawn(command, [...prefix, ...options.args ?? []], {
    cwd: options.root, env: childEnv(options.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const isBrain = (options.kind ?? 'brain') === 'brain';
  if (isBrain && child.pid) currentBrainGroup.pgid = child.pid;
  let stderr = '', abortKind: AbortKind | undefined;
  let spawnError = false;
  type Cleanup = { code: number | null; cleaned: boolean };
  let reclaim: Promise<Cleanup> | undefined;
  let resolveCleanup!: (result: Cleanup | PromiseLike<Cleanup>) => void;
  const cleanupFinished = new Promise<Cleanup>(resolve => { resolveCleanup = resolve; });
  const closed = new Promise<number | null>(resolve => { child.once('close', code => resolve(code)); });
  // 등록 중 즉시 종료해도 출력이 유실되지 않도록 먼저 iterator를 연결한다.
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lineIterator = lines[Symbol.asyncIterator]();
  const waitClosed = async (ms: number) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(code => ({ code, timedOut: false })),
        new Promise<{ code: null; timedOut: boolean }>(resolve => {
          timeout = setTimeout(() => resolve({ code: null, timedOut: true }), ms);
        }),
      ]);
    } finally { clearTimeout(timeout); }
  };
  const beginReclaim = () => {
    if (!reclaim) reclaim = (async () => {
      const reclaimed = child.pid ? await reclaimOwnedGroup(child.pid) : true;
      // stdout 소비 루프와 병행한다. 그룹 밖 자손의 파이프 때문에 루프가 끝나지 않아도 시간 제한이 동작한다.
      const closeDeadline = Date.now() + 10000;
      const requestedGrace = options.closeGraceMs ?? 3000;
      const graceMs = Number.isFinite(requestedGrace) ? Math.max(0, Math.min(requestedGrace, 10000)) : 3000;
      const grace = await waitClosed(graceMs);
      if (!grace.timedOut) return { code: grace.code, cleaned: reclaimed };
      child.stdout.destroy(); child.stderr.destroy(); lines.close();
      const final = await waitClosed(Math.max(0, closeDeadline - Date.now()));
      return { code: final.code, cleaned: false };
    })();
    resolveCleanup(reclaim);
    return reclaim;
  };
  child.once('exit', beginReclaim);
  child.once('error', () => { spawnError = true; beginReclaim(); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
  child.stdin.on('error', () => { /* 조기 종료 시 EPIPE를 종료 결과로 처리한다. */ });
  const abort = (kind: AbortKind) => {
    abortKind ??= kind;
    beginReclaim();
  };
  const onAbort = () => abort('user');
  const timer = setTimeout(() => abort('deadline'), options.maxMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) abort('user');
  try {
    if (child.pid) await registerProc(options.root, {
      pid: child.pid, pgid: child.pid, startedAt: await processStartedAt(child.pid) ?? `spawn:${new Date().toISOString()}`,
      runId: options.runId, kind: options.kind ?? 'brain', cmd: command,
    });
    child.stdin.end(options.input ?? '');
    for await (const line of lineIterator) {
      if (abortKind || !line.trim() || !options.onEvent) continue;
      let event: Record<string, any>;
      try { event = JSON.parse(line); }
      catch { abort('protocolError'); continue; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') { abort('protocolError'); continue; }
      const reason = await options.onEvent(event);
      if (reason) abort(reason);
    }
    // EOF는 프로세스 종료가 아니다. exit/error/abort에서 시작한 회수만 기다린다.
    const { code, cleaned } = await cleanupFinished;
    if (cleaned && child.pid) await removeProc(options.root, child.pid, options.runId);
    return { code, stderr: spawnError ? '실행 파일을 시작할 수 없습니다.' : stderr, abortKind, cleaned, pid: child.pid };
  } catch (error) {
    abort('protocolError');
    const { cleaned } = await beginReclaim();
    if (cleaned && child.pid) await removeProc(options.root, child.pid, options.runId);
    throw error;
  } finally {
    if (isBrain && currentBrainGroup.pgid === child.pid) currentBrainGroup.pgid = undefined;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
