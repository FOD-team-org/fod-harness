import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, symlink, chmod, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { DetectUnreadableError, detectVerify, verifySkipDirs } from '../src/core/verify-detect.ts';
const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp('/private/tmp/vc1-detect-'); roots.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content); }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each([
  ['dart', { 'pubspec.yaml': 'name: sample', 'test/nested/a_test.dart': '' }, ['dart pub get', 'dart analyze', 'dart test'], []],
  ['node', { 'package.json': JSON.stringify({ scripts: { test: 'anything', lint: 'anything', typecheck: 'anything', build: 'anything' } }) }, ['npm run typecheck', 'npm run lint', 'npm test'], ['npm run build']],
  ['go', { 'go.mod': '' }, ['go vet ./...', 'go test ./...'], ['go build ./...']],
  ['rust', { 'Cargo.toml': '' }, ['cargo check', 'cargo test'], ['cargo build --release']],
  ['swift', { 'Package.swift': '', 'Tests/a.swift': '' }, ['swift build', 'swift test'], []],
  ['python', { 'pyproject.toml': '[tool.pytest.ini_options]' }, ['python3 -m pytest -q'], []],
  ['gradle', { gradlew: '' }, ['./gradlew test'], ['./gradlew build']],
] as [string, Record<string, string>, string[], string[]][])('%s preset', async (stack, files, commands, heavy) => {
  const root = await fixture(files);
  const expected = { stacks: [{ stack, dir: '', notes: [] }], commands, heavy };
  expect(await detectVerify(root)).toEqual(expected);
  await commitTree(root);
  expect(await detectVerify(root, { source: 'head' })).toEqual(expected);
});
it.each(['darwin', 'linux'] as const)('Flutter precedence, nested tests and %s builds', async platform => {
  const root = await fixture({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter # SDK\n', 'test/deep/a_test.dart': '', 'android/gradlew': '', 'ios/a': '', 'web/a': '', 'package.json': '{"scripts":{"test":"x"}}' });
  expect(await detectVerify(root, { platform })).toEqual({ stacks: [{ stack: 'flutter', dir: '', notes: [] }],
    commands: ['flutter pub get', 'flutter analyze', 'flutter test'], heavy: [...(platform === 'darwin' ? ['flutter build ios --debug --no-codesign'] : []), 'flutter build apk --debug', 'flutter build web'] });
});
it('nonASCII realpath, shell quoting, all matches sorted by full path', async () => {
  const root = await fixture({ "앱 'folder/pubspec.yaml": 'sdk: flutter', 'a/x/go.mod': '', 'a-z/Cargo.toml': '' });
  const result = await detectVerify(root);
  expect(result?.stacks.map(s => s.dir)).toEqual(['a-z', 'a/x', "앱 'folder"]);
  expect(result?.commands.slice(-2)).toEqual(["cd '앱 '\\''folder' && flutter pub get", "cd '앱 '\\''folder' && dart analyze"]);
  expect(result?.stacks.at(-1)?.notes).toEqual(['flutter analyze 비ASCII 경로 오류 회피']);
});
it('depth 2, every skip name, prefix, symlink files and directories', async () => {
  const files = Object.fromEntries(['.hidden', 'node_modules', 'build', 'dist', 'out', 'target', 'Pods', 'vendor', 'coverage', 'wt-123', 'one/two/three'].map(d => [`${d}/go.mod`, '']));
  const root = await fixture(files), other = await fixture({ 'go.mod': '' });
  await symlink(other, join(root, 'linked')); await symlink(join(other, 'go.mod'), join(root, 'go.mod'));
  expect(await detectVerify(root, { skipPrefixes: ['wt-'] })).toBeUndefined();
  await writeFile(join(root, 'one/two/go.mod'), '');
  expect((await detectVerify(root, { skipPrefixes: ['wt-'] }))?.stacks).toEqual([{ stack: 'go', dir: 'one/two', notes: [] }]);
});
it.each([['pnpm-lock.yaml', 'pnpm', 'pnpm test'], ['yarn.lock', 'yarn', 'yarn test'], ['bun.lock', 'bun', 'bun run test'], ['bun.lockb', 'bun', 'bun run test']])('Node %s', async (lock, pm, test) => {
  const root = await fixture({ [lock]: '', 'package.json': '{"scripts":{"typecheck":"x","test":"x","build":"x"}}' });
  expect(await detectVerify(root)).toMatchObject({ commands: [`${pm} run typecheck`, test], heavy: [`${pm} run build`] });
});
it('npm placeholder, invalid/build-only package and no tests do not invent verification', async () => {
  const root = await fixture({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'x' } }) });
  expect(await detectVerify(root)).toBeUndefined();
  await writeFile(join(root, 'package.json'), '{'); expect(await detectVerify(root)).toBeUndefined();
  await writeFile(join(root, 'pubspec.yaml'), 'name: x');
  expect((await detectVerify(root))?.commands).toEqual(['dart pub get', 'dart analyze']);
});
it.each(['setup.py', 'requirements.txt', 'pyproject.toml'])('Python %s requires a test marker', async file => {
  const root = await fixture({ [file]: '' }); expect(await detectVerify(root)).toBeUndefined();
  await mkdir(join(root, 'tests')); expect((await detectVerify(root))?.commands).toEqual(['python3 -m pytest -q']);
});
it('Swift without Tests and package-manager priority', async () => {
  const root = await fixture({ 'Package.swift': '' }); expect((await detectVerify(root))?.commands).toEqual(['swift build']);
  await writeFile(join(root, 'package.json'), '{"scripts":{"lint":"x"}}');
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) await writeFile(join(root, lock), '');
  expect((await detectVerify(root))?.commands).toEqual(['pnpm run lint']);
});

it('G1 skipDirs excludes a directory and descendants without excluding siblings', async () => {
  const root = await fixture({ 'docs/x/pubspec.yaml': 'sdk: flutter', 'notes/x/go.mod': '', 'docs-extra/go.mod': '' });
  expect((await detectVerify(root, { skipDirs: ['docs', 'notes'] }))?.stacks).toEqual([{ stack: 'go', dir: 'docs-extra', notes: [] }]);
});
it('H2 unreadable directory fails detection even when another stack exists', async () => {
  const root = await fixture({ 'blocked/pubspec.yaml': 'sdk: flutter', 'app/go.mod': '' });
  await chmod(join(root, 'blocked'), 0o000);
  try { await expect(detectVerify(root)).rejects.toEqual(new DetectUnreadableError('blocked')); }
  finally { await chmod(join(root, 'blocked'), 0o755); }
});
it('G7 dash-prefixed directory executes in the actual directory through sh', async () => {
  const root = await fixture({ '-P/pubspec.yaml': 'sdk: flutter', '.stubs/flutter': '#!/bin/sh\npwd > marker\n' });
  await chmod(join(root, '.stubs/flutter'), 0o755);
  const detected = (await detectVerify(root))!;
  expect(detected.commands[0]).toBe("cd './-P' && flutter pub get");
  await promisify(execFile)('/bin/sh', ['-c', detected.commands[0]], { cwd: root, env: { ...process.env, PATH: `${join(root, '.stubs')}:${process.env.PATH}` } });
  expect((await readFile(join(root, '-P/marker'), 'utf8')).trim()).toBe(join(root, '-P'));
});
it('G8 tooling Node root includes Flutter child in root-first order', async () => {
  const root = await fixture({ 'package.json': '{"scripts":{"lint":"fixture"}}', 'app/pubspec.yaml': 'sdk: flutter', 'app/test/a_test.dart': '', 'app/android/gradlew': '' });
  expect(await detectVerify(root)).toMatchObject({ stacks: [{ stack: 'node', dir: '' }, { stack: 'flutter', dir: 'app' }],
    commands: ['npm run lint', "cd 'app' && flutter pub get", "cd 'app' && flutter analyze", "cd 'app' && flutter test"] });
});
it.each(['workspaces', 'pnpm'])('G8 Node workspace %s stops child traversal', async kind => {
  const root = await fixture({ 'package.json': JSON.stringify({ scripts: { lint: 'fixture' }, ...(kind === 'workspaces' ? { workspaces: [] } : {}) }),
    ...(kind === 'pnpm' ? { 'pnpm-workspace.yaml': '' } : {}), 'packages/a/package.json': '{"scripts":{"test":"fixture"}}' });
  expect((await detectVerify(root))?.stacks).toEqual([{ stack: 'node', dir: '', notes: [] }]);
});
it('G8 non-root Node still stops traversal', async () => {
  const root = await fixture({ 'tools/package.json': '{"scripts":{"lint":"fixture"}}', 'tools/app/pubspec.yaml': 'sdk: flutter' });
  expect((await detectVerify(root))?.stacks).toEqual([{ stack: 'node', dir: 'tools', notes: [] }]);
});

it('H2 unreadable Flutter test folder fails; explicitly skipped folders remain ignored', async () => {
  const root = await fixture({ 'app/pubspec.yaml': 'sdk: flutter', 'app/test/a_test.dart': '' });
  await chmod(join(root, 'app/test'), 0o000);
  try { await expect(detectVerify(root)).rejects.toEqual(new DetectUnreadableError('app/test')); }
  finally { await chmod(join(root, 'app/test'), 0o755); }
  for (const name of ['.hidden', 'node_modules', 'wt-task', 'docs']) {
    await mkdir(join(root, name)); await chmod(join(root, name), 0o000);
    try { expect((await detectVerify(root, { skipPrefixes: ['wt-'], skipDirs: ['docs'] }))?.stacks).toHaveLength(1); }
    finally { await chmod(join(root, name), 0o755); }
  }
});
it('H3 docs roots resolve against workspace root only in workspace mode', () => {
  expect(verifySkipDirs('/ws/member', 'docs')).toEqual(['docs']);
  expect(verifySkipDirs('/ws/member', 'docs', '/ws')).toEqual([]);
  expect(verifySkipDirs('/ws/member', 'member/docs', '/ws')).toEqual(['docs']);
  expect(verifySkipDirs('/ws/wt-member', 'member/docs', '/ws')).toEqual([]);
});

async function commitTree(root: string) {
  const git = (args: string[]) => promisify(execFile)('/usr/bin/git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  await git(['init']); await git(['add', '.']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
}
it.each(['darwin', 'linux'] as const)('I1 HEAD/fs parity includes prefix, quoting, skips, symlinks and %s Flutter', async platform => {
  const root = await fixture({ 'nested/package.json': '{"scripts":{"lint":"fixture"}}',
    "nested/-P/pubspec.yaml": 'sdk: flutter', 'nested/-P/test/deep/x_test.dart': '', 'nested/-P/ios/a': '', 'nested/-P/android/a': '', 'nested/-P/web/a': '',
    "nested/앱 'name/pubspec.yaml": 'sdk: flutter', 'nested/a/b/go.mod': '', 'nested/a/b/c/Cargo.toml': '',
    'nested/docs/go.mod': '', 'nested/wt-task/go.mod': '', 'nested/.hidden/go.mod': '', 'nested/node_modules/go.mod': '' });
  await symlink('-P', join(root, 'nested/linked'));
  await mkdir(join(root, 'nested/link-file')); await symlink('../-P/pubspec.yaml', join(root, 'nested/link-file/pubspec.yaml'));
  await commitTree(root);
  const options = { platform, skipDirs: ['docs'], skipPrefixes: ['wt-'] };
  const fs = await detectVerify(join(root, 'nested'), options);
  expect(fs?.stacks.map(s => s.dir)).toEqual(['', '-P', 'a/b', "앱 'name"]);
  expect(await detectVerify(join(root, 'nested'), { ...options, source: 'head' })).toEqual(fs);
});
it.each(['workspaces', 'pnpm'])('I1 HEAD preserves G8 %s workspace boundary', async kind => {
  const root = await fixture({ 'package.json': JSON.stringify({ scripts: { lint: 'fixture' }, ...(kind === 'workspaces' ? { workspaces: [] } : {}) }),
    ...(kind === 'pnpm' ? { 'pnpm-workspace.yaml': '' } : {}), 'app/go.mod': '' });
  await commitTree(root);
  expect(await detectVerify(root, { source: 'head' })).toEqual(await detectVerify(root));
  expect((await detectVerify(root, { source: 'head' }))?.stacks).toHaveLength(1);
});

it('J5 control characters in directories and test filenames are skipped in fs and HEAD', async () => {
  const root = await fixture({ 'package.json': '{"scripts":{"lint":"fixture"}}',
    'a\nb/package.json': '{"scripts":{"test":"fixture"}}', 'bad\x7f/go.mod': '',
    'app/pubspec.yaml': 'sdk: flutter', 'app/test/bad\t_test.dart': '', 'app/test/sub\r/x_test.dart': '' });
  const expected = await detectVerify(root);
  expect(expected?.stacks.map(s => s.dir)).toEqual(['', 'app']);
  expect(expected?.commands).not.toContain("cd 'app' && flutter test");
  await commitTree(root);
  expect(await detectVerify(root, { source: 'head' })).toEqual(expected);
});
it('J6 HEAD does not descend into gitlinks while fs installation can detect their stack', async () => {
  const root = await fixture({ 'package.json': '{"scripts":{"lint":"fixture"}}' }); await commitTree(root);
  const sub = join(root, 'submodule'); await mkdir(sub); await writeFile(join(sub, 'go.mod'), ''); await commitTree(sub);
  const git = (args: string[]) => promisify(execFile)('/usr/bin/git', ['-C', root, ...args]);
  const oid = (await promisify(execFile)('/usr/bin/git', ['-C', sub, 'rev-parse', 'HEAD'])).stdout.trim();
  await git(['update-index', '--add', '--cacheinfo', `160000,${oid},submodule`]);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'gitlink']);
  expect((await detectVerify(root))?.stacks.map(s => s.dir)).toEqual(['', 'submodule']);
  expect((await detectVerify(root, { source: 'head' }))?.stacks.map(s => s.dir)).toEqual(['']);
});
