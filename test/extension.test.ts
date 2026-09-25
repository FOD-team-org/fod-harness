import { it, expect, vi, afterEach } from 'vitest';
import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent';
import provider from '../extensions/provider/index.ts';
import { getConfig } from '../src/core/config.ts';
import { readState, updateState } from '../src/core/state.ts';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { childEnv } from '../extensions/provider/runner.ts';
import { listProcs } from '../src/core/procs.ts';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const root of roots.splice(0)) { expect(await listProcs(root)).toEqual([]); await rm(root, { recursive: true, force: true }); }
});
async function setup(configText?: string) {
  const root = await mkdtemp('/private/tmp/fodh-extension-'); roots.push(root); await mkdir(join(root, '.pi')); await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.pi/harness.json'), configText ?? JSON.stringify({ brain: { allowedModels: ['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet'], command: resolve('test/fake-claude/claude'), switchCommand: [resolve('test/fake-claude/switch')], maxTurnMinutes: 0.2 } }));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(key, undefined);
  vi.stubEnv('HOME', root); vi.stubEnv('FAKE_CLAUDE_SCENARIO', 'first');
  let config: ProviderConfig | undefined;
  let active = ['read','bash','edit'];
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const api = { registerProvider: (name: string, value: ProviderConfig) => { expect(name).toBe('claude-code'); config = value; },
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
    on: (name: string, handler: (...args: any[]) => Promise<void>) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try { provider(api); } finally { cwd.mockRestore(); }
  const ctx = { cwd: root, model: { provider: 'claude-code' }, ui: { notify: vi.fn() } };
  return { root, config: config!, handlers, ctx, active: () => active };
}
it('설정 모델 목록, 100만 컨텍스트, 활성 도구 끄기와 원래 도구 복원', async () => {
  const test = await setup();
  expect(test.config.models?.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet']);
  expect(test.config.models?.every(model => model.contextWindow === 1000000)).toBe(true);
  await test.handlers.get('session_start')!({}, test.ctx);
  try {
    expect(test.active()).toEqual([]); expect(await calls(test.root)).toHaveLength(1);
    await test.handlers.get('model_select')!({ model: { provider: 'other' } }); expect(test.active()).toEqual(['read','bash','edit']);
    await test.handlers.get('model_select')!({ model: { provider: 'claude-code', id: 'haiku' } }); expect(test.active()).toEqual([]);
    expect(await calls(test.root)).toHaveLength(1);
  } finally { await test.handlers.get('session_shutdown')!(); }
  expect(test.active()).toEqual(['read','bash','edit']);
  await expect(readFile(join(test.root, '.pi/harness.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('다른 모델로 시작한 뒤 claude-code 선택 때 doctor 실행', async () => {
  const test = await setup(); test.ctx.model.provider = 'other';
  await test.handlers.get('session_start')!({}, test.ctx);
  try {
    expect(await calls(test.root)).toHaveLength(0); expect(test.active()).toEqual(['read','bash','edit']);
    await test.handlers.get('model_select')!({ model: { provider: 'claude-code', id: 'haiku' } }); expect(await calls(test.root)).toHaveLength(1); expect(test.active()).toEqual([]);
  } finally { await test.handlers.get('session_shutdown')!(); }
});
it('세션 종료는 실행 중인 두뇌를 abort하고 회수 뒤 잠금을 해제', async () => {
  const test = await setup();
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']) vi.stubEnv(key, undefined);
  await test.handlers.get('session_start')!({}, test.ctx);
  vi.stubEnv('FAKE_CLAUDE_SCENARIO', 'hang');
  const model = { ...test.config.models!.find(model => model.id === 'haiku')!, provider: 'claude-code', api: 'claude-code', baseUrl: 'local://claude-code' };
  const stream = test.config.streamSimple!(model, { messages: [{ role: 'user', content: '멈춤', timestamp: 0 }] });
  try {
    await new Promise(resolve => setTimeout(resolve, 400));
    const rejected = test.config.streamSimple!(model, { messages: [] });
    expect((await rejected.result()).errorMessage).toContain('이미 실행');
  } finally { await test.handlers.get('session_shutdown')!(); }
  expect((await stream.result()).stopReason).toBe('aborted');
  expect(await listProcs(test.root)).toEqual([]);
});

async function calls(root: string) {
  try { return (await readFile(join(root, '.pi/fake-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch { return []; }
}
it('신선한 doctor 재사용, TTL 만료 시 모델 선택에서 재검사, 컴팩션 경고', async () => {
  const test = await setup();
  await updateState(test.root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await test.handlers.get('session_start')!({}, test.ctx);
  try {
    expect(await calls(test.root)).toHaveLength(0);
    expect(test.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('compaction.enabled=false'), 'warning');
    await updateState(test.root, { doctor: { ok: true, checkedAt: new Date(Date.now() - 13 * 3600000).toISOString() } });
    await test.handlers.get('model_select')!({ model: { provider: 'claude-code', id: 'haiku' } });
    expect(await calls(test.root)).toHaveLength(1);
  } finally { await test.handlers.get('session_shutdown')!(); }
});
it('doctor 미완료 streamSimple은 start/error 스트림을 반환', async () => {
  const test = await setup();
  const model = { ...test.config.models!.find(model => model.id === 'haiku')!, provider: 'claude-code', api: 'claude-code', baseUrl: 'local://claude-code' };
  const stream = test.config.streamSimple!(model, { messages: [] });
  const events = []; for await (const event of stream) events.push(event.type);
  expect(events).toEqual(['start', 'error']);
  await test.handlers.get('session_shutdown')!();
});

it('Pi 모델 선택은 설정과 상태의 brain.model을 바꾸며 최근 doctor를 재사용한다', async () => {
  const test = await setup();
  await updateState(test.root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await test.handlers.get('session_start')!({}, test.ctx);
  try {
    await test.handlers.get('model_select')!({ model: { provider: 'claude-code', id: 'opus' } });
    expect(await getConfig(test.root, 'brain.model')).toBe('claude-opus-5-5');
    expect((await readState(test.root)).brain).toMatchObject({ model: 'claude-opus-5-5' });
    expect(await calls(test.root)).toHaveLength(0);
  } finally { await test.handlers.get('session_shutdown')!(); }
});

it.each(['{}', '{', '{"brain":{"allowedModels":[]}}', '{"brain":{"model":"haiku"}}'])('P8 Pi 기본 목록과 읽기/검증 실패 %s 경고는 첫 session_start 한 번', async raw => {
  const t = await setup(raw); t.ctx.model.provider = 'other';
  try {
    expect(t.config.models?.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-1']);
    for (let i = 0; i < 2; i++) {
      await t.handlers.get('session_start')!({}, t.ctx);
      await t.handlers.get('session_shutdown')!();
    }
    expect(t.ctx.ui.notify.mock.calls.filter(([message]) => message.includes('기본 모델 목록'))).toHaveLength(raw === '{}' ? 0 : 1);
  } finally { await t.handlers.get('session_shutdown')!(); }
});
it('P8 Pi 등록은 사용자 허용 목록 ID를 그대로 사용한다', async () => {
  const t = await setup('{"brain":{"model":"claude-opus-6","allowedModels":["claude-opus-6","haiku"]}}');
  try { expect(t.config.models?.map(model => model.id)).toEqual(['claude-opus-6', 'haiku']); }
  finally { await t.handlers.get('session_shutdown')!(); }
});
it('P8 목록 밖 model_select는 알림 후 준비·도구를 끈 채 오류 스트림을 반환한다', async () => {
  const t = await setup();
  await updateState(t.root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  try {
    await t.handlers.get('session_start')!({}, t.ctx);
    await expect(t.handlers.get('model_select')!({ model: { provider: 'claude-code', id: 'unapproved' } }, t.ctx)).resolves.toBeUndefined();
    expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('brain.allowedModels'), 'error');
    expect(t.active()).toEqual([]);
    expect(await getConfig(t.root, 'brain.model')).toBe('claude-fable-5-1');
    const model = { ...t.config.models![0], provider: 'claude-code', api: 'claude-code', baseUrl: 'local://claude-code' };
    expect((await t.config.streamSimple!(model, { messages: [] }).result()).stopReason).toBe('error');
    expect(await calls(t.root)).toHaveLength(0);
  } finally { await t.handlers.get('session_shutdown')!(); }
});
it('P8 첫 턴 전 순서 교정은 반복해서 밀려도 신호별 원장을 한 번만 남긴다', async () => {
  const { ensureShutdownReclaimFirst, shutdownReclaimMarker } = await import('../src/provider/shutdown.ts');
  const { readLedger } = await import('../src/core/ledger.ts');
  const t = await setup(), piHandler = () => {};
  const signals = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
  await updateState(t.root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  try {
    await t.handlers.get('session_start')!({}, t.ctx);
    const model = { ...t.config.models![0], provider: 'claude-code', api: 'claude-code', baseUrl: 'local://claude-code' };
    for (let i = 0; i < 2; i++) {
      for (const signal of signals) { process.off(signal, piHandler); process.prependListener(signal, piHandler); }
      expect((await t.config.streamSimple!(model, { messages: [] }).result()).stopReason).toBe('stop');
      for (const signal of signals) expect((process.rawListeners(signal)[0] as any)[shutdownReclaimMarker]).toBe(true);
    }
    expect(ensureShutdownReclaimFirst()).toEqual([]);
    expect((await readLedger(t.root)).filter(entry => entry.action === 'shutdown:reorder')).toEqual([
      expect.objectContaining({ evidence: { signals: ['SIGHUP', 'SIGTERM', 'SIGINT'] } }),
    ]);
  } finally {
    for (const signal of signals) process.off(signal, piHandler);
    await t.handlers.get('session_shutdown')!();
  }
});

it.each([false, true])('P8-c 설정 파일 부재는 경고 없이 기본 목록, 읽기 실패=%s면 경고', async unreadable => {
  const t = await setup();
  await t.handlers.get('session_shutdown')!();
  await rm(join(t.root, '.pi/harness.json'));
  if (unreadable) await mkdir(join(t.root, '.pi/harness.json'));
  const handlers = new Map<string, Function>(), registerProvider = vi.fn();
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(t.root);
  try { provider({ registerProvider, on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => [], setActiveTools: vi.fn() } as unknown as ExtensionAPI); }
  finally { cwd.mockRestore(); }
  try {
    expect(registerProvider.mock.calls[0][1].models.map((model: any) => model.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-1']);
    await handlers.get('session_start')!({}, { ...t.ctx, model: undefined });
    expect(t.ctx.ui.notify.mock.calls.filter(([message]) => message.includes('기본 모델 목록'))).toHaveLength(unreadable ? 1 : 0);
  } finally { await handlers.get('session_shutdown')!(); }
});
