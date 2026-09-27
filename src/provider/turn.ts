import { TurnDisplay, toolBlock, HOOK_DENIAL_PREFIX, type BrainOutput } from './display.ts';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditPathReport } from '../core/audit.ts';
import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { workspaceMembers } from '../core/workspace.ts';
import { loadConfig } from '../core/config.ts';
import { notify } from '../core/notify.ts';
import { readState, updateState, activeStates } from '../core/state.ts';
import { acquireLock } from '../core/lock.ts';
import { appendLedger, unknownEntries } from '../core/ledger.ts';
import { listInbox, deliverInbox } from '../core/inbox.ts';
import { reclaimTask } from '../core/reclaim.ts';
import { addJudgment, beginJudgmentSnapshot, finishJudgmentSnapshot, recoverJudgmentSnapshot } from '../core/judgment.ts';
import { runProcess, type ProcessResult } from './runner.ts';
import { checkBillingEnvironment } from './preflight.ts';
import { rateLimitVerdict } from './rate-limit.ts';
import { redact, safeValue } from './privacy.ts';
const notifiedAuditPaths = new Set<string>();
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface TurnOptions {
  root: string; model?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
  onText?: (text: string) => void; notify?: (message: string) => void | Promise<void>;
  lockHeld?: boolean; doctor?: boolean;
  display?: BrainOutput; onProgress?: (line: string) => void;
}
export interface TurnResult {
  hookDenials?: number;
  init?: { skills: string[]; memory_paths: string[]; plugins: string[]; agents: string[]; commands: string[] };
  reason: 'stop' | 'error' | 'aborted'; classification?: string; usage?: Record<string, number>; contextUsage?: boolean; runId: string;
}
export function claudeArgs(root: string, model: string, sid: string, resume: boolean, doctor = false, allowPlugins = false): string[] {
  return ['-p', '--dangerously-skip-permissions', resume ? '--resume' : '--session-id', sid,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...doctor ? [] : ['--append-system-prompt-file', join(packageRoot, 'templates/brain-rules.md')],
    '--settings', join(root, '.claude/settings.json'), '--model', model,
    ...allowPlugins ? [] : ['--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    ...doctor ? ['--max-turns', '3'] : []];
}
export async function buildPrompt(root: string, latest: string, runId: string): Promise<string> {
  const state = await readState(root);
  const pending = (await listInbox(root)).filter(item => item.status !== 'applied');
  const unknown = await unknownEntries(root);
  const recovery = state.state === 'recovering' || unknown.length > 0
    ? '복구 모드: 원장의 unknown 항목을 증거로 대조하라(커밋 SHA, 원격 SHA, 위임 결과 파일, 워크트리 존재).\n'
      + unknown.map(({ runId, action, at, evidence }) => JSON.stringify({ runId, action, at,
        ...(evidence && typeof evidence === 'object' && 'repo' in evidence ? { repo: evidence.repo } : {}) })).join('\n')
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
const turnsKey = Symbol.for('fodh.turnsInProgress');
const sharedTurns = globalThis as typeof globalThis & { [turnsKey]?: Set<string> };
const turnsInProgress = sharedTurns[turnsKey] ??= new Set<string>();
export const isTurnInProgress = (root: string): boolean => turnsInProgress.has(resolve(root));
const canonicalTool = (name: unknown): unknown => name === 'Task' ? 'Agent' : name;
export async function runTurn(latest: string, options: TurnOptions): Promise<TurnResult> {
  const display = new TurnDisplay(options.doctor ? 'full' : options.display ?? 'full', options.onText, options.onProgress);
  let classification: string | undefined = 'processError';
  try {
    const result = await executeTurn(latest, options, display);
    classification = result.reason === 'stop' ? undefined : result.classification ?? result.reason;
    return result;
  } catch (error) {
    classification = options.signal?.aborted ? 'aborted'
      : error instanceof Error && error.message.startsWith('configError:') ? 'configError' : 'processError';
    throw error;
  } finally { display.finish(classification); }
}
async function executeTurn(latest: string, options: TurnOptions, display: TurnDisplay): Promise<TurnResult> {
  const { root } = options;
  const runId = randomUUID();
  let release: (() => Promise<void>) | undefined;
  let unclassifiedLogged = false;
  let reportText = '';
  let stateAtBrainExit: string | undefined;
  const turnSuspicions = new Set<string>();
  const turnUnresolved = new Set<string>();
  const pendingDenials: (() => Promise<void>)[] = [];
  const patchState = (patch: Parameters<typeof updateState>[1]) =>
    options.doctor ? Promise.resolve(undefined) : updateState(root, patch);
  try {
    if (!options.lockHeld) release = await acquireLock(join(root, '.pi/harness.lock'));
    await checkBillingEnvironment(root, options.env);
    const config = await loadConfig(root);
    const members = config.workspace ? (await workspaceMembers(root, config)).map(member => member.path) : undefined;
    const model = options.doctor ? 'haiku' : options.model ?? config.brain.model;
    if (!config.brain.skipPermissions) throw new Error('configError: skipPermissions가 필요합니다.');
    try { await access(join(root, '.claude/settings.json')); }
    catch { throw new Error('configError: 프로젝트 Claude settings가 없습니다.'); }
    const initial = await readState(root);
    const prompt = options.doctor ? latest : await buildPrompt(root, latest, runId);
    const sessionId = options.doctor ? randomUUID() : initial.sessionId ?? randomUUID();
    const resume = !options.doctor && !!initial.sessionId;
    const suppliedEnv = options.env ?? process.env;
    const env = { ...suppliedEnv, BASH_DEFAULT_TIMEOUT_MS: suppliedEnv.BASH_DEFAULT_TIMEOUT_MS ?? '600000',
      BASH_MAX_TIMEOUT_MS: suppliedEnv.BASH_MAX_TIMEOUT_MS ?? '600000', FODH_PACKAGE_ROOT: packageRoot, FODH_PROJECT_ROOT: root, FODH_BRAIN: '1', FODH_DOCS_ROOT: config.docs.root,
      FODH_PROTECTED_EXTRA: [config.interview.extraBankFile, config.docs.overrideDir].join(':') };
    const attempt = 0;
    reportText = '';
    stateAtBrainExit = undefined;
    const action = `brain:${attempt}`;
    const brainTurn = { runId, startedAt: new Date().toISOString() };
    let init: TurnResult['init'];
    let result: Record<string, any> | undefined, initialized = false, toolSeen = false;
    let partialText = false, lastPersisted = 0, lastEventAt: string | undefined;
    const toolInputs = new Map<string, { tool_name: string; tool_input: unknown }>();
    const denials = new Map<string, any>();
    const displayedDenialIds = new Map<string, string>();
    const displayDenial = (denial: any, line?: string, toolUseId?: string) => {
      const key = canonical({ tool: canonicalTool(denial.tool_name), input: denial.tool_input });
      const id = toolUseId ?? denial.tool_use_id ?? displayedDenialIds.get(key) ?? `input:${key}`;
      displayedDenialIds.set(key, id);
      display.denial(id, line);
    };
    type DenialKind = 'approval' | 'boundary' | 'guard' | 'unknown';
    const rememberDenial = (denial: any, kind: DenialKind = 'unknown', toolUseId?: string) => {
      const safe = safeValue(denial), key = canonical({ tool: canonicalTool(safe.tool_name), input: safe.tool_input });
      const previous = denials.get(key);
      denials.set(key, { ...safe, kind: kind === 'unknown' ? previous?.kind ?? kind : kind,
        tool_use_id: toolUseId ?? previous?.tool_use_id ?? safe.tool_use_id ?? `result-${denials.size}` });
    };
    const persistDenials = async () => {
      if (options.doctor) return;
      const state = await readState(root);
      let firstId: string | undefined;
      for (const [key, safe] of denials) {
        const action = safe.kind === 'approval' ? `hook:${attempt}:${safe.tool_use_id}`
          : `hook:${safe.kind}:${attempt}:${safe.tool_use_id}`;
        await appendLedger(root, { runId, action, status: 'ok', evidence: safeValue(safe) });
        if (safe.kind === 'unknown' && !unclassifiedLogged) {
          await appendLedger(root, { runId, action: 'hook:unclassified', status: 'warn' });
          unclassifiedLogged = true;
        }
        if (safe.kind !== 'approval') continue;
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
    const text = (value: string) => display.text(value);
    let outcome: ProcessResult;
    turnsInProgress.add(resolve(root));
    try {
      await beginJudgmentSnapshot(root, brainTurn);
      await appendLedger(root, { runId, action, status: 'pre', taskId: initial.taskId, state: initial.state });
      outcome = await runProcess({ root, command: config.brain.command,
        args: claudeArgs(root, model, sessionId, resume, options.doctor, config.brain.allowPlugins),
        input: prompt, runId, maxMs: turnDeadlineMs(config.brain.maxTurnMinutes, options.doctor), env, signal: options.signal,
        onEvent: async event => {
          display.observe(event);
          const child = !!event.parent_tool_use_id;
          const parentText = (value: string) => child ? value.replace(/^/gmu, '↳ ') : value;
          lastEventAt = new Date().toISOString();
          if (Date.now() - lastPersisted >= 5000) {
            await patchState({ lastEventAt, runId }); lastPersisted = Date.now();
          }
          if (event.type === 'system' && event.subtype === 'init') {
            const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
            init = { plugins: Array.isArray(event.plugins) ? event.plugins.flatMap((plugin: unknown) => plugin && typeof plugin === 'object' && 'source' in plugin && typeof plugin.source === 'string' ? [plugin.source] : []) : [],
              agents: strings(event.agents), commands: strings(event.slash_commands), skills: strings(event.skills), memory_paths: strings(event.memory_paths && !Array.isArray(event.memory_paths) && typeof event.memory_paths === 'object' ? Object.values(event.memory_paths) : event.memory_paths) };
            const evidence = safeValue({
              session_id: event.session_id, model: event.model, permissionMode: event.permissionMode,
              skills: init.skills, plugins: init.plugins.length, agents: init.agents.length, commands: init.commands.length, memory_paths: event.memory_paths, apiKeySource: event.apiKeySource, tools: event.tools, mcp_servers: event.mcp_servers,
            });
            await appendLedger(root, { runId, action: `system.init:${attempt}`, status: 'ok', evidence });
            if (event.apiKeySource !== 'none') return 'billing';
            const requestedModel = model;
            if (typeof event.model !== 'string' || !matchesModel(requestedModel, event.model)
              || !options.doctor && !config.brain.allowedModels.some(entry => matchesModel(entry, event.model))) {
              await appendLedger(root, { runId, action: 'brain:model-rejected', status: 'fail',
                evidence: { requested: requestedModel, actual: event.model, allowed: config.brain.allowedModels } });
              return 'configError';
            }
            if (event.permissionMode !== 'bypassPermissions' || event.session_id !== sessionId) return 'configError';
            initialized = true;
            if (!options.doctor) await patchState(current => ({
              sessionId, actualModel: event.model, brain: {
                ...(current.brain as Record<string, unknown> | undefined), model,
              },
            }));
          } else if (event.type === 'rate_limit_event') {
            const info = event.rate_limit_info;
            await patchState({ rateLimitInfo: safeValue(info ?? {}) });
            const verdict = rateLimitVerdict(info);
            if (verdict !== 'continue') return verdict;
          } else if (event.type === 'stream_event') {
            if (!child && event.event?.type === 'message_start') { partialText = false; reportText = ''; }
            if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
              if (!child) { reportText += event.event.delta.text; partialText = true; }
              text(parentText(event.event.delta.text));
            }
          } else if (event.type === 'assistant') {
            if (!child) reportText = (event.message?.content ?? []).filter((block: any) => block.type === 'text')
              .map((block: any) => block.text).join('\n');
            for (const block of event.message?.content ?? []) {
              if (block.type === 'tool_use') {
                toolSeen = true; toolInputs.set(block.id, { tool_name: block.name, tool_input: block.input });
                text(toolBlock(parentText(`[tool] ${block.name}: ${JSON.stringify(block.input)}`)));
              }
              if (block.type === 'text' && (child || !partialText)) text(parentText(block.text));
            }
          } else if (event.type === 'user') {
            for (const block of event.message?.content ?? []) if (block.type === 'tool_result') {
              const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
              const visible = redact(content);
              const suffix = visible.length > 400 ? `… (${visible.length - 400}자 생략)` : '';
              text(toolBlock(parentText(`[도구 결과] ${visible.slice(0, 400)}${suffix}`)));
              await appendLedger(root, {
                runId, action: `tool_result:${attempt}:${block.tool_use_id}`, status: 'ok',
                evidence: { tool_use_id: block.tool_use_id, is_error: !!block.is_error,
                  length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
              });
              if (block.is_error && /hook error|PreToolUse/i.test(content)) {
                const label = /\[(승인|경계|보호)\]/u.exec(content)?.[1];
                const kind: DenialKind = label === '승인' ? 'approval' : label === '경계' ? 'boundary' : label === '보호' ? 'guard' : 'unknown';
                const message = {
                  approval: '승인 필요: 판단대기 항목을 확인하세요.',
                  boundary: '경계: 같은 동작을 다시 시도하지 말고 위임(fodh codex task / Claude Agent)으로 바꾸세요.',
                  guard: '보호: 이 동작은 포기하세요.', unknown: '분류 없음: 원장을 확인하세요.',
                }[kind];
                const notice = `${HOOK_DENIAL_PREFIX}${message}`;
                const denial = toolInputs.get(block.tool_use_id);
                displayDenial(denial ?? {}, display.mode === 'full' ? parentText(notice) : notice, block.tool_use_id);
                if (denial) rememberDenial(denial, kind, block.tool_use_id);
                if (options.doctor) await appendLedger(root, { runId, action: `hook:${attempt}:${block.tool_use_id}`, status: 'ok',
                  evidence: safeValue({ tool_use_id: block.tool_use_id, ...denial, kind }) });
              }
            }
          } else if (event.type === 'result') {
            result = event;
            if (typeof event.result === 'string') reportText = event.result;
            await appendLedger(root, { runId, action: `result:${attempt}`, status: event.is_error ? 'fail' : 'ok', evidence: safeValue({
              model: (await readState(root)).actualModel, stop_reason: event.stop_reason, terminal_reason: event.terminal_reason,
              is_error: event.is_error, api_error_status: event.api_error_status, permission_denials: event.permission_denials ?? [],
              usage: event.usage,
            }) });
            for (const denial of event.permission_denials ?? []) {
              const known = denials.has(canonical(safeValue({ tool: canonicalTool(denial.tool_name), input: denial.tool_input })));
              displayDenial(denial, known ? undefined : `${HOOK_DENIAL_PREFIX}분류 없음: 원장을 확인하세요.`);
              rememberDenial(denial);
            }
          }
        },
      });
    } finally {
      try { stateAtBrainExit = (await readState(root)).state; } catch { /* Fall back to current state at report time. */ }
      try { await finishJudgmentSnapshot(root); }
      catch (error) {
        try { await appendLedger(root, { runId, action: 'judgment:snapshot-finish', status: 'fail',
          evidence: { error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) } }); }
        catch { /* Preserve the runner result even when diagnostic storage fails. */ }
        turnsInProgress.delete(resolve(root));
        try { await recoverJudgmentSnapshot(root); }
        catch {
          // A failed comparison must not leave the completed turn active indefinitely.
          await updateState(root, current => current.brainTurn?.runId === runId && !current.brainTurn.endedAt
            ? { brainTurn: { ...current.brainTurn, endedAt: new Date().toISOString() } } : {});
        }
      }
      if (lastEventAt) await patchState({ lastEventAt, runId });
    }
    if (!options.doctor) {
      const suspicious = new Set<string>();
      const worktrees = (await readState(root)).worktrees ?? [];
      for (const tool of toolInputs.values()) {
        if (denials.has(canonical(safeValue({ tool: canonicalTool(tool.tool_name), input: tool.tool_input })))) continue;
        const audit = auditPathReport(tool.tool_name, (tool.tool_input ?? {}) as Record<string, unknown>, {
          root, docsRoot: config.docs.root, worktrees, ...(members ? { members } : {}),
        });
        for (const path of audit.boundary) suspicious.add(redact(path));
        for (const raw of audit.unresolved) {
          const path = redact(raw);
          if (turnUnresolved.has(path)) continue;
          turnUnresolved.add(path);
          await appendLedger(root, { runId, action: 'audit:path-unresolved', status: 'info', evidence: { path } });
        }
      }
      for (const path of suspicious) {
        if (turnSuspicions.has(path)) continue;
        turnSuspicions.add(path);
        await appendLedger(root, { runId, action: 'audit:path-boundary', status: 'warn', evidence: { path } });
      }
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
      try { await options.notify?.('API 키 과금 경로를 감지해 두뇌를 멈췄습니다. 구독 로그인으로 실행되는지 확인하세요(apiKeySource).'); }
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
      await patchState({ state: 'paused(quota)' });
      return { reason: 'error', classification: 'quota', runId };
    }
    if (options.doctor) {
      const markerDenied = [...denials.values()].some(denial => denial.tool_name === 'Bash'
        && typeof denial.tool_input?.command === 'string' && denial.tool_input.command.includes('FODH_DOCTOR_MARKER'));
      const pathDenied = [...denials.values()].some(denial => denial.tool_name === 'Write'
        && typeof denial.tool_input?.file_path === 'string'
        && resolve(root, denial.tool_input.file_path) === resolve(root, 'src/FODH_DOCTOR_MARKER.ts'));
      if (!initialized || !markerDenied || !pathDenied) return { reason: 'error', classification: 'configError', runId };
      return { reason: 'stop', ...lastCallUsage(result ?? {}), runId, init, hookDenials: 2 };
    }
    if (!initialized || !result || outcome.code !== 0 || result.is_error) {
      await patchState({ state: uncertain ? 'recovering' : 'paused(error)' });
      return { reason: 'error', classification: 'processError', runId };
    }
    const current = await readState(root);
    if (current.awaitingSlot && !current.delegation && activeStates.has(current.state) && current.state !== 'recovering') {
      await patchState({ state: 'paused(slot)' });
    }
    return { reason: 'stop', ...lastCallUsage(result), runId };
  } catch (error) {
    if ((await readState(root)).state !== 'paused(billing)'
      && (await unknownEntries(root)).some(entry => entry.runId === runId)) {
      await patchState({ state: 'recovering' });
    }
    throw error;
  } finally {
    try {
      for (const persist of pendingDenials) await persist();
      if (!options.doctor) {
        try {
          const tail = reportText.trim().split(/\r?\n/u).filter(line => line.trim()).slice(-3);
          const reported = tail.map(line => /^상태:\s*([A-Za-z_()]+)\s*$/u.exec(line.replace(/[`*]/gu, '').trim())?.[1]).findLast(Boolean);
          const actual = stateAtBrainExit ?? (await readState(root)).state;
          if (reported && reported !== actual) {
            await appendLedger(root, { runId, action: 'report:state-mismatch', status: 'warn',
              evidence: { reported: redact(reported), actual } });
            await notify(root, { key: `report:state-mismatch:${runId}`, level: 'info', title: '두뇌 상태 보고',
              body: `두뇌 보고 상태 ${reported} ≠ 실제 ${actual}` });
          }
        } catch (error) {
          try { await appendLedger(root, { runId, action: 'report:state-check', status: 'fail',
            evidence: { error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) } }); }
          catch { /* Diagnostic storage failure must also preserve the original turn result. */ }
        }
      }
      const fresh = [...turnSuspicions].filter(path => !notifiedAuditPaths.has(`${resolve(root)}\0${path}`));
      if (fresh.length && options.notify) {
        try {
          await options.notify(`훅이 놓친 소스 쓰기 의심 ${fresh.length}건: ${fresh.slice(0, 3).join(', ')}${fresh.length > 3 ? '…' : ''} (fodh ledger list)`);
          for (const path of fresh) notifiedAuditPaths.add(`${resolve(root)}\0${path}`);
        } catch { await appendLedger(root, { runId, action: 'audit:notify', status: 'fail' }); }
      }
    } finally { turnsInProgress.delete(resolve(root)); await release?.(); }
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
  alias = alias.replace(/\[[^\]]*\]$/u, '');
  actual = actual.replace(/\[[^\]]*\]$/u, '');
  if (alias.startsWith('claude-')) return actual === alias
    || actual.startsWith(`${alias}-`) && /^\d{8}$/u.test(actual.slice(alias.length + 1));
  if (alias === 'fable') return actual === 'claude-fable-5-1' || actual.includes('-fable-');
  return actual === alias || actual.includes(`-${alias}-`);
}
