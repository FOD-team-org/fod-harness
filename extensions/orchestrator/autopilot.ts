import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readAutopilot, autopilotSweep, changeAutopilot } from '../../src/core/autopilot.ts';
import { readState } from '../../src/core/state.ts';
import { hasActiveJudgmentSnapshot } from '../../src/core/judgment.ts';
import { harnessPath, withFileLock } from '../../src/core/storage.ts';
import { notify } from '../../src/core/notify.ts';
import { resumeContext } from './resume.ts';
import { applyAndResume, startDevelopment } from './index.ts';

export async function runAutopilot(pi: ExtensionAPI, ctx: ExtensionContext, root = ctx.cwd, now: () => Date = () => new Date()): Promise<void> {
  if (!(await readAutopilot(root)).enabled) { ctx.ui?.setStatus?.('fodh-autopilot', undefined); return; }
  const context = resumeContext(ctx);
  const notifications: Promise<unknown>[] = [];
  const notificationErrors: unknown[] = [];
  await autopilotSweep(root, { now, hasUI: ctx.hasUI,
    idle: () => ctx.isIdle() && !ctx.hasPendingMessages?.() && !ctx.signal?.aborted,
    apply: (ids, expected) => applyAndResume(pi, context, root, ids, expected, 'autopilot'),
    notify: (key, body, level) => { notifications.push(notify(root, { key, body, level, title: '오토파일럿' }, context, { now: now().getTime() }).catch(error => { notificationErrors.push(error); })); },
  });
  await Promise.all(notifications);
  if (notificationErrors.length) throw notificationErrors[0];
  await withFileLock(harnessPath(root, 'harness-autopilot-gate'), async () => {
    const auto = await readAutopilot(root), state = await readState(root);
    if (!auto.enabled || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages?.() || ctx.signal?.aborted
      || state.userHold || state.userAborted || await hasActiveJudgmentSnapshot(root)) return;
    if (state.state === 'PROJECT_READY') {
      await changeAutopilot(root, async current => {
        if (current.enabled && (!current.until || now().getTime() < Date.parse(current.until))) await startDevelopment(pi, ctx, root, 'autopilot');
      });
    } else if (state.state === 'DONE_ALL') {
      await changeAutopilot(root, async current => {
        if (!current.enabled || current.doneAll) return;
        current.doneAll = true;
        await notify(root, { key: 'autopilot:done-all', title: '오토파일럿', level: 'info', body: '오토파일럿: 백로그를 모두 끝냈습니다 — 새 범위는 사용자가 정합니다' }, context, { now: now().getTime() });
      });
    }
  });
  const auto = await readAutopilot(root);
  ctx.ui?.setStatus?.('fodh-autopilot', auto.enabled ? `오토 ${auto.answered ?? 0}/${auto.maxAnswers ?? 30}` : undefined);
}

