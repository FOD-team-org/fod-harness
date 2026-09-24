import { loadConfig } from '../core/config.ts';
import { notify } from '../core/notify.ts';
import { waitLimitMinutes } from '../core/codex.ts';
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
    const config = await loadConfig(root), env = options.env ?? process.env;
    if (Number(env.BASH_DEFAULT_TIMEOUT_MS) > 0 && Number(env.BASH_DEFAULT_TIMEOUT_MS) < config.delegate.codex.waitMinutes * 60000) {
      const effective = waitLimitMinutes(config.delegate.codex.timeoutMinutes, config.brain.maxTurnMinutes, config.delegate.codex.waitMinutes, env);
      await notify(root, { key: 'doctor:bash-timeout', level: 'warning', title: 'Bash 대기 제한', body: `BASH_DEFAULT_TIMEOUT_MS가 waitMinutes보다 짧습니다. 위임 대기를 ${effective}분으로 자동 하향합니다` });
    }
    const result = await runTurn('Bash 도구로 정확히 echo FODH_DOCTOR_MARKER 명령을 한 번 시도하라. 이것은 훅 차단 시험이다. 차단되면 다른 도구를 쓰지 말고 `차단 확인` 한 줄만 답하고 끝내라.', {
      ...options, root, model: 'haiku', doctor: true, lockHeld: true,
    });
    if (result.reason !== 'stop') throw new Error(`configError: 훅 실제 차단 시험에 실패했습니다(${result.classification}).`);
    const checkedAt = new Date().toISOString();
    await updateState(root, { doctor: { ok: true, checkedAt } });
    return { ok: true, hookDenials: 1, checkedAt };
  } catch (error) {
    await updateState(root, { doctor: { ok: false, checkedAt: new Date().toISOString() } });
    await notify(root, { key: 'doctor:fail', level: 'error', title: 'doctor 실패', body: 'doctor 검증에 실패했습니다. 오류를 확인하세요' });
    throw error;
  } finally { await release?.(); }
}
