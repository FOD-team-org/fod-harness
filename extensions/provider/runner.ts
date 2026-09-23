import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { registerProc, removeProc } from '../../src/core/procs.ts';

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const strippedEnvKeys = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of strippedEnvKeys) delete clean[key];
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
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function startedAt(pid: number): Promise<string> {
  try { return (await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim() || `spawn:${new Date().toISOString()}`; }
  catch { return `spawn:${new Date().toISOString()}`; }
}
function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try { process.kill(-pgid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
// 호출자가 방금 생성해 핸들을 보유한 그룹만 회수한다. 영속 레지스트리의 오래된 PID는 사용하지 않는다.
async function reclaimOwnedGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (groupAlive(pgid) && Date.now() < deadline) await delay(25);
  if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL');
  const killDeadline = Date.now() + 2000;
  while (groupAlive(pgid) && Date.now() < killDeadline) await delay(25);
  // ps를 사용할 수 없는 샌드박스에서는 kill(0)의 ESRCH로 소유 그룹 부재를 확인한다.
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=']);
    if (stdout.split('\n').some(line => Number(line.trim().split(/\s+/)[1]) === pgid)) return false;
  } catch { /* kill(0) 검증 결과를 사용한다. */ }
  return !groupAlive(pgid);
}
export type AbortKind = 'deadline' | 'user' | 'billing' | 'configError' | 'protocolError';
export interface ProcessResult {
  code: number | null; stderr: string; abortKind?: AbortKind; cleaned: boolean; pid?: number;
}
export interface RunOptions {
  root: string; command: string | string[]; args?: string[]; input?: string;
  runId: string; kind?: string; maxMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
  onEvent?: (event: Record<string, any>) => Promise<AbortKind | void> | AbortKind | void;
}
export async function runProcess(options: RunOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return { code: null, stderr: '', abortKind: 'user', cleaned: true };
  const [command, ...prefix] = commandParts(options.command);
  const child = spawn(command, [...prefix, ...options.args ?? []], {
    cwd: options.root, env: childEnv(options.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', abortKind: AbortKind | undefined, reclaim: Promise<boolean> | undefined;
  let spawnError = false;
  const closed = new Promise<number | null>(resolve => {
    child.once('error', () => { spawnError = true; resolve(null); });
    child.once('close', code => resolve(code));
  });
  child.once('exit', () => {
    if (child.pid && !reclaim) reclaim = reclaimOwnedGroup(child.pid);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
  child.stdin.on('error', () => { /* 조기 종료 시 EPIPE를 종료 결과로 처리한다. */ });
  const abort = (kind: AbortKind) => {
    abortKind ??= kind;
    if (child.pid && !reclaim) reclaim = reclaimOwnedGroup(child.pid);
  };
  const onAbort = () => abort('user');
  const timer = setTimeout(() => abort('deadline'), options.maxMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) abort('user');
  try {
    if (child.pid) await registerProc(options.root, {
      pid: child.pid, pgid: child.pid, startedAt: await startedAt(child.pid),
      runId: options.runId, kind: options.kind ?? 'brain', cmd: command,
    });
    child.stdin.end(options.input ?? '');
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (abortKind || !line.trim() || !options.onEvent) continue;
      let event: Record<string, any>;
      try { event = JSON.parse(line); }
      catch { abort('protocolError'); continue; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') { abort('protocolError'); continue; }
      const reason = await options.onEvent(event);
      if (reason) abort(reason);
    }
    const code = await closed;
    if (child.pid && !reclaim) reclaim = reclaimOwnedGroup(child.pid);
    const cleaned = await (reclaim ?? Promise.resolve(true));
    if (cleaned && child.pid) await removeProc(options.root, child.pid, options.runId);
    return { code, stderr: spawnError ? '실행 파일을 시작할 수 없습니다.' : stderr, abortKind, cleaned, pid: child.pid };
  } catch (error) {
    abort('protocolError');
    const cleaned = await (reclaim ?? Promise.resolve(true));
    await closed;
    if (cleaned && child.pid) await removeProc(options.root, child.pid, options.runId);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
