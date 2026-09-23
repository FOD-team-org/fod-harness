import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import { readState, doctorFresh, updateState } from '../../src/core/state.ts';
import { loadConfig, setConfig } from '../../src/core/config.ts';
import { join } from 'node:path';
import { acquireLock } from '../../src/core/lock.ts';
import { streamClaude } from './stream.ts';
import { doctor } from '../../src/cli/doctor.ts';
export default function provider(pi: ExtensionAPI) {
  let root = process.cwd();
  let restoreTools: string[] | undefined;
  let release: (() => Promise<void>) | undefined;
  let controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  let ready = false;
  let notify: ((message: string) => void) | undefined;
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
    models: ['fable', 'opus', 'sonnet', 'haiku'].map(id => ({ id, name: `Claude Code ${id}`, reasoning: false, input: ['text'],
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
      const stream = streamClaude(model, context, { ...options, signal }, { root, lockHeld: true, notify, useConfiguredModel: true });
      pending = stream.result().finally(() => { pending = undefined; });
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
    root = ctx.cwd; controller = new AbortController(); ready = false;
    notify = message => ctx.ui.notify(message, 'warning');
    notify('Pi 자동 컴팩션을 꺼 주세요: .pi/settings.json 또는 ~/.pi/agent/settings.json의 compaction.enabled=false');
    release = await acquireLock(join(root, '.pi/harness.lock'));
    selectTools(ctx.model?.provider === 'claude-code');
    if (ctx.model?.provider === 'claude-code') {
      await ensureDoctor();
    }
  });
  pi.on('model_select', async event => {
    const active = event.model.provider === 'claude-code';
    selectTools(active);
    if (active) {
      await setConfig(root, 'brain.model', event.model.id);
      await updateState(root, current => ({ brain: {
        ...(current.brain as Record<string, unknown> | undefined), model: event.model.id,
      } }));
      await ensureDoctor();
    }
  });
  pi.on('session_shutdown', async () => {
    controller.abort();
    try { await pending; } finally { await release?.(); release = undefined; ready = false; selectTools(false); }
  });
}
