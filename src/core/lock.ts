import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartedAt } from './process-time.ts';

export interface LockOwner { pid: number; startedAt: string; token: string }
const heldKey = Symbol.for('fodh.lock.held');
const shared = globalThis as typeof globalThis & { [heldKey]?: Set<string> };
const held = shared[heldKey] ??= new Set<string>();
const startedKey = Symbol.for('fodh.lock.selfStartedAt');
const startedShared = globalThis as typeof globalThis & { [startedKey]?: string };
function normalizedStart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export async function ownerAt(path: string): Promise<LockOwner | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as LockOwner; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('잠금 파일을 읽을 수 없습니다', { cause: error });
  }
}

export async function lockOwnerAlive(owner: LockOwner, options: {
  startedAt?: (pid: number) => Promise<string | undefined>;
} = {}): Promise<boolean> {
  if (owner.pid === process.pid) return held.has(owner.token);
  if (!isProcessAlive(owner.pid)) return false;
  try {
    const actualText = await (options.startedAt ?? processStartedAt)(owner.pid);
    const expectedText = typeof owner.startedAt === 'string' ? owner.startedAt.trim() : '';
    if (!actualText || !expectedText) return true;
    const actual = Date.parse(actualText), expected = Date.parse(expectedText);
    if (Number.isFinite(actual) && Number.isFinite(expected)) return Math.abs(actual - expected) <= 2000;
    return actualText === expectedText;
  } catch { /* ps가 제한되면 signal 0의 생존 결과를 유지한다. */ }
  return true;
}

export async function acquireLock(path: string, options: {
  waitMs?: number; startedAt?: () => Promise<string | undefined>;
} = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  let startedAt: string | undefined;
  try {
    if (options.startedAt) startedAt = normalizedStart(await options.startedAt());
    else {
      startedAt = startedShared[startedKey];
      if (!startedAt) {
        startedAt = normalizedStart(await processStartedAt(process.pid));
        if (startedAt) startedShared[startedKey] = startedAt;
      }
    }
  }
  catch { /* Restricted ps falls back to the Node start time. */ }
  const owner: LockOwner = {
    pid: process.pid, startedAt: startedAt || new Date(Date.now() - process.uptime() * 1000).toISOString(), token: randomUUID(),
  };
  const temporary = `${path}.${owner.token}.tmp`;
  const reclaim = `${path}.reclaim`;
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  // 완성된 JSON의 하드링크로 잠금을 획득하므로 빈 소유자 파일이 노출되지 않는다.
  await writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try {
    for (;;) {
      try { await link(temporary, path); held.add(owner.token); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const current = await ownerAt(path);
      if (current && !(await lockOwnerAlive(current))) {
        let claimed = false;
        try {
          await mkdir(reclaim); claimed = true;
          // 회수자끼리 직렬화한 뒤 다시 읽어 새 소유자의 잠금을 지우지 않는다.
          const latest = await ownerAt(path);
          if (latest && !(await lockOwnerAlive(latest))) await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // 회수자가 비정상 종료한 경우만 오래된 회수 표식을 제거한다.
          const info = await stat(reclaim).catch(() => undefined);
          if (info && Date.now() - info.mtimeMs > 60_000) await rm(reclaim, { recursive: true, force: true });
        } finally { if (claimed) await rm(reclaim, { recursive: true, force: true }); }
        await delay(10);
        continue;
      }
      if (Date.now() >= deadline) throw new Error('다른 하네스가 잠금을 사용 중입니다');
      await delay(10);
    }
  } finally { await unlink(temporary).catch(() => undefined); }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = await ownerAt(path);
      if (current?.token === owner.token) await unlink(path);
    } finally { held.delete(owner.token); }
  };
}
