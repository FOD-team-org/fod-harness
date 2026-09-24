import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 레지스트리와 잠금 검증은 동일한 C 로케일 시작 시각을 사용한다.
// ps 제한 또는 빈 출력은 시작 시각을 확인하지 못했다는 뜻이다.
export async function processStartedAt(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

export async function processGroup(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
      timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const pgid = Number(stdout.trim());
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch { return undefined; }
}

export async function processParent(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 1000 });
    const parent = Number(stdout.trim());
    return stdout.trim() && Number.isSafeInteger(parent) && parent >= 0 ? parent : undefined;
  } catch { return undefined; }
}

// undefined means that ancestry could not be verified (including restricted ps).
export async function descendantOf(pid: number, ancestor: number,
  parentOf: (pid: number) => Promise<number | undefined> = processParent): Promise<boolean | undefined> {
  const seen = new Set<number>();
  for (let depth = 0; depth < 128; depth++) {
    if (pid === ancestor) return true;
    if (pid <= 1) return false;
    if (seen.has(pid)) return undefined;
    seen.add(pid);
    const parent = await parentOf(pid);
    if (parent === undefined) return undefined;
    pid = parent;
  }
  return undefined;
}
