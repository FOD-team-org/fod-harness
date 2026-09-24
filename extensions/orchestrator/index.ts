import { recoverOrphanBrain } from '../../src/core/brain-lifecycle.ts';
import { randomUUID } from 'node:crypto';
import { redact } from '../../src/provider/privacy.ts';
import { scaffoldDoc } from '../../src/core/docs.ts';
import { ensureHarnessGitignore, GitignoreNotRegularError } from '../../src/core/project-init.ts';
import { startInterview, validateInterviewStart } from '../../src/core/interview.ts';
import { installSkills } from '../../src/core/skills.ts';
import { generateClaudeMd } from '../../src/core/claude-md.ts';
import { readMeta } from '../../src/core/codex-record.ts';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.ts';
import { readState, updateState, transitionState, activeStates as active, doctorFresh } from '../../src/core/state.ts';
import { listBacklog } from '../../src/core/backlog.ts';
import { runPick, decidePick, blockedTaskIds } from '../../src/core/pick.ts';
import { runCleanup } from '../../src/core/cleanup.ts';
import { notify, setNotifyContext } from '../../src/core/notify.ts';
import { applyJudgments, readJudgment, hasActiveJudgmentSnapshot, recoverJudgmentSnapshot, JudgmentConflict } from '../../src/core/judgment.ts';
import { listInbox, resolveInbox, type InboxRecord } from '../../src/core/inbox.ts';
import { appendLedger, unknownEntries } from '../../src/core/ledger.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from '../../src/core/storage.ts';

import { autoResume, resumeContext, send } from './resume.ts';
import { watcherStatus, judgmentStableFor, tick, logDeferredDecision } from '../../src/core/watcher.ts';
export { instruction } from './resume.ts';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function initialize(root: string): Promise<void> {
  try { await ensureHarnessGitignore(root); }
  catch (error) {
    if (!(error instanceof GitignoreNotRegularError)) throw error;
    await appendLedger(root, { runId: randomUUID(), action: 'init:gitignore', status: 'skipped', evidence: { skipped: error.skipped } });
  }
  await scaffoldDoc(root, 'backlog', { ifMissing: true });
  await scaffoldDoc(root, 'worklog', { ifMissing: true });
  await readJudgment(root);
}
async function prepareProject(root: string, ctx: ExtensionContext, reportChanges = false): Promise<void> {
  for (const action of [async () => {
    const result = await installSkills(root);
    for (const name of result.conflicts) ctx.ui.notify(`사용자 스킬과 이름이 겹칩니다: ${name}`, 'warning');
  }, async () => {
    const generated = await generateClaudeMd(root);
    if (reportChanges && 'files' in generated && generated.files?.some(file => file.changed)) ctx.ui.notify('CLAUDE.md 하네스 규칙이 바뀌었습니다. 커밋 필요', 'info');
  }]) {
    try { await action(); } catch { ctx.ui.notify('하네스 스킬 또는 CLAUDE.md 준비에 실패했습니다. fodh 명령으로 확인하세요.', 'warning'); }
  }
}

export default function orchestrator(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    setNotifyContext(ctx.cwd, resumeContext(ctx));
    await recoverOrphanBrain(ctx.cwd);
    await recoverJudgmentSnapshot(ctx.cwd);
    try { await ensureHarnessGitignore(ctx.cwd); }
    catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      try { await appendLedger(ctx.cwd, { runId: randomUUID(), action: 'init:gitignore', status: error instanceof GitignoreNotRegularError ? 'skipped' : 'fail',
        evidence: { error: message, ...(error instanceof GitignoreNotRegularError ? { skipped: error.skipped } : {}) } }); }
      catch { /* An initialization diagnostic must not prevent the session from starting. */ }
      try {
        const warn = () => notify(ctx.cwd, { key: 'init:gitignore', title: '하네스 초기화', level: 'warning',
          body: `.gitignore 갱신 ${error instanceof GitignoreNotRegularError ? '건너뜀' : '실패'}: ${message}` }, resumeContext(ctx));
        if (error instanceof GitignoreNotRegularError) {
          const path = harnessPath(ctx.cwd, 'harness-init-warned.json');
          await withFileLock(path, async () => {
            if ((await readJson<{ gitignore?: string }>(path, {})).gitignore === 'not-regular-file') return;
            await warn();
            await atomicWrite(path, JSON.stringify({ gitignore: 'not-regular-file', at: new Date().toISOString() }) + '\n');
          });
        } else await warn();
      }
      catch { /* Notification I/O is also best effort during session startup. */ }
    }
    try { await generateClaudeMd(ctx.cwd, { legacyWorklogOnly: true }); }
    catch (error) {
      try { await notify(ctx.cwd, { key: 'init:claude-md', title: '하네스 초기화', level: 'warning',
        body: `CLAUDE.md 작업일지 규약 갱신 실패: ${redact(error instanceof Error ? error.message : String(error))}` }, resumeContext(ctx)); }
      catch { /* Keep startup usable if migration diagnostics fail. */ }
    }
  });
  pi.on('session_shutdown', async (_event, ctx) => { setNotifyContext(ctx.cwd); });
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'extension') {
      const hold = /(?:^|[^\p{L}\p{N}_])(?:멈춰|멈추|기다려|잠깐|보류|확인할게|확인하고|(?:stop|hold|wait|pause)(?![\p{L}\p{N}_]))/iu.test(event.text);
      await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, autoTurns: 0, userHold: hold, userHoldSource: hold ? 'input' : undefined });
    } else if ((await readState(ctx.cwd)).userHoldSource !== 'command') {
      await updateState(ctx.cwd, { userHold: false, userHoldSource: undefined });
    }
    return { action: 'continue' };
  });
  pi.registerCommand('hold', {
    description: '다음 두뇌 턴의 사용자 대기 허용',
    handler: async (_args, ctx) => {
      await updateState(ctx.cwd, { userHold: true, userHoldSource: 'command' });
      ctx.ui.notify('다음 두뇌 턴의 대기: 사용자 를 받습니다', 'info');
    },
  });
  pi.registerCommand('project-start', {
    description: '프로젝트 인터뷰 시작',
    handler: async (args, ctx) => {
      if ((await readState(ctx.cwd)).state !== 'IDLE') throw new Error('project-start는 IDLE에서만 시작할 수 있습니다');
      try { await validateInterviewStart(ctx.cwd); await initialize(ctx.cwd); }
      catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        ctx.ui.notify(`인터뷰 시작 불가: ${message}`, 'error');
        await appendLedger(ctx.cwd, { runId: randomUUID(), action: 'project-start', status: 'fail', evidence: { error: message } });
        return;
      }
      const state = await transitionState(ctx.cwd, 'INTERVIEW');
      await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, ...(args.trim() ? { projectName: args.trim() } : {}) });
      await startInterview(ctx.cwd);
      await prepareProject(ctx.cwd, ctx);
      await send(pi, ctx.cwd, state);
    },
  });
  pi.registerCommand('develop-start', {
    description: '백로그 계획 또는 작업 선택 시작',
    handler: async (_args, ctx) => {
      let state = await readState(ctx.cwd);
      if (!['IDLE', 'PROJECT_READY', 'DONE_ALL', 'PLANNING', 'PICK', 'WAIT_RETRY', 'WAIT_RESOURCE'].includes(state.state)
        && !state.state.startsWith('paused(')) throw new Error('현재 상태에서 develop-start를 시작할 수 없습니다');
      if (state.state === 'WAIT_RETRY' && state.retry?.nextAt && Date.parse(state.retry.nextAt) > Date.now()) {
        ctx.ui.notify(`${Math.ceil((Date.parse(state.retry.nextAt) - Date.now()) / 60000)}분 뒤 재시도 예정`, 'info'); return;
      }
      await prepareProject(ctx.cwd, ctx, true);
      const missingBacklog = !await exists(join(ctx.cwd, 'docs/backlog.md'));
      const tasks = await listBacklog(ctx.cwd);
      if (missingBacklog) await initialize(ctx.cwd);
      await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, autoTurns: 0 });
      if (!tasks.length && state.state === 'PLANNING') {
        ctx.ui.notify('백로그가 비어 있습니다. PLANNING 을 계속합니다', 'info'); return;
      }
      if (['IDLE', 'PROJECT_READY', 'DONE_ALL'].includes(state.state)) state = await transitionState(ctx.cwd, 'PLANNING');
      if (!tasks.length) {
        if (state.state !== 'PLANNING') throw new Error('백로그 계획은 PLANNING 상태가 필요합니다');
        await send(pi, ctx.cwd, state); return;
      }
      if (state.state !== 'PICK') await transitionState(ctx.cwd, 'PICK');
      const result = await runPick(ctx.cwd);
      if (result.outcome === 'EMPTY') { ctx.ui.notify(result.reason, 'info'); return; }
      state = await readState(ctx.cwd);
      if (active.has(state.state)) await send(pi, ctx.cwd, state);
      else ctx.ui.notify(JSON.stringify(result), 'info');
    },
  });
  pi.registerCommand('status', {
    description: '상태·미적용 인박스·미해결 원장·최근 한도 표시',
    handler: async (_args, ctx) => {
      const [state, inbox, unknown, watcher] = await Promise.all([readState(ctx.cwd), listInbox(ctx.cwd), unknownEntries(ctx.cwd), watcherStatus(ctx.cwd)]);
      const delegationMeta = state.delegation ? await readMeta(ctx.cwd, state.delegation.runId) : undefined;
      const delegation = state.delegation ? { ...state.delegation, status: delegationMeta?.status ?? 'unknown',
        minutes: Math.max(0, (Date.now() - Date.parse(state.delegation.startedAt)) / 60000) } : null;
      ctx.ui.notify(JSON.stringify({ delegation, state: state.state, task: state.taskId ?? null,
        inbox: inbox.filter(item => item.status !== 'applied'), unknown, watcher, rateLimit: state.rateLimitInfo ?? null }), 'info');
    },
  });
  pi.registerCommand('judged', {
    description: '판단 답 적용 후 작업 재개',
    handler: async (args, ctx) => {
      const ids = args.trim() ? args.trim().split(/\s+/u) : undefined;
      if (ids?.some(id => !/^A\d+(?:-\d+)?$/u.test(id))) throw new Error('판단 번호가 올바르지 않습니다');
      const held = (await readJudgment(ctx.cwd)).items.filter(item => item.held);
      if (!ids && held.length) {
        ctx.ui.notify(`held: ${held.map(item => `${item.id}=${JSON.stringify(item.answer)}(두뇌 턴 ${item.held!.runId.slice(0, 8)})`).join(', ')}`, 'info');
        return;
      }
      const released = held.filter(item => ids?.includes(item.id)).map(({ id, answer }) => ({ id, answer }));
      await updateState(ctx.cwd, { userAborted: false });
      const before = await readState(ctx.cwd);
      const result = await applyJudgments(ctx.cwd, ids, undefined, { releaseHeld: !!ids?.length });
      ctx.ui.notify(JSON.stringify({ ...result, released }), 'info');
      const state = await readState(ctx.cwd);
      if ((before.state === 'WAIT_JUDGMENT' || before.state === 'paused(cleanup)') && result.applied.length && active.has(state.state)) {
        await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, autoTurns: 0 });
        await send(pi, ctx.cwd, state, state.state);
      }
    },
  });
  pi.registerCommand('cleanup', {
    description: '프로세스·저장공간·워크트리 정리 (/cleanup dry 지원)',
    handler: async (args, ctx) => {
      if (args.trim() && !['dry', '--dry-run'].includes(args.trim())) throw new Error('/cleanup [dry|--dry-run]');
      const result = await runCleanup(ctx.cwd, { scope: 'all', dryRun: !!args.trim() });
      await notify(ctx.cwd, { key: `cleanup:${result.runId}`, level: result.ok ? 'info' : 'warning', title: '정리 결과',
        body: JSON.stringify({ ok: result.ok, remaining: (result.processes?.residual.length ?? 0) + (result.processes?.unverified.length ?? 0), stale: result.processes?.stale.length ?? 0, protected: result.processes?.protected.length ?? 0, report: '.pi/cleanup-last.json' }) }, resumeContext(ctx));
    },
  });
  pi.on('agent_end', async (event, ctx) => {
    try {
      const last = [...event.messages].reverse().find(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'aborted') { await updateState(ctx.cwd, { userAborted: true }); return; }
      if (last?.role === 'assistant' && last.stopReason === 'error') {
        const state = await updateState(ctx.cwd, current => ({ brainErrors: Number(current.brainErrors ?? 0) + 1 }));
        if (Number(state.brainErrors) >= 3) await notify(ctx.cwd, { key: 'brain-errors', title: '두뇌 오류', level: 'error', body: '두뇌 오류가 3회 연속 발생했습니다. 상태와 원장을 확인하세요' }, resumeContext(ctx));
        return;
      }
      if ((await readState(ctx.cwd)).brainErrors) await updateState(ctx.cwd, { brainErrors: 0 });
      if (ctx.hasUI === false) return;
      const text = last?.role === 'assistant' ? last.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
      const tail = text.split('\n').map(line => line.trim()).filter(Boolean).slice(-3)
        .map(line => line.replace(/^[`<>]+|[`<>]+$/gu, '').trim());
      const marker = tail.map(line => /^대기: 위임\s+([`<>]*[A-Za-z0-9_-]+[`<>]*)$/u.exec(line)?.[1])
        .find(Boolean)?.replace(/[`<>]/gu, '');
      const awaitingUser = text.split('\n').some(line => line.trim().replace(/^[*_`]+|[*_`]+$/gu, '').trim() === '대기: 사용자');
      const slotState = await readState(ctx.cwd);
      if (slotState.awaitingSlot && !slotState.delegation
        && (active.has(slotState.state) && !['recovering', 'INTERVIEW'].includes(slotState.state) || slotState.state === 'paused(slot)')) {
        if (slotState.state !== 'paused(slot)') await updateState(ctx.cwd, { state: 'paused(slot)', awaitingUser: false, autoTurns: 0 });
        else await updateState(ctx.cwd, { awaitingUser: false, autoTurns: 0 });
        return;
      }
      {
        const waiting = await withFileLock(harnessPath(ctx.cwd, 'harness-resume'), async () => {
          const state = await readState(ctx.cwd);
          const runId = state.delegation?.runId;
          const meta = runId ? await readMeta(ctx.cwd, runId) : undefined;
          if (meta && !meta.finishedAt) {
            if (marker !== runId && state.delegation?.implied !== runId) {
              await appendLedger(ctx.cwd, { runId: runId!, action: 'delegation:implied', status: 'ok', evidence: { marker: marker ?? null, runId } });
              await updateState(ctx.cwd, { delegation: { ...state.delegation!, implied: runId } });
            }
            await updateState(ctx.cwd, { awaitingDelegation: true, ...(awaitingUser ? { awaitingUser: true } : {}), autoTurns: 0 }); return true;
          }
          if (marker) await appendLedger(ctx.cwd, { runId: marker, action: 'delegation:marker', status: 'skip' });
          await updateState(ctx.cwd, { awaitingDelegation: false }); return false;
        });
        if (waiting) return;
      }
      const waitingState = await readState(ctx.cwd);
      if (awaitingUser && !waitingState.userHold && waitingState.state === 'PICK') {
        const state = await readState(ctx.cwd), tasks = await listBacklog(ctx.cwd);
        const decision = decidePick(tasks, state, { slots: 'ok', now: Date.now() });
        const open = (await readJudgment(ctx.cwd)).items;
        const blocked = blockedTaskIds(tasks, open);
        const candidates = tasks.filter(task => task.status !== 'done' && !blocked.has(task.id)).map(task => task.id);
        const allBlocked = tasks.some(task => task.status !== 'done') && !candidates.length;
        if (decision.outcome !== 'EMPTY' && !allBlocked
          && !(!candidates.length && (decision.outcome === 'DONE_ALL' || decision.outcome.startsWith('WAIT_')))) {
          await updateState(ctx.cwd, { awaitingUser: false });
          await appendLedger(ctx.cwd, { runId: randomUUID(), action: 'pick:user-wait-rejected', status: 'skip', evidence: { taskIds: candidates } });
          await autoResume(pi, ctx.cwd, resumeContext(ctx), 'agent_end', `[PICK 에서는 사용자를 기다리지 않는다. fodh pick 을 실행해 결과(${decision.outcome})를 확정하라${candidates.length ? `: ${candidates.join(', ')}` : ''}]`);
          return;
        }
      }
      if (awaitingUser) {
        const state = await readState(ctx.cwd);
        if (!state.userHold && state.taskId && ['SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'REVIEW', 'MERGE', 'DOCS', 'CLEANUP'].includes(state.state)) {
          const task = (await listBacklog(ctx.cwd)).find(task => task.id === state.taskId);
          const blocking = (await readJudgment(ctx.cwd)).items.some(item => !item.followup
            && (item.blocks.split(/[\s,]+/u).includes(state.taskId!) || task?.status === `blocked(${item.id})`));
          if (!blocking) {
            await updateState(ctx.cwd, { awaitingUser: false });
            await appendLedger(ctx.cwd, { runId: randomUUID(), action: 'turn:user-wait-rejected', status: 'skip', evidence: { state: state.state, taskId: state.taskId } });
            await autoResume(pi, ctx.cwd, resumeContext(ctx), 'agent_end', '[task 진행 중에는 사용자를 기다리지 않는다. 사용자 결정이 필요하면 fodh judgment add --title … --blocks <taskId> --reclaim 으로 등록하고(RECLAIM→PICK 으로 간다), 아니면 계속 진행하라]');
            return;
          }
        }
        if (state.userHold) await appendLedger(ctx.cwd, { runId: randomUUID(), action: 'turn:user-wait-accepted', status: 'ok',
          evidence: { state: state.state, taskId: state.taskId, hold: state.userHoldSource ?? 'input' } });
        await updateState(ctx.cwd, { awaitingUser: true, autoTurns: 0 }); return;
      }
      if ((await readState(ctx.cwd)).awaitingUser) { await updateState(ctx.cwd, { autoTurns: 0 }); return; }
      await autoResume(pi, ctx.cwd, resumeContext(ctx), 'agent_end');
    } finally {
      if ((await readState(ctx.cwd)).userHold) await updateState(ctx.cwd, { userHold: false, userHoldSource: undefined });
    }
  });
}

interface DecisionOptions { retry?: () => Promise<void>; now?: () => number }
const decisionTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number }>();
export function clearDecisionTimers(root: string): void {
  const pending = decisionTimers.get(root);
  if (pending) clearTimeout(pending.timer);
  decisionTimers.delete(root);
}
function deferDecision(root: string, delay: number, retry: () => Promise<void>): boolean {
  const at = Date.now() + delay;
  const current = decisionTimers.get(root);
  if (current && Math.abs(current.at - at) < 1000) return false;
  clearDecisionTimers(root);
  const timer = setTimeout(() => {
    decisionTimers.delete(root);
    void retry().catch(async () => {
      try { await appendLedger(root, { runId: 'free-text-retry', action: 'watcher:tick', status: 'fail',
        evidence: { message: '자유 서술 재결정 실패' } }); } catch { /* storage unavailable */ }
    });
  }, Math.max(1, delay));
  timer.unref(); decisionTimers.set(root, { timer, at }); return true;
}
export async function decideInbox(pi: ExtensionAPI, ctx: ExtensionContext, root: string, records: InboxRecord[], options: DecisionOptions = {}): Promise<{ deferred: string[] }> {
  const context = resumeContext(ctx), deferred: string[] = [];
  for (const kind of new Set(records.map(record => record.kind))) {
    const batch = records.filter(record => record.kind === kind);
    let applied: string[] = [], resumed = false, handled = false, resolve = false;
    try {
      if (kind === 'judgment-changed') {
        if (await hasActiveJudgmentSnapshot(root)) {
          deferred.push(...batch.map(record => record.id));
          const retry = options.retry ?? (async () => {
            await tick(root, { judgmentOnly: true });
            await decideInbox(pi, ctx, root, batch, options);
          });
          deferDecision(root, 5000, retry);
          await logDeferredDecision(root, batch, applied, resumed);
          continue;
        }
        const document = await readJudgment(root, { answered: true });
        const hasHeld = document.items.some(item => item.held);
        const answered = document.items.filter(item => !item.followup && !item.held);
        const config = await loadConfig(root);
        const stableFor = await judgmentStableFor(root, options.now?.());
        const waiting = answered.filter(item => item.classification?.applicable && item.classification.kind === 'freeform'
          && !/(?:^|[\s,.:;])(승인(?:합니다|해요|해|함)?|진행(?:합니다|해요|해)?)(?=$|[\s,.:;])/u.test(item.answer)
          && stableFor < config.watch.freeTextStableSeconds);
        const ready = answered.filter(item => !waiting.includes(item));
        if (ready.length) {
          const result = await applyJudgments(root, ready.map(item => item.id), Object.fromEntries(ready.map(item => [item.id, item.raw])));
          applied = result.applied.map(item => item.id);
          const reasked = result.unapplied.length ? (await readJudgment(root)).items
            .filter(item => item.reaskOf && ready.some(answer => answer.id === item.reaskOf))
            .map(item => ({ id: item.id, reaskOf: item.reaskOf })) : [];
          context.notify(JSON.stringify({ ...result, reasked }), 'info');
          if (applied.length && active.has((await readState(root)).state)) {
            await updateState(root, { awaitingUser: false, autoTurns: 0 });
            resumed = (await autoResume(pi, root, context, kind)).resumed === true;
          }
          handled = applied.length > 0 || reasked.length > 0;
        }
        if (waiting.length) {
          deferred.push(...batch.map(record => record.id));
          const seconds = Math.ceil(config.watch.freeTextStableSeconds - stableFor);
          const retry = options.retry ?? (async () => {
            await tick(root, { judgmentOnly: true });
            await decideInbox(pi, ctx, root, batch, options);
          });
          if (deferDecision(root, seconds * 1000, retry)) context.notify(`자유 서술 답 ${seconds}초 뒤 적용 예정`, 'info');
        } else {
          clearDecisionTimers(root); resolve = true;
          if (!applied.length && !handled && !hasHeld) context.notify('판단대기 변경 감지 — 적용할 답 없음', 'info');
        }
      } else if (kind === 'codex-done') {
        const matching: InboxRecord[] = [];
        await withFileLock(harnessPath(root, 'harness-resume'), async () => {
          for (const record of batch) {
            const runId = record.codexRunId ?? record.runId;
            const state = await readState(root);
            if (state.delegation?.runId === runId) {
              await updateState(root, { delegation: undefined, awaitingDelegation: false, autoTurns: 0 });
              matching.push(record);
            } else await resolveInbox(root, [record.id], 'orchestrator', 'codex-done:stale');
          }
        });
        if (matching.length) {
          for (const record of matching) {
            if (record.supervisorLost) await notify(root, { key: `codex:${record.codexRunId ?? record.runId}`, level: 'warning', title: '위임 완료', body: '감독 사망 뒤 추정한 성공 — 결과를 직접 확인' }, context);
            else if (['fail', 'timeout', 'lost'].includes(String(record.codexStatus))) {
              await notify(root, { key: `codex:${record.codexRunId ?? record.runId}`, level: 'warning', title: '위임 실패', body: `Codex 위임 ${record.codexRunId ?? record.runId}: ${record.codexStatus} — 결과를 확인하세요` }, context);
            }
          }
          resumed = (await autoResume(pi, root, context, kind)).resumed === true;
          handled = true; // Keep the matching inbox available to buildPrompt / brain ack, also when busy.
        }
      } else if (kind === 'memory-pressure') {
        const report = await runCleanup(root, { scope: 'processes' });
        await notify(root, { key: kind, level: 'warning', title: '메모리 경고', body: `스왑 ${batch[0].swapUsedGB} GB — 잔존 프로세스 ${report.processes?.reclaimed.length ?? 0}개 회수` }, context);
        handled = true;
      } else if (kind === 'memory-critical') {
        const wasActive = active.has((await readState(root)).state);
        if (wasActive) await transitionState(root, 'paused(memory)', { system: true });
        await notify(root, { key: kind, level: 'error', title: '메모리 중단', body: `스왑 초과가 5분 지속되어 ${wasActive ? '새 위임을 중단했습니다' : '회복 전까지 새 위임을 거부합니다'}. 해제: fodh memory reset(스왑이 실제로 줄지 않으면 다시 걸린다)` }, context);
        handled = true;
      } else if (kind === 'slot-free') {
        const state = await readState(root);
        const waiting = state.awaitingSlot;
        const matching = waiting && batch.some(record => record.since === waiting.since && record.ownerRunId === waiting.owner.runId);
        if (matching && (state.state === 'paused(slot)' || ['PICK', 'WAIT_RESOURCE'].includes(state.state) && state.lastPaused === 'slot')) {
          await updateState(root, { awaitingSlot: undefined, autoTurns: 0 });
          if (state.state !== 'PICK') await transitionState(root, 'PICK');
          resumed = (await autoResume(pi, root, context, kind)).resumed === true;
        }
        handled = true; resolve = true;
      } else if (kind === 'memory-recovered') {
        const state = await readState(root);
        const recover = state.state === 'paused(memory)' || state.state === 'WAIT_RESOURCE' && state.lastPaused === 'memory';
        if (recover || state.lastPaused === 'memory') await updateState(root, { lastPaused: undefined });
        if (recover) {
          await transitionState(root, 'PICK');
          resumed = (await autoResume(pi, root, context, kind)).resumed === true;
        }
        await notify(root, { key: kind, level: 'info', title: '메모리 회복', body: batch.some(record => record.manualReset) ? '메모리 정지를 수동 해제했습니다. 스왑이 실제로 줄지 않으면 다시 걸립니다' : '스왑 사용량이 회복 기준을 5분 동안 유지했습니다' }, context);
        handled = true;
      } else if (kind === 'stalled') {
        const state = await readState(root);
        if (state.state === 'recovering' || state.userAborted) {
          context.notify(`사용자 중단 상태: ${state.state} — 사용자 입력 또는 명령으로 이어갑니다`, 'info');
          resolve = true;
        } else {
          const result = await autoResume(pi, root, context, kind);
          resumed = result.resumed === true; handled = resumed || result.stopped === true;
          resolve = !resumed;
          if (result.skipped) context.notify(`두뇌 정체 감지 — 자동 재개 건너뜀: ${result.skipped}`, 'warning');
        }
      } else if (kind === 'child-timeout' || kind === 'child-gone') {
        context.notify(`자식 프로세스 ${kind === 'child-timeout' ? '시간 초과' : '종료'} 감지: ${batch.map(record => record.pid).join(', ')} — 다음 턴에 전달`, 'warning');
        handled = true;
      } else if (kind === 'recover') {
        const state = await readState(root);
        if (state.state !== 'recovering' && !state.userAborted && active.has(state.state) && state.awaitingUser !== true
          && doctorFresh(state, (await loadConfig(root)).brain.doctorTtlHours)) {
          resumed = (await autoResume(pi, root, context, kind)).resumed === true; handled = resumed;
        } else {
          context.notify(`이전 세션 상태: ${state.state}${state.taskId ? ` /${state.taskId}` : ''} — /develop-start 또는 /judged 로 이어갑니다`, 'info');
        }
        resolve = true;
      }
    } catch (error) {
      if (kind !== 'judgment-changed' || !(error instanceof JudgmentConflict)) throw error;
      deferred.push(...batch.map(record => record.id));
      continue; // Normal editor contention: retry next tick without a failure or warning.
    }
    if (!handled && batch.some(record => deferred.includes(record.id))) {
      await logDeferredDecision(root, batch, applied, resumed);
    } else await appendLedger(root, { runId: batch[0]!.id, action: `watcher:decide:${kind}`, status: handled ? 'ok' : 'skip',
      evidence: { ids: batch.map(record => record.id), applied, resumed } });
    if (resolve) await resolveInbox(root, batch.map(record => record.id), 'orchestrator', `watcher:decide:${kind}`);
  }
  return { deferred };
}
