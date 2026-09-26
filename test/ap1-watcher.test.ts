import { afterEach, expect, it, vi } from 'vitest';
import { project } from './p5-helpers.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import watcher from '../extensions/watcher/index.ts';
import { runAutopilot } from '../extensions/orchestrator/autopilot.ts';
import { decideInbox } from '../extensions/orchestrator/index.ts';
import { pendingDecisions } from '../src/core/watcher.ts';
// Use watcher-extension's fake Pi, fake timers and notification-free dependencies.
vi.mock('../extensions/orchestrator/autopilot.ts', () => ({ runAutopilot: vi.fn(async () => {}) }));
vi.mock('../extensions/orchestrator/index.ts', () => ({ decideInbox: vi.fn(async () => ({ deferred: [] })), clearDecisionTimers: vi.fn() }));
vi.mock('../src/core/watcher.ts', () => ({ tick: vi.fn(async () => ({})), memoryTick: vi.fn(async () => []), detectRecovery: vi.fn(async () => []), pendingDecisions: vi.fn(async () => []), recordDecision: vi.fn(async () => {}) }));
vi.mock('../src/core/cleanup.ts', () => ({ runCleanup: vi.fn(async () => ({ ok: true })) }));
vi.mock('node:fs', async original => ({ ...await original<object>(), watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })) }));
afterEach(() => vi.useRealTimers());
it.each([true, false])('watcher는 decidePending 다음 autopilot, UI=%s', async hasUI => {
  const root = await project(); const handlers = new Map<string, any>();
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { cwd: root, hasUI, isIdle: () => true, ui: { notify: vi.fn() } };
  const now = () => new Date('2026-09-27T00:00:00Z');
  watcher(pi, { now }); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  await handlers.get('session_start')({}, ctx);
  vi.mocked(runAutopilot).mockClear(); vi.mocked(decideInbox).mockClear();
  vi.mocked(pendingDecisions).mockResolvedValueOnce([{ id: 'event', kind: 'judgment-changed', status: 'queued', at: now().toISOString() }]);
  try {
    await vi.advanceTimersByTimeAsync(5000);
    // Let real async file reads complete; no real delay or 30-second timer wait.
    for (let i = 0; i < 20 && hasUI && !vi.mocked(runAutopilot).mock.calls.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
    if (hasUI) {
      expect(runAutopilot).toHaveBeenCalledWith(pi, expect.objectContaining({ cwd: root }), root, now);
      expect(vi.mocked(decideInbox).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runAutopilot).mock.invocationCallOrder[0]);
    } else expect(runAutopilot).not.toHaveBeenCalled();
  } finally { await handlers.get('session_shutdown')({}, ctx); }
});
