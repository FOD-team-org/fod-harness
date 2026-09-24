import { loadConfig } from './config.ts';
import { ownerAt, lockOwnerAlive } from './lock.ts';
import { descendantOf } from './process-time.ts';
import { harnessPath } from './storage.ts';

export async function assertNotBrain(root: string, what: string): Promise<void> {
  const owner = await ownerAt(harnessPath(root, 'harness.lock'));
  const child = owner && owner.pid !== process.pid && await lockOwnerAlive(owner)
    ? await descendantOf(process.ppid, owner.pid) : false;
  if (process.env.FODH_BRAIN === '1' || child !== false) {
    if (['판단 답변', '판단 적용'].includes(what)) throw new Error(`판단은 사용자만 답합니다: ${(await loadConfig(root)).judgment.file} 의 \`- 답:\` 줄을 사용자가 채운다`);
    throw new Error(`두뇌 세션은 ${what} 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요`);
  }
}
