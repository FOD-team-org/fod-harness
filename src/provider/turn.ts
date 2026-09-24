import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { loadConfig } from '../core/config.ts';
import { readState, updateState } from '../core/state.ts';
import { acquireLock } from '../core/lock.ts';
import { appendLedger, unknownEntries } from '../core/ledger.ts';
import { listInbox, deliverInbox } from '../core/inbox.ts';
import { reclaimTask } from '../core/reclaim.ts';
import { addJudgment } from '../core/judgment.ts';
import { runProcess, type ProcessResult } from './runner.ts';
import { checkBillingEnvironment } from './preflight.ts';
import { redact, safeValue } from './privacy.ts';
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface TurnOptions {
  root: string; model?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
  onText?: (text: string) => void; notify?: (message: string) => void | Promise<void>;
  lockHeld?: boolean; doctor?: boolean;
}
export interface TurnResult {
  init?: { skills: string[]; memory_paths: string[] };
  reason: 'stop' | 'error' | 'aborted'; classification?: string; usage?: Record<string, number>; contextUsage?: boolean; runId: string;
}
export function claudeArgs(root: string, model: string, sid: string, resume: boolean, doctor = false): string[] {
  return ['-p', '--dangerously-skip-permissions', resume ? '--resume' : '--session-id', sid,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...doctor ? [] : ['--append-system-prompt-file', join(packageRoot, 'templates/brain-rules.md')],
    '--settings', join(root, '.claude/settings.json'), '--model', model,
    ...doctor ? ['--max-turns', '2'] : []];
}
export async function buildPrompt(root: string, latest: string, runId: string): Promise<string> {
  const state = await readState(root);
  const pending = (await listInbox(root)).filter(item => item.status !== 'applied');
  const unknown = await unknownEntries(root);
  const recovery = state.state === 'recovering' || unknown.length > 0
    ? '복구 모드: 원장의 unknown 항목을 증거로 대조하라(커밋 SHA, 원격 SHA, 위임 결과 파일, 워크트리 존재).\n'
      + unknown.map(({ runId, action, at }) => JSON.stringify({ runId, action, at })).join('\n')
      + '\nfodh ledger resolve <runId> <action> ok|fail --evidence "증거 대조 결과" 로 각 항목을 닫아라.\n' : '';
  await deliverInbox(root, pending.map(item => item.id), runId);
  return recovery + pending.map(item => `[인박스 ${item.id}] ${JSON.stringify(item)}` + (item.kind === 'codex-done' ? item.resultDir ? `\nfodh codex result ${item.codexRunId ?? item.runId} 를 읽고 결과를 반영하라.` : '\n결과 없음 — 위임을 다시 시작하거나 fodh judgment add 로 판단을 등록하라.' : '')).join('\n') + (pending.length ? '\n\n' : '') + latest;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}
export async function runTurn(latest: string, options: TurnOptions): Promise<TurnResult> {
  const { root } = options;
  const runId = randomUUID();
  let release: (() => Promise<void>) | undefined;
  const pendingDenials: (() => Promise<void>)[] = [];
  const patchState = (patch: Parameters<typeof updateState>[1]) =>
    options.doctor ? Promise.resolve(undefined) : updateState(root, patch);
  try {
    if (!options.lockHeld) release = await acquireLock(join(root, '.pi/harness.lock'));
    await checkBillingEnvironment(root, options.env);
    const config = await loadConfig(root);
    const model = options.doctor ? 'haiku' : options.model ?? config.brain.model;
    if (!config.brain.skipPermissions) throw new Error('configError: skipPermissions가 필요합니다.');
    try { await access(join(root, '.claude/settings.json')); }
    catch { throw new Error('configError: 프로젝트 Claude settings가 없습니다.'); }
    const initial = await readState(root);
    const prompt = options.doctor ? latest : await buildPrompt(root, latest, runId);
    const sessionId = options.doctor ? randomUUID() : initial.sessionId ?? randomUUID();
    let resume = !options.doctor && !!initial.sessionId;
    const suppliedEnv = options.env ?? process.env;
    const env = { ...suppliedEnv, BASH_DEFAULT_TIMEOUT_MS: suppliedEnv.BASH_DEFAULT_TIMEOUT_MS ?? '600000',
      BASH_MAX_TIMEOUT_MS: suppliedEnv.BASH_MAX_TIMEOUT_MS ?? '600000', FODH_PACKAGE_ROOT: packageRoot, FODH_PROJECT_ROOT: root, FODH_BRAIN: '1',
      FODH_PROTECTED_EXTRA: [config.interview.extraBankFile, config.docs.overrideDir].join(':') };
    for (let attempt = 0; attempt < 2; attempt++) {
      const action = `brain:${attempt}`;
      await appendLedger(root, { runId, action, status: 'pre', taskId: initial.taskId, state: initial.state });
      let init: TurnResult['init'];
      let result: Record<string, any> | undefined, initialized = false, toolSeen = false;
      let partialText = false, lastPersisted = 0, lastEventAt: string | undefined;
      const toolInputs = new Map<string, { tool_name: string; tool_input: unknown }>();
      const denials = new Map<string, any>();
      const rememberDenial = (denial: any) => {
        const safe = safeValue(denial);
        denials.set(canonical({ tool: safe.tool_name, input: safe.tool_input }), safe);
      };
      const persistDenials = async () => {
        if (options.doctor) return;
        const state = await readState(root);
        let firstId: string | undefined;
        for (const [key, safe] of denials) {
          const dedupeKey = createHash('sha256').update(key).digest('hex');
          const { item } = await addJudgment(root, {
            title: `${safe.tool_name}: ${safe.tool_input?.command ?? JSON.stringify(safe.tool_input)}`,
            background: 'Claude Code 훅이 실행을 거부했습니다. 승인이 필요한지 판단하세요.',
            options: ['해당 동작 승인', '보류'], recommend: '승인 범위를 확인한 뒤 결정',
            blocks: state.taskId ?? '', dedupeKey: `${dedupeKey}:${state.taskId ?? ''}`, requiresApproval: true,
          });
          firstId ??= item.id;
        }
        if (state.taskId && firstId) {
          await reclaimTask(root, state.taskId, firstId, { suspended: true });
          if (state.state === 'paused(billing)') await patchState({ state: 'paused(billing)' });
        }
      };
      pendingDenials.push(persistDenials);
      const text = (value: string) => options.onText?.(redact(value));
      let outcome: ProcessResult;
      try {
        outcome = await runProcess({ root, command: config.brain.command,
          args: claudeArgs(root, model, sessionId, resume, options.doctor),
          input: prompt, runId, maxMs: turnDeadlineMs(config.brain.maxTurnMinutes, options.doctor), env, signal: options.signal,
          onEvent: async event => {
            lastEventAt = new Date().toISOString();
            if (Date.now() - lastPersisted >= 5000) {
              await patchState({ lastEventAt, runId }); lastPersisted = Date.now();
            }
            if (event.type === 'system' && event.subtype === 'init') {
              const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
              init = { skills: strings(event.skills), memory_paths: strings(event.memory_paths && !Array.isArray(event.memory_paths) && typeof event.memory_paths === 'object' ? Object.values(event.memory_paths) : event.memory_paths) };
              const evidence = safeValue({
                session_id: event.session_id, model: event.model, permissionMode: event.permissionMode,
                ...init, memory_paths: event.memory_paths, apiKeySource: event.apiKeySource, tools: event.tools, mcp_servers: event.mcp_servers,
              });
              await appendLedger(root, { runId, action: `system.init:${attempt}`, status: 'ok', evidence });
              if (event.apiKeySource !== 'none') return 'billing';
              const requestedModel = model;
              if (event.permissionMode !== 'bypassPermissions' || event.session_id !== sessionId || typeof event.model !== 'string' ||
                !matchesModel(requestedModel, event.model)) return 'configError';
              initialized = true;
              if (!options.doctor) await patchState(current => ({
                sessionId, actualModel: event.model, brain: {
                  ...(current.brain as Record<string, unknown> | undefined), model,
                },
              }));
            } else if (event.type === 'rate_limit_event') {
              const info = event.rate_limit_info;
              await patchState({ rateLimitInfo: safeValue(info ?? {}) });
              if (info?.status === 'rejected' && info?.isUsingOverage !== true
                && (info?.overageStatus === undefined || info.overageStatus === 'rejected')) return 'quota';
              if (info?.isUsingOverage === true || info?.overageStatus !== 'rejected') return 'billing';
            } else if (event.type === 'stream_event') {
              if (event.event?.type === 'message_start') partialText = false;
              if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
                partialText = true; text(event.event.delta.text);
              }
            } else if (event.type === 'assistant') {
              for (const block of event.message?.content ?? []) {
                if (block.type === 'tool_use') {
                  toolSeen = true; toolInputs.set(block.id, { tool_name: block.name, tool_input: block.input });
                  text(`\n[tool] ${block.name}: ${JSON.stringify(block.input)}\n`);
                }
                if (block.type === 'text' && !partialText) text(block.text);
              }
            } else if (event.type === 'user') {
              for (const block of event.message?.content ?? []) if (block.type === 'tool_result') {
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
                const visible = redact(content);
                const suffix = visible.length > 400 ? `… (${visible.length - 400}자 생략)` : '';
                text(`\n[도구 결과] ${visible.slice(0, 400)}${suffix}\n`);
                await appendLedger(root, {
                  runId, action: `tool_result:${attempt}:${block.tool_use_id}`, status: 'ok',
                  evidence: { tool_use_id: block.tool_use_id, is_error: !!block.is_error,
                    length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
                });
                if (block.is_error && /hook error|PreToolUse/i.test(content)) {
                  text('\n[훅 차단] 승인 필요: 판단대기 항목을 확인하세요.\n');
                  const denial = toolInputs.get(block.tool_use_id);
                  if (denial) rememberDenial(denial);
                  await appendLedger(root, { runId, action: `hook:${attempt}:${block.tool_use_id}`, status: 'ok',
                    evidence: safeValue({ tool_use_id: block.tool_use_id, ...denial }) });
                }
              }
            } else if (event.type === 'result') {
              result = event;
              await appendLedger(root, { runId, action: `result:${attempt}`, status: event.is_error ? 'fail' : 'ok', evidence: safeValue({
                model: (await readState(root)).actualModel, stop_reason: event.stop_reason, terminal_reason: event.terminal_reason,
                is_error: event.is_error, api_error_status: event.api_error_status, permission_denials: event.permission_denials ?? [],
                usage: event.usage,
              }) });
              for (const denial of event.permission_denials ?? []) rememberDenial(denial);
            }
          },
        });
      } finally {
        if (lastEventAt) await patchState({ lastEventAt, runId });
      }
      const configError = outcome.abortKind === 'configError'
        || /requires --verbose|unknown (?:option|model)|invalid (?:settings|model)/i.test(outcome.stderr);
      const quota = outcome.abortKind === 'quota' || result?.api_error_status === 429
        || !!(result?.is_error && /(rate|usage) limit|limit reached|out of (?:extra )?usage|resets? at/i.test(result.result ?? ''))
        || /rate limit|usage limit/i.test(outcome.stderr);
      const uncertain = !outcome.cleaned || (!result && (toolSeen
        || (!!outcome.abortKind && outcome.abortKind !== 'quota') || !configError && !quota));
      await appendLedger(root, { runId, action,
        status: uncertain ? 'unknown' : result?.is_error || outcome.code !== 0 || configError ? 'fail' : 'ok',
        evidence: { code: outcome.code, abortKind: outcome.abortKind, cleaned: outcome.cleaned } });
      if (outcome.abortKind === 'billing') {
        await patchState({ state: 'paused(billing)' });
        try { await options.notify?.('추가 사용 과금 가능성을 감지하여 두뇌를 중단했습니다.'); }
        catch { await appendLedger(root, { runId, action: 'billing-notify', status: 'fail', evidence: { reason: '알림 콜백 실패' } }); }
        return { reason: 'aborted', classification: 'billing', runId };
      }
      if (!outcome.cleaned) {
        await patchState({ state: 'recovering' });
        return { reason: 'error', classification: 'cleanupFailed', runId };
      }
      if (configError) {
        await patchState({ state: 'paused(error)' });
        return { reason: 'error', classification: 'configError', runId };
      }
      if (outcome.abortKind && outcome.abortKind !== 'quota') {
        await patchState({ state: 'recovering' });
        return { reason: outcome.abortKind === 'protocolError' ? 'error' : 'aborted', classification: outcome.abortKind, runId };
      }
      if (quota) {
        if (options.doctor) return { reason: 'error', classification: 'configError: quota', runId };
        if ((await unknownEntries(root)).some(entry => entry.runId === runId)) {
          await patchState({ state: 'recovering' });
          return { reason: 'error', classification: 'unknown', runId };
        }
        if (attempt === 0) {
          await appendLedger(root, { runId, action: 'switch', status: 'pre' });
          const switched = await runProcess({ root, command: config.brain.switchCommand, runId, kind: 'switch',
            maxMs: Math.min(60000, config.brain.maxTurnMinutes * 60000), env, signal: options.signal });
          await appendLedger(root, { runId, action: 'switch',
            status: switched.abortKind || !switched.cleaned ? 'unknown' : switched.code === 0 ? 'ok' : 'fail' });
          if (switched.abortKind || !switched.cleaned) {
            await patchState({ state: 'recovering' });
            return { reason: 'aborted', classification: 'switchAborted', runId };
          }
          if (switched.code === 0) { resume = initialized || resume; continue; }
        }
        await patchState({ state: 'paused(quota)' });
        return { reason: 'error', classification: 'quota', runId };
      }
      if (options.doctor) {
        const markerDenied = [...denials.values()].some(denial => denial.tool_name === 'Bash'
          && typeof denial.tool_input?.command === 'string' && denial.tool_input.command.includes('FODH_DOCTOR_MARKER'));
        if (!markerDenied) return { reason: 'error', classification: 'configError', runId };
        return { reason: 'stop', ...lastCallUsage(result ?? {}), runId, init };
      }
      if (!initialized || !result || outcome.code !== 0 || result.is_error) {
        await patchState({ state: uncertain ? 'recovering' : 'paused(error)' });
        return { reason: 'error', classification: 'processError', runId };
      }
      return { reason: 'stop', ...lastCallUsage(result), runId };
    }
    return { reason: 'error', classification: 'quota', runId };
  } catch (error) {
    if ((await readState(root)).state !== 'paused(billing)'
      && (await unknownEntries(root)).some(entry => entry.runId === runId)) {
      await patchState({ state: 'recovering' });
    }
    throw error;
  } finally {
    try { for (const persist of pendingDenials) await persist(); } finally { await release?.(); }
  }
}
export function latestMessage<T extends {
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
}>(context: T): string {
  const message = [...context.messages].reverse().find(message => message.role === 'user' || String(message.role) === 'custom');
  if (!message) return '';
  return typeof message.content === 'string' ? message.content
    : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export function turnDeadlineMs(maxTurnMinutes: number, doctor = false): number {
  return Math.min(doctor ? 180000 : Infinity, maxTurnMinutes * 60000);
}
export function lastCallUsage(result: Record<string, any>): { usage: Record<string, number>; contextUsage: boolean } {
  const models = result.modelUsage;
  const lastModel: any = Array.isArray(models) ? models.at(-1) : models && Object.values(models).at(-1);
  const iterations = result.usage?.iterations ?? lastModel?.usage?.iterations ?? lastModel?.iterations;
  const last = Array.isArray(iterations) && iterations.length ? iterations.at(-1) : lastModel;
  const usage = last?.usage ?? last ?? result.usage ?? {};
  return { usage: {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0,
  }, contextUsage: !!last };
}

export function matchesModel(alias: string, actual: string): boolean {
  if (alias === 'fable') return actual === 'claude-fable-5-1' || actual.includes('-fable-');
  return actual === alias || actual.includes(`-${alias}-`);
}
