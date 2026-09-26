import { expect, it, vi } from 'vitest';
import { mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { launcherPath } from './launcher-helpers.ts';
import { project } from './p5-helpers.ts';
import { startPlan, startRoot, implicitStart } from '../src/cli/start.ts';
import { setConfig } from '../src/core/config.ts';
const execute = promisify(execFile);
it('R5회차 Node만 있는 PATH에서도 직접·상대 심링크·FODH_NODE로 CLI를 호출한다', async () => {
  const root = await project(), links = join(root, 'links'); await mkdir(links);
  const entry = join(links, 'fodh'); await symlink(resolve('bin/fodh'), entry);
  const relative = join(links, 'relative'); await symlink('fodh', relative);
  for (const [file, path, node] of [
    [resolve('bin/fodh'), dirname(process.execPath), ''],
    [relative, dirname(process.execPath), ''],
    [relative, links, process.execPath],
  ]) {
    const { stdout, stderr } = await execute(file, ['state', 'get'], {
      cwd: root, env: { ...process.env, PATH: path, FODH_NODE: node, FODH_BRAIN: '1', FODH_CODEX_CHILD: '' },
    });
    expect(stderr).toBe(''); expect(JSON.parse(stdout).state).toBe('INTERVIEW');
  }
});
async function fixture() {
  const root = await project(), safe = await launcherPath(root), fake = safe.bin;
  await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  await mkdir(join(root, 'fake-home')); vi.stubEnv('HOME', join(root, 'fake-home')); vi.stubEnv('PATH', safe.path);
  await writeFile(join(fake, 'pi'), `#!/bin/sh\nprintf '{"pid":%s,"parent":%s}\\n' "$$" "$PPID"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: safe.path, FODH_BRAIN: '', FODH_CODEX_CHILD: '', FODH_PROJECT_ROOT: '',
    CLAUDECODE: 'FAKE_VALUE', CLAUDE_CODE_ENTRYPOINT: 'FAKE_VALUE', ANTHROPIC_API_KEY: 'FAKE_VALUE' };
  return { root, fake, env };
}
it('L1 하위 폴더 루트 탐색·모델 별칭·JSON 환경 변경만 출력', async () => {
  const { root, env } = await fixture(), sub = join(root, 'a/b'); await mkdir(sub, { recursive: true });
  expect(await startRoot(sub)).toBe(root);
  const plan = await startPlan({ cwd: sub, model: 'opus', env, dryRun: true });
  expect(plan).toMatchObject({ cwd: root, argv: ['pi', '-e', expect.stringContaining('/extensions/provider/index.ts'), '-e', expect.stringContaining('/extensions/orchestrator/index.ts'), '-e', expect.stringContaining('/extensions/watcher/index.ts'), '--model', 'claude-code/claude-opus-5-5'],
    env: { unset: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY'], set: { PI_SKIP_VERSION_CHECK: '1', FODH_PACKAGE_ROOT: resolve('.') } } });
  const { stdout } = await execute(resolve('bin/fodh'), ['start', '--dry-run'], { cwd: sub, env: { ...env, FODH_BRAIN: '1' } });
  expect(JSON.parse(stdout).cwd).toBe(root); expect(stdout).not.toContain('FAKE_VALUE');
});
it('L1 설정 모델·allowlist 밖 거부·없는 프로젝트/실행파일 안내', async () => {
  const { root, env } = await fixture();
  await setConfig(root, 'brain.model', 'opus');
  expect((await startPlan({ cwd: root, env })).argv.at(-1)).toBe('claude-code/claude-opus-5-5');
  await expect(startPlan({ cwd: root, env, model: 'haiku' })).rejects.toThrow('brain.allowedModels');
  await expect(startRoot('/private/tmp')).rejects.toThrow('하네스 프로젝트 루트가 아닙니다');
  await expect(startPlan({ cwd: root, env: { ...env, PATH: root } })).rejects.toThrow('README의 pi 설치 안내');
});
it('L1 두뇌 실제 시작 거부·살아 있는 잠금 거부·죽은 잠금 보존', async () => {
  const { root, env } = await fixture();
  await expect(startPlan({ cwd: root, env: { ...env, FODH_BRAIN: '1' } })).rejects.toThrow('--dry-run');
  await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: 901, startedAt: 'fixture', token: 'lock' }));
  const alive = vi.fn(async () => true);
  await expect(startPlan({ cwd: root, env, alive })).rejects.toThrow('이미 이 프로젝트의 하네스가 실행 중입니다(pid 901). 그 터미널 창을 쓰세요');
  expect(alive).toHaveBeenCalledOnce();
  expect((await startPlan({ cwd: root, env: { ...env, FODH_BRAIN: '1' }, dryRun: true, alive })).cwd).toBe(root);
  expect(alive).toHaveBeenCalledOnce();
  expect((await startPlan({ cwd: root, env, alive: async () => false })).cwd).toBe(root);
});
it('L1 셸 exec는 동일 PID로 가짜 pi에 교체·env 제거·루트 cwd·심링크 설치', async () => {
  const { root, fake, env } = await fixture();
  await writeFile(join(fake, 'pi'), `#!/bin/sh\n[ -z "\${CLAUDECODE+x}" ] && [ -z "\${CLAUDE_CODE_ENTRYPOINT+x}" ] && [ -z "\${ANTHROPIC_API_KEY+x}" ] || exit 80\n[ "$PI_SKIP_VERSION_CHECK" = 1 ] && [ -n "$FODH_PACKAGE_ROOT" ] || exit 81\nprintf '%s\\n' "$$" "$PWD" "$@"\n`, { mode: 0o755 });
  const link = join(fake, "fodh 'launcher'"); await symlink(resolve('bin/fodh'), link);
  const sub = join(root, "sub 'quote'"); await mkdir(sub);
  const intermediate = join(fake, 'relative-link'); await symlink("fodh 'launcher'", intermediate);
  const child = spawn(intermediate, [], { cwd: sub, env: { ...env, FODH_NODE: process.execPath } });
  let output = ''; child.stdout.on('data', v => output += v);
  const code = await new Promise(resolve => child.once('close', resolve));
  expect(code).toBe(0); const lines = output.trim().split('\n');
  expect(Number(lines[0])).toBe(child.pid); expect(lines[1]).toBe(root); expect(lines.at(-1)).toBe('claude-code/claude-fable-5-1');
});

it('L1 Git 경계·HOME 경계·HOME 전역 .pi 무시·가장 가까운 프로젝트', async () => {
  const { root, env } = await fixture(), home = join(root, 'home'), nested = join(home, 'project/sub');
  await mkdir(nested, { recursive: true }); await mkdir(join(home, '.pi')); await writeFile(join(home, '.pi/harness.json'), '{}');
  await expect(startRoot(home, home)).rejects.toThrow('하네스 프로젝트 루트가 아닙니다');
  await expect(startRoot(nested, home)).rejects.toThrow('하네스 프로젝트 루트가 아닙니다');
  const repository = join(home, 'project'); await mkdir(join(repository, '.git'));
  await expect(startRoot(nested, root + '/absent-home')).rejects.toThrow('하네스 프로젝트 루트가 아닙니다');
  await mkdir(join(repository, '.pi')); await writeFile(join(repository, '.pi/harness.json'), '{}');
  expect(await startRoot(nested, home)).toBe(repository);
  const linked = join(repository, 'linked'); await mkdir(linked); await writeFile(join(linked, '.git'), 'gitdir: /unused');
  await expect(startRoot(linked, process.env.HOME)).rejects.toThrow('워크트리 정보를 확인할 수 없습니다');
});
it('L1 비TTY 루트 없음은 도움말+init 안내 exit 0, 명시 start는 오류, 도움말 별칭', async () => {
  const { root, env } = await fixture(), empty = join(root, 'isolated'); await mkdir(empty); await mkdir(join(empty, '.git'));
  const wrapper = resolve('bin/fodh');
  const answer = await execute(wrapper, [], { cwd: empty, env });
  expect(JSON.parse(answer.stdout).next).toContain('fodh init'); expect(JSON.parse(answer.stdout).help.length).toBeGreaterThan(1);
  await expect(execute(wrapper, ['start'], { cwd: empty, env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('fodh init') });
  for (const args of [['help'], ['--help'], ['-h'], ['start', '--help']]) {
    expect(JSON.parse((await execute(wrapper, args, { cwd: empty, env })).stdout).help.length).toBeGreaterThan(0);
  }
});
it('L1 두뇌의 인자 없음은 pi·질문 없이 도움말, 일반 명령과 FODH_NODE 전달', async () => {
  const { root, fake, env } = await fixture();
  await writeFile(join(fake, 'pi'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  const brain = await execute(resolve('bin/fodh'), [], { cwd: root, env: { ...env, FODH_BRAIN: '1' } });
  expect(JSON.parse(brain.stdout).help.length).toBeGreaterThan(1);
  const forwarded = await execute(resolve('bin/fodh'), ['state', 'get'], { cwd: root, env: { ...env, FODH_NODE: process.execPath } });
  expect(JSON.parse(forwarded.stdout).state).toBe('INTERVIEW');
  await expect(execute(resolve('bin/fodh'), ['help'], { cwd: root, env: { ...env, FODH_NODE: '/missing-node' } })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('FODH_NODE') });
});
it('L1 내부 --print는 cwd·argv·env만 셸 인용, 비밀값 제외', async () => {
  const { root, env } = await fixture();
  const { stdout } = await execute(process.execPath, [resolve('bin/fodh-start.mjs'), '--print', '--model', 'opus'], { cwd: root, env });
  expect(stdout).toContain(`cd '${root}' && exec env`); expect(stdout).toContain("'-u' 'ANTHROPIC_API_KEY'");
  expect(stdout).toContain("'PI_SKIP_VERSION_CHECK=1'"); expect(stdout).toContain('FODH_PACKAGE_ROOT=');
  expect(stdout).toContain('claude-code/claude-opus-5-5'); expect(stdout).not.toContain('FAKE_VALUE');
});
it('L1 TTY 설치 수락·거절·비TTY 분기와 설치 후 요약/실행 계획', async () => {
  const { root, env } = await fixture(), empty = join(root, 'new'); await mkdir(empty); await mkdir(join(empty, '.git'));
  const ask = vi.fn(async () => 'N'), report = vi.fn();
  const initialize = vi.fn(async () => {
    await mkdir(join(empty, '.pi')); await writeFile(join(empty, '.pi/harness.json'), '{}');
    await mkdir(join(empty, '.claude')); await writeFile(join(empty, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
    return { root: empty, dryRun: false, created: ['.pi/harness.json'], existed: [], skipped: [], settingsNeedsHook: false,
      gitInitialized: true, committed: true, nextSteps: ['/project-start 를 실행하세요'] };
  });
  expect(await implicitStart({ cwd: empty, env, ask, report, initialize })).toBeUndefined(); expect(ask).not.toHaveBeenCalled();
  expect(await implicitStart({ cwd: empty, env, interactive: true, ask, report, initialize })).toBeUndefined();
  expect(ask).toHaveBeenCalledWith(`이 폴더(${empty})는 하네스 프로젝트가 아닙니다. 여기에 하네스를 설치하고 열까요? [y/N] `);
  expect(initialize).not.toHaveBeenCalled(); ask.mockResolvedValue('y');
  expect((await implicitStart({ cwd: empty, env, interactive: true, ask, report, initialize }))?.cwd).toBe(empty);
  expect(initialize).toHaveBeenCalledOnce(); expect(report.mock.calls[0][0]).toContain('/project-start');
  expect(await readFile(join(empty, '.pi/harness.json'), 'utf8')).toBe('{}');
});
