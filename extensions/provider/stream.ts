import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from '@mariozechner/pi-ai';
import { loadConfig } from '../../src/core/config.ts';
import { readState, updateState } from '../../src/core/state.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { appendLedger, unknownEntries } from '../../src/core/ledger.ts';
import { listInbox, deliverInbox } from '../../src/core/inbox.ts';
import { addJudgment } from '../../src/core/judgment.ts';
import { runProcess } from './runner.ts';
import { checkBillingEnvironment } from './preflight.ts';
import { redact, safeValue } from './privacy.ts';
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface TurnOptions {
  root: string; model: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
  onText?: (text: string) => void; notify?: (message: string) => void | Promise<void>;
  lockHeld?: boolean; doctor?: boolean;
}
export interface TurnResult { reason: 'stop' | 'error' | 'aborted'; classification?: string; usage?: Record<string, number>; runId: string; }
export function claudeArgs(root: string, model: string, sid: string, resume: boolean, doctor = false): string[] {
  return ['-p', '--dangerously-skip-permissions', resume ? '--resume' : '--session-id', sid,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt-file', join(packageRoot, 'templates/brain-rules.md'),
    '--settings', join(root, '.claude/settings.json'), '--model', model,
    ...doctor ? ['--max-turns', '2'] : []];
}
export async function buildPrompt(root: string, latest: string, runId: string): Promise<string> {
  const state = await readState(root);
  const pending = (await listInbox(root)).filter(item => item.status !== 'applied');
  const recovery = state.state === 'recovering' || (await unknownEntries(root)).length > 0
    ? '복구 모드: 원장의 unknown 항목을 증거로 대조하라(커밋 SHA, 원격 SHA, 위임 결과 파일, 워크트리 존재).\n' : '';
  await deliverInbox(root, pending.map(item => item.id), runId);
  return recovery + pending.map(item => `[인박스 ${item.id}] ${JSON.stringify(item)}`).join('\n') + (pending.length ? '\n\n' : '') + latest;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function runTurn(latest: string, options: TurnOptions): Promise<TurnResult> {
  const { root } = options;
  const runId = randomUUID();
  let release: (() => Promise<void>) | undefined;
  try {
    if (!options.lockHeld) release = await acquireLock(join(root, '.pi/harness.lock'));
    await checkBillingEnvironment(root, options.env);
    const config = await loadConfig(root);
    if (!config.brain.skipPermissions) throw new Error('configError: skipPermissions가 필요합니다.');
    try { await access(join(root, '.claude/settings.json')); }
    catch { throw new Error('configError: 프로젝트 Claude settings가 없습니다.'); }
    const initial = await readState(root);
    const prompt = options.doctor ? latest : await buildPrompt(root, latest, runId);
    const sessionId = options.doctor ? randomUUID() : initial.sessionId ?? randomUUID();
    let resume = !options.doctor && !!initial.sessionId;
    const env = { ...options.env ?? process.env, FODH_PACKAGE_ROOT: packageRoot };
    for (let attempt = 0; attempt < 2; attempt++) {
      const action = `brain:${attempt}`;
      await appendLedger(root, { runId, action, status: 'pre', taskId: initial.taskId, state: initial.state });
      let result: Record<string, any> | undefined, initialized = false, toolSeen = false;
      let partialText = false;
      const text = (value: string) => options.onText?.(redact(value));
      const outcome = await runProcess({ root, command: config.brain.command,
        args: claudeArgs(root, options.doctor ? 'haiku' : options.model, sessionId, resume, options.doctor),
        input: prompt, runId, maxMs: config.brain.maxTurnMinutes * 60000, env, signal: options.signal,
        onEvent: async event => {
          await updateState(root, { lastEventAt: new Date().toISOString(), runId });
          if (event.type === 'system' && event.subtype === 'init') {
            const evidence = safeValue({ session_id: event.session_id, model: event.model, permissionMode: event.permissionMode, tools: event.tools, mcp_servers: event.mcp_servers });
            await appendLedger(root, { runId, action: `system.init:${attempt}`, status: 'ok', evidence });
            if (event.permissionMode !== 'bypassPermissions' || event.session_id !== sessionId || typeof event.model !== 'string' ||
              !(event.model === (options.doctor ? 'haiku' : options.model) || event.model.includes(`-${options.doctor ? 'haiku' : options.model}-`))) return 'configError';
            initialized = true;
            if (!options.doctor) await updateState(root, { sessionId, actualModel: event.model });
          } else if (event.type === 'rate_limit_event') {
            const info = event.rate_limit_info;
            await updateState(root, { rateLimitInfo: safeValue(info ?? {}) });
            if (info?.isUsingOverage === true || info?.overageStatus !== 'rejected') return 'billing';
          } else if (event.type === 'stream_event') {
            if (event.event?.type === 'message_start') partialText = false;
            if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
              partialText = true; text(event.event.delta.text);
            }
          } else if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'tool_use') { toolSeen = true; text(`\n[tool] ${block.name}: ${JSON.stringify(block.input)}\n`); }
              if (block.type === 'text' && !partialText) text(block.text);
            }
          } else if (event.type === 'user') {
            for (const block of event.message?.content ?? []) if (block.type === 'tool_result') {
              text(`\n[도구 결과] ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}\n`);
              await appendLedger(root, { runId, action: `tool_result:${attempt}:${block.tool_use_id}`, status: 'ok', evidence: safeValue(block) });
            }
          } else if (event.type === 'system' && event.subtype === 'hook_response' && event.exit_code === 2) {
            text('\n[훅 차단] 승인 필요: 판단대기 항목을 확인하세요.\n');
            await appendLedger(root, { runId, action: `hook:${attempt}:${event.hook_id}`, status: 'ok', evidence: { exit_code: 2, hook_name: event.hook_name } });
          } else if (event.type === 'result') {
            result = event;
            await appendLedger(root, { runId, action: `result:${attempt}`, status: event.is_error ? 'fail' : 'ok', evidence: safeValue({
              model: (await readState(root)).actualModel, stop_reason: event.stop_reason, terminal_reason: event.terminal_reason,
              is_error: event.is_error, api_error_status: event.api_error_status, permission_denials: event.permission_denials ?? [], usage: event.usage,
            }) });
            for (const denial of options.doctor ? [] : event.permission_denials ?? []) {
              const safe = safeValue(denial);
              const dedupeKey = createHash('sha256').update(canonical({ tool: safe.tool_name, input: safe.tool_input })).digest('hex');
              await addJudgment(root, { title: `${safe.tool_name}: ${safe.tool_input?.command ?? JSON.stringify(safe.tool_input)}`,
                background: 'Claude Code 훅이 실행을 거부했습니다. 승인이 필요한지 판단하세요.',
                options: ['해당 동작 승인', '보류'], recommend: '승인 범위를 확인한 뒤 결정', blocks: initial.taskId ?? '', dedupeKey });
            }
          }
        },
      });
      const configError = outcome.abortKind === 'configError' || /requires --verbose|unknown (?:option|model)|invalid (?:settings|model)/i.test(outcome.stderr);
      const quota = !!(result?.is_error && result.api_error_status === 429) || /rate limit|usage limit/i.test(outcome.stderr);
      const uncertain = !outcome.cleaned || (!result && (toolSeen || !!outcome.abortKind || !configError && !quota));
      await appendLedger(root, { runId, action, status: uncertain ? 'unknown' : result?.is_error || outcome.code !== 0 || configError ? 'fail' : 'ok',
        evidence: { code: outcome.code, abortKind: outcome.abortKind, cleaned: outcome.cleaned } });
      if (!outcome.cleaned) {
        await updateState(root, { state: 'recovering' });
        return { reason: 'error', classification: 'cleanupFailed', runId };
      }
      if (outcome.abortKind === 'billing') {
        await updateState(root, { state: 'paused(billing)' });
        try { await options.notify?.('추가 사용 과금 가능성을 감지하여 두뇌를 중단했습니다.'); }
        catch { await appendLedger(root, { runId, action: 'billing-notify', status: 'fail', evidence: { reason: '알림 콜백 실패' } }); }
        return { reason: 'aborted', classification: 'billing', runId };
      }
      if (configError) {
        await updateState(root, { state: 'paused(error)' });
        return { reason: 'error', classification: 'configError', runId };
      }
      if (outcome.abortKind) {
        await updateState(root, { state: 'recovering' });
        return { reason: outcome.abortKind === 'protocolError' ? 'error' : 'aborted', classification: outcome.abortKind, runId };
      }
      if (quota) {
        if ((await unknownEntries(root)).length) {
          await updateState(root, { state: 'recovering' });
          return { reason: 'error', classification: 'unknown', runId };
        }
        if (attempt === 0) {
          await appendLedger(root, { runId, action: 'switch', status: 'pre' });
          const switched = await runProcess({ root, command: config.brain.switchCommand, runId, kind: 'switch', maxMs: Math.min(60000, config.brain.maxTurnMinutes * 60000), env, signal: options.signal });
          await appendLedger(root, { runId, action: 'switch', status: switched.abortKind || !switched.cleaned ? 'unknown' : switched.code === 0 ? 'ok' : 'fail' });
          if (switched.abortKind || !switched.cleaned) {
            await updateState(root, { state: 'recovering' });
            return { reason: 'aborted', classification: 'switchAborted', runId };
          }
          if (switched.code === 0) { resume = initialized || resume; continue; }
        }
        await updateState(root, { state: 'paused(quota)' });
        return { reason: 'error', classification: 'quota', runId };
      }
      if (!initialized || !result || outcome.code !== 0 || result.is_error) {
        await updateState(root, { state: uncertain ? 'recovering' : 'paused(error)' });
        return { reason: 'error', classification: 'processError', runId };
      }
      if (options.doctor && !(result.permission_denials ?? []).some((denial: any) => denial.tool_name === 'Bash' && denial.tool_input?.command === 'echo FODH_DOCTOR_MARKER')) {
        return { reason: 'error', classification: 'configError', runId };
      }
      return { reason: 'stop', usage: result.usage, runId };
    }
    return { reason: 'error', classification: 'quota', runId };
  } catch (error) {
    if ((await readState(root)).state !== 'paused(billing)' && (await unknownEntries(root)).some(entry => entry.runId === runId)) await updateState(root, { state: 'recovering' });
    throw error;
  } finally { await release?.(); }
}
export function latestMessage(context: Context): string {
  const message = [...context.messages].reverse().find(message => message.role === 'user' || String(message.role) === 'custom');
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}
export function streamClaude(model: Model<any>, context: Context, options: SimpleStreamOptions | undefined, turnOptions: Omit<TurnOptions, 'model' | 'signal' | 'onText'>) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
  void (async () => {
    stream.push({ type: 'start', partial: output });
    stream.push({ type: 'text_start', contentIndex: 0, partial: output });
    try {
      const result = await runTurn(latestMessage(context), { ...turnOptions, model: model.id, signal: options?.signal, onText: delta => {
        const content = output.content[0];
        if (content.type === 'text') content.text += delta;
        stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: output });
      } });
      const usage = result.usage ?? {};
      output.usage.input = usage.input_tokens ?? 0;
      output.usage.output = usage.output_tokens ?? 0;
      output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
      output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      output.stopReason = result.reason;
      const content = output.content[0];
      stream.push({ type: 'text_end', contentIndex: 0, content: content.type === 'text' ? content.text : '', partial: output });
      if (result.reason === 'stop') stream.push({ type: 'done', reason: 'stop', message: output });
      else { output.errorMessage = `하네스 실행 중단: ${result.classification}`; stream.push({ type: 'error', reason: result.reason, error: output }); }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error && /^(configError:|하네스|잠금)/.test(error.message) ? error.message : '하네스 실행 실패: 설정과 원장을 확인하세요.';
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } finally { stream.end(); }
  })();
  return stream;
}
