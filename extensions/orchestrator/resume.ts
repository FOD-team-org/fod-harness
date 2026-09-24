import { slotOwnerAlive } from '../../src/core/slots.ts';
import { redact } from '../../src/provider/privacy.ts';
import { interviewStatus, remainingAreas } from '../../src/core/interview.ts';
import { substitute, todayKst } from '../../src/core/template-values.ts';
import { notify } from '../../src/core/notify.ts';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPath, withFileLock } from '../../src/core/storage.ts';
import { getConfig, loadConfig } from '../../src/core/config.ts';
import { activeStates as active, readState, updateState, transitionState, stopForJudgment, type HarnessState } from '../../src/core/state.ts';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
export async function instruction(root: string, state: HarnessState, promptState = state.state): Promise<string> {
  // Only known state names become filenames; state JSON never chooses an arbitrary path.
  if (!active.has(promptState)) throw new Error(`자동 진행할 수 없는 상태: ${promptState}`);
  const config = await loadConfig(root);
  const prompt = await readFile(join(templates, 'prompts', `${promptState}.md`), 'utf8');
  let interviewSummary = '';
  if (promptState === 'INTERVIEW') {
    try {
      const interview = await interviewStatus(root);
      interviewSummary = interview.docFile ? `남은 필수 ${interview.remainingMust}개 — 영역 ${remainingAreas(interview) || '없음'}` : '인터뷰 기록 없음';
    } catch (error) {
      interviewSummary = `인터뷰 은행 오류: ${redact(error instanceof Error ? error.message : String(error))}. 사용자에게 파일 수정을 요청하고 대기: 사용자`;
    }
  }
  const values: Record<string, string> = {
    docsRoot: config.docs.root, today: todayKst(), interviewSummary,
    taskId: state.taskId ?? '', judgmentFile: config.judgment.file, backlogFile: 'docs/backlog.md',
  };
  const rendered = substitute(prompt, values, false);
  return rendered;
}

export async function send(pi: ExtensionAPI, root: string, state: HarnessState, promptState = state.state, automatic = false): Promise<void> {
  pi.sendMessage({ customType: 'harness-orchestrator', content: await instruction(root, state, promptState),
    display: true, details: { state: state.state, taskId: state.taskId } },
  { triggerTurn: true, ...(automatic ? { deliverAs: 'followUp' as const } : {}) });
}
export interface ResumeContext {
  cwd: string; hasUI: boolean; isIdle: () => boolean;
  notify: (message: string, type: 'info' | 'warning' | 'error') => void;
}
export function resumeContext(ctx: ExtensionContext): ResumeContext {
  return { cwd: ctx.cwd, hasUI: ctx.hasUI, isIdle: () => ctx.isIdle?.() ?? true,
    notify: (message, type) => ctx.ui?.notify?.(message, type) };
}
export interface ResumeResult { resumed?: boolean; skipped?: string; stopped?: boolean }
export async function autoResume(pi: ExtensionAPI, root: string, ctxLike: ResumeContext, reason: string, prefix = ''): Promise<ResumeResult> {
  if (ctxLike.hasUI === false) return { skipped: 'print' };
  if (ctxLike.isIdle() === false) return { skipped: 'busy' };
  return withFileLock(harnessPath(root, 'harness-resume'), async () => {
    if (!ctxLike.isIdle()) return { skipped: 'busy' };
    let state = await readState(root);
    if (state.userAborted) return { skipped: 'user-aborted' };
    if (state.awaitingUser && reason === 'slot-free' && state.lastPaused === 'slot') state = await updateState(root, { awaitingUser: false });
    if (state.awaitingUser) return { skipped: 'awaiting-user' };
    if (state.awaitingSlot) {
      if (await slotOwnerAlive(state.awaitingSlot.owner)) return { skipped: 'slot' };
      const waiting = state.awaitingSlot;
      state = await updateState(root, current => current.awaitingSlot?.since === waiting.since
        && current.awaitingSlot.owner.runId === waiting.owner.runId ? { awaitingSlot: undefined } : {});
      if (state.awaitingSlot) return { skipped: 'slot' };
      if (state.state === 'paused(slot)' || state.state === 'WAIT_RESOURCE' && state.lastPaused === 'slot') state = await transitionState(root, 'PICK');
    }
    if (state.awaitingDelegation) return { skipped: 'delegation' };
    if (!active.has(state.state)) {
      if (state.state.startsWith('WAIT_') || state.state.startsWith('paused(') || state.state === 'DONE_ALL' || state.state === 'CLEANUP_FAILED') await notify(root, { key: `state:${state.state}`, title: '하네스 상태', body: `하네스 상태: ${state.state}`, level: state.state.startsWith('paused(') ? 'warning' : 'info' }, ctxLike);
      return { skipped: 'inactive' };
    }
    if (state.state === 'recovering' && state.recoveryAutoResumed === true) return { skipped: 'recovery-limit' };
    const config = await getConfig(root) as { maxAutoTurns?: unknown };
    const maxAutoTurns = config.maxAutoTurns ?? 3;
    if (!Number.isSafeInteger(maxAutoTurns) || Number(maxAutoTurns) < 1) throw new Error('maxAutoTurns는 1 이상의 정수여야 합니다');
    if (Number(state.autoTurns ?? 0) >= Number(maxAutoTurns)) {
      await stopForJudgment(root);
      await notify(root, { key: 'stopForJudgment', title: '진행 정체', body: '진행 정체를 판단대기에 등록했습니다.', level: 'warning' }, ctxLike);
      return { stopped: true };
    }
    let content: string;
    try { content = await instruction(root, state); }
    catch (error) {
      try { ctxLike.notify(`자동 재개 전송에 실패했습니다. ${redact(error instanceof Error ? error.message : String(error)).slice(0, 120)} 다음 사용자 입력에서 다시 진행합니다.`, 'warning'); } catch { /* disposed UI */ }
      return { skipped: 'send-failed' };
    }
    if (prefix) content = prefix + '\n' + content;
    let beforeSend: Partial<HarnessState> = {};
    state = await updateState(root, current => {
      beforeSend = { autoTurns: current.autoTurns,
        ...(current.state === 'recovering' ? { recoveryAutoResumed: current.recoveryAutoResumed } : {}) };
      return { autoTurns: Number(current.autoTurns ?? 0) + 1,
        ...(current.state === 'recovering' ? { recoveryAutoResumed: true } : {}) };
    });
    try {
      // No await between the final idle check and Pi's synchronous streaming transition.
      if (!ctxLike.isIdle()) {
        await updateState(root, beforeSend);
        return { skipped: 'busy' };
      }
      pi.sendMessage({ customType: 'harness-orchestrator', content, display: true,
        details: { state: state.state, taskId: state.taskId } }, { triggerTurn: true, deliverAs: 'followUp' });
      return { resumed: true };
    } catch (error) {
      await updateState(root, beforeSend);
      try { ctxLike.notify(`자동 재개 전송에 실패했습니다. ${redact(error instanceof Error ? error.message : String(error)).slice(0, 120)} 다음 사용자 입력에서 다시 진행합니다.`, 'warning'); }
      catch { /* 세션 폐기 뒤에는 warning 알림도 사용할 수 없다. */ }
      return { skipped: 'send-failed' };
    }
  });
}
