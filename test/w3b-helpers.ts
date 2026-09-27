import { vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import orchestrator from '../extensions/orchestrator/index.ts';
import { fixture, writeConfig } from './w1-helpers.ts';
import { updateState } from '../src/core/state.ts';
export const now = Date.parse('2026-09-27T00:00:00Z');
export async function single() {
  const f = await fixture(['web']); await writeConfig(f.root, {});
  await updateState(f.root, { state: 'PICK' });
  return f;
}
export function ui(root: string) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const sendMessage = vi.fn();
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage } as unknown as ExtensionAPI;
  const ctx = { cwd: root, hasUI: true, isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), ui: { notify: vi.fn(), setStatus: vi.fn() } };
  orchestrator(pi);
  return { pi, ctx, context: ctx as unknown as ExtensionContext, sendMessage,
    command: (name: string) => commands.get(name)!.handler('', ctx),
    start: () => handlers.get('session_start')!({}, ctx),
    end: (stopReason = 'aborted') => handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason, content: [] }] }, ctx) };
}
