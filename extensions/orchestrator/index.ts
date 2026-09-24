import { readMeta } from '../../src/core/codex-record.ts';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/core/config.ts';
import { readState, updateState, transitionState, activeStates as active, doctorFresh } from '../../src/core/state.ts';
import { listBacklog } from '../../src/core/backlog.ts';
import { runPick } from '../../src/core/pick.ts';
import { cleanupReport } from '../../src/core/reclaim.ts';
import { applyJudgments, readJudgment, JudgmentConflict } from '../../src/core/judgment.ts';
import { listInbox, resolveInbox, type InboxRecord } from '../../src/core/inbox.ts';
import { appendLedger, unknownEntries } from '../../src/core/ledger.ts';
import { atomicWrite, harnessPath, withFileLock } from '../../src/core/storage.ts';

import { autoResume, resumeContext, send } from './resume.ts';
import { watcherStatus, judgmentStableFor, tick, logDeferredDecision } from '../../src/core/watcher.ts';
export { instruction } from './resume.ts';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));


async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function initialize(root: string): Promise<void> {
  for (const name of ['backlog.md', '작업일지.md']) {
    const path = join(root, 'docs', name);
    await withFileLock(path, async () => {
      if (!await exists(path)) await atomicWrite(path, await readFile(join(templates, name), 'utf8'));
    });
  }
  await readJudgment(root);
}

export default function orchestrator(pi: ExtensionAPI): void {
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'extension') await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, autoTurns: 0 });
    return { action: 'continue' };
  });
  pi.registerCommand('project-start', {
    description: '프로젝트 인터뷰 시작',
    handler: async (args, ctx) => {
      if ((await readState(ctx.cwd)).state !== 'IDLE') throw new Error('project-start는 IDLE에서만 시작할 수 있습니다');
      await initialize(ctx.cwd);
      const state = await transitionState(ctx.cwd, 'INTERVIEW');
      await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, ...(args.trim() ? { projectName: args.trim() } : {}) });
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
      await updateState(ctx.cwd, { userAborted: false });
      const before = await readState(ctx.cwd);
      const result = await applyJudgments(ctx.cwd, ids);
      ctx.ui.notify(JSON.stringify(result), 'info');
      const state = await readState(ctx.cwd);
      if ((before.state === 'WAIT_JUDGMENT' || before.state === 'paused(cleanup)') && result.applied.length && active.has(state.state)) {
        await updateState(ctx.cwd, { userAborted: false, awaitingUser: false, autoTurns: 0 });
        await send(pi, ctx.cwd, state, state.state);
      }
    },
  });
  pi.registerCommand('cleanup', {
    description: '프로세스 레지스트리 잔존 보고 (P4 전까지 정리 실행 없음)',
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(await cleanupReport(ctx.cwd)), 'info'); },
  });
  pi.on('agent_end', async (event, ctx) => {
    const last = [...event.messages].reverse().find(message => message.role === 'assistant');
    if (last?.role === 'assistant' && last.stopReason === 'aborted') { await updateState(ctx.cwd, { userAborted: true }); return; }
    if (ctx.hasUI === false) return;
    if (last?.role === 'assistant' && last.stopReason === 'error') return;
    const text = last?.role === 'assistant' ? last.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
    const tail = text.split('\n').map(line => line.trim()).filter(Boolean).slice(-3)
      .map(line => line.replace(/^[`<>]+|[`<>]+$/gu, '').trim());
    const marker = tail.map(line => /^대기: 위임\s+([`<>]*[A-Za-z0-9_-]+[`<>]*)$/u.exec(line)?.[1])
      .find(Boolean)?.replace(/[`<>]/gu, '');
    const awaitingUser = text.split('\n').some(line => line.trim().replace(/^[*_`]+|[*_`]+$/gu, '').trim() === '대기: 사용자');
    if (marker) {
      const waiting = await withFileLock(harnessPath(ctx.cwd, 'harness-resume'), async () => {
        const state = await readState(ctx.cwd);
        const meta = state.delegation?.runId === marker ? await readMeta(ctx.cwd, marker) : undefined;
        if (meta && !meta.finishedAt) {
          await updateState(ctx.cwd, { awaitingDelegation: true, ...(awaitingUser ? { awaitingUser: true } : {}), autoTurns: 0 }); return true;
        }
        await appendLedger(ctx.cwd, { runId: marker, action: 'delegation:marker', status: 'skip' });
        await updateState(ctx.cwd, { awaitingDelegation: false }); return false;
      });
      if (waiting) return;
    }
    if (awaitingUser) {
      await updateState(ctx.cwd, { awaitingUser: true, autoTurns: 0 }); return;
    }
    if ((await readState(ctx.cwd)).awaitingUser) { await updateState(ctx.cwd, { autoTurns: 0 }); return; }
    await autoResume(pi, ctx.cwd, resumeContext(ctx), 'agent_end');
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
        const answered = (await readJudgment(root, { answered: true })).items.filter(item => !item.followup);
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
          if (!applied.length && !handled) context.notify('판단대기 변경 감지 — 적용할 답 없음', 'info');
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
            if (record.supervisorLost) context.notify('감독 사망 뒤 추정한 성공 — 결과를 직접 확인', 'warning');
            else if (['fail', 'timeout', 'lost'].includes(String(record.codexStatus))) {
              context.notify(`Codex 위임 ${record.codexRunId ?? record.runId}: ${record.codexStatus} — 결과를 확인하세요`, 'warning');
            }
          }
          resumed = (await autoResume(pi, root, context, kind)).resumed === true;
          handled = true; // Keep the matching inbox available to buildPrompt / brain ack, also when busy.
        }
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
