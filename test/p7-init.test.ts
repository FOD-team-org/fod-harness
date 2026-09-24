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
    expect(failures).toEqual([expect.objectContaining({ status: 'fail', evidence: expect.objectContaining(
      kind === 'write-error' ? { error: 'fixture: write denied' } : { skipped: 'not-regular-file' }) })]);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('.gitignore 갱신 실패'), 'warning');
    if (kind === 'directory') expect((await lstat(path)).isDirectory()).toBe(true);
    else if (kind === 'symlink') {
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readlink(path)).toBe(target);
      expect(await readFile(target, 'utf8')).toBe('# 사용자 원본\n');
    } else expect(await readFile(path, 'utf8')).toBe('# 유지\n');
  } finally { await handlers.get('session_shutdown')!({}, ctx); }
});
