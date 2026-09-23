import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
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
    models: ['opus', 'sonnet', 'haiku'].map(id => ({ id, name: `Claude Code ${id}`, reasoning: false, input: ['text'],
      contextWindow: 1000000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model, context, options) => {
      if (!ready || !release) throw new Error('configError: 세션 doctor 검증이 완료되지 않았습니다.');
      if (pending) throw new Error('하네스 턴이 이미 실행 중입니다.');
      const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const stream = streamClaude(model, context, { ...options, signal }, { root, lockHeld: true, notify });
      pending = stream.result().finally(() => { pending = undefined; });
      return stream;
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    root = ctx.cwd; controller = new AbortController(); ready = false;
    notify = message => ctx.ui.notify(message, 'warning');
    release = await acquireLock(join(root, '.pi/harness.lock'));
    selectTools(ctx.model?.provider === 'claude-code');
    if (ctx.model?.provider === 'claude-code') {
      await doctor(root, { lockHeld: true, signal: controller.signal }); ready = true;
    }
  });
  pi.on('model_select', async event => {
    const active = event.model.provider === 'claude-code';
    selectTools(active);
    if (active && !ready) { await doctor(root, { lockHeld: !!release, signal: controller.signal }); ready = true; }
  });
  pi.on('session_shutdown', async () => {
    controller.abort();
    try { await pending; } finally { await release?.(); release = undefined; ready = false; selectTools(false); }
  });
}
