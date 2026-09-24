import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { project } from './p5-helpers.ts';
import orchestrator, { initialize } from '../extensions/orchestrator/index.ts';

const required = ['.pi/harness.lock', '.pi/harness-*.json', '.pi/harness-*.jsonl', '.pi/scratch/',
  '.pi/codex/', '.pi/cleanup-last.json', '.pi/harness-config-warned.json'];
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
