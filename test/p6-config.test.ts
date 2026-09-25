import { liveHarness } from './p7-brain-helpers.ts';
import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { approvalConfigKeys, setConfig } from '../src/core/config.ts';
import * as processes from '../src/core/process-time.ts';

it('P6 승인 전용 키는 사용자 CLI --approve 필요, 상위 객체도 우회 불가', async () => {
  const root = await project();
  const values: Record<string, string> = {
    approvalRules: '[{"id":"db-migrate","pattern":"^npm"}]',
    'worktrees.links': '["node_modules"]', requiresApproval: '["prod-migration"]',
    'brain.allowedModels': JSON.stringify(['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet']),
    'delegate.codex.command': '"fake-codex"', 'brain.command': '"fake-claude"',
    'brain.switchCommand': '["fake-switch"]', 'delegate.codex.sandbox': '"read-only"',
  };
  expect(approvalConfigKeys.every(key => Object.hasOwn(values, key))).toBe(true);
  for (const key of approvalConfigKeys) {
    const before = await readFile(join(root, '.pi/harness.json'));
    expect(await cli(root, ['config', 'set', key, values[key]])).toMatchObject({ code: 1, value: { error: `승인 전용 키입니다: ${key}. --approve 를 붙여 사용자 터미널에서 실행하세요` } });
    expect(await readFile(join(root, '.pi/harness.json'))).toEqual(before);
    expect((await cli(root, ['config', 'set', key, values[key], '--approve'])).code).toBe(0);
  }
  expect((await cli(root, ['config', 'set', 'brain', '{}'])).code).toBe(1);
  expect((await cli(root, ['config', 'set', 'brain.model', 'haiku'])).code).toBe(0);
});
it('P6 두뇌는 --approve로 verify·delegate·승인 키를 포함한 어떤 설정도 변경 못한다', async () => {
  const root = await project(), before = await readFile(join(root, '.pi/harness.json'));
  await liveHarness(root); vi.stubEnv('FODH_BRAIN', '1');
  for (const key of ['verify.commands', 'delegate.codex.workerModel', ...approvalConfigKeys, 'custom'])
    expect(await cli(root, ['config', 'set', key, '["true"]', '--approve'])).toMatchObject({ code: 1, value: { error: expect.stringContaining('사용자 터미널') } });
  expect(await readFile(join(root, '.pi/harness.json'))).toEqual(before);
});
it('P6 env 없는 부모 체인의 잠금 소유자도 거부하고 무관한 사용자 체인은 허용한다', async () => {
  const root = await project(), before = await readFile(join(root, '.pi/harness.json'));
  await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: process.ppid, startedAt: 'owner-start', token: 'fixture' }));
  vi.spyOn(processes, 'processStartedAt').mockResolvedValue('owner-start');
  const chain = vi.spyOn(processes, 'descendantOf').mockResolvedValue(true);
  vi.stubEnv('FODH_BRAIN', '');
  await expect(setConfig(root, 'verify.commands', '["true"]')).rejects.toThrow('두뇌 세션');
  expect(chain).toHaveBeenCalledWith(process.ppid, process.ppid);
  expect(await readFile(join(root, '.pi/harness.json'))).toEqual(before);
  chain.mockResolvedValue(false);
  await setConfig(root, 'brain.allowedModels', JSON.stringify(['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet']));
  await expect(setConfig(root, 'brain.model', 'haiku')).resolves.toBe('haiku');
  chain.mockResolvedValue(undefined);
  await expect(setConfig(root, 'brain.model', 'fable')).rejects.toThrow('두뇌 세션');
});
it('P6 부모 체인 조회는 조상·무관·ps 실패·순환을 구별한다', async () => {
  const parent = vi.fn(async (pid: number) => ({ 30: 20, 20: 10, 10: 1 }[pid]));
  expect(await processes.descendantOf(30, 10, parent)).toBe(true);
  expect(await processes.descendantOf(30, 99, parent)).toBe(false);
  expect(await processes.descendantOf(30, 99, async () => undefined)).toBeUndefined();
  expect(await processes.descendantOf(30, 99, async () => 30)).toBeUndefined();
});
