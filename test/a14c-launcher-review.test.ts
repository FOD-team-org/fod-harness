import { afterEach, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launcherPath } from './launcher-helpers.ts';
import { initProject } from '../src/cli/init.ts';
import { implicitStart, startPlan } from '../src/cli/start.ts';
import { doctorFiles } from '../src/core/doctor.ts';
const run = promisify(execFile), roots: string[] = [];
const wrapper = resolve('bin/fodh'), planner = resolve('bin/fodh-start.mjs');
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = await mkdtemp('/private/tmp/fodh-round4-'); roots.push(parent);
  const home = join(parent, 'home'), root = join(home, 'project'); await mkdir(root, { recursive: true });
  const safe = await launcherPath(parent);
  for (const key of Object.keys(process.env).filter(k => /^GIT_/u.test(k) || k === 'EMAIL')) vi.stubEnv(key, undefined);
  const config = join(parent, 'gitconfig'); await writeFile(config, '[user]\n name = Fixture\n email = fixture@example.invalid\n[commit]\n gpgsign = false\n');
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', safe.path); vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('FODH_BRAIN', ''); vi.stubEnv('FODH_CODEX_CHILD', ''); vi.stubEnv('FODH_PROJECT_ROOT', '');
  return { parent, home, root, bin: safe.bin };
}
async function git(root: string, ...args: string[]) {
  if (!roots.some(p => root.startsWith(p + '/'))) throw new Error('temporary repositories only');
  return (await run('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}
async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else if (entry.isFile()) result[path] = (await readFile(join(root, path))).toString('base64');
  }
  return result;
}
async function print(cwd: string, input: string) {
  const child = spawn(process.execPath, [planner, '--print', '--implicit', '--interactive'], { cwd });
  let stdout = '', stderr = '';
  child.stdout.on('data', v => stdout += v); child.stderr.on('data', v => stderr += v);
  child.stdin.end(input);
  const code = await new Promise<number | null>(r => child.once('close', r));
  return { stdout, stderr, code };
}
it.each([false, true])('R4-1 실제 HOME 및 dotfiles HOME 설치 무변경 거부 (git=%s)', async repository => {
  const { home } = await fixture(); if (repository) await git(home, 'init');
  const before = await snapshot(home);
  await expect(initProject({ cwd: home })).rejects.toThrow('프로젝트 폴더에서 실행하세요');
  expect(await snapshot(home)).toEqual(before);
});
it('R4-1 HOME 심링크 cwd 및 HOME Git 최상위 하위 폴더도 무변경 거부', async () => {
  const { parent, home, root } = await fixture(); await git(home, 'init');
  const alias = join(parent, 'home-alias'); await symlink(home, alias); const before = await snapshot(home);
  for (const cwd of [alias, root]) for (const dryRun of [false, true]) await expect(initProject({ cwd, dryRun })).rejects.toThrow('프로젝트 폴더에서 실행하세요');
  vi.stubEnv('HOME', alias);
  await expect(initProject({ cwd: home })).rejects.toThrow('프로젝트 폴더에서 실행하세요');
  expect(await snapshot(home)).toEqual(before);
});
it('R4-1 / 직접 init은 Git보다 먼저 거부 (시험용 git은 쓰기 없이 실패)', async () => {
  const { bin } = await fixture(); await unlink(join(bin, 'git'));
  await writeFile(join(bin, 'git'), '#!/bin/sh\nexit 93\n', { mode: 0o755 });
  await expect(initProject({ cwd: '/' })).rejects.toThrow('프로젝트 폴더에서 실행하세요');
});
it.each(['home', 'slash'])('R4-1 인자 없는 %s 시작은 질문/설치 없이 도움말', async location => {
  const { home } = await fixture(), cwd = location === 'home' ? home : '/';
  const ask = vi.fn(async () => 'N'), report = vi.fn(), initialize = vi.fn();
  expect(await implicitStart({ cwd, interactive: true, ask, report, initialize })).toBeUndefined();
  expect(ask).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
  expect(report.mock.calls.flat().join(' ')).toContain('프로젝트 폴더에서 실행하세요');
  const result = await run(wrapper, [], { cwd });
  expect(JSON.parse(result.stdout).help.length).toBeGreaterThan(0); expect(result.stderr).toContain('프로젝트 폴더에서 실행하세요');
});
it('R4-2 init y + 기존 훅 없음: JSON 조각 안내·exit 1·pi 실행 금지·설정 보존', async () => {
  const { root } = await fixture(); await git(root, 'init'); await writeFile(join(root, 'code.ts'), 'FAKE_VALUE');
  await git(root, 'add', 'code.ts'); await git(root, 'commit', '-m', 'fixture');
  await mkdir(join(root, '.claude')); const settings = '{"permissions":{"allow":[]}}\n'; await writeFile(join(root, '.claude/settings.json'), settings);
  const result = await print(root, 'y\n');
  expect(result.code).toBe(1); expect(result.stdout).not.toContain('exec env'); expect(result.stdout).not.toContain('FAKE_PI');
  expect(result.stderr).toContain('PreToolUse'); expect(result.stderr).toContain('pretooluse.sh');
  expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
});
it.each(['missing', 'empty', 'malformed', 'wrong-event', 'disabled'])('R4-2 %s 훅은 start/인자 없음 거부 및 dry-run JSON 사유', async variant => {
  const { root } = await fixture(); await mkdir(join(root, '.pi')); await writeFile(join(root, '.pi/harness.json'), '{}');
  await mkdir(join(root, '.claude'));
  const template = JSON.parse(await readFile('templates/claude-settings.json', 'utf8'));
  const text = variant === 'empty' ? '{}' : variant === 'malformed' ? '{' : variant === 'disabled' ? JSON.stringify({ ...template, disableAllHooks: true })
    : JSON.stringify({ hooks: { PostToolUse: template.hooks.PreToolUse } });
  if (variant !== 'missing') await writeFile(join(root, '.claude/settings.json'), text);
  await expect(startPlan({ cwd: root })).rejects.toThrow('PreToolUse');
  for (const args of [[], ['start']]) await expect(run(wrapper, args, { cwd: root })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('PreToolUse') });
  const dry = await run(wrapper, ['start', '--dry-run'], { cwd: root });
  const plan = JSON.parse(dry.stdout); expect(plan).toMatchObject({ allowed: false, settingsNeedsHook: true }); expect(plan.reason).toContain('PreToolUse');
  expect(plan.hookPatch).toEqual(template);
  expect(await doctorFiles(root, async () => [])).toMatchObject({ settingsNeedsHook: true });
});
it('R4-3 질문 EOF(Ctrl-D)는 N과 같이 도움말 exit 0 및 무변경', async () => {
  const { root } = await fixture(), before = await snapshot(root);
  const result = await print(root, ''); expect(result.code).toBe(0);
  expect(result.stdout).toContain('printf'); expect(result.stdout).toContain('fodh init'); expect(result.stderr).not.toContain('Aborted');
  expect(await snapshot(root)).toEqual(before);
});
it('R4-4 설치 질문은 cwd 대신 실제 git 최상위를 표시한다', async () => {
  const { root } = await fixture(); await git(root, 'init'); const cwd = join(root, 'src/app'); await mkdir(cwd, { recursive: true });
  const ask = vi.fn(async () => 'N');
  await implicitStart({ cwd, interactive: true, ask, report: vi.fn() });
  expect(ask).toHaveBeenCalledWith(`이 폴더(${root})는 하네스 프로젝트가 아닙니다. 여기에 하네스를 설치하고 열까요? [y/N] `);
});
it('R4-5 연결 워크트리 start/인자 없음/init은 본 저장소 안내 후 거부·무변경', async () => {
  const { root, home } = await fixture(); await initProject({ cwd: root });
  const linked = join(home, 'linked'); await git(root, 'worktree', 'add', '-b', 'fixture-linked', linked);
  await mkdir(join(linked, 'src')); await mkdir(join(linked, '.claude'));
  await writeFile(join(linked, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  const before = await snapshot(linked);
  for (const cwd of [linked, join(linked, 'src')]) {
    await expect(startPlan({ cwd })).rejects.toThrow(`하네스 워크트리입니다 — 본 저장소 ${root} 에서 실행하세요`);
    await expect(initProject({ cwd })).rejects.toThrow('하네스 워크트리입니다');
    for (const args of [[], ['start'], ['init']]) await expect(run(wrapper, args, { cwd })).rejects.toMatchObject({ code: 1 });
  }
  expect(await snapshot(linked)).toEqual(before);
});
it('R4-6 .DS_Store만 있는 새 폴더는 /project-start 안내', async () => {
  const { root } = await fixture(); await writeFile(join(root, '.DS_Store'), 'FAKE_VALUE');
  expect((await initProject({ cwd: root })).nextSteps[0]).toContain('/project-start');
});

it('R4-2 훅 안내의 원본 JSON을 합친 뒤에만 가짜 pi exec 허용·doctor 판정 공유', async () => {
  const { root } = await fixture(); await mkdir(join(root, '.pi')); await writeFile(join(root, '.pi/harness.json'), '{}');
  let stderr = '';
  try { await run(wrapper, ['start'], { cwd: root }); } catch (error) { stderr = (error as { stderr: string }).stderr; }
  const patch = JSON.parse(stderr.slice(stderr.indexOf('{')));
  expect(patch).toEqual(JSON.parse(await readFile('templates/claude-settings.json', 'utf8')));
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: [] }, ...patch }));
  expect(await doctorFiles(root, async () => [])).toMatchObject({ settingsNeedsHook: false });
  expect((await run(wrapper, [], { cwd: root })).stdout).toBe('FAKE_PI\n');
  expect((await run(wrapper, ['start'], { cwd: root })).stdout).toBe('FAKE_PI\n');
});
it('R4-1 Git 대상 루트가 /인 경우도 쓰기 전 거부 (가짜 Git)', async () => {
  const { root, bin } = await fixture(); await unlink(join(bin, 'git'));
  await writeFile(join(bin, 'git'), '#!/bin/sh\nprintf "/\n"\n', { mode: 0o755 });
  await expect(initProject({ cwd: root, dryRun: true })).rejects.toThrow('프로젝트 폴더에서 실행하세요');
  expect(await snapshot(root)).toEqual({});
});
