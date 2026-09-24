import { ownerAt, lockOwnerAlive } from './lock.ts';
import { descendantOf } from './process-time.ts';
import { harnessPath } from './storage.ts';

export async function assertNotBrain(root: string, what: string): Promise<void> {
  const owner = await ownerAt(harnessPath(root, 'harness.lock'));
  const child = owner && owner.pid !== process.pid && await lockOwnerAlive(owner)
    ? await descendantOf(process.ppid, owner.pid) : false;
  if (process.env.FODH_BRAIN === '1' || child !== false) {
    throw new Error(`두뇌 세션은 ${what} 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요`);
  }
}
