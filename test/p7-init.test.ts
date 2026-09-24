import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, symlink, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { project } from './p5-helpers.ts';
import orchestrator, { initialize } from '../extensions/orchestrator/index.ts';
import { readLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';
import * as storage from '../src/core/storage.ts';

const required = ['.pi/harness.lock', '.pi/*.lock', '.pi/harness-*.json', '.pi/harness-*.jsonl', '.pi/scratch/',
  '.pi/codex/', '.pi/verify/', '.pi/cleanup-last.json', '.pi/harness-config-warned.json'];
it.each(['file', 'directory'] as const)('F11 git %s initialize는 기존 gitignore를 보존하고 누락 줄만 한 번 추가한다', async git => {
  const root = await project('IDLE');
  if (git === 'file') await writeFile(join(root, '.git'), 'gitdir: unused-fixture');
  else await mkdir(join(root, '.git'));
  const original = '# 사용자 규칙\r\nnode_modules/\r\n.pi/codex/';
  await writeFile(join(root, '.gitignore'), original);
  await initialize(root); const first = await readFile(join(root, '.gitignore'), 'utf8');
  expect(first.startsWith(original + '\r\n')).toBe(true);
  for (const line of required) expect(first.split(/\r?\n/u).filter(value => value === line)).toHaveLength(1);
  await initialize(root); expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(first);
});

it('F11 첫 세션은 gitignore가 없으면 생성하고 비-git initialize는 생성하지 않는다', async () => {
  const root = await project('IDLE'); await mkdir(join(root, '.git'));
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  orchestrator({ registerCommand: vi.fn(), on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: true, ui: { notify: vi.fn() } };
  await handlers.get('session_start')!({}, ctx);
  expect((await readFile(join(root, '.gitignore'), 'utf8')).trimEnd().split('\n')).toEqual(required);
  await handlers.get('session_shutdown')!({}, ctx);
  const plain = await project('IDLE'); await initialize(plain);
  await expect(readFile(join(plain, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['directory', 'symlink', 'write-error'] as const)('L2 gitignore %s여도 세션은 시작하고 실패·알림만 남긴다', async kind => {
  const root = await project('IDLE'); await mkdir(join(root, '.git'));
  await setConfig(root, 'notify.channels', '["tui","ledger"]');
  const path = join(root, '.gitignore'), target = join(root, 'user-ignore');
  if (kind === 'directory') await mkdir(path);
  else if (kind === 'symlink') { await writeFile(target, '# 사용자 원본\n'); await symlink(target, path); }
  else {
    await writeFile(path, '# 유지\n');
    const original = storage.atomicWrite;
    vi.spyOn(storage, 'atomicWrite').mockImplementation(async (file, text) => {
      if (file === path) throw new Error('fixture: write denied');
      return original(file, text);
    });
  }
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  orchestrator({ registerCommand: vi.fn(), on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: true, ui: { notify: vi.fn() } };
  try {
    await expect(handlers.get('session_start')!({}, ctx)).resolves.toBeUndefined();
    const failures = (await readLedger(root)).filter(entry => entry.action === 'init:gitignore');
    expect(failures).toEqual([expect.objectContaining({ status: kind === 'write-error' ? 'fail' : 'skipped', evidence: expect.objectContaining(
      kind === 'write-error' ? { error: 'fixture: write denied' } : { skipped: 'not-regular-file' }) })]);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(kind === 'write-error' ? '.gitignore 갱신 실패' : '.gitignore 갱신 건너뜀'), 'warning');
    if (kind === 'directory') expect((await lstat(path)).isDirectory()).toBe(true);
    else if (kind === 'symlink') {
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readlink(path)).toBe(target);
      expect(await readFile(target, 'utf8')).toBe('# 사용자 원본\n');
    } else expect(await readFile(path, 'utf8')).toBe('# 유지\n');
  } finally { await handlers.get('session_shutdown')!({}, ctx); }
});

it('R1 비정규 gitignore는 initialize 후속 문서 준비를 막지 않는다', async () => {
  const { todayKst } = await import('../src/core/template-values.ts');
  const root = await project('IDLE'); await mkdir(join(root, '.git'));
  const target = join(root, 'user-ignore'); await writeFile(target, 'preserve');
  await symlink(target, join(root, '.gitignore'));
  await initialize(root);
  for (const file of ['backlog.md', `작업일지/${todayKst()}.md`, '판단대기.md']) {
    expect(await readFile(join(root, 'docs', file), 'utf8')).not.toBe('');
  }
  expect(await readFile(target, 'utf8')).toBe('preserve');
  expect((await readLedger(root)).filter(e => e.action === 'init:gitignore')).toMatchObject([{ status: 'skipped' }]);
});
it('R1 일반 I/O 오류는 initialize에서 그대로 올린다', async () => {
  const root = await project('IDLE'); await mkdir(join(root, '.git'));
  const original = storage.atomicWrite;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (file, text) => {
    if (file === join(root, '.gitignore')) throw new Error('fixture: write denied');
    return original(file, text);
  });
  await expect(initialize(root)).rejects.toThrow('fixture: write denied');
});
it('R2 세션마다 skipped 원장은 남기되 영속 표지로 프로젝트당 한 번만 알린다', async () => {
  const root = await project('IDLE'); await mkdir(join(root, '.git')); await mkdir(join(root, '.gitignore'));
  await setConfig(root, 'notify.channels', '["tui","ledger"]');
  const ctx = { cwd: root, hasUI: true, ui: { notify: vi.fn() } };
  for (let i = 0; i < 2; i++) {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
    orchestrator({ registerCommand: vi.fn(), on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
    await handlers.get('session_start')!({}, ctx); await handlers.get('session_shutdown')!({}, ctx);
  }
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  const ledger = await readLedger(root);
  expect(ledger.filter(e => e.action === 'init:gitignore').map(e => e.status)).toEqual(['skipped', 'skipped']);
  // No second notify call, including a notify-level dedupe/skip entry.
  expect(ledger.filter(e => e.action === 'notify:init:gitignore')).toHaveLength(1);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-init-warned.json'), 'utf8'))).toEqual({ gitignore: 'not-regular-file', at: expect.any(String) });
});
it('S5 세션 시작은 옛 관리 블록만 이행하고 사용자 영역·옛 작업일지는 보존한다', async () => {
  const { generateClaudeMd } = await import('../src/core/claude-md.ts');
  const root = await project('IDLE');
  await mkdir(join(root, 'docs'), { recursive: true });
  const oldLog = join(root, 'docs/작업일지.md'); await writeFile(oldLog, 'legacy log bytes\n');
  const path = join(root, 'CLAUDE.md'), prefix = '# 사용자 머리\n작업일지.md 사용자 문구\n\n', suffix = '\n사용자 꼬리\n';
  await generateClaudeMd(root);
  const generated = await readFile(path, 'utf8');
  const block = generated.slice(generated.indexOf('<!-- fodh:managed:begin'));
  await writeFile(path, prefix + block.replace('작업일지/YYYY-MM-DD.md', '작업일지.md') + suffix);
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  orchestrator({ registerCommand: vi.fn(), on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: true, ui: { notify: vi.fn() } };
  const reads = vi.spyOn(storage, 'readText');
  await handlers.get('session_start')!({}, ctx);
  expect(reads.mock.calls.some(([file]) => file === oldLog)).toBe(false);
  const migrated = await readFile(path, 'utf8');
  expect(migrated).toBe(prefix + block + suffix);
  const writes = vi.spyOn(storage, 'atomicWrite');
  await handlers.get('session_start')!({}, ctx);
  expect(writes.mock.calls.some(([file]) => file === path)).toBe(false);
  expect(reads.mock.calls.some(([file]) => file === oldLog)).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(migrated);
  reads.mockRestore();
  expect(await readFile(oldLog, 'utf8')).toBe('legacy log bytes\n');
  await handlers.get('session_shutdown')!({}, ctx);
});
