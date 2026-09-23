import { it, expect, vi, afterEach } from 'vitest';
import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent';
import provider from '../extensions/provider/index.ts';
import { doctor } from '../src/cli/doctor.ts';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { childEnv } from '../extensions/provider/runner.ts';
import { listProcs } from '../src/core/procs.ts';
vi.mock('../src/cli/doctor.ts', () => ({ doctor: vi.fn(async () => ({ ok: true })) }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const root of roots.splice(0)) { expect(await listProcs(root)).toEqual([]); await rm(root, { recursive: true, force: true }); }
});
async function setup() {
  const root = await mkdtemp('/private/tmp/fodh-extension-'); roots.push(root); await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: { command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')], maxTurnMinutes: 0.2 } }));
  await writeFile(join(root, '.claude/settings.json'), '{}');
  let config: ProviderConfig | undefined;
  let active = ['read','bash','edit'];
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const api = { registerProvider: (name: string, value: ProviderConfig) => { expect(name).toBe('claude-code'); config = value; },
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
    on: (name: string, handler: (...args: any[]) => Promise<void>) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  provider(api);
  const ctx = { cwd: root, model: { provider: 'claude-code' }, ui: { notify: vi.fn() } };
  return { root, config: config!, handlers, ctx, active: () => active };
}
it('모델 3종, 100만 컨텍스트, 활성 도구 끄기와 원래 도구 복원', async () => {
  const test = await setup();
  expect(test.config.models?.map(model => model.id)).toEqual(['opus','sonnet','haiku']);
  expect(test.config.models?.every(model => model.contextWindow === 1000000)).toBe(true);
  await test.handlers.get('session_start')!({}, test.ctx);
  try {
    expect(test.active()).toEqual([]); expect(doctor).toHaveBeenCalledOnce();
    await test.handlers.get('model_select')!({ model: { provider: 'other' } }); expect(test.active()).toEqual(['read','bash','edit']);
    await test.handlers.get('model_select')!({ model: { provider: 'claude-code' } }); expect(test.active()).toEqual([]);
    expect(doctor).toHaveBeenCalledOnce();
  } finally { await test.handlers.get('session_shutdown')!(); }
  expect(test.active()).toEqual(['read','bash','edit']);
  await expect(readFile(join(test.root, '.pi/harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('다른 모델로 시작한 뒤 claude-code 선택 때 doctor 실행', async () => {
  const test = await setup(); test.ctx.model.provider = 'other';
  await test.handlers.get('session_start')!({}, test.ctx);
  try {
    expect(doctor).not.toHaveBeenCalled(); expect(test.active()).toEqual(['read','bash','edit']);
    await test.handlers.get('model_select')!({ model: { provider: 'claude-code' } }); expect(doctor).toHaveBeenCalledOnce(); expect(test.active()).toEqual([]);
  } finally { await test.handlers.get('session_shutdown')!(); }
});
it('세션 종료는 실행 중인 두뇌를 abort하고 회수 뒤 잠금을 해제', async () => {
  const test = await setup();
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']) vi.stubEnv(key, undefined);
  vi.stubEnv('HOME', test.root); vi.stubEnv('FAKE_CLAUDE_SCENARIO', 'hang');
  await test.handlers.get('session_start')!({}, test.ctx);
  const model = { ...test.config.models![2], provider: 'claude-code', api: 'claude-code', baseUrl: 'local://claude-code' };
  const stream = test.config.streamSimple!(model, { messages: [{ role: 'user', content: '멈춤', timestamp: 0 }] });
  try {
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(() => test.config.streamSimple!(model, { messages: [] })).toThrow('이미 실행');
  } finally { await test.handlers.get('session_shutdown')!(); }
  expect((await stream.result()).stopReason).toBe('aborted');
  expect(await listProcs(test.root)).toEqual([]);
});
