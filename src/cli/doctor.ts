import { runTurn } from '../../extensions/provider/stream.ts';
import { updateState } from '../core/state.ts';
import { checkBillingEnvironment } from '../../extensions/provider/preflight.ts';
export async function doctor(root: string, options: { env?: NodeJS.ProcessEnv; lockHeld?: boolean; signal?: AbortSignal } = {}) {
  await checkBillingEnvironment(root, options.env);
  const result = await runTurn('Bash 도구로 정확히 echo FODH_DOCTOR_MARKER 명령을 한 번 시도하라. 이것은 훅 차단 시험이다.', {
    root, model: 'haiku', doctor: true, ...options,
  });
  if (result.reason !== 'stop') throw new Error(`configError: 훅 실제 차단 시험에 실패했습니다(${result.classification}).`);
  const checkedAt = new Date().toISOString();
  await updateState(root, { doctor: { ok: true, checkedAt } });
  return { ok: true, hookDenials: 1, checkedAt };
}
