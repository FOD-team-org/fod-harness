import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfig, loadConfig, setConfig } from '../src/core/config.ts';
import { main } from '../src/cli/index.ts';
import { claudeArgs, matchesModel, packageRoot } from '../src/provider/turn.ts';
import { childEnv } from '../src/provider/runner.ts';

const execute = promisify(execFile), roots: string[] = [];
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-config-'); roots.push(root); return root;
}
afterEach(async () => {
  vi.restoreAllMocks(); process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function cli(root: string, args: string[]) {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += chunk; return true; });
  process.exitCode = 0;
  try { await main(args, root); return { code: process.exitCode, value: JSON.parse(output) }; }
  finally { write.mockRestore(); }
}
it('설정 기본값은 fable, 회전 끔, Opus 수행자, astra/sol xhigh 및 자식 1이다', async () => {
  const root = await project();
  expect(await getConfig(root)).toMatchObject({
    brain: { model: 'fable', rotateAtTokens: 0, doctorTtlHours: 12 },
    delegate: { claude: { subagentModel: 'opus' }, codex: {
      brainModel: 'gpt-6-astra', brainEffort: 'xhigh', workerModel: 'gpt-6-sol', workerEffort: 'xhigh', maxChildAgents: 1,
    } },
  });
  await expect(readFile(join(root, '.pi/harness.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('CLI config get/set은 점 키와 JSON 값, 기본값 및 기존 알 수 없는 설정을 보존한다', async () => {
  const root = await project(); await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ project: { name: '시험' }, brain: { custom: '유지' } }));
  expect(await cli(root, ['config', 'set', 'brain.model', 'opus'])).toEqual({ code: 0, value: 'opus' });
  expect(await cli(root, ['config', 'get', 'brain.model'])).toEqual({ code: 0, value: 'opus' });
  expect(await cli(root, ['config', 'set', 'brain.rotateAtTokens', '250000'])).toEqual({ code: 0, value: 250000 });
  expect(await cli(root, ['config', 'set', 'brain.skipPermissions', 'false'])).toEqual({ code: 0, value: false });
  expect(await cli(root, ['config', 'set', 'custom', '{"items":[1,2],"empty":null}']))
    .toEqual({ code: 0, value: { items: [1, 2], empty: null } });
  expect(await cli(root, ['config', 'get', 'custom.empty'])).toEqual({ code: 0, value: null });
  const config = (await cli(root, ['config', 'get'])).value;
  expect(config).toMatchObject({ project: { name: '시험' }, brain: { custom: '유지', model: 'opus' },
    delegate: { codex: { workerEffort: 'xhigh' } } });
  expect(JSON.parse(await readFile(join(root, '.pi/harness.json'), 'utf8'))).not.toHaveProperty('delegate');
});
it.each([
  ['brain.model', 'haiku'], ['brain.model', 'sonnet'], ['brain.model', 'fable'],
  ['brain.rotateAtTokens', '0'], ['brain.doctorTtlHours', '24'],
  ['delegate.claude.subagentModel', 'opus'], ['delegate.codex.brainModel', 'custom-brain'],
  ['delegate.codex.brainEffort', 'low'], ['delegate.codex.workerModel', 'custom-worker'],
  ['delegate.codex.workerEffort', 'medium'], ['delegate.codex.maxChildAgents', '0'],
])('설정 변경 및 재로드: %s=%s', async (key, value) => {
  const root = await project();
  const written = await setConfig(root, key, value);
  expect(await getConfig(root, key)).toEqual(written);
  expect(await loadConfig(root)).toBeTruthy();
});
it.each([
  ['brain.model', 'other'], ['brain.model', 'null'], ['brain.rotateAtTokens', '-1'],
  ['brain.rotateAtTokens', '1.5'], ['brain.rotateAtTokens', '"10"'], ['brain.rotateAtTokens', 'null'],
  ['brain.doctorTtlHours', '0'], ['delegate.claude.subagentModel', '2'],
  ['delegate.codex.brainModel', 'false'], ['delegate.codex.brainModel', 'null'],
  ['delegate.codex.brainEffort', 'ultra'], ['delegate.codex.workerEffort', 'max'],
  ['delegate.codex.workerModel', '[]'], ['delegate.codex.maxChildAgents', '-1'],
  ['delegate.codex.maxChildAgents', '0.5'], ['delegate.codex.maxChildAgents', 'null'],
  ['delegate.codex', 'false'], ['__proto__.polluted', 'true'], ['brain..model', 'fable'],
])('잘못된 설정은 기존 파일을 바이트 그대로 보존: %s=%s', async (key, value) => {
  const root = await project(); await setConfig(root, 'brain.model', 'fable');
  const path = join(root, '.pi/harness.json'), before = await readFile(path, 'utf8');
  await expect(setConfig(root, key, value)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(before);
  expect({}).not.toHaveProperty('polluted');
});
it('CLI 오류는 JSON/exit 1이며 설정 파일을 생성하지 않는다', async () => {
  const root = await project();
  expect((await cli(root, ['config', 'set', 'brain.model', 'invalid'])).code).toBe(1);
  expect((await cli(root, ['config', 'get', 'unknown.path'])).code).toBe(1);
  expect((await cli(root, ['config', 'get', 'brain.model', 'extra'])).code).toBe(1);
  await expect(readFile(join(root, '.pi/harness.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('서로 다른 키의 동시 config set은 갱신을 유실하지 않는다', async () => {
  const root = await project();
  await Promise.all([setConfig(root, 'brain.model', 'opus'), setConfig(root, 'delegate.codex.maxChildAgents', '2')]);
  expect(await loadConfig(root)).toMatchObject({ brain: { model: 'opus' }, delegate: { codex: { maxChildAgents: 2 } } });
});
it('fable 모델 ID 대응과 기존 별칭 검증을 유지한다', () => {
  expect(matchesModel('fable', 'claude-fable-5-1')).toBe(true);
  expect(matchesModel('fable', 'claude-fable-test')).toBe(true);
  expect(matchesModel('fable', 'fable')).toBe(false);
  expect(matchesModel('fable', 'claude-opus-5-5')).toBe(false);
  expect(matchesModel('opus', 'claude-opus-5-5')).toBe(true);
  expect(matchesModel('haiku', 'haiku')).toBe(true);
});
it('가짜 claude --model fable은 init 및 modelUsage에서 같은 전체 ID를 반환한다', async () => {
  const root = await project();
  const pending = execute(resolve('test/fake-claude/claude'), [
    '--verbose', '--model', 'fable', '--session-id', 'fable-fixture-test',
  ], { cwd: root, env: { ...childEnv(), HOME: root, FAKE_CLAUDE_SCENARIO: 'first' }, timeout: 5000 });
  pending.child.stdin?.end('fable fixture');
  const { stdout } = await pending;
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events.find(event => event.subtype === 'init').model).toBe('claude-fable-5-1');
  expect(Object.keys(events.find(event => event.type === 'result').modelUsage)).toEqual(['claude-fable-5-1']);
});
it('Claude autocompact 인자/settings 불간섭과 env 원본 그대로 전달', async () => {
  const args = claudeArgs('/project', 'fable', 'sid', true);
  expect(args.join(' ')).not.toMatch(/compact|autocompact/i);
  const original = { KEEP: 'keep', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' };
  expect(childEnv(original)).toEqual({ ...original, PATH: join(packageRoot, 'bin') });
  expect(childEnv({ KEEP: 'keep' })).toEqual({ KEEP: 'keep', PATH: join(packageRoot, 'bin') });
  expect(await readFile('templates/claude-settings.json', 'utf8')).not.toMatch(/compact/i);
});
