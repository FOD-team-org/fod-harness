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
