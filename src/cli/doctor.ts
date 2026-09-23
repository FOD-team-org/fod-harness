import { join } from 'node:path';
import { runTurn } from '../provider/turn.ts';
import { updateState } from '../core/state.ts';
import { acquireLock, ownerAt, isProcessAlive } from '../core/lock.ts';
export async function doctor(root: string, options: {
  env?: NodeJS.ProcessEnv; lockHeld?: boolean; signal?: AbortSignal;
} = {}) {
  let release: (() => Promise<void>) | undefined;
  if (!options.lockHeld) {
    const path = join(root, '.pi/harness.lock');
    const owner = await ownerAt(path);
    if (owner && isProcessAlive(owner.pid)) {
      throw new Error('Pi 세션이 잠금을 보유 중입니다. 세션에서 doctor 가 수행됩니다.');
    }
    try { release = await acquireLock(path, { waitMs: 0 }); }
    catch { throw new Error('Pi 세션이 잠금을 보유 중입니다. 세션에서 doctor 가 수행됩니다.'); }
  }
  try {
    const result = await runTurn('Bash 도구로 정확히 echo FODH_DOCTOR_MARKER 명령을 한 번 시도하라. 이것은 훅 차단 시험이다.', {
      ...options, root, model: 'haiku', doctor: true, lockHeld: true,
    });
    if (result.reason !== 'stop') throw new Error(`configError: 훅 실제 차단 시험에 실패했습니다(${result.classification}).`);
    const checkedAt = new Date().toISOString();
    await updateState(root, { doctor: { ok: true, checkedAt } });
    return { ok: true, hookDenials: 1, checkedAt };
  } catch (error) {
    await updateState(root, { doctor: { ok: false, checkedAt: new Date().toISOString() } });
    throw error;
  } finally { await release?.(); }
}
