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
  ['delegate.codex.waitMinutes', '3'], ['delegate.codex.workerEffort', 'medium'], ['delegate.codex.maxChildAgents', '0'],
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

it('P3 delegate/worktrees 기본값은 config get에 모두 노출된다', async () => {
  const root = await project();
  expect(await getConfig(root, 'delegate')).toEqual({ claude: { subagentModel: 'opus', maxChildAgents: 1 },
    codex: { command: 'codex', brainModel: 'gpt-6-astra', brainEffort: 'xhigh', workerModel: 'gpt-6-sol', workerEffort: 'xhigh', sandbox: 'workspace-write', maxChildAgents: 1, timeoutMinutes: 90, waitMinutes: 8 },
    route: { design: 'claude', default: 'codex' } });
  expect(await getConfig(root, 'worktrees')).toEqual({ root: '..', prefix: 'wt-' });
  expect(await getConfig(root, 'watch.childTimeoutMinutes')).toBe(90);
});
it.each([
  ['delegate.codex.sandbox', 'danger-full-access', 'delegate.codex.sandbox는 workspace-write, read-only 중 하나여야 합니다'],
  ['delegate.codex.waitMinutes', '0', '양의 정수'], ['delegate.codex.waitMinutes', '0.5', '양의 정수'],
  ['delegate.codex.timeoutMinutes', '0', '양의 정수'], ['delegate.codex.timeoutMinutes', '0.1', '양의 정수'],
  ['delegate.codex.command', '[]', '명령'], ['delegate.claude.maxChildAgents', '-1', '0 이상의 정수'],
  ['delegate.route', '{"unknown":"codex"}', 'delegate.route'], ['delegate.route', '{"design":"other"}', 'delegate.route'],
  ['worktrees.root', '/outside', '상대 경로'], ['worktrees.prefix', '../wt-', '[A-Za-z0-9_-]+'],
])('P3 설정 %s 거부', async (key, value, message) => {
  const root = await project(); await expect(setConfig(root, key, value)).rejects.toThrow(message);
});

it('P4 설정 기본값·budget 값만 검증·저장', async () => {
  const root = await project();
  expect(await getConfig(root)).toMatchObject({ cleanup: { rebuildablePaths: [], keepPaths: [], sharedCaches: { enabled: false, paths: [] }, codexRunsKeep: 20, swapWarnGB: 8 },
    verify: { commands: [], heavy: [], timeoutMinutes: 30 }, notify: { channels: ['tui', 'macos'] }, budget: { dailyTurns: 200, dailyHours: 20 } });
  for (const [key, value] of [['cleanup.codexRunsKeep', '0'], ['budget.dailyTurns', '2'], ['budget.dailyHours', '0.5'], ['verify.commands', '["node --version"]'], ['notify.channels', '["slack","ledger"]']]) {
    expect(await setConfig(root, key, value)).toEqual(JSON.parse(value)); expect(await getConfig(root, key)).toEqual(JSON.parse(value));
  }
});
it.each([
  ['cleanup.rebuildablePaths', '[1]'], ['cleanup.keepPaths', 'false'], ['cleanup.sharedCaches.enabled', '1'], ['cleanup.codexRunsKeep', '-1'],
  ['cleanup.processes.neverKill', '[""]'], ['cleanup.swapWarnGB', '0'], ['verify.commands', '["node \\"unclosed"]'],
  ['verify.heavy', '[null]'], ['verify.timeoutMinutes', '0'], ['notify.channels', '["email"]'], ['notify.channels', '[1]'],
  ['budget.dailyTurns', '1.5'], ['budget.dailyHours', '-1'],
])('P4 잘못된 %s 설정을 저장 전에 거부', async (key, value) => {
  const root = await project(); await setConfig(root, 'brain.model', 'fable');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await expect(setConfig(root, key, value)).rejects.toThrow(); expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('P4 CLI 명령·인자 검증·dry-run·ledger 알림·빈 검증 exit 1', async () => {
  const root = await project(); await setConfig(root, 'notify.channels', '["ledger"]');
  expect(await cli(root, ['cleanup', 'run', '--scope', 'all', '--dry-run'])).toMatchObject({ code: 0, value: { ok: true, dryRun: true } });
  expect((await cli(root, ['cleanup', 'run', '--scope', 'bad'])).code).toBe(1);
  expect((await cli(root, ['notify', 'send', '--title', 'test', '--body', 'body'])).code).toBe(0);
  expect((await cli(root, ['notify', 'send', '--title', 'test', '--body', 'body', '--level', 'bad'])).code).toBe(1);
  expect((await cli(root, ['verify', 'run'])).code).toBe(1);
  expect((await cli(root, ['memory', 'status'])).code).toBe(0);
});

it('P5 기본값 전체 노출과 선택 설정', async () => {
  const root = await project();
  expect(await getConfig(root)).toMatchObject({ interview: { enforce: true, roundSize: 6, maxAsks: 2, extraBankFile: '.pi/interview-bank.md' },
    docs: { root: 'docs', overrideDir: '.pi/templates/docs' }, skills: { target: '.claude/skills', install: ['fodh-workflow','fodh-spec-writing','fodh-review-checklist','fodh-judgment'] }, claudeMd: { targets: ['CLAUDE.md'] } });
  await setConfig(root, 'interview.roundSize', '8'); await setConfig(root, 'interview.maxAsks', '5'); await setConfig(root, 'interview.enforce', 'false');
  expect((await loadConfig(root)).interview).toMatchObject({ enforce: false, roundSize: 8, maxAsks: 5 });
});
it.each([
  ['interview.enforce','1','interview.enforce는 불리언이어야 합니다'],
  ['interview.roundSize','4','interview.roundSize는 5~8 사이 정수여야 합니다'], ['interview.roundSize','6.5','5~8'], ['interview.roundSize','9','5~8'],
  ['interview.maxAsks','0','1~5'], ['interview.maxAsks','6','1~5'], ['interview.maxAsks','null','1~5'],
  ['interview.extraBankFile','../outside','interview.extraBankFile은 프로젝트 내부 상대 경로여야 합니다'],
  ['docs.root','/outside','docs.root은 프로젝트 내부 상대 경로여야 합니다'], ['docs.overrideDir','../outside','docs.overrideDir은 프로젝트 내부 상대 경로여야 합니다'],
  ['skills.target','../outside','skills.target은 프로젝트 내부 상대 경로여야 합니다'], ['skills.install','["missing"]','skills.install 에 없는 스킬: missing'],
  ['skills.install','[1]','문자열 배열'], ['claudeMd.targets','[]','claudeMd.targets'], ['claudeMd.targets','["other"]','claudeMd.targets'],
  ['claudeMd.targets','["CLAUDE.md","CLAUDE.md"]','claudeMd.targets'],
])('P5 %s 검증과 실패 시 무변경',async(key,value,message)=>{
  const root=await project();await setConfig(root,'brain.model','fable');const path=join(root,'.pi/harness.json'),before=await readFile(path);
  await expect(setConfig(root,key,value)).rejects.toThrow(message);expect(await readFile(path)).toEqual(before);
});

it.each(['interview.enforce','interview','requiresApproval','skills.target','claudeMd.targets','docs.overrideDir','brain.model','watch.pollSeconds','cleanup.keepPaths','notify.channels','custom'])('M2 두뇌의 %s 변경은 바이트 불변 거부',async key=>{
  const root=await project();await setConfig(root,'brain.model','fable');const path=join(root,'.pi/harness.json'),before=await readFile(path);
  vi.stubEnv('FODH_BRAIN','1');
  try { await expect(setConfig(root,key,'false')).rejects.toThrow(`두뇌 세션은 config set ${key} 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요`);expect(await readFile(path)).toEqual(before); }
  finally { vi.unstubAllEnvs(); }
});
it('M2/P6 두뇌 delegate/verify 하위 키도 거부하고 사용자 설정은 유지',async()=>{
  const root=await project();vi.stubEnv('FODH_BRAIN','1');
  try { await expect(setConfig(root,'delegate.codex.workerModel','custom')).rejects.toThrow('두뇌 세션');await expect(setConfig(root,'verify.commands','["node --version"]')).rejects.toThrow('두뇌 세션'); }
  finally { vi.unstubAllEnvs(); }
  await setConfig(root,'interview.enforce','false');expect((await loadConfig(root)).interview.enforce).toBe(false);
});

it.each(['docs.overrideDir', 'interview.extraBankFile'])('N9 %s는 루트·문서 겹침을 거부하고 전용 경로를 허용한다', async key => {
  const root = await project(); await setConfig(root, 'docs.root', 'notes/project');
  const path = join(root, '.pi/harness.json'), before = await readFile(path);
  for (const value of ['.', './', 'custom/..', 'notes', 'notes/project', 'notes/project/child']) {
    await expect(setConfig(root, key, value)).rejects.toThrow(`${key}은 .pi/ 아래 또는 docs.root와 겹치지 않는 경로`);
    expect(await readFile(path)).toEqual(before);
  }
  for (const value of ['.pi/custom', 'custom/templates', 'notes/project-other']) await setConfig(root, key, value);
  await expect(setConfig(root, 'docs.root', 'notes')).rejects.toThrow(key);
  expect((await loadConfig(root)).docs.root).toBe('notes/project');
  await setConfig(root, key, '.pi/custom');
  await expect(setConfig(root, 'docs.root', '.pi/custom/docs')).rejects.toThrow(key);
});

it('L2 doctor는 max-turns 3, 일반 두뇌는 턴 제한 인자 없음', () => {
  const args = claudeArgs('/project', 'haiku', 'sid', false, true);
  expect(args[args.indexOf('--max-turns') + 1]).toBe('3');
  expect(claudeArgs('/project', 'haiku', 'sid', false)).not.toContain('--max-turns');
});

it.each(['.', '', './', '../outside', '/outside', '.pi', '.git', '.claude', 'nested/..'])('L8 docs.root %j는 경계 약화 없이 거부한다', async value => {
  const root = await project(); await setConfig(root, 'brain.model', 'fable');
  const path = join(root, '.pi/harness.json'), before = await readFile(path);
  await expect(setConfig(root, 'docs.root', JSON.stringify(value))).rejects.toThrow('docs.root');
  expect(await readFile(path)).toEqual(before);
});
it('L8 일반 문서 하위 경로는 계속 허용한다', async () => {
  const root = await project(); await setConfig(root, 'docs.root', 'notes/project');
  expect((await loadConfig(root)).docs.root).toBe('notes/project');
});

it('F27 brain.allowPlugins는 기본 false이고 boolean만 받는다', async () => {
  const root = await project();
  expect((await loadConfig(root)).brain.allowPlugins).toBe(false);
  await setConfig(root, 'brain.allowPlugins', 'true');
  expect((await loadConfig(root)).brain.allowPlugins).toBe(true);
  await expect(setConfig(root, 'brain.allowPlugins', 'yes')).rejects.toThrow('불리언');
});
