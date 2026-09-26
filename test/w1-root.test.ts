import { expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectRoots } from '../src/cli/project-root.ts';
import { resolveCliRoot } from '../src/cli/root.ts';
import { startPlan, startShell, implicitStart } from '../src/cli/start.ts';
import { initProject } from '../src/cli/init.ts';
import { initWorkspace, validateMarker, removeMarker } from '../src/core/workspace.ts';
import { fixture, git, writeConfig } from './w1-helpers.ts';
it('멤버 하위·심링크 → workspace, 옛 config/state보다 표지 우선, 첫 안내·래퍼', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  await writeConfig(f.member(), { brain: { model: 'opus' } });
  await writeFile(join(f.member(), '.pi/harness-state.json'), '{"state":"DONE_ALL"}');
  const sub = join(f.member(), 'sub/nested'); await mkdir(sub, { recursive: true });
  await symlink(sub, join(f.parent, 'alias'));
  for (const cwd of [sub, join(f.parent, 'alias')]) {
    expect(await projectRoots(cwd)).toMatchObject({ harness: f.root, member: 'web' });
    expect(await resolveCliRoot(cwd, '')).toBe(f.root);
    const plan = await startPlan({ cwd, dryRun: true }); expect(plan.cwd).toBe(f.root);
    expect(plan.notice).toBe('워크스페이스 workspace (멤버 web 에서 열림)'); expect(startShell(plan)).toContain(plan.notice);
  }
  expect((await startPlan({ cwd: f.root, dryRun: true })).notice).toBeUndefined();
  const ask = vi.fn(), report = vi.fn();
  expect((await implicitStart({ cwd: sub, ask, report }))?.notice).toContain('멤버 web'); expect(ask).not.toHaveBeenCalled();
  const output = await promisify(execFile)(process.execPath, [resolve('bin/fodh-start.mjs'), '--print', '--implicit'], { cwd: sub });
  expect(output.stdout).toContain('멤버 web'); expect(output.stdout).toContain(`cd '${f.root}'`);
  const cli = await promisify(execFile)(resolve('bin/fodh'), ['state', 'get'], { cwd: sub });
  expect(JSON.parse(cli.stdout).state).toBe('IDLE');
  expect((await validateMarker(join(f.member(), '.git'))).ok).toBe(true);
  await expect(initProject({ cwd: sub, dryRun: true })).rejects.toThrow(`이 레포는 워크스페이스 ${f.root}에 속합니다`);
});
it('연결 워크트리는 등록 여부와 관계없이 거부, 잘못된 표지는 표지 오류가 우선', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  const wt = join(f.parent, 'linked'); await git(f.member(), 'worktree', 'add', '-b', 'user-branch', wt);
  const sub = join(wt, 'sub'); await mkdir(sub);
  const methods = [() => projectRoots(sub), () => resolveCliRoot(sub, ''), () => startPlan({ cwd: sub, dryRun: true })];
  for (const call of methods) await expect(call()).rejects.toThrow('멤버 web의 워크트리 안입니다');
  expect(await resolveCliRoot(sub, f.root)).toBe(f.root);
  await writeFile(join(f.member(), '.git/fodh-workspace'), '/missing-workspace\n');
  for (const call of methods) await expect(call()).rejects.toThrow('표지가 맞지 않습니다');
});
it.each(['missing-config', 'removed-member', 'empty', 'relative'])('표지 불일치 %s는 조용히 무시하지 않는다', async kind => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  const marker = join(f.member(), '.git/fodh-workspace');
  if (kind === 'missing-config') await writeFile(marker, f.parent + '\n');
  if (kind === 'removed-member') { delete f.repos.web; await writeConfig(f.root, f.candidate); }
  if (kind === 'empty') await writeFile(marker, '');
  if (kind === 'relative') await writeFile(marker, '../workspace\n');
  expect((await validateMarker(join(f.member(), '.git'))).ok).toBe(false);
  await expect(projectRoots(f.member())).rejects.toThrow('표지가 맞지 않습니다');
  await expect(resolveCliRoot(f.member(), '')).rejects.toThrow('표지가 맞지 않습니다');
  await removeMarker(join(f.member(), '.git')); expect((await projectRoots(f.member())).harness).toBeUndefined();
});

it('워크스페이스가 삭제되면 실제 표지 경로와 사용자 복구 방법을 안내한다', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  await rm(f.root, { recursive: true });
  const message = `표지 파일 ${join(f.member(), '.git/fodh-workspace')}; 워크스페이스가 없어졌다면 이 파일을 지우세요`;
  await expect(projectRoots(f.member())).rejects.toThrow(message);
  await expect(resolveCliRoot(f.member(), '')).rejects.toThrow(message);
  expect((await validateMarker(join(f.member(), '.git'))).reason).toContain(message);
});
