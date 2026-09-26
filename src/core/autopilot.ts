import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { assertNotBrain } from './brain-guard.ts';
import { loadConfig, type HarnessConfig } from './config.ts';
import { AnswerConflict, JudgmentConflict, answerJudgment, approvalRequired, hasActiveJudgmentSnapshot, questionHash, readJudgment, type JudgmentItem } from './judgment.ts';
import { notify, type NotifyContext } from './notify.ts';
import { appendLedger } from './ledger.ts';
import { readState, type HarnessState } from './state.ts';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { redact } from '../provider/privacy.ts';

interface Pending { firstSeen: string; rev: number; questionHash: string; option: number }
export interface AutopilotState {
  enabled: boolean; runId?: string; since?: string; until?: string; interview?: boolean; maxAnswers?: number; answered?: number;
  perTask?: Record<string, number>; perScope?: Record<string, number>; stallResumed?: Record<string, boolean>;
  pending?: Record<string, Pending>; recentTitles?: string[];
  stallNotified?: Record<string, true>; notified?: Record<string, Record<string, true>>;
  chat?: { scope: string; count: number; progress?: string; decisions?: string };
  // Store fingerprints, not judgment contents; editor changes never authorize a retry.
  pendingApply?: Record<string, string>; failedApply?: string[]; doneAll?: boolean;
  scope?: string; // Pure eligibility input, supplied from the harness by the caller.
}
export interface AutopilotStatus extends AutopilotState { remainingMs?: number; unappliedAutoAnswers: string[] }
const fingerprint = (raw: string) => createHash('sha256').update(raw).digest('hex');
const path = (root: string) => harnessPath(root, 'harness-autopilot.json');
export const readAutopilot = (root: string): Promise<AutopilotState> => readJson(path(root), { enabled: false });
const save = (root: string, state: AutopilotState) => atomicWrite(path(root), JSON.stringify(state, null, 2) + '\n');
export async function changeAutopilot<T>(root: string, action: (state: AutopilotState) => Promise<T>): Promise<T> {
  return withFileLock(harnessPath(root, 'harness-autopilot'), async () => {
    const state = await readAutopilot(root), before = JSON.stringify(state);
    const result = await action(state);
    if (JSON.stringify(state) !== before) await save(root, state);
    return result;
  });
}
export function parseAutopilotDuration(value: string): number {
  const match = /^([1-9]\d*)(m|h|d)$/u.exec(value);
  const ms = match ? Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[match[2]]!) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 7 * 86400000) throw new Error('--for는 30m·8h·2d 꼴이며 최대 7일입니다');
  return ms;
}
export function parseAutopilotCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    for: { type: 'string' }, max: { type: 'string' }, interview: { type: 'boolean' },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || !['on', 'off', 'status'].includes(action)
    || action !== 'on' && Object.keys(values).length) throw new Error('autopilot on|off|status [--for 8h] [--max 30] [--interview]');
  if (values.max !== undefined && !/^(?:[1-9]\d?|1\d\d|200)$/u.test(values.max)) throw new Error('--max는 1~200 사이 정수여야 합니다');
  return { action, options: { ...(values.for !== undefined ? { forMs: parseAutopilotDuration(values.for) } : {}),
    ...(values.max ? { max: Number(values.max) } : {}), interview: values.interview ?? false } };
}
export async function autopilotOn(root: string, options: { forMs?: number; max?: number; interview?: boolean; now: Date }): Promise<AutopilotState> {
  await assertNotBrain(root, 'autopilot on');
  const max = options.max ?? (await loadConfig(root)).autopilot.maxAnswers;
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error('--max는 1~200 사이 정수여야 합니다');
  if (options.forMs !== undefined && (!Number.isSafeInteger(options.forMs) || options.forMs <= 0 || options.forMs > 7 * 86400000)) throw new Error('--for는 최대 7일입니다');
  const state: AutopilotState = { enabled: true, runId: randomUUID(), since: options.now.toISOString(),
    ...(options.forMs === undefined ? {} : { until: new Date(options.now.getTime() + options.forMs).toISOString() }),
    interview: options.interview ?? false, maxAnswers: max, answered: 0, perTask: {}, perScope: {}, stallResumed: {}, pending: {}, recentTitles: [], chat: { scope: '', count: 0 } };
  await withFileLock(harnessPath(root, 'harness-autopilot'), () => save(root, state));
  return state;
}
const unappliedAnswers = async (root: string): Promise<string[]> => (await readJudgment(root)).items
  .filter(item => item.answerSource === 'autopilot').map(item => item.id);
const unappliedMessage = (id: string) => `오토파일럿이 꺼졌습니다 — ${id} 는 자동 답이 적혀 있지만 아직 적용되지 않았습니다. 확인 뒤 /judged ${id} 또는 답을 고치세요`;
export async function autopilotOff(root: string, options: { context?: NotifyContext; now?: Date } = {}): Promise<AutopilotStatus> {
  await assertNotBrain(root, 'autopilot off');
  return changeAutopilot(root, async state => {
    const wasEnabled = state.enabled;
    state.enabled = false; state.pending = {}; state.pendingApply = {};
    const unappliedAutoAnswers = await unappliedAnswers(root);
    if (wasEnabled) for (const id of unappliedAutoAnswers) await notify(root, {
      key: `autopilot:off:${id}`, title: '오토파일럿', body: unappliedMessage(id), level: 'warning',
    }, options.context, { now: options.now?.getTime() });
    return { ...state, unappliedAutoAnswers };
  });
}
export async function autopilotStatus(root: string, now: Date): Promise<AutopilotStatus> {
  const state = await readAutopilot(root);
  return { ...state, unappliedAutoAnswers: await unappliedAnswers(root),
    ...(state.until ? { remainingMs: Math.max(0, Date.parse(state.until) - now.getTime()) } : {}) };
}
const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ');
export function recommendedOption(item: JudgmentItem): number | undefined {
  const text = item.recommend.trim();
  if (!text || text.startsWith('추천 없음')) return;
  if (item.origin?.kind === 'interview' && item.options.length === 2
    && item.options[0] === '추천안 채택' && item.options[1] === '직접 답하기'
    && normalize(text) === normalize(item.options[1])) return;
  if (item.origin?.kind === 'interview' && (normalize(text) === normalize(item.options[0] ?? '')
    || item.options.length === 2 && item.options[0] === '추천안 채택' && item.options[1] === '직접 답하기')) return 1;
  if (!text) return;
  const circle = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.indexOf(text[0]);
  const number = circle >= 0 ? circle + 1 : Number(/^\d+(?=번|\)|\.|\s|$)/u.exec(text)?.[0]);
  return Number.isInteger(number) && number >= 1 && number <= item.options.length ? number : undefined;
}
export function autopilotBlocked(item: JudgmentItem, config: HarnessConfig): boolean {
  if (approvalRequired(item, config.requiresApproval)) return true;
  const text = `${item.title} ${item.background} ${item.options.join(' ')} ${item.recommend} ${item.detail ?? ''}`;
  if (approvalRequired({ ...item, background: text }, config.requiresApproval)) return true;
  if (/마이그레이션|배포|운영|릴리스|출시|삭제|되돌리|태그|토큰|시크릿|키|과금|비용|요금|계정|권한|게시|공개|발송|이메일|SMS|알림 발송|\b(?:tags?|prod(?:uction)?|drop\w*|reset\w*|force\w*|tokens?|deploy\w*|migrat\w*|release\w*|publish\w*|delet\w*|revert\w*|secrets?|billing|permissions?)\b/iu.test(text)) return true;
  return config.requiresApproval.some(name => {
    if (text.toLowerCase().includes(name.toLowerCase())) return true;
    const rule = config.approvalRules.find(rule => rule.id === name);
    if (!rule) return false;
    if (rule.description && text.toLowerCase().includes(rule.description.toLowerCase())) return true;
    try { return new RegExp(rule.pattern, 'i').test(text); } catch { return false; }
  });
}
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\(?rev\s*\d+\)?/giu, '').replace(/[at]\d+/giu, '').replace(/[\s\d①-⑳]+/gu, '');
}
export const autopilotScope = (state: HarnessState): string => `${state.state === 'WAIT_JUDGMENT' ? state.resumeState ?? state.state : state.state}:${state.phase ?? (state.taskId ? 'task' : 'project')}`;
export function autopilotEligible(item: JudgmentItem, config: HarnessConfig, state: AutopilotState, now: Date): { ok: true; option: number } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!state.enabled) return no('꺼짐');
  if (state.until && now.getTime() >= Date.parse(state.until)) return no('기간 만료');
  if (!item.origin || item.origin.kind === 'cli') return no('출처 제외');
  if (item.origin.kind === 'interview' && !state.interview) return no('인터뷰 제외');
  if (item.answer.trim() || item.held || item.followup || item.reaskOf || item.resolution === 'cleanup') return no('답·보류·후속·정리 판단');
  if (autopilotBlocked(item, config)) return no('승인 필요');
  if (item.options.length < 2) return no('선택지 부족');
  const option = recommendedOption(item);
  if (option === undefined) return no('추천 번호 없음');
  if (item.origin.kind === 'stall' && (!item.origin.scope || state.stallResumed?.[item.origin.scope])) return no('두 번째 정체');
  if ((state.answered ?? 0) >= (state.maxAnswers ?? config.autopilot.maxAnswers)) return no('전체 한도');
  const tasks = item.blocks.match(/\bT\d+\b/gu) ?? [];
  if (tasks.some(task => (state.perTask?.[task] ?? 0) >= config.autopilot.perTaskMax)) return no('task 한도');
  if (!tasks.length && (state.perScope?.[state.scope ?? state.chat?.scope ?? ''] ?? 0) >= config.autopilot.perScopeMax) return no('범위 한도');
  if (state.recentTitles?.includes(normalizeTitle(redact(item.title)))) return no('같은 질문이 되풀이됐다');
  return { ok: true, option };
}
export const autopilotInstruction = '[오토파일럿 켜짐] 사용자에게 채팅으로 묻지 말고 판단으로 등록한다. 추천은 네가 실제로 고를 안의 번호로 시작한다(예: `① …`). 고를 수 없으면 `추천 없음 — 이유`. 되돌리기 어렵거나 밖으로 나가는 동작은 `--requires-approval` 로 올린다.';
export const autopilotReply = '[오토파일럿] 사용자가 추천안으로 진행하도록 맡겼다. 방금 물은 것은 각각 네 추천으로 정하고 근거를 문서에 남긴 뒤 진행하라. 인터뷰 답은 `--source default` 로 기록한다. 승인 필수이거나 되돌리기 어려운 것, 추천을 정할 수 없는 것만 `fodh judgment add` 로 등록하고(되돌리기 어려우면 `--requires-approval`) 대기: 사용자.';
export function trackAutopilotProgress(auto: AutopilotState, state: HarnessState, completed?: { id: string; rev?: number }[]): void {
  const scope = autopilotScope(state), progress = `${scope}:${state.taskId ?? '-'}:${state.enteredAt ?? ''}`;
  const decisions = completed?.map(item => `${item.id}:${item.rev ?? 1}`).sort().join(',');
  if (auto.chat?.progress !== progress || decisions !== undefined && auto.chat.decisions !== decisions) auto.chat = { scope, count: 0, progress, decisions };
}
export async function resetAutopilotChat(root: string): Promise<void> {
  await changeAutopilot(root, async auto => { if (auto.enabled) { trackAutopilotProgress(auto, await readState(root)); auto.chat!.count = 0; } });
}
export async function autopilotChat(root: string, now: Date, send: (prefix: string) => Promise<boolean>): Promise<'sent' | 'limit' | 'skip'> {
  return changeAutopilot(root, async auto => {
    if (!auto.enabled || auto.until && now.getTime() >= Date.parse(auto.until)) return 'skip';
    const state = await readState(root), config = await loadConfig(root);
    const document = await readJudgment(root);
    trackAutopilotProgress(auto, state, document.completed);
    if (state.userHold || state.userAborted || (auto.answered ?? 0) >= (auto.maxAnswers ?? config.autopilot.maxAnswers)
      || state.state === 'REVIEW' && (state.phase === 'task' || !!state.taskId) || !(['RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PLANNING'].includes(state.state) || state.state === 'INTERVIEW' && auto.interview)) return 'skip';
    const items = document.items;
    if (items.some(item => autopilotEligible(item, config, { ...auto, scope: autopilotScope(state) }, now).ok || item.answerSource === 'autopilot' && !item.followup)) return 'skip';
    if (auto.chat!.count >= config.autopilot.maxChatReplies) return 'limit';
    if (!await send(autopilotReply)) return 'skip';
    auto.chat!.count++;
    return 'sent';
  });
}
export interface SweepDeps {
  now: () => Date; idle: () => boolean; hasUI: boolean;
  apply: (ids: string[], expected: Record<string, string>) => Promise<{ applied: string[] }>;
  notify: (key: string, body: string, level: 'info' | 'warning') => void;
}
export async function autopilotSweep(root: string, deps: SweepDeps): Promise<{ registered: string[]; answered: string[]; applied: string[]; skipped: Record<string, string> }> {
  const result = { registered: [] as string[], answered: [] as string[], applied: [] as string[], skipped: {} as Record<string, string> };
  if (!(await readAutopilot(root)).enabled || !deps.hasUI) return result;
  return withFileLock(harnessPath(root, 'harness-autopilot-sweep'), async () => {
    const expected: Record<string, string> = {};
    const tell = (key: string, body: string, level: 'info' | 'warning' = 'info') => deps.notify(key, redact(body).slice(0, 200), level);
    const tellOnce = (auto: AutopilotState, id: string, reason: string, key: string, body: string, level: 'info' | 'warning' = 'info') => {
      const reasons = (auto.notified ??= {})[id] ??= {};
      if (reasons[reason]) return;
      reasons[reason] = true; tell(key, body, level);
    };
    const disable = async (auto: AutopilotState, reason: string) => {
      auto.enabled = false; auto.pending = {}; auto.pendingApply = {};
      const ids = await unappliedAnswers(root);
      if (ids.length) for (const id of ids) tell(`autopilot:off:${id}`, unappliedMessage(id), 'warning');
      else tell('autopilot:off', `오토파일럿이 꺼졌습니다 — ${reason}`);
    };
    let generation: string | undefined;
    await changeAutopilot(root, async auto => {
      if (!auto.enabled) return;
      generation = auto.runId ?? auto.since;
      const config = await loadConfig(root), now = deps.now();
      const max = auto.maxAnswers ?? config.autopilot.maxAnswers;
      if (auto.until && now.getTime() >= Date.parse(auto.until) || (auto.answered ?? 0) >= max) {
        await disable(auto, auto.until && now.getTime() >= Date.parse(auto.until) ? '기간 만료' : `한도 ${max}개 도달`); return;
      }
      const harness = await readState(root);
      if (!deps.idle() || harness.userHold || harness.userAborted || await hasActiveJudgmentSnapshot(root)) return;
      const document = await readJudgment(root);
      trackAutopilotProgress(auto, harness, document.completed);
      const scope = autopilotScope(harness);
      const items = document.items;
      auto.pending ??= {}; auto.pendingApply ??= {};
      for (const seen of [auto.stallNotified, auto.notified]) {
        if (seen) for (const id of Object.keys(seen)) if (!items.some(item => item.id === id)) delete seen[id];
      }
      for (const id of Object.keys(auto.pending)) if (!items.some(item => item.id === id)) delete auto.pending[id];
      for (const [id, digest] of Object.entries(auto.pendingApply)) {
        const item = items.find(item => item.id === id);
        if (item?.answerSource === 'autopilot' && fingerprint(item.raw) === digest && !item.held && !item.followup && !item.reaskOf) expected[id] = item.raw;
        else delete auto.pendingApply[id];
      }
      for (const item of items) {
        const eligible = autopilotEligible(item, config, { ...auto, scope }, now);
        if (!eligible.ok) {
          result.skipped[item.id] = eligible.reason; delete auto.pending[item.id];
          if (eligible.reason === '두 번째 정체' && !auto.stallNotified?.[item.id]) {
            (auto.stallNotified ??= {})[item.id] = true;
            tell(`autopilot:${item.id}:stall`, `오토파일럿: ${item.origin?.scope?.split(':')[0]} 에서 두 번째 정체 — 사용자 확인이 필요합니다`, 'warning');
          }
          continue;
        }
        let pending = auto.pending[item.id];
        if (!pending || pending.rev !== item.rev || pending.questionHash !== questionHash(item) || pending.option !== eligible.option) {
          pending = auto.pending[item.id] = { firstSeen: now.toISOString(), rev: item.rev, questionHash: questionHash(item), option: eligible.option };
          result.registered.push(item.id);
          tellOnce(auto, item.id, 'pending', `autopilot:${item.id}`, `오토파일럿: ${item.id} 을 ${config.autopilot.delaySeconds}초 뒤 ${'①②③④⑤⑥⑦⑧⑨⑩'[eligible.option - 1] ?? eligible.option}(${item.options[eligible.option - 1].slice(0, 24)})로 답합니다 — 막으려면 직접 답하거나 /autopilot off`);
        }
        if (now.getTime() - Date.parse(pending.firstSeen) < config.autopilot.delaySeconds * 1000) continue;
        try {
          const written = await withFileLock(harnessPath(root, 'harness-judgment-apply'), async () => {
            const latest = await readState(root);
            if (!deps.idle() || latest.userHold || latest.userAborted || await hasActiveJudgmentSnapshot(root)) throw new AnswerConflict('두뇌 턴 또는 사용자 중단');
            return answerJudgment(root, item.id, String(eligible.option), { expectEmpty: true, expectedRaw: item.raw, source: 'autopilot' });
          });
          expected[item.id] = written.item.raw;
          auto.pendingApply[item.id] = fingerprint(written.item.raw);
          result.answered.push(item.id); delete auto.pending[item.id];
          auto.answered = (auto.answered ?? 0) + 1;
          const tasks = [...new Set(item.blocks.match(/\bT\d+\b/gu) ?? [])];
          auto.perTask ??= {}; auto.perScope ??= {}; auto.stallResumed ??= {}; auto.recentTitles ??= [];
          for (const task of tasks) auto.perTask[task] = (auto.perTask[task] ?? 0) + 1;
          if (!tasks.length) auto.perScope[scope] = (auto.perScope[scope] ?? 0) + 1;
          if (item.origin?.kind === 'stall') auto.stallResumed[item.origin.scope!] = true;
          auto.recentTitles.push(normalizeTitle(redact(item.title)));
          // Persist each successful write before doing anything that can fail.
          await save(root, auto);
          await appendLedger(root, { runId: item.id, action: 'judgment:autopilot', status: 'ok', at: now.toISOString(), evidence: {
            id: item.id, option: eligible.option, recommend: redact(item.recommend).slice(0, 80), origin: item.origin, delaySeconds: config.autopilot.delaySeconds, blocks: item.blocks,
          } });
        } catch (error) {
          if (!(error instanceof AnswerConflict || error instanceof JudgmentConflict)) throw error;
          delete auto.pending[item.id]; result.skipped[item.id] = '답 경합';
        }
      }
    });
    const ids = Object.keys(expected), latest = await readAutopilot(root), harness = await readState(root);
    let conflict = false;
    if (ids.length && latest.enabled && (latest.runId ?? latest.since) === generation && deps.idle() && !harness.userHold && !harness.userAborted) {
      try { result.applied = (await deps.apply(ids, expected)).applied; }
      catch (error) {
        if (error instanceof JudgmentConflict) conflict = true;
        else for (const id of ids) result.skipped[id] = '적용 실패';
      }
      await changeAutopilot(root, async auto => {
        if ((auto.runId ?? auto.since) !== generation) return;
        const completed = new Set((await readJudgment(root)).completed.map(item => item.id));
        for (const id of ids) {
          if (completed.has(id)) {
            delete auto.pendingApply?.[id]; delete result.skipped[id];
            auto.failedApply = auto.failedApply?.filter(failed => failed !== id);
          } else if (!conflict) {
            delete auto.pendingApply?.[id];
            if (!result.applied.includes(id)) {
              if (!auto.failedApply?.includes(id)) (auto.failedApply ??= []).push(id);
              tellOnce(auto, id, 'failed', `autopilot:${id}:failed`, `오토파일럿: ${id} 적용 실패 — 직접 확인이 필요합니다`, 'warning');
            }
          }
        }
        if (auto.enabled && (auto.answered ?? 0) >= (auto.maxAnswers ?? 30)) {
          await disable(auto, `한도 ${auto.maxAnswers ?? 30}개 도달`);
        }
      });
    }
    return result;
  });
}
