import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appendLedger } from '../../src/core/ledger.ts';
import { installShutdownReclaim, ensureShutdownReclaimFirst } from '../../src/provider/shutdown.ts';
import { getCurrentBrainGroup } from '../../src/provider/runner.ts';
import { recoverOrphanBrain } from '../../src/core/brain-lifecycle.ts';
import { setNotifyContext } from '../../src/core/notify.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { readState, doctorFresh, updateState } from '../../src/core/state.ts';
import { loadConfig, setConfig, brainModels, defaultAllowedModels } from '../../src/core/config.ts';
import { join } from 'node:path';
import { acquireLock } from '../../src/core/lock.ts';
import { streamClaude } from './stream.ts';
import { doctor } from '../../src/cli/doctor.ts';
import { waitForShutdown } from '../../src/core/shutdown-wait.ts';
import { compactionDisabled } from './compaction.ts';
const reorderKey = Symbol.for('fodh.shutdownReorderedSignals');
const shared = globalThis as typeof globalThis & { [reorderKey]?: Set<string> };
const reorderedSignals = shared[reorderKey] ??= new Set<string>();
export default function provider(pi: ExtensionAPI, options: { shutdownWaitMs?: number } = {}) {
  let root = process.cwd();
  let models: string[], modelWarning: string | undefined;
  try { models = brainModels(JSON.parse(readFileSync(join(root, '.pi/harness.json'), 'utf8').trim() || '{}')).allowedModels; }
  catch (error) {
    models = [...defaultAllowedModels];
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') modelWarning = '두뇌 모델 설정을 읽거나 검증하지 못했습니다. 기본 모델 목록을 사용합니다. .pi/harness.json을 확인하세요';
  }
  let uninstallShutdownReclaim: (() => void) | undefined = installShutdownReclaim(getCurrentBrainGroup, () => root);
  let restoreTools: string[] | undefined;
  let release: (() => Promise<void>) | undefined;
  let controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  let ready = false;
  let notify: ((message: string) => void) | undefined;
  let ui: { setWorkingMessage: (line?: string) => void } | undefined;
  const selectTools = (active: boolean) => {
    if (active) {
      restoreTools ??= pi.getActiveTools();
      pi.setActiveTools([]);
    } else if (restoreTools) {
      pi.setActiveTools(restoreTools); restoreTools = undefined;
    }
  };
  pi.registerProvider('claude-code', {
    name: 'Claude Code 구독', baseUrl: 'local://claude-code', api: 'claude-code', apiKey: 'local-cli-no-credential',
    models: models.map(id => ({ id, name: `Claude Code ${id}`, reasoning: false, input: ['text'],
      contextWindow: 1000000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model, context, options) => {
      if (!ready || !release || pending) {
        const stream = createAssistantMessageEventStream();
        const error: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error', timestamp: Date.now(),
          errorMessage: pending ? '하네스 턴이 이미 실행 중입니다.' : 'configError: 세션 doctor 검증이 완료되지 않았습니다.',
        };
        stream.push({ type: 'start', partial: error });
        stream.push({ type: 'error', reason: 'error', error }); stream.end();
        return stream;
      }
      const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const signals = ensureShutdownReclaimFirst().filter(signal => !reorderedSignals.has(signal));
      if (signals.length) {
        for (const signal of signals) reorderedSignals.add(signal);
        void appendLedger(root, { runId: randomUUID(), action: 'shutdown:reorder', status: 'ok', evidence: { signals } })
          .catch(() => notify?.('종료 신호 처리기 순서 복구 원장을 기록하지 못했습니다.'));
      }
      const stream = streamClaude(model, context, { ...options, signal }, { root, lockHeld: true, notify, ui, useConfiguredModel: true });
      const completion = stream.result().finally(() => { if (pending === completion) pending = undefined; });
      pending = completion;
      return stream;
    },
  });
  const ensureDoctor = async () => {
    ready = false;
    const config = await loadConfig(root);
    if (!doctorFresh(await readState(root), config.brain.doctorTtlHours)) {
      await doctor(root, { lockHeld: !!release, signal: controller.signal });
    }
    ready = true;
  };
  pi.on('session_start', async (_event, ctx) => {
    root = ctx.cwd;
    ui = ctx.hasUI ? ctx.ui : undefined;
    uninstallShutdownReclaim?.();
    uninstallShutdownReclaim = installShutdownReclaim(getCurrentBrainGroup, () => root);
    controller = new AbortController(); ready = false;
    setNotifyContext(root, { hasUI: ctx.hasUI, notify: (body, level) => ctx.ui.notify(body, level) });
    notify = message => ctx.ui.notify(message, 'warning');
    if (modelWarning) { notify(modelWarning); modelWarning = undefined; }
    if (!compactionDisabled(root, ctx.isProjectTrusted?.() ?? true)) notify('Pi 자동 컴팩션을 꺼 주세요: .pi/settings.json 또는 ~/.pi/agent/settings.json의 compaction.enabled=false. 0.79 부터 프로젝트 설정은 신뢰 전에는 무시되므로 전역 ~/.pi/agent/settings.json 을 권장');
    release = await acquireLock(join(root, '.pi/harness.lock'));
    await recoverOrphanBrain(root, true);
    selectTools(ctx.model?.provider === 'claude-code');
    if (ctx.model?.provider === 'claude-code') {
      await ensureDoctor();
    }
  });
  pi.on('model_select', async (event, ctx) => {
    const active = event.model.provider === 'claude-code';
    selectTools(active);
    if (active) {
      ready = false;
      try { await setConfig(root, 'brain.model', event.model.id); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); return; }
      const model = (await loadConfig(root)).brain.model;
      await updateState(root, current => ({ brain: {
        ...(current.brain as Record<string, unknown> | undefined), model,
      } }));
      await ensureDoctor();
    }
  });
  pi.on('session_shutdown', async () => {
    try { ui?.setWorkingMessage(); } catch { /* Disposed UI. */ }
    ui = undefined;
    controller.abort(); ready = false;
    uninstallShutdownReclaim?.(); uninstallShutdownReclaim = undefined;
    setNotifyContext(root);
    try { await waitForShutdown(root, 'provider', [pending], options.shutdownWaitMs, () => {
      const pgid = getCurrentBrainGroup();
      if (pgid && Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid) {
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* Already gone; preserve the marker for recovery. */ }
        try { writeFileSync(join(root, '.pi/harness-brain-orphan.json'), JSON.stringify({ pgid, signal: 'shutdown-timeout', at: new Date().toISOString() }) + '\n', { mode: 0o600 }); }
        catch { /* Failure to write recovery evidence must not prevent shutdown cleanup. */ }
      }
    }); }
    finally { pending = undefined; await release?.(); release = undefined; selectTools(false); }
  });
}
