import { afterEach, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launcherPath } from './launcher-helpers.ts';
import { initProject } from '../src/cli/init.ts';
import { generateClaudeMd } from '../src/core/claude-md.ts';
import { installSkills } from '../src/core/skills.ts';
import { loadConfig } from '../src/core/config.ts';
import { harnessIgnores } from '../src/core/project-init.ts';
const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture(identity = true) {
  const parent = await mkdtemp('/private/tmp/fodh-a14c-init-'); roots.push(parent);
  const root = join(parent, 'project'); await mkdir(root);
  const home = join(parent, 'home'); await mkdir(home); vi.stubEnv('HOME', home);
  vi.stubEnv('PATH', (await launcherPath(parent)).path);
  const config = join(parent, 'gitconfig');
  await writeFile(config, `[init]\n defaultBranch = fixture-branch\n[commit]\n gpgsign = false\n${identity ? '[user]\n name = Fixture User\n email = fixture@example.invalid\n' : '[user]\n useConfigOnly = true\n'}`);
  for (const key of Object.keys(process.env).filter(k => /^GIT_/u.test(k) || k === 'EMAIL')) vi.stubEnv(key, undefined);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('FODH_BRAIN', ''); vi.stubEnv('FODH_CODEX_CHILD', '');
  return root;
}
async function git(root: string, ...args: string[]) {
  if (!roots.some(p => root.startsWith(p + '/'))) throw new Error('temporary repository only');
  return (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}
async function snapshot(root: string, rel = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(rel, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else result[path] = await readFile(join(root, path), 'utf8');
  }
  return result;
}
it('L2 빈 디렉터리: 사용자 기본 브랜치·신원으로 설정 3개만 첫 커밋, J1·P2·기존 생성 함수 결과', async () => {
  const root = await fixture(), result = await initProject({ cwd: root, brain: 'opus' });
  expect(result).toMatchObject({ gitInitialized: true, committed: true, settingsNeedsHook: false });
  expect(result.nextSteps).toContain('/project-start 를 실행하세요');
  expect(JSON.parse(await readFile(join(root, '.pi/harness.json'), 'utf8'))).toEqual({ brain: { model: 'opus' } });
  expect(await git(root, 'branch', '--show-current')).toBe('fixture-branch');
  expect(await git(root, 'log', '-1', '--format=%an <%ae>%n%s')).toBe('Fixture User <fixture@example.invalid>\nchore(harness): fod-harness 설정');
  expect((await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n')).toHaveLength(3);
  expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('.pi/harness.json');
  expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(await readFile('templates/claude-settings.json', 'utf8'));
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toContain('## 열린 판단');
  await expect(readdir(join(root, 'docs/판단기록'))).rejects.toThrow();
  expect(await generateClaudeMd(root, { check: true })).toEqual({ upToDate: true });
  const installed = await installSkills(root); expect(installed.installed).toEqual([]); expect(installed.updated).toEqual([]);
  expect(installed.unchanged).toHaveLength((await loadConfig(root)).skills.install.length);
  expect(await git(root, 'status', '--porcelain')).toBe('');
});
it('L2 커밋 있는 저장소의 하위 폴더: 루트에 설치하고 기존 .gitignore·커밋·코드 보존', async () => {
  const root = await fixture(); await git(root, 'init');
  await writeFile(join(root, 'code.ts'), 'export const value = 1;\n'); await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'fixture'); const head = await git(root, 'rev-parse', 'HEAD');
  await mkdir(join(root, 'sub'));
  const result = await initProject({ cwd: join(root, 'sub') });
  expect(result.root).toBe(root); expect(result.committed).toBe(false);
  expect(result.nextSteps[0]).toContain('/develop-start'); expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  expect(JSON.parse(await readFile(join(root, '.pi/harness.json'), 'utf8'))).toEqual({ brain: { model: 'claude-fable-5-1' } });
});
it('L2 재실행: 기존 파일·사용자 수정 스킬·관리 문서·exclude 바이트 보존, 중복 없음', async () => {
  const root = await fixture(); await initProject({ cwd: root });
  const config = await loadConfig(root), skill = join(config.skills.target, config.skills.install[0], 'SKILL.md');
  await writeFile(join(root, skill), 'user modified skill\n');
  await writeFile(join(root, 'CLAUDE.md'), 'user modified document\n');
  const before = await snapshot(root), exclude = await readFile(join(root, '.git/info/exclude'), 'utf8');
  const again = await initProject({ cwd: root, brain: 'opus' });
  expect(again.created).toEqual([]); expect(again.existed).toContain('.pi/harness.json');
  expect(await snapshot(root)).toEqual(before); expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toBe(exclude);
  const lines = exclude.split('\n').filter(l => l && !l.startsWith('#')); expect(new Set(lines).size).toBe(lines.length);
  expect(lines.filter(line => line.startsWith('.pi/'))).toEqual(harnessIgnores);
  expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
});
it.each([false, true])('L2 기존 settings 보존·훅 필요 보고 (hook=%s)', async hook => {
  const root = await fixture(); await mkdir(join(root, '.claude'));
  const old = hook ? await readFile('templates/claude-settings.json', 'utf8') : '{"permissions":{"allow":[]}}\n';
  await writeFile(join(root, '.claude/settings.json'), old);
  const result = await initProject({ cwd: root });
  expect(result.settingsNeedsHook).toBe(!hook); expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(old);
  expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).not.toContain('.claude/settings.json');
  if (!hook) expect(result.nextSteps.join(' ')).toContain('hooks.PreToolUse');
});
it('L2 dry-run은 새/기존 저장소에 파일·index·exclude 변경 없음', async () => {
  const root = await fixture(); const before = await snapshot(root);
  const plan = await initProject({ cwd: root, brain: 'fable', dryRun: true });
  expect(plan.created).toContain('.pi/harness.json'); expect(await snapshot(root)).toEqual(before);
  expect(await readdir(root)).toEqual([]);
  await initProject({ cwd: root }); const files = await snapshot(root), index = await readFile(join(root, '.git/index'));
  const exclude = await readFile(join(root, '.git/info/exclude'));
  await initProject({ cwd: root, dryRun: true });
  expect(await snapshot(root)).toEqual(files); expect(await readFile(join(root, '.git/index'))).toEqual(index);
  expect(await readFile(join(root, '.git/info/exclude'))).toEqual(exclude);
});
it('L2 --brain 별칭·프로젝트 allowlist 검사, 두뇌·Codex 자식은 dry-run도 거부', async () => {
  const root = await fixture();
  await expect(initProject({ cwd: root, brain: 'haiku' })).rejects.toThrow('brain.allowedModels');
  expect(await readdir(root)).toEqual([]);
  await mkdir(join(root, '.pi')); await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ brain: { model: 'fable', allowedModels: ['claude-fable-5-1'] } }));
  await expect(initProject({ cwd: root, brain: 'opus' })).rejects.toThrow('brain.allowedModels');
  vi.stubEnv('FODH_BRAIN', '1');
  for (const dryRun of [false, true]) await expect(initProject({ cwd: root, dryRun })).rejects.toThrow('두뇌');
  vi.stubEnv('FODH_BRAIN', ''); vi.stubEnv('FODH_CODEX_CHILD', '1');
  await expect(initProject({ cwd: root })).rejects.toThrow('Codex 위임');
});
it('L2 신원 없음: 설정 파일 보존·커밋 건너뜀, 신원 설정 후 재실행으로 첫 커밋', async () => {
  const root = await fixture(false), result = await initProject({ cwd: root });
  expect(result.committed).toBe(false); expect(result.skipped).toContainEqual({ path: 'commit', reason: expect.stringContaining('Git 신원') });
  expect(await git(root, 'rev-list', '--all', '--max-count=1')).toBe('');
  expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toContain('fodh:managed');
  await git(root, 'config', 'user.name', 'Local Fixture'); await git(root, 'config', 'user.email', 'local@example.invalid');
  expect((await initProject({ cwd: root })).committed).toBe(true);
  expect(await git(root, 'log', '-1', '--format=%an')).toBe('Local Fixture');
});
it('L2 훅 실패는 우회·출력 전달 없이 보고, 기존 staged 파일은 첫 커밋 밖에 보존', async () => {
  const root = await fixture(); await git(root, 'init');
  await writeFile(join(root, 'user.txt'), 'user file'); await git(root, 'add', 'user.txt');
  const hook = join(root, '.git/hooks/pre-commit'); await writeFile(hook, '#!/bin/sh\necho FAKE_VALUE >&2\nexit 1\n', { mode: 0o755 });
  const failed = await initProject({ cwd: root }); expect(failed.committed).toBe(false);
  expect(failed.skipped[0].reason).toContain('훅'); expect(JSON.stringify(failed)).not.toContain('FAKE_VALUE');
  await rm(hook); expect((await initProject({ cwd: root })).committed).toBe(true);
  expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('user.txt');
  expect(await git(root, 'diff', '--cached', '--name-only')).toBe('user.txt');
});
it('L2 래퍼 init --dry-run/help 인자 전달, 사용자 전용 명령 표', async () => {
  const root = await fixture();
  const { stdout } = await execute(resolve('bin/fodh'), ['init', '--brain', 'opus', '--dry-run'], { cwd: root });
  expect(JSON.parse(stdout)).toMatchObject({ root, dryRun: true, committed: false });
  const help = await execute(resolve('bin/fodh'), ['init', '--help'], { cwd: root });
  expect(JSON.parse(help.stdout).help[0].usage).toContain('fodh init');
  expect(await readdir(root)).toEqual([]);
});

it('L1→L2 설치 질문 y: 실제 init·첫 커밋 후 요약과 exec 계획 출력 (pi 실행 없음)', async () => {
  const root = await fixture(), fake = join(roots.at(-1)!, 'fake-bin'); await mkdir(fake);
  await writeFile(join(fake, 'pi'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  const child = spawn(process.execPath, [resolve('bin/fodh-start.mjs'), '--print', '--implicit', '--interactive'], {
    cwd: root, env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.end('y\n');
  expect(await new Promise(resolve => child.once('close', resolve))).toBe(0);
  expect(stderr).toContain('[y/N]'); expect(stderr).toContain('하네스 설치: 생성'); expect(stderr).toContain('/project-start');
  expect(stdout).toContain(`cd '${root}' && exec env`); expect(stdout).toContain(`'${fake}/pi'`);
  expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
});
it('L2 설정의 판단 경로·스킬 경로·복수 문서 targets 보존, 기본 생성 명령은 갱신 가능', async () => {
  const root = await fixture(); await mkdir(join(root, '.pi'));
  const configText = JSON.stringify({ judgment: { file: 'notes/판단.md', archive: 'notes/archive' },
    skills: { target: '.claude/custom-skills' }, claudeMd: { targets: ['CLAUDE.md', 'AGENTS.md'] } });
  await writeFile(join(root, '.pi/harness.json'), configText);
  await writeFile(join(root, 'AGENTS.md'), 'preserve agents\n');
  const result = await initProject({ cwd: root });
  expect(result.committed).toBe(true); expect(result.existed).toContain('AGENTS.md');
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('preserve agents\n');
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(configText);
  expect(await readFile(join(root, 'notes/판단.md'), 'utf8')).toContain('열린 판단 없음');
  await expect(readdir(join(root, 'notes/archive'))).rejects.toThrow();
  const config = await loadConfig(root), name = config.skills.install[0];
  expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toContain(`.claude/custom-skills/${name}/`);
  await writeFile(join(root, config.skills.target, name, 'SKILL.md'), 'edited\n');
  expect((await installSkills(root)).updated).toContain(name);
  await generateClaudeMd(root); expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('fodh:managed:begin');
  expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).not.toContain('- fodh init\n');
});
