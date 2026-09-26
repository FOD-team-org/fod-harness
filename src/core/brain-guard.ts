import { loadConfig } from './config.ts';
import { ownerAt, lockOwnerAlive } from './lock.ts';
import { descendantOf } from './process-time.ts';
import { harnessPath } from './storage.ts';

// Provenance requires an explicit brain environment; ancestry is only a denial guard.
export const originOfCaller = (): 'brain' | 'cli' => process.env.FODH_BRAIN === '1' ? 'brain' : 'cli';

export async function isBrainProcess(root: string): Promise<boolean> {
  const owner = await ownerAt(harnessPath(root, 'harness.lock'));
  const child = owner && owner.pid !== process.pid && await lockOwnerAlive(owner)
    ? await descendantOf(process.ppid, owner.pid) : false;
  return process.env.FODH_BRAIN === '1' || child !== false;
}

export async function assertNotBrain(root: string, what: string): Promise<void> {
  if (await isBrainProcess(root)) {
    if (['판단 답변', '판단 적용'].includes(what)) throw new Error(`판단은 사용자만 답합니다: ${(await loadConfig(root)).judgment.file} 의 \`- 답:\` 줄을 사용자가 채운다`);
    throw new Error(`두뇌 세션은 ${what} 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요`);
  }
}

export class HarnessNotAliveError extends Error {
  constructor() { super('하네스가 실행 중이 아닙니다(잠금 소유자 없음). 두뇌 명령을 거부합니다'); }
}
export async function assertHarnessAlive(root: string): Promise<void> {
  if (process.env.FODH_BRAIN !== '1') return;
  try {
    const owner = await ownerAt(harnessPath(root, 'harness.lock'));
    if (owner && await lockOwnerAlive(owner)) return;
  } catch { /* Unreadable or malformed ownership is not proof of a live harness. */ }
  throw new HarnessNotAliveError();
}
