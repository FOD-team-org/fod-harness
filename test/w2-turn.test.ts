import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace } from './w2-helpers.ts';
import { runTurn } from '../src/provider/turn.ts';
import { childEnv, runProcess, type RunOptions } from '../src/provider/runner.ts';
import { readLedger } from '../src/core/ledger.ts';
vi.mock('../src/provider/runner.ts', async original => ({ ...await original<object>(), runProcess: vi.fn() }));
it('turn은 멤버 main 경로를 감사에 전달한다(실제 두뇌·Bash 실행 없음)', async () => {
  const f = await workspace();
  await mkdir(join(f.root, '.claude')); await writeFile(join(f.root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  vi.mocked(runProcess).mockImplementation(async (options: RunOptions) => {
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', model: 'claude-fable-5-1', session_id: sid, permissionMode: 'bypassPermissions', apiKeySource: 'none' });
    await options.onEvent?.({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write', name: 'Bash', input: { command: 'cp a ../web/src/x.ts' } }] } });
    await options.onEvent?.({ type: 'result', is_error: false, result: 'done', permission_denials: [] });
    return { code: 0, stderr: '', cleaned: true };
  });
  expect(await runTurn('test', { root: f.root, env: childEnv() })).toMatchObject({ reason: 'stop' });
  expect(await readLedger(f.root)).toContainEqual(expect.objectContaining({ action: 'audit:path-boundary', status: 'warn', evidence: { path: join(f.member(), 'src/x.ts') } }));
});
