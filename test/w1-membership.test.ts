import { expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initWorkspace, addWorkspaceMember, removeWorkspaceMember, readMarker, listWorkspace } from '../src/core/workspace.ts';
import { acquireLock } from '../src/core/lock.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import * as installation from '../src/cli/init.ts';
import { cli } from './p5-helpers.ts';
import { fixture, git, snapshot } from './w1-helpers.ts';
it('3개 멤버 설치, raw 설정·표지·로컬 명의·IDLE·다음 안내', async () => {
  const f = await fixture(), result = await initWorkspace({ cwd: f.root, repos: f.args });
  expect(result.committed).toBe(true); expect(result.nextSteps[0]).toBe('fodh 로 창을 열고 첫 백로그를 요청합니다(fodh backlog add --repo <이름> …)');
  const config = JSON.parse(await readFile(join(f.root, '.pi/harness.json'), 'utf8'));
  expect(config).toEqual(f.candidate); expect(config.verify).toBeUndefined(); expect(config.worktrees).toBeUndefined();
  for (const name of Object.keys(f.repos)) expect(await readMarker(join(f.member(name), '.git'))).toBe(f.root);
  expect(await git(f.root, 'log', '-1', '--format=%an <%ae>')).toBe('W1 Fixture <w1@example.invalid>');
  expect(await git(f.root, 'config', '--local', '--get', 'user.email')).toBe('w1@example.invalid');
  expect((await listWorkspace(f.root)).every(m => m.marker === 'ok' && m.oldHarness === 'none' && m.onBase)).toBe(true);
});
it.each(['lock', 'state', 'marker', 'branch', 'base'])('멤버 사전 검사 실패 %s: 전후 파일 바이트 동일', async kind => {
  const f = await fixture(); const member = f.member('app'); let release: (() => Promise<void>) | undefined;
  if (kind === 'lock') release = await acquireLock(join(member, '.pi/harness.lock'), { startedAt: async () => 'fixture' });
  if (kind === 'state') { await mkdir(join(member, '.pi')); await writeFile(join(member, '.pi/harness-state.json'), '{"state":"IMPLEMENT"}'); }
  if (kind === 'marker') await writeFile(join(member, '.git/fodh-workspace'), '/other/workspace\n');
  if (kind === 'branch') { await git(member, 'checkout', '-b', 'wt-app-old'); await git(member, 'commit', '--allow-empty', '-m', 'old'); await git(member, 'checkout', 'main'); }
  if (kind === 'base') await git(member, 'branch', '-m', 'other');
  const before = await snapshot(f.parent);
  const expected = { lock: '잠금이 살아 있습니다', state: '옛 하네스 상태: IMPLEMENT', marker: '다른 워크스페이스 표지', branch: '병합 안 된 prefix 브랜치', base: 'baseBranch main가 없습니다' }[kind]!;
  try { await expect(initWorkspace({ cwd: f.root, repos: f.args })).rejects.toThrow(expected); expect(await snapshot(f.parent)).toEqual(before); }
  finally { await release?.(); }
});
it('병합된 prefix 브랜치·같은 표지는 허용, dry-run 쓰기 없음', async () => {
  const f = await fixture(); await git(f.member(), 'branch', 'wt-web-old');
  await writeFile(join(f.member(), '.git/fodh-workspace'), f.root + '\n');
  const before = await snapshot(f.parent); const plan = await initWorkspace({ cwd: f.root, repos: f.args, dryRun: true });
  expect(plan.dryRun).toBe(true); expect(await snapshot(f.parent)).toEqual(before);
  expect((await initWorkspace({ cwd: f.root, repos: f.args })).committed).toBe(true);
});
it.each(['missing', 'different'])('명의 %s: 전역 명의 무시·파일 보존·identity 재실행', async kind => {
  const f = await fixture();
  if (kind === 'missing') await git(f.member('app'), 'config', '--local', '--unset', 'user.email');
  else await git(f.member('app'), 'config', '--local', 'user.email', 'different@example.invalid');
  const global = join(f.parent, 'global-config'); await writeFile(global, '[user]\n name = GLOBAL\n email = global@example.invalid\n'); vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  const result = await initWorkspace({ cwd: f.root, repos: f.args });
  expect(result.committed).toBe(false); expect(result.nextSteps.join('\n')).toContain('저장소 명의를 정할 수 없어');
  expect(await git(f.root, 'rev-list', '--all', '--max-count=1')).toBe('');
  const again = await initWorkspace({ cwd: f.root, repos: f.args, identity: 'Explicit User <explicit@example.invalid>' });
  expect(again.committed).toBe(true); expect(await git(f.root, 'log', '-1', '--format=%an <%ae>')).toBe('Explicit User <explicit@example.invalid>');
});
it('저장소 로컬 명의는 identity보다 우선', async () => {
  const f = await fixture(); await git(f.root, 'init', '-b', 'main');
  await git(f.root, 'config', '--local', 'user.name', 'Local'); await git(f.root, 'config', '--local', 'user.email', 'local@example.invalid');
  const result = await initWorkspace({ cwd: f.root, repos: f.args, identity: 'Explicit <explicit@example.invalid>' });
  expect(result.committed).toBe(true); expect(await git(f.root, 'log', '-1', '--format=%an')).toBe('Local');
});
it('커밋 훅 실패: 새 표지 회수·기존 표지 보존·출력 비전달·재시도', async () => {
  const f = await fixture(); await git(f.root, 'init', '-b', 'main');
  await writeFile(join(f.member(), '.git/fodh-workspace'), f.root + '\n');
  const hook = join(f.root, '.git/hooks/pre-commit'); await writeFile(hook, '#!/bin/sh\necho PRIVATE_TEST_OUTPUT >&2\nexit 1\n', { mode: 0o755 });
  const result = await initWorkspace({ cwd: f.root, repos: f.args });
  expect(result.committed).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_OUTPUT');
  expect(await readMarker(join(f.member(), '.git'))).toBe(f.root); expect(await readMarker(join(f.member('app'), '.git'))).toBeUndefined();
  await rm(hook); expect((await initWorkspace({ cwd: f.root, repos: f.args })).committed).toBe(true);
});
it('기존 하네스·멤버 내부 init·잘못된 identity 모두 쓰기 전 거부', async () => {
  const f = await fixture();
  await expect(initWorkspace({ cwd: f.member(), repos: f.args })).rejects.toThrow('HOME·루트·루트의 조상·안쪽');
  await expect(initWorkspace({ cwd: f.root, repos: f.args, identity: 'bad' })).rejects.toThrow('--identity 는');
  expect(await readdir(f.root)).toEqual([]);
  await initWorkspace({ cwd: f.root, repos: f.args });
  await expect(initWorkspace({ cwd: f.root, repos: f.args })).rejects.toThrow('이미');
});
it('add/remove 승인·두뇌 거부·미완 task·상태 worktree 검사·표지 제거', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args.slice(0, 2) });
  await expect(addWorkspaceMember(f.root, 'app', '../app')).rejects.toThrow('--approve');
  await addWorkspaceMember(f.root, 'app', '../app', { approve: true });
  await expect(removeWorkspaceMember(f.root, 'app')).rejects.toThrow('--approve');
  vi.stubEnv('FODH_BRAIN', '1'); await expect(removeWorkspaceMember(f.root, 'app', { approve: true })).rejects.toThrow('두뇌'); vi.stubEnv('FODH_BRAIN', '');
  const task = await addTask(f.root, { title: 'task', category: 'docs', repo: 'app' });
  await expect(removeWorkspaceMember(f.root, 'app', { approve: true })).rejects.toThrow('미완');
  await setTask(f.root, task.id, { repo: 'web' });
  await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', worktrees: [{ repo: 'app', taskId: 'T99', path: '../wt-app-T99', branch: 'wt-app-T99' }] }));
  await expect(removeWorkspaceMember(f.root, 'app', { approve: true })).rejects.toThrow('워크트리');
  await writeFile(join(f.root, '.pi/harness-state.json'), '{"state":"IDLE"}');
  await removeWorkspaceMember(f.root, 'app', { approve: true }); expect(await readMarker(join(f.member('app'), '.git'))).toBeUndefined();
});
it('래퍼 workspace init/list/add/remove dispatch (실제 도구 실행 없음)', async () => {
  const f = await fixture(); const execute = promisify(execFile);
  const run = async (...args: string[]) => JSON.parse((await execute(resolve('bin/fodh'), args, { cwd: f.root })).stdout);
  expect((await run('workspace', 'init', '--repo', f.args[0], '--repo', f.args[1])).committed).toBe(true);
  expect(await run('workspace', 'list')).toHaveLength(2);
  expect(await run('workspace', 'add', 'app', '../app', '--approve')).toMatchObject({ name: 'app' });
  expect(await run('workspace', 'remove', 'app', '--approve')).toMatchObject({ removed: true });
});

it.each(['lock', 'state', 'marker', 'branch', 'base', 'path'])('add 사전 검사 실패 %s: 전후 파일 바이트 동일', async kind => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args.slice(0, 2) });
  const member = f.member('app'); let release: (() => Promise<void>) | undefined;
  if (kind === 'lock') release = await acquireLock(join(member, '.pi/harness.lock'), { startedAt: async () => 'fixture' });
  if (kind === 'state') { await mkdir(join(member, '.pi')); await writeFile(join(member, '.pi/harness-state.json'), '{"state":"IMPLEMENT"}'); }
  if (kind === 'marker') await writeFile(join(member, '.git/fodh-workspace'), '/other/workspace\n');
  if (kind === 'branch') { await git(member, 'checkout', '-b', 'wt-app-old'); await git(member, 'commit', '--allow-empty', '-m', 'old'); await git(member, 'checkout', 'main'); }
  if (kind === 'base') await git(member, 'branch', '-m', 'other');
  const before = await snapshot(f.parent);
  const expected = { lock: '잠금이 살아 있습니다', state: '옛 하네스 상태: IMPLEMENT', marker: '다른 워크스페이스 표지', branch: '병합 안 된 prefix 브랜치', base: 'baseBranch main가 없습니다', path: '경로와 .git 디렉터리' }[kind]!;
  try {
    await expect(addWorkspaceMember(f.root, 'app', kind === 'path' ? '../missing' : '../app', { approve: true })).rejects.toThrow(expected);
    expect(await snapshot(f.parent)).toEqual(before);
  } finally { await release?.(); }
});
it.each(['FODH_CODEX_CHILD', 'FODH_BRAIN'])('%s는 init/add/remove를 실행할 수 없다', async key => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args.slice(0, 2) });
  const before = await snapshot(f.parent); vi.stubEnv(key, '1');
  const expected = key === 'FODH_CODEX_CHILD' ? 'Codex 위임' : '두뇌 세션';
  await expect(initWorkspace({ cwd: f.root, repos: f.args })).rejects.toThrow(expected);
  await expect(addWorkspaceMember(f.root, 'app', '../app', { approve: true })).rejects.toThrow(expected);
  await expect(removeWorkspaceMember(f.root, 'web', { approve: true })).rejects.toThrow(expected);
  expect(await snapshot(f.parent)).toEqual(before);
});
it.each(['member', 'git'])('삭제된 %s 경로도 raw 설정으로 제거한다', async kind => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  await rm(kind === 'member' ? f.member('app') : join(f.member('app'), '.git'), { recursive: true });
  if (kind === 'member') await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', worktrees: [{ repo: 'app', taskId: 'T99', path: '../missing-worktree' }] }));
  expect(await cli(f.root, ['workspace', 'remove', 'app', '--approve'])).toMatchObject({ code: 0, value: { removed: true } });
  expect(JSON.parse(await readFile(join(f.root, '.pi/harness.json'), 'utf8')).workspace.repos.app).toBeUndefined();
  expect(await readMarker(join(f.member('app'), '.git'))).toBeUndefined();
});
it('없어진 멤버의 미완 task는 여전히 remove를 막고 다른 없어진 멤버는 순차 제거 가능', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  await addTask(f.root, { title: 'unfinished', category: 'docs', repo: 'app' });
  await rm(f.member('app'), { recursive: true }); await rm(f.member('backend'), { recursive: true });
  await expect(removeWorkspaceMember(f.root, 'app', { approve: true })).rejects.toThrow('미완 task');
  await expect(removeWorkspaceMember(f.root, 'backend', { approve: true })).resolves.toMatchObject({ removed: true });
});
it('사용자가 먼저 커밋한 재실행은 git 로컬 명의를 쓰지 않는다', async () => {
  const f = await fixture(); await git(f.member('app'), 'config', '--local', '--unset', 'user.email');
  expect((await initWorkspace({ cwd: f.root, repos: f.args })).committed).toBe(false);
  await git(f.root, 'config', '--local', 'user.name', 'Temporary User'); await git(f.root, 'config', '--local', 'user.email', 'temp@example.invalid');
  await git(f.root, 'commit', '--allow-empty', '-m', 'user commit');
  await git(f.root, 'config', '--local', '--unset', 'user.name'); await git(f.root, 'config', '--local', '--unset', 'user.email');
  const path = join(f.root, '.git/config'), before = await readFile(path);
  const result = await initWorkspace({ cwd: f.root, repos: f.args, identity: 'Unused User <unused@example.invalid>' });
  expect(result.committed).toBe(false); expect(result.skipped).toContainEqual({ path: 'commit', reason: '커밋이 있는 저장소이므로 자동 커밋하지 않습니다' });
  expect(await readFile(path)).toEqual(before);
});
it('initProject 사전 실패는 workspace 재개 기록을 남기지 않는다', async () => {
  const f = await fixture(), before = await snapshot(f.parent);
  vi.spyOn(installation, 'initProject').mockRejectedValueOnce(new Error('설치 사전 검사 실패'));
  await expect(initWorkspace({ cwd: f.root, repos: f.args })).rejects.toThrow('설치 사전 검사 실패');
  expect(await snapshot(f.parent)).toEqual(before);
  await expect(readFile(join(f.root, '.pi/harness-workspace-init.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
