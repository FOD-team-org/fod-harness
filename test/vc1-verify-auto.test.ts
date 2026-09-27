import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, chmod, symlink, readdir, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { gitProject, git } from './p7-git-helpers.ts';
import { invoke } from './hook-helpers.ts';
import { runVerify, detectVerifyConfig, noDetectedVerify, autoVerifyDirtyError } from '../src/core/verify.ts';
import { autoVerifyMarker, loadConfig, setConfig, verifyHash, writeAutoVerify } from '../src/core/config.ts';
import { DetectGitError, DetectUnreadableError, detectVerify } from '../src/core/verify-detect.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addTask } from '../src/core/backlog.ts';
import { initProject } from '../src/cli/init.ts';
import { addWorkspaceMember, initWorkspace } from '../src/core/workspace.ts';
import * as claudeMd from '../src/core/claude-md.ts';
import * as brainGuard from '../src/core/brain-guard.ts';
import * as tree from '../src/core/proc-tree.ts';
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function stub(root: string, name: string, body: string) {
  const bin = join(root, '.stubs'); await mkdir(bin, { recursive: true });
  const file = join(bin, name); await writeFile(file, `#!/bin/sh\n${body}\n`); await chmod(file, 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`); return file;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('shell cd executes marker instead of false success; quoted arguments', async () => {
  const root = await project('VERIFY'); await mkdir(join(root, 'sub'));
  await setConfig(root, 'verify.commands', JSON.stringify([`cd sub && ${quote(process.execPath)} -e "require('fs').writeFileSync('marker','a b')"`]));
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ exit: 0, residual: false }] });
  expect(await readFile(join(root, 'sub/marker'), 'utf8')).toBe('a b');
});
it.each([['false && true', 1], ['exit 3', 3], ['echo x | grep y', 1]] as const)('shell %s fails with %s', async (cmd, exit) => {
  const root = await project('VERIFY'); await setConfig(root, 'verify.commands', JSON.stringify([cmd]));
  expect(await runVerify(root)).toMatchObject({ ok: false, commands: [{ exit }] });
});
it('shell timeout reclaims group including sleep child (stubbed process inspection)', async () => {
  const root = await project('VERIFY');
  await setConfig(root, 'verify.commands', '["sleep 30 & echo $! > sleeper; wait"]');
  await setConfig(root, 'verify.timeoutMinutes', '0.005');
  // ps is sandbox-blocked: exercise the verifier reclamation contract with an owned group stub.
  vi.spyOn(tree, 'reclaimCodexTree').mockImplementation(async pgid => {
    // Synchronize child startup even if the host delays scheduling past the timeout.
    await vi.waitFor(async () => expect(Number(await readFile(join(root, 'sleeper'), 'utf8'))).toBeGreaterThan(1), { timeout: 5000 });
    process.kill(-pgid, 'SIGKILL'); return true;
  });
  expect(await runVerify(root)).toMatchObject({ ok: false, commands: [{ timedOut: true, residual: false }] });
  const pid = Number(await readFile(join(root, 'sleeper'), 'utf8'));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
});
it.each([false, true])('empty config auto-fills Flutter in task worktree and executes; brain=%s', async brain => {
  const root = await project('VERIFY'), task = await addTask(root, { title: 'task', category: 'docs' });
  const worktree = join(root, "task 'space"); await mkdir(join(worktree, 'test'), { recursive: true });
  await writeFile(join(worktree, 'pubspec.yaml'), 'sdk: flutter'); await writeFile(join(worktree, 'test/a_test.dart'), '');
  await linkFixture(root, worktree); await commitFixture(worktree);
  await updateState(root, { taskId: task.id, worktrees: [{ taskId: task.id, path: worktree, createdAt: new Date().toISOString(), branch: 'fixture' }] });
  await stub(root, 'flutter', 'echo "$*" >> invoked');
  if (brain) vi.stubEnv('FODH_BRAIN', '1');
  expect((await runVerify(root)).ok).toBe(true);
  expect(await readFile(join(worktree, 'invoked'), 'utf8')).toBe('pub get\nanalyze\ntest\n');
  const config = await loadConfig(root);
  expect(config.verify.auto).toMatchObject({ stacks: ['flutter:'], hash: verifyHash(config.verify) });
  expect((await readLedger(root)).find(e => e.action === 'verify:auto-config')).toMatchObject({ status: 'ok', evidence: { base: worktree, commands: config.verify.commands, heavy: [] } });
  expect((await readLedger(root)).some(e => e.action === 'notify:verify:auto-config' && JSON.stringify(e).includes('검증 명령 자동 설정'))).toBe(true);
  if (brain) {
    vi.spyOn(brainGuard, 'assertHarnessAlive').mockResolvedValue();
    expect(await cli(root, ['config', 'set', 'verify.commands', '["true"]', '--approve'])).toMatchObject({ code: 1, value: { error: expect.stringContaining('두뇌 세션') } });
    expect((await loadConfig(root)).verify.commands).toEqual(config.verify.commands);
  }
});
it('empty heavy preserves successful state, no verify ledger/result or slot', async () => {
  const root = await project('VERIFY'); await setConfig(root, 'verify.commands', '["true"]');
  expect((await runVerify(root)).ok).toBe(true);
  const before = await readState(root), ledger = await readLedger(root), files = await readdir(join(root, '.pi/verify'));
  expect(await runVerify(root, { heavy: true })).toEqual({ ok: false, skipped: 'heavy-empty', error: 'verify.heavy 가 비어 있어 heavy 검증을 건너뜁니다(상태 변경 없음)' });
  expect(await readState(root)).toEqual(before); expect(await readLedger(root)).toEqual(ledger);
  expect(await readdir(join(root, '.pi/verify'))).toEqual(files);
});
it('no detection records failure; user commands never trigger detection', async () => {
  const root = await project('VERIFY'); expect(await runVerify(root)).toMatchObject({ ok: false, error: noDetectedVerify });
  await writeFile(join(root, 'go.mod'), ''); await setConfig(root, 'verify.commands', '["true"]');
  expect((await runVerify(root)).ok).toBe(true); expect((await loadConfig(root)).verify.auto).toBeUndefined();
});
it('automatic detection uses task root, not cwd; user heavy and timeout preserved; generation warning', async () => {
  const root = await project('VERIFY'); await mkdir(join(root, 'sub')); await writeFile(join(root, 'package.json'), '{"scripts":{"lint":"unused","build":"unused"}}');
  await stub(root, 'npm', 'echo stub > marker');
  await setConfig(root, 'verify.heavy', '["echo custom-heavy"]'); await setConfig(root, 'verify.timeoutMinutes', '7');
  vi.spyOn(claudeMd, 'generateClaudeMd').mockRejectedValue(new Error('fixture'));
  expect((await runVerify(root, { cwd: 'sub' })).ok).toBe(true);
  expect((await loadConfig(root)).verify).toMatchObject({ commands: ['npm run lint'], heavy: ['echo custom-heavy'], timeoutMinutes: 7 });
  expect((await readLedger(root)).filter(e => e.action === 'verify:auto-config').map(e => e.status)).toEqual(['ok', 'warn']);
  expect(await readFile(join(root, 'sub/marker'), 'utf8')).toContain('stub');
});
it('detect preview is read-only in any state; CLI rejects arbitrary command and invalid cwd', async () => {
  const root = await project('IDLE'); await writeFile(join(root, 'go.mod'), '');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['verify', 'detect'])).toMatchObject({ code: 0, value: { userSet: false, detected: { commands: ['go vet ./...', 'go test ./...'] } } });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  vi.spyOn(brainGuard, 'assertHarnessAlive').mockResolvedValue();
  expect(await cli(root, ['verify', 'detect', 'true', '--apply'])).toMatchObject({ code: 1 });
  await expect(detectVerifyConfig(root, { cwd: '/' })).rejects.toThrow('--cwd');
  vi.stubEnv('FODH_BRAIN', '');
  const outside = await project(); await symlink(outside, join(root, 'escape'));
  await expect(detectVerifyConfig(root, { cwd: 'escape' })).rejects.toThrow('--cwd');
});
it('detect apply permits auto hash, rejects user modifications even brain --approve, user can approve', async () => {
  const root = await project('IDLE'); await writeFile(join(root, 'go.mod'), '');
  vi.stubEnv('FODH_BRAIN', '1');
  vi.spyOn(brainGuard, 'assertHarnessAlive').mockResolvedValue();
  expect(await cli(root, ['verify', 'detect', '--apply'])).toMatchObject({ code: 0 });
  expect(await cli(root, ['verify', 'detect', '--apply'])).toMatchObject({ code: 0 });
  vi.stubEnv('FODH_BRAIN', ''); await setConfig(root, 'verify.commands', '["echo custom"]');
  expect(await detectVerifyConfig(root)).toMatchObject({ userSet: true });
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow('사용자가 설정한');
  vi.stubEnv('FODH_BRAIN', '1'); await expect(detectVerifyConfig(root, { apply: true, approve: true })).rejects.toThrow('사용자가 설정한');
  vi.stubEnv('FODH_BRAIN', ''); await detectVerifyConfig(root, { apply: true, approve: true });
  expect((await loadConfig(root)).verify.commands).toEqual(['go vet ./...', 'go test ./...']);
  expect((await readLedger(root)).filter(e => e.action === 'verify:auto-config' && e.status === 'ok').every(e => (e.evidence as { via?: string })?.via === 'detect')).toBe(true);
});
it('no detection cannot apply; malformed auto rejected and valid auto causes no unknown-key warning', async () => {
  const root = await project(); await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow('자동 감지된 스택이 없습니다');
  for (const auto of [null, [], 'x', {}, { at: 'bad', stacks: [], hash: 'x' }]) await expect(setConfig(root, 'verify.auto', JSON.stringify(auto))).rejects.toThrow();
  await writeFile(join(root, 'go.mod'), ''); await detectVerifyConfig(root, { apply: true });
  expect(JSON.stringify(await readLedger(root))).not.toContain('config:unknown-key');
});
it('writer rejects fabricated results and protects concurrent user edits inside lock', async () => {
  const root = await project(); await writeFile(join(root, 'go.mod'), ''); const detected = (await detectVerify(root))!;
  await expect(writeAutoVerify(root, 'verify', { ...detected, commands: ['true'] })).rejects.toThrow('detectVerify');
  expect(() => detected.commands.push('true')).toThrow();
  await setConfig(root, 'verify.commands', '["echo user"]');
  await expect(writeAutoVerify(root, 'verify', detected)).rejects.toThrow('사용자가 설정한');
});
it.each(['IDLE', 'VERIFY', 'FIX', 'paused(quota)'])('hook allows brain verify detect --apply in %s', async state => {
  expect((await invoke('Bash', { command: 'fodh verify detect --apply' }, state, { env: { FODH_BRAIN: '1' } })).code).toBe(0);
});
async function workspace(marked = true) {
  const root = await project('VERIFY'), member = await project('IDLE');
  await fixtureGit(member, ['init', '-b', 'main']);
  await writeFile(join(member, '.gitignore'), '.pi/\ntask/\ninvoked\n'); await commitFixture(member);
  const verify = { commands: ['git diff --check'], heavy: [] };
  const raw = { notify: { channels: ['ledger'] }, workspace: { repos: { app: { path: `../${member.split('/').at(-1)}`, worktrees: { prefix: 'wt-app-' }, verify: { ...verify, ...(marked ? { auto: autoVerifyMarker(verify, []) } : {}) } } } } };
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify(raw));
  const task = await addTask(root, { title: 'workspace task', category: 'docs', repo: 'app' });
  const wt = join(member, 'task'); await fixtureGit(member, ['worktree', 'add', '-b', 'fixture', wt]); await writeFile(join(wt, 'pubspec.yaml'), 'sdk: flutter'); await writeFile(join(wt, '.gitignore'), 'invoked\n'); await commitFixture(wt);
  await updateState(root, { taskId: task.id, worktrees: [{ taskId: task.id, path: wt, createdAt: new Date().toISOString(), branch: 'fixture', repo: 'app' }] });
  await stub(root, 'flutter', 'echo "$*" >> invoked');
  return { root, member, wt };
}
it.each([false, true])('workspace placeholder replacement only with marker=%s', async marked => {
  const { root, wt } = await workspace(marked); expect((await runVerify(root)).ok).toBe(true);
  const verify = (await loadConfig(root)).workspace!.repos.app.verify;
  expect(verify.commands).toEqual(marked ? ['flutter pub get', 'flutter analyze'] : ['git diff --check']);
  if (marked) expect(await readFile(join(wt, 'invoked'), 'utf8')).toBe('pub get\nanalyze\n');
});
it('workspace detect selects task/member, accepts --repo without task, rejects foreign cwd', async () => {
  const { root, member, wt } = await workspace();
  expect(await detectVerifyConfig(root)).toMatchObject({ base: wt });
  await updateState(root, { taskId: undefined });
  await writeFile(join(member, 'pubspec.yaml'), 'sdk: flutter'); await commitFixture(member);
  expect(await cli(root, ['verify', 'detect', '--repo', 'app', '--apply'])).toMatchObject({ code: 0, value: { base: member } });
  expect((await loadConfig(root)).workspace!.repos.app.verify.auto?.stacks).toEqual(['flutter:']);
  await expect(detectVerifyConfig(root, { repo: 'app', cwd: root })).rejects.toThrow('--cwd');
});
// A fake git executable permits init/add tests without real commits, branches or repositories.
async function initGitStub(root: string) {
  await mkdir(join(root, '.git/info'), { recursive: true });
  await stub(root, 'git', `case "$*" in\n*--show-toplevel*) pwd;;\n*--git-common-dir*) echo .git;;\n*--git-dir*) echo .git;;\n*--git-path*) echo .git/info/exclude;;\n*rev-list*) echo existing-history;;\n*--abbrev-ref*) echo main;;\n*' commit '*|commit*|*' add '*|add*|*' init '*|init*) exit 99;;\nesac`);
}
it.each([false, true])('init existing code new config dryRun=%s detects without executing commands', async dryRun => {
  const root = await project('IDLE'); const { rm } = await import('node:fs/promises'); await rm(join(root, '.pi'), { recursive: true });
  await writeFile(join(root, 'go.mod'), ''); await initGitStub(root);
  const result = await initProject({ cwd: root, dryRun });
  expect(result.verifyDetected?.commands).toEqual(['go vet ./...', 'go test ./...']);
  if (dryRun) await expect(readFile(join(root, '.pi/harness.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  else expect((await loadConfig(root)).verify.auto?.hash).toBe(verifyHash((await loadConfig(root)).verify));
});
it('init preserves preexisting config; workspace add detects or marks placeholder', async () => {
  const root = await project('IDLE'); await initGitStub(root); await writeFile(join(root, 'go.mod'), '');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect((await initProject({ cwd: root })).verifyDetected).toBeNull(); expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  const ws = await workspace();
  for (const name of ['node', 'plain']) {
    const member = await project('IDLE'); await mkdir(join(member, '.git'));
    if (name === 'node') await writeFile(join(member, 'package.json'), '{"scripts":{"test":"fixture"}}');
    await addWorkspaceMember(ws.root, name, `../${member.split('/').at(-1)}`, { approve: true });
    const verify = (await loadConfig(ws.root)).workspace!.repos[name].verify;
    expect(verify.commands).toEqual(name === 'node' ? ['npm test'] : ['git diff --check']);
    expect(verify.auto?.hash).toBe(verifyHash(verify));
  }
});
it.each([false, true])('workspace init uses same presets dryRun=%s (fake git)', async dryRun => {
  const root = await project('IDLE'), member = await project('IDLE');
  const { rm } = await import('node:fs/promises'); await rm(join(root, '.pi'), { recursive: true });
  await initGitStub(root); await mkdir(join(member, '.git')); await writeFile(join(member, 'go.mod'), '');
  const result = await initWorkspace({ cwd: root, repos: [`app=../${member.split('/').at(-1)}`], dryRun });
  expect(result.created).toContain('.pi/harness.json');
  if (dryRun) await expect(readFile(join(root, '.pi/harness.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  else {
    const verify = (await loadConfig(root)).workspace!.repos.app.verify;
    expect(verify.commands).toEqual(['go vet ./...', 'go test ./...']);
    expect(verify.auto?.hash).toBe(verifyHash(verify));
  }
});
it('detected subdirectory shell prefix executes safely with spaces and apostrophe', async () => {
  const root = await project('VERIFY'), dir = join(root, "app 'one"); await mkdir(dir);
  await writeFile(join(dir, 'pubspec.yaml'), 'sdk: flutter'); await stub(root, 'flutter', 'echo "$*" >> invoked');
  expect((await runVerify(root)).ok).toBe(true);
  expect(await readFile(join(dir, 'invoked'), 'utf8')).toBe('pub get\nanalyze\n');
  expect((await loadConfig(root)).verify.auto?.stacks).toEqual(["flutter:app 'one"]);
});
it('editing heavy invalidates auto hash; timeout alone does not', async () => {
  const root = await project(); await writeFile(join(root, 'go.mod'), '');
  await detectVerifyConfig(root, { apply: true }); await setConfig(root, 'verify.timeoutMinutes', '9');
  expect(await detectVerifyConfig(root)).toMatchObject({ userSet: false });
  await setConfig(root, 'verify.heavy', '["echo custom"]');
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow('사용자가 설정한');
});
it('detect --apply retains live-brain guard while preview works without a lock', async () => {
  const root = await project(); await writeFile(join(root, 'go.mod'), ''); vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['verify', 'detect'])).toMatchObject({ code: 0 });
  expect(await cli(root, ['verify', 'detect', '--apply'])).toMatchObject({ code: 2 });
  expect((await loadConfig(root)).verify.commands).toEqual([]);
});

it('G1 brain apply rejects child cwd even with approve, preview and same realpath remain allowed', async () => {
  const root = await project('IDLE');
  await writeFile(join(root, 'package.json'), '{"scripts":{"typecheck":"fixture","test":"fixture"}}');
  await mkdir(join(root, 'node_modules/leaf'), { recursive: true });
  await writeFile(join(root, 'node_modules/leaf/package.json'), '{"scripts":{"lint":"fixture"}}');
  await detectVerifyConfig(root, { apply: true });
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  vi.stubEnv('FODH_BRAIN', '1');
  for (const approve of [false, true]) {
    await expect(detectVerifyConfig(root, { cwd: 'node_modules/leaf', apply: true, approve }))
      .rejects.toThrow(`--apply 는 --cwd 없이 기준 경로(${root})에서만 감지합니다`);
    expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  }
  expect(await detectVerifyConfig(root, { cwd: 'node_modules/leaf' })).toMatchObject({ detected: { commands: ['npm run lint'] } });
  await symlink(root, join(root, 'alias'));
  expect(await detectVerifyConfig(root, { cwd: 'alias', apply: true })).toMatchObject({ base: root, applied: { commands: ['npm run typecheck', 'npm test'] } });
});
it('G1 apply uses task worktree before project/member roots', async () => {
  const { root, member, wt } = await workspace();
  await expect(detectVerifyConfig(root, { apply: true, cwd: member, approve: true })).rejects.toThrow(`기준 경로(${wt})`);
  expect(await detectVerifyConfig(root, { apply: true, cwd: wt })).toMatchObject({ base: wt, applied: { commands: ['flutter pub get', 'flutter analyze'] } });
});
it.each(['docs', 'notes/../custom'])('G1 detect and automatic fill exclude configured docs %s', async docsRoot => {
  const root = await project('VERIFY'); await setConfig(root, 'docs.root', JSON.stringify(docsRoot));
  const docs = (await loadConfig(root)).docs.root;
  await mkdir(join(root, docs, 'x'), { recursive: true }); await writeFile(join(root, docs, 'x/pubspec.yaml'), 'sdk: flutter');
  await mkdir(join(root, 'app')); await writeFile(join(root, 'app/go.mod'), '');
  await stub(root, 'go', 'exit 0');
  expect(await detectVerifyConfig(root)).toMatchObject({ detected: { stacks: [{ stack: 'go', dir: 'app', notes: [] }] } });
  expect((await runVerify(root)).ok).toBe(true);
  expect((await loadConfig(root)).verify.auto?.stacks).toEqual(['go:app']);
});
it('H3 single init excludes docs while workspace init/add include member docs', async () => {
  const root = await project('IDLE'); const { rm } = await import('node:fs/promises');
  await rm(join(root, '.pi'), { recursive: true }); await initGitStub(root);
  await mkdir(join(root, 'docs/x'), { recursive: true }); await writeFile(join(root, 'docs/x/pubspec.yaml'), 'sdk: flutter');
  await writeFile(join(root, 'source.txt'), 'fixture');
  expect((await initProject({ cwd: root, dryRun: true })).verifyDetected).toBeNull();
  const member = await project('IDLE'); await mkdir(join(member, '.git'));
  await mkdir(join(member, 'docs/x'), { recursive: true }); await writeFile(join(member, 'docs/x/pubspec.yaml'), 'sdk: flutter');
  await initWorkspace({ cwd: root, repos: [`app=../${member.split('/').at(-1)}`] });
  expect((await loadConfig(root)).workspace!.repos.app.verify.auto?.stacks).toEqual(['flutter:docs/x']);
  await setConfig(root, 'docs.root', 'notes');
  const added = await project('IDLE'); await mkdir(join(added, '.git'));
  await mkdir(join(added, 'notes/x'), { recursive: true }); await writeFile(join(added, 'notes/x/pubspec.yaml'), 'sdk: flutter');
  await addWorkspaceMember(root, 'added', `../${added.split('/').at(-1)}`, { approve: true });
  expect((await loadConfig(root)).workspace!.repos.added.verify.auto?.stacks).toEqual(['flutter:notes/x']);
});
it('G2 user heavy survives Python autofill and brain reapply; only user approve replaces it', async () => {
  const root = await project('VERIFY'); await writeFile(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]');
  await stub(root, 'python3', 'exit 0'); await setConfig(root, 'verify.heavy', '["echo user-heavy"]');
  expect((await runVerify(root)).ok).toBe(true);
  vi.stubEnv('FODH_BRAIN', '1'); await detectVerifyConfig(root, { apply: true });
  let verify = (await loadConfig(root)).verify;
  expect(verify.heavy).toEqual(['echo user-heavy']);
  expect(verify.auto).toMatchObject({ heavySource: 'user', hash: verifyHash(verify) });
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await expect(detectVerifyConfig(root, { apply: true, approve: true })).rejects.toThrow('사용자가 설정한');
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  vi.stubEnv('FODH_BRAIN', ''); await detectVerifyConfig(root, { apply: true, approve: true });
  verify = (await loadConfig(root)).verify;
  expect(verify.heavy).toEqual([]); expect(verify.auto?.heavySource).toBeUndefined();
  expect(verify.auto?.hash).toBe(verifyHash(verify));
});
it('G2 heavySource accepts only user', async () => {
  const root = await project(), auto = autoVerifyMarker({ commands: [], heavy: [] }, []);
  for (const heavySource of ['auto', '', null, true, 1]) {
    await expect(loadConfig(root, { verify: { auto: { ...auto, heavySource } } }, { dryRun: true })).rejects.toThrow('verify.auto');
  }
  expect((await loadConfig(root, { verify: { auto: { ...auto, heavySource: 'user' } } }, { dryRun: true })).verify.auto?.heavySource).toBe('user');
});
it('G3 undetected marked workspace placeholder fails without running diff or changing config', async () => {
  const { root, wt } = await workspace(); const { rm } = await import('node:fs/promises');
  await rm(join(wt, 'pubspec.yaml'));
  await commitFixture(wt);
  await stub(root, 'git', `case "$*" in *'diff --check'*) echo invoked > ${quote(join(wt, 'diff-ran'))};; *) exec /usr/bin/git "$@";; esac`);
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  const result = await runVerify(root);
  expect(result).toMatchObject({ ok: false, error: noDetectedVerify });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  expect((await readLedger(root)).filter(e => ['verify:run', 'verify:auto-config'].includes(e.action))).toEqual([]);
  await expect(readFile(join(wt, 'diff-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (!('runId' in result)) throw new Error('missing verification result');
  expect(await readdir(join(root, '.pi/verify', result.runId))).toEqual(['result.json']);
  expect((await readState(root)).verify?.ok).toBe(false);
});
it('G5 failed reclamation fallback kills shell and sleep grandchild, retaining residual', async () => {
  const root = await project('VERIFY');
  await setConfig(root, 'verify.commands', JSON.stringify(["/bin/sh -c 'sleep 30 & echo $! > sleeper; wait' & echo $! > inner; wait"]));
  await setConfig(root, 'verify.timeoutMinutes', '0.005');
  const pids: number[] = [];
  vi.spyOn(tree, 'reclaimCodexTree').mockImplementation(async pgid => {
    await vi.waitFor(async () => expect(Number(await readFile(join(root, 'sleeper'), 'utf8'))).toBeGreaterThan(1), { timeout: 5000 });
    pids.push(pgid, Number(await readFile(join(root, 'inner'), 'utf8')), Number(await readFile(join(root, 'sleeper'), 'utf8')));
    return false;
  });
  try {
    expect(await runVerify(root)).toMatchObject({ ok: false, commands: [{ timedOut: true, residual: true }] });
    expect(pids).toHaveLength(3);
    for (const pid of pids) await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
  }
});

// Real Git is confined to disposable fixtures; the working repository is never committed.
const fixtureGit = (root: string, args: string[]) => promisify(execFile)('/usr/bin/git', ['-C', root, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
});
async function commitFixture(root: string) {
  await fixtureGit(root, ['add', '.']);
  await fixtureGit(root, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
}
async function linkFixture(root: string, wt: string) {
  // Preserve files prepared by a test, then attach a real linked worktree.
  const saved = `${wt}.prepared`; await rename(wt, saved);
  await fixtureGit(root, ['init', '-b', 'main']);
  await writeFile(join(root, '.gitignore'), '.pi/\ndocs/\n.stubs/\ntask*/\n');
  await commitFixture(root);
  await fixtureGit(root, ['worktree', 'add', '-b', 'fixture', wt]);
  for (const name of await readdir(saved)) await rename(join(saved, name), join(wt, name));
  await rm(saved, { recursive: true });
}
async function gitTask() {
  const root = await project('VERIFY'), task = await addTask(root, { title: 'git detection', category: 'docs' });
  const wt = join(root, 'task'); await mkdir(wt);
  await linkFixture(root, wt);
  await writeFile(join(wt, '.gitignore'), 'ignored/\n');
  await writeFile(join(wt, 'package.json'), JSON.stringify({ scripts: { typecheck: 'fixture', lint: 'fixture', test: 'fixture' } }));
  await commitFixture(wt);
  await updateState(root, { taskId: task.id, worktrees: [{ taskId: task.id, path: wt, branch: 'fixture', createdAt: new Date().toISOString() }] });
  return { root, wt };
}
it('H1 brain cannot delete test via dirty or committed manifest; user approve and brain additions work', async () => {
  const { root, wt } = await gitTask();
  await detectVerifyConfig(root, { apply: true });
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await writeFile(join(wt, 'package.json'), JSON.stringify({ scripts: { typecheck: 'fixture', lint: 'fixture' } }));
  vi.stubEnv('FODH_BRAIN', '1');
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow(autoVerifyDirtyError);
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  await commitFixture(wt);
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow('현재 검증 명령을 줄입니다(빠짐: npm test)');
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  // User approval also bypasses the dirty check, but brain approval never does.
  await writeFile(join(wt, 'package.json'), JSON.stringify({ scripts: { typecheck: 'fixture' } }));
  await expect(detectVerifyConfig(root, { apply: true, approve: true })).rejects.toThrow('사용자가 설정한');
  vi.stubEnv('FODH_BRAIN', '');
  expect(await detectVerifyConfig(root, { apply: true, approve: true })).toMatchObject({ applied: { commands: ['npm run typecheck', 'npm run lint'] } });
  await commitFixture(wt);
  await detectVerifyConfig(root, { apply: true, approve: true });
  await writeFile(join(wt, 'package.json'), JSON.stringify({ scripts: { typecheck: 'fixture', lint: 'fixture' } }));
  await commitFixture(wt);
  vi.stubEnv('FODH_BRAIN', '1');
  expect(await detectVerifyConfig(root, { apply: true })).toMatchObject({ applied: { commands: ['npm run typecheck', 'npm run lint'] } });
});
it('H1 first autofill refuses untracked files without executing; ignored files allow clean autofill', async () => {
  const { root, wt } = await gitTask();
  await stub(root, 'npm', 'echo invoked >> invoked');
  await writeFile(join(wt, 'untracked'), 'fixture');
  await mkdir(join(wt, 'ignored')); await writeFile(join(wt, 'ignored/file'), 'fixture');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root, { cwd: 'task/ignored' })).toMatchObject({ ok: false, error: autoVerifyDirtyError });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  expect((await readLedger(root)).filter(e => ['verify:run', 'verify:auto-config'].includes(e.action))).toEqual([]);
  await expect(readFile(join(wt, 'invoked'))).rejects.toMatchObject({ code: 'ENOENT' });
  const { rm } = await import('node:fs/promises'); await rm(join(wt, 'untracked'));
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: true });
  expect(await readFile(join(wt, 'invoked'), 'utf8')).toBe('invoked\ninvoked\ninvoked\n');
});
it('H1 writer rejects heavy removal and permits order changes with exact command strings', async () => {
  const root = await project();
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture', lint: 'fixture', build: 'fixture' } }));
  await detectVerifyConfig(root, { apply: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture', lint: 'fixture' } }));
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow('빠짐: npm run build');
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  const raw = JSON.parse(before), verify = { commands: ['npm test', 'npm run lint'], heavy: [] };
  raw.verify = { ...verify, auto: autoVerifyMarker(verify, []) };
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify(raw));
  expect(await detectVerifyConfig(root, { apply: true })).toMatchObject({ applied: { commands: ['npm run lint', 'npm test'] } });
  raw.verify.commands = ['npm test ', 'npm run lint']; raw.verify.auto = autoVerifyMarker(raw.verify, []);
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify(raw));
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow('빠짐: npm test ');
});
it.each(['app', 'app/test'])('H2 unreadable %s fails run and detect with unchanged config', async dir => {
  const root = await project('VERIFY'); await mkdir(join(root, 'app/test'), { recursive: true });
  await writeFile(join(root, 'app/pubspec.yaml'), 'sdk: flutter'); await writeFile(join(root, 'app/test/a_test.dart'), '');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await chmod(join(root, dir), 0o000);
  try {
    const error = new DetectUnreadableError(dir);
    expect(await runVerify(root)).toMatchObject({ ok: false, error: error.message });
    for (const apply of [false, true]) await expect(detectVerifyConfig(root, { apply })).rejects.toEqual(error);
    expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
    expect((await readLedger(root)).filter(e => ['verify:run', 'verify:auto-config'].includes(e.action))).toEqual([]);
  } finally { await chmod(join(root, dir), 0o755); }
});
it('H2 chmod test folder in clean Git cannot remove an existing flutter test command', async () => {
  const { root, wt } = await gitTask(); await mkdir(join(wt, 'app/test'), { recursive: true });
  await writeFile(join(wt, 'app/pubspec.yaml'), 'sdk: flutter'); await writeFile(join(wt, 'app/test/a_test.dart'), '');
  await commitFixture(wt); await detectVerifyConfig(root, { apply: true });
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await chmod(join(wt, 'app/test'), 0o000);
  try {
    expect((await fixtureGit(wt, ['status', '--porcelain'])).stdout).toBe('');
    const result = await detectVerifyConfig(root, { apply: true });
    expect(result.detected?.commands).toContain("cd 'app' && flutter test");
    expect((await loadConfig(root)).verify.commands).toEqual(JSON.parse(before).verify.commands);
  } finally { await chmod(join(wt, 'app/test'), 0o755); }
});
it('H2 init and workspace init/add install undetected with warnings for unreadable folders', async () => {
  const root = await project('IDLE'); const { rm } = await import('node:fs/promises');
  await rm(join(root, '.pi'), { recursive: true }); await initGitStub(root);
  await mkdir(join(root, 'blocked')); await chmod(join(root, 'blocked'), 0o000);
  try {
    expect(await initProject({ cwd: root })).toMatchObject({ verifyDetected: null, warnings: [new DetectUnreadableError('blocked').message] });
    expect(JSON.parse(await readFile(join(root, '.pi/harness.json'), 'utf8')).verify).toBeUndefined();
  } finally { await chmod(join(root, 'blocked'), 0o755); }
  const ws = await project('IDLE'); await rm(join(ws, '.pi'), { recursive: true }); await initGitStub(ws);
  const member = await project('IDLE'); await mkdir(join(member, '.git')); await mkdir(join(member, 'blocked')); await chmod(join(member, 'blocked'), 0o000);
  try {
    expect(await initWorkspace({ cwd: ws, repos: [`app=../${member.split('/').at(-1)}`] })).toMatchObject({ warnings: [new DetectUnreadableError('blocked').message] });
    const verify = (await loadConfig(ws)).workspace!.repos.app.verify;
    expect(verify).toMatchObject({ commands: ['git diff --check'], auto: { stacks: [], hash: verifyHash(verify) } });
  } finally { await chmod(join(member, 'blocked'), 0o755); }
  const added = await project('IDLE'); await mkdir(join(added, '.git')); await mkdir(join(added, 'blocked')); await chmod(join(added, 'blocked'), 0o000);
  try {
    expect(await addWorkspaceMember(ws, 'added', `../${added.split('/').at(-1)}`, { approve: true })).toMatchObject({ warnings: [new DetectUnreadableError('blocked').message] });
    const verify = (await loadConfig(ws)).workspace!.repos.added.verify;
    expect(verify).toMatchObject({ commands: ['git diff --check'], auto: { stacks: [], hash: verifyHash(verify) } });
  } finally { await chmod(join(added, 'blocked'), 0o755); }
});
it('H3 member and task docs/package.json participate in detect and placeholder autofill', async () => {
  const { root, member, wt } = await workspace(); const { rm } = await import('node:fs/promises');
  await rm(join(wt, 'pubspec.yaml'));
  for (const base of [member, wt]) {
    await mkdir(join(base, 'docs'), { recursive: true });
    await writeFile(join(base, 'docs/package.json'), '{"scripts":{"test":"fixture"}}');
    await commitFixture(base);
  }
  await stub(root, 'npm', 'echo invoked > invoked');
  expect((await detectVerifyConfig(root)).detected?.commands).toEqual(["cd 'docs' && npm test"]);
  expect((await runVerify(root)).ok).toBe(true);
  expect(await readFile(join(wt, 'docs/invoked'), 'utf8')).toBe('invoked\n');
  await rm(wt, { recursive: true });
  await updateState(root, { taskId: undefined, worktrees: [] });
  expect(await detectVerifyConfig(root, { repo: 'app', apply: true })).toMatchObject({ applied: { commands: ["cd 'docs' && npm test"] } });
});

it('H1 unborn Git tree returns dirty failure instead of a missing HEAD exception', async () => {
  const root = await project('VERIFY'); await fixtureGit(root, ['init']);
  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"fixture"}}');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, error: autoVerifyDirtyError, head: null, clean: false });
  await expect(detectVerifyConfig(root, { apply: true })).rejects.toThrow(autoVerifyDirtyError);
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('H1 execution clean evidence includes changes made by auto-config document generation', async () => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0');
  vi.spyOn(claudeMd, 'generateClaudeMd').mockImplementation(async () => {
    await writeFile(join(wt, 'CLAUDE.md'), 'fixture'); return { files: [] };
  });
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false });
  expect((await readState(root)).verify?.clean).toBe(false);
});

it.each(['skip-worktree', 'assume-unchanged', 'hidden-untracked'])('I1/I2 first fill rejects %s and retains empty config', async attack => {
  const { root, wt } = await gitTask();
  if (attack === 'hidden-untracked') {
    await fixtureGit(wt, ['config', 'status.showUntrackedFiles', 'no']);
    await writeFile(join(wt, 'pubspec.yaml'), 'name: fake');
  } else {
    await fixtureGit(wt, ['update-index', `--${attack}`, 'package.json']);
    if (attack === 'skip-worktree') await writeFile(join(wt, 'package.json'), '{"scripts":{"lint":"fixture"}}');
  }
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, clean: false, error: autoVerifyDirtyError });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  expect((await detectVerifyConfig(root)).detected?.commands).toEqual(['npm run typecheck', 'npm run lint', 'npm test']);
  // The same clean evidence is required even for user-managed verification (REVIEW gate).
  await setConfig(root, 'verify.commands', '["true"]');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false });
});
it.each(['missing-git', 'missing-head'])('I1 registered %s fails run and every detect mode without writing', async kind => {
  const { root, wt } = await gitTask();
  if (kind === 'missing-git') await rename(join(wt, '.git'), join(wt, '.git.bak'));
  else {
    const ref = (await fixtureGit(wt, ['symbolic-ref', 'HEAD'])).stdout.trim();
    await fixtureGit(wt, ['update-ref', '-d', ref]);
  }
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, error: new DetectGitError().message });
  for (const options of [{}, { apply: true }, { apply: true, approve: true }]) {
    await expect(detectVerifyConfig(root, options)).rejects.toEqual(new DetectGitError());
  }
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('I1 chmod 444 child cannot silently omit committed Node commands on first fill', async () => {
  const { root, wt } = await gitTask(); await mkdir(join(wt, 'web'));
  await writeFile(join(wt, 'web/package.json'), '{"scripts":{"test":"fixture"}}'); await commitFixture(wt);
  await stub(root, 'npm', 'exit 0'); await chmod(join(wt, 'web'), 0o444);
  try {
    const result = await runVerify(root), verify = (await loadConfig(root)).verify;
    if ('error' in result) {
      expect(result.ok).toBe(false); expect(verify.commands).toEqual([]);
      expect([autoVerifyDirtyError, new DetectGitError().message]).toContain(result.error);
    } else expect(verify.commands).toEqual(['npm run typecheck', 'npm run lint', 'npm test', "cd 'web' && npm test"]);
  } finally { await chmod(join(wt, 'web'), 0o755); }
});
it('J3 missing sparse skip-worktree entry is dirty and HEAD detection retains tests', async () => {
  const { root, wt } = await gitTask();
  await fixtureGit(wt, ['update-index', '--skip-worktree', 'package.json']); await rm(join(wt, 'package.json'));
  await stub(root, 'npm', 'exit 0');
  expect(await runVerify(root)).toMatchObject({ ok: false, clean: false, error: autoVerifyDirtyError });
  expect((await loadConfig(root)).verify.commands).toEqual([]);
  expect((await detectVerifyConfig(root)).detected?.commands).toContain('npm test');
  await setConfig(root, 'verify.commands', '["true"]');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false });
});
it('I2 dirtyPaths ignores status.showUntrackedFiles and reports verification output', async () => {
  const { root, wt } = await gitTask(); await fixtureGit(wt, ['config', 'status.showUntrackedFiles', 'no']);
  await setConfig(root, 'verify.commands', '["echo fixture > generated"]');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: true, dirtyAfter: ['generated'] });
});
it('I3 committed Flutter tests refresh before execution with ledger and notification', async () => {
  const { root, wt } = await gitTask(); await rm(join(wt, 'package.json'));
  await writeFile(join(wt, 'pubspec.yaml'), 'sdk: flutter'); await commitFixture(wt);
  await stub(root, 'flutter', 'exit 0');
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ cmd: 'flutter pub get' }, { cmd: 'flutter analyze' }] });
  await mkdir(join(wt, 'test')); await writeFile(join(wt, 'test/x_test.dart'), ''); await commitFixture(wt);
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ cmd: 'flutter pub get' }, { cmd: 'flutter analyze' }, { cmd: 'flutter test' }] });
  const verify = (await loadConfig(root)).verify;
  expect(verify.auto?.hash).toBe(verifyHash(verify));
  const ledger = await readLedger(root);
  expect(ledger.filter(e => e.action === 'verify:auto-config' && e.status === 'ok')).toHaveLength(2);
  expect(ledger.find(e => e.action === 'verify:auto-config' && (e.evidence as { via?: string }).via === 'refresh')).toMatchObject({ evidence: { commands: verify.commands } });
  expect(ledger.filter(e => e.action === 'notify:verify:auto-config')).toHaveLength(2);
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8'); await runVerify(root);
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('I3 removed lint remains configured and executes with failure', async () => {
  const { root, wt } = await gitTask(); await detectVerifyConfig(root, { apply: true });
  await writeFile(join(wt, 'package.json'), '{"scripts":{"typecheck":"fixture","test":"fixture"}}'); await commitFixture(wt);
  await stub(root, 'npm', 'case "$*" in "run lint") exit 7;; esac');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, commands: [{ cmd: 'npm run typecheck', exit: 0 }, { cmd: 'npm run lint', exit: 7 }] });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('I3 delete-commit then restore-commit adds npm test back before execution', async () => {
  const { root, wt } = await gitTask(), original = await readFile(join(wt, 'package.json'), 'utf8');
  await writeFile(join(wt, 'package.json'), '{"scripts":{"typecheck":"fixture","lint":"fixture"}}'); await commitFixture(wt);
  await stub(root, 'npm', 'exit 0'); await runVerify(root);
  expect((await loadConfig(root)).verify.commands).toEqual(['npm run typecheck', 'npm run lint']);
  await writeFile(join(wt, 'package.json'), original); await commitFixture(wt);
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ cmd: 'npm run typecheck' }, { cmd: 'npm run lint' }, { cmd: 'npm test' }] });
});
it.each(['user', 'hash-mismatch', 'dirty', 'git-error', 'unreadable'])('I3 refresh %s keeps current configuration and executes', async kind => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0');
  if (kind === 'user') await setConfig(root, 'verify.commands', '["npm run lint"]');
  else await detectVerifyConfig(root, { apply: true });
  if (kind === 'hash-mismatch') await setConfig(root, 'verify.commands', '["npm run lint"]');
  await writeFile(join(wt, 'package.json'), '{"scripts":{"typecheck":"fixture","lint":"fixture","test":"fixture","build":"fixture"}}');
  if (kind !== 'dirty') await commitFixture(wt);
  if (kind === 'git-error') await rename(join(wt, '.git'), join(wt, '.git.bak'));
  if (kind === 'unreadable') {
    // Non-git refresh retains the fs permission failure behavior.
    await rename(join(wt, '.git'), join(wt, '.git.bak'));
    await rename(join(root, '.git'), join(root, '.git.bak'));
    await updateState(root, { worktrees: [] });
    await mkdir(join(root, 'web')); await writeFile(join(root, 'web/package.json'), '{}'); await chmod(join(root, 'web'), 0o444);
  }
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  try {
    expect(await runVerify(root)).toMatchObject({ ok: true });
    expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
    expect((await readLedger(root)).some(e => e.action === 'verify:auto-config' && (e.evidence as { via?: string }).via === 'refresh')).toBe(['git-error', 'unreadable'].includes(kind));
  } finally { if (kind === 'unreadable') await chmod(join(root, 'web'), 0o755); }
});
it.each([false, true])('I3 heavy additions respect user heavy=%s and skip heavy runs', async userHeavy => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0');
  if (userHeavy) await setConfig(root, 'verify.heavy', '["true"]');
  await runVerify(root);
  await writeFile(join(wt, 'package.json'), '{"scripts":{"typecheck":"fixture","lint":"fixture","test":"fixture","build":"fixture"}}'); await commitFixture(wt);
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  await runVerify(root, { heavy: true }); expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  await runVerify(root);
  expect((await loadConfig(root)).verify.heavy).toEqual(userHeavy ? ['true'] : ['npm run build']);
  if (userHeavy) expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it.each(['web/package.json', 'pubspec.yaml', 'pyproject.toml'])('I4 fs unreadable %s fails run/detect and init completes with warning', async path => {
  const root = await project('VERIFY');
  if (path.startsWith('web/')) await mkdir(join(root, 'web'));
  await writeFile(join(root, path), path.endsWith('.json') ? '{"scripts":{"test":"fixture"}}' : 'fixture');
  const blocked = path.startsWith('web/') ? 'web' : path;
  await chmod(join(root, blocked), blocked === 'web' ? 0o444 : 0o000);
  try {
    const error = new DetectUnreadableError(path), before = await readFile(join(root, '.pi/harness.json'), 'utf8');
    expect(await runVerify(root)).toMatchObject({ ok: false, error: error.message });
    await expect(detectVerifyConfig(root)).rejects.toEqual(error);
    expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
    await rm(join(root, '.pi'), { recursive: true }); await initGitStub(root);
    expect(await initProject({ cwd: root })).toMatchObject({ verifyDetected: null, warnings: [error.message] });
    expect(JSON.parse(await readFile(join(root, '.pi/harness.json'), 'utf8')).verify).toBeUndefined();
  } finally { await chmod(join(root, blocked), blocked === 'web' ? 0o755 : 0o644); }
});
it('I1 missing registered .git cannot fall back to an enclosing repository', async () => {
  const { root, wt } = await gitTask();
  await fixtureGit(root, ['init']); await writeFile(join(root, '.gitignore'), '.pi/\ndocs/\ntask/\n'); await commitFixture(root);
  await rename(join(wt, '.git'), join(wt, '.git.bak'));
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, error: new DetectGitError().message });
  await expect(detectVerifyConfig(root, { apply: true, approve: true })).rejects.toEqual(new DetectGitError());
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});

it('J1 replacement blobs cannot weaken first fill or refresh and cannot hide dirty evidence', async () => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0');
  const weak = join(root, '.stubs/weak.json');
  await writeFile(weak, '{"scripts":{"typecheck":"fixture","lint":"fixture"}}');
  const replaceManifest = async () => {
    const original = (await fixtureGit(wt, ['rev-parse', 'HEAD:package.json'])).stdout.trim();
    const replacement = (await fixtureGit(wt, ['hash-object', '-w', weak])).stdout.trim();
    await fixtureGit(wt, ['replace', original, replacement]);
  };
  const committed = (await fixtureGit(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  await fixtureGit(root, ['update-ref', 'refs/heads/main', committed]);
  await replaceManifest();
  expect((await fixtureGit(wt, ['diff', 'main..HEAD'])).stdout).toBe('');
  expect((await fixtureGit(wt, ['status', '--porcelain'])).stdout).toBe('');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: true });
  expect((await loadConfig(root)).verify.commands).toContain('npm test');
  await writeFile(join(wt, 'package.json'), '{"scripts":{"typecheck":"fixture","lint":"fixture","test":"fixture","build":"fixture"}}');
  await commitFixture(wt); await replaceManifest();
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: true });
  expect((await loadConfig(root)).verify).toMatchObject({ commands: ['npm run typecheck', 'npm run lint', 'npm test'], heavy: ['npm run build'] });
  await writeFile(join(wt, 'package.json'), '{"scripts":{"lint":"fixture"}}');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false });
});
it('J2 inherited Git overrides cannot redirect detection/clean; command environment is preserved', async () => {
  const { root, wt } = await gitTask(), other = await project();
  await fixtureGit(other, ['init']); await writeFile(join(other, 'package.json'), '{"scripts":{"lint":"fixture"}}'); await commitFixture(other);
  const head = (await fixtureGit(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  await stub(root, 'npm', 'test -n "$GIT_DIR" && test "$GIT_CONFIG_COUNT" = 1');
  vi.stubEnv('GIT_DIR', join(other, '.git')); vi.stubEnv('GIT_WORK_TREE', other);
  vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare'); vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: true, head });
  expect((await loadConfig(root)).verify.commands).toContain('npm test');
  await writeFile(join(wt, 'untracked'), 'fixture');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false, head });
});
it.each([false, true])('J2 forged worktree .git leaves null evidence; refresh=%s', async refresh => {
  const { root, wt } = await gitTask(), fake = join(wt, 'fake');
  await stub(root, 'npm', 'exit 0'); if (refresh) await runVerify(root);
  await mkdir(fake);
  await fixtureGit(fake, ['init']); await fixtureGit(fake, ['fetch', root, 'fixture']);
  await fixtureGit(fake, ['checkout', '--detach', 'FETCH_HEAD']);
  const head = (await fixtureGit(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  expect((await fixtureGit(fake, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
  await writeFile(join(wt, '.git'), 'gitdir: fake/.git\n');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: refresh, clean: null, head: null, ...(!refresh ? { error: new DetectGitError().message } : {}) });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  for (const options of [{}, { apply: true }, { apply: true, approve: true }]) await expect(detectVerifyConfig(root, options)).rejects.toEqual(new DetectGitError());
  await setConfig(root, 'verify.commands', '["true"]');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: null, head: null });
  expect((await readState(root)).verify).toMatchObject({ clean: null, head: null });
});
it('J4 clean and dirtyAfter ignore weakened repository stat/untracked settings', async () => {
  const { root, wt } = await gitTask();
  for (const [key, value] of Object.entries({ 'core.trustctime': 'false', 'core.checkStat': 'minimal', 'core.ignoreStat': 'true', 'core.untrackedCache': 'true', 'status.showUntrackedFiles': 'no' })) {
    await fixtureGit(wt, ['config', key, value]);
  }
  await writeFile(join(wt, 'package.json'), '{"scripts":{"lint":"fixture"}}');
  await writeFile(join(wt, 'untracked'), 'fixture');
  await setConfig(root, 'verify.commands', '["echo fixture > generated"]');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false, dirtyAfter: ['generated'] });
});
it('J5 committed newline directory is skipped on refresh without throwing or changing commands', async () => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0'); await runVerify(root);
  await mkdir(join(wt, 'a\nb')); await writeFile(join(wt, 'a\nb/package.json'), '{"scripts":{"test":"fixture"}}'); await commitFixture(wt);
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ cmd: 'npm run typecheck' }, { cmd: 'npm run lint' }, { cmd: 'npm test' }] });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('J5 refresh concurrent user edit returns writer error as warn and executes current contract', async () => {
  const configModule = await import('../src/core/config.ts');
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0'); await runVerify(root);
  await writeFile(join(wt, 'package.json'), '{"scripts":{"typecheck":"fixture","lint":"fixture","test":"fixture","build":"fixture"}}'); await commitFixture(wt);
  const writer = configModule.writeAutoVerify;
  vi.spyOn(configModule, 'writeAutoVerify').mockImplementationOnce(async (...args) => {
    await setConfig(root, 'verify.commands', '["echo user"]');
    return writer(...args);
  });
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ cmd: 'npm run typecheck' }, { cmd: 'npm run lint' }, { cmd: 'npm test' }] });
  expect((await loadConfig(root)).verify.commands).toEqual(['echo user']);
  expect((await readLedger(root)).filter(e => e.action === 'verify:auto-config' && e.status === 'warn')).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ via: 'refresh', warning: configModule.verifyUserSetError }) }));
});
it('J5 first-fill writer failure finishes with ok=false and preserves configuration', async () => {
  const configModule = await import('../src/core/config.ts');
  const { root } = await gitTask(), before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  vi.spyOn(configModule, 'writeAutoVerify').mockRejectedValueOnce(new Error('fixture write failure'));
  expect(await runVerify(root)).toMatchObject({ ok: false, error: 'fixture write failure' });
  expect((await readState(root)).verify?.ok).toBe(false);
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  expect((await readLedger(root)).some(e => e.action === 'verify:run')).toBe(false);
});
it('J6 refresh of 40 folders uses at most 20 Git invocations per ordinary run', async () => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0');
  for (let i = 0; i < 40; i++) {
    const dir = join(wt, `p${i}`); await mkdir(dir); await writeFile(join(dir, 'package.json'), '{"scripts":{"test":"fixture"}}');
  }
  await commitFixture(wt); await runVerify(root);
  const log = join(root, '.stubs/git-count');
  await stub(root, 'git', `echo git >> ${quote(log)}\nexec /usr/bin/git "$@"`);
  expect(await runVerify(root)).toMatchObject({ ok: true });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').length;
  expect(calls).toBeGreaterThan(0); expect(calls).toBeLessThanOrEqual(20);
});

it.each([false, true])('K1 external fake gitdir with real commondir is rejected; refresh=%s', async refresh => {
  const { root, wt } = await gitTask(), outside = await project();
  await stub(root, 'npm', 'exit 0'); if (refresh) await runVerify(root);
  const { cp } = await import('node:fs/promises');
  const original = (await fixtureGit(wt, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const common = (await fixtureGit(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const fake = join(outside, 'fake-gitdir'); await cp(original, fake, { recursive: true });
  await writeFile(join(fake, 'commondir'), common + '\n');
  await writeFile(join(wt, '.git'), `gitdir: ${fake}\n`);
  // Forge only the external index stat cache: Git reports clean at the real commit
  // even though the same-sized tracked file differs from that commit.
  const { stat, utimes } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const manifest = join(wt, 'package.json');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replaceAll('fixture', 'changed'));
  await utimes(manifest, new Date(0), new Date(0));
  const info = await stat(manifest, { bigint: true });
  const indexPath = join(fake, 'index'), index = await readFile(indexPath);
  expect(index.readUInt32BE(4)).toBe(2);
  const entry = index.indexOf(Buffer.from('package.json\0')) - 62;
  expect(entry).toBeGreaterThanOrEqual(12);
  const fields = [info.ctimeNs / 1000000000n, info.ctimeNs % 1000000000n,
    info.mtimeNs / 1000000000n, info.mtimeNs % 1000000000n,
    info.dev, info.ino, info.mode, info.uid, info.gid, info.size];
  fields.forEach((value, i) => index.writeUInt32BE(Number(value & 0xffffffffn), entry + i * 4));
  createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  await writeFile(indexPath, index);
  expect((await fixtureGit(wt, ['status', '--porcelain'])).stdout).toBe('');
  expect((await fixtureGit(wt, ['show', 'HEAD:package.json'])).stdout).not.toBe(await readFile(manifest, 'utf8'));
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: refresh, head: null, clean: null });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  expect((await readState(root)).verify).toMatchObject({ head: null, clean: null });
  for (const options of [{}, { apply: true }, { apply: true, approve: true }]) {
    await expect(detectVerifyConfig(root, options)).rejects.toEqual(new DetectGitError());
  }
});
it('K1 trusted management directory must point back to the registered worktree', async () => {
  const { root, wt } = await gitTask();
  const dir = (await fixtureGit(wt, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  await writeFile(join(dir, 'gitdir'), join(root, '.git') + '\n');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, head: null, clean: null });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('K2 external attributes clean filter cannot hide same-size tracked edits', async () => {
  const { root, wt } = await gitTask(); await stub(root, 'npm', 'exit 0');
  await writeFile(join(wt, 'tracked.txt'), 'good\n'); await commitFixture(wt);
  const attributes = join(root, '.stubs/attributes');
  await writeFile(attributes, 'tracked.txt filter=fixture\n');
  await fixtureGit(wt, ['config', 'core.attributesFile', attributes]);
  await fixtureGit(wt, ['config', 'filter.fixture.clean', "printf 'good\\n'"]);
  await writeFile(join(wt, 'tracked.txt'), 'evil\n');
  expect((await fixtureGit(wt, ['status', '--porcelain'])).stdout).toBe('');
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  expect(await runVerify(root)).toMatchObject({ ok: false, clean: false });
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
  await setConfig(root, 'verify.commands', '["true"]');
  expect(await runVerify(root)).toMatchObject({ ok: true, clean: false });
});
it('K3 validateTaskCommit reads actual objects despite a replacement blob', async () => {
  const { commitWorktree, validateTaskCommit } = await import('../src/core/worktree.ts');
  const { root, path, task } = await gitProject();
  await writeFile(join(path, 'code.txt'), 'good\n');
  const result = await commitWorktree(root, task.id, 'fixture');
  if (!('commit' in result)) throw new Error('missing commit');
  await setConfig(root, 'verify.commands', '["true"]'); await runVerify(root);
  const oid = await git(path, 'rev-parse', 'HEAD:code.txt');
  const replacementFile = join(root, '.pi/replacement'); await writeFile(replacementFile, 'evil\n');
  const replacement = await git(root, 'hash-object', '-w', replacementFile);
  await git(path, 'replace', oid, replacement);
  expect(await git(path, 'show', 'HEAD:code.txt')).toBe('evil');
  // Invalidate the index stat cache so status really hashes the worktree content.
  await writeFile(join(path, 'code.txt'), 'evil\n'); await git(path, 'status', '--porcelain');
  await writeFile(join(path, 'code.txt'), 'good\n');
  await expect(validateTaskCommit(root, task.id, result.commit, 'review')).resolves.toBeUndefined();
  await writeFile(join(path, 'code.txt'), 'evil\n');
  await expect(validateTaskCommit(root, task.id, result.commit, 'review')).rejects.toThrow('검수 대상');
});
it('K3 Codex and Claude process environments force actual Git objects; verify env stays inherited', async () => {
  const { codexChildEnv } = await import('../src/core/codex-supervisor.ts');
  const { runProcess } = await import('../src/provider/runner.ts');
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '0' };
  expect(codexChildEnv(env, 'fixture')).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1' });
  const root = await project('VERIFY');
  const result = await runProcess({ root, command: [process.execPath, '-e',
    "require('fs').writeFileSync('child-env', process.env.GIT_NO_REPLACE_OBJECTS)"], runId: 'fixture', maxMs: 5000, env });
  expect(result.code).toBe(0);
  expect(await readFile(join(root, 'child-env'), 'utf8')).toBe('1');
  vi.stubEnv('GIT_NO_REPLACE_OBJECTS', '0');
  await setConfig(root, 'verify.commands', '["test \\\"$GIT_NO_REPLACE_OBJECTS\\\" = 0"]');
  expect(await runVerify(root)).toMatchObject({ ok: true });
});
it.each(['ledger', 'notify'])('K5 first fill continues with saved commands after %s error', async failure => {
  const ledger = await import('../src/core/ledger.ts'), notification = await import('../src/core/notify.ts');
  const { root } = await gitTask(); await stub(root, 'npm', 'exit 0');
  if (failure === 'ledger') {
    const append = ledger.appendLedger;
    vi.spyOn(ledger, 'appendLedger').mockImplementation(async (...args) => {
      if (args[1].action === 'verify:auto-config') throw new Error('fixture ledger failure');
      return append(...args);
    });
  } else vi.spyOn(notification, 'notify').mockRejectedValueOnce(new Error('fixture notify failure'));
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runVerify(root)).toMatchObject({ ok: true, commands: [{ cmd: 'npm run typecheck' }, { cmd: 'npm run lint' }, { cmd: 'npm test' }] });
  expect((await loadConfig(root)).verify.commands).toContain('npm test');
  expect((await readState(root)).verify?.ok).toBe(true);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`fixture ${failure} failure`));
});
it.each(['ls-tree', 'cat-file'])('K6 oversized HEAD %s reports dedicated limit and preserves config', async command => {
  const { root } = await gitTask();
  // Real execFile overflow without constructing a huge repository.
  await stub(root, 'git', `case " $* " in *" ${command} "*) exec ${quote(process.execPath)} -e 'process.stdout.write("x".repeat(17 * 1024 * 1024))';; esac\nexec /usr/bin/git "$@"`);
  const before = await readFile(join(root, '.pi/harness.json'), 'utf8');
  const message = 'HEAD 목록이 너무 큽니다(16 MiB 초과) — 사용자가 verify.commands 를 설정해야 합니다';
  expect(await runVerify(root)).toMatchObject({ ok: false, error: message });
  await expect(detectVerifyConfig(root)).rejects.toThrow(message);
  expect(await readFile(join(root, '.pi/harness.json'), 'utf8')).toBe(before);
});
it('K3 forged replacement ancestry cannot turn an unmerged root commit into merge evidence', async () => {
  const { validateTaskCommit } = await import('../src/core/worktree.ts');
  const { root, path, task } = await gitProject();
  await writeFile(join(path, 'code.txt'), 'reviewed\n');
  await git(path, 'add', 'code.txt'); await git(path, 'commit', '-m', 'review');
  const review = await git(path, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'root-only'), 'root\n');
  await git(root, 'add', 'root-only'); await git(root, 'commit', '-m', 'unmerged root');
  const actual = await git(root, 'rev-parse', 'HEAD');
  const fake = await git(root, 'commit-tree', 'HEAD^{tree}', '-p', review, '-m', 'forged merge ancestry');
  await git(root, 'replace', actual, fake);
  expect(await git(root, 'merge-base', '--is-ancestor', review, actual)).toBe('');
  expect(await git(root, 'rev-list', '--parents', '-n', '1', actual)).toBe(`${actual} ${review}`);
  await expect(validateTaskCommit(root, task.id, actual, 'merge', review)).rejects.toThrow('병합 커밋');
});
