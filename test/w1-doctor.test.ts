import { expect, it, vi } from 'vitest';
vi.mock('../src/provider/turn.ts', () => ({ runTurn: vi.fn(async () => ({ reason: 'stop', hookDenials: [], init: {} })) }));
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { doctorWorkspace } from '../src/core/doctor.ts';
import { doctor } from '../src/cli/doctor.ts';
import { readLedger } from '../src/core/ledger.ts';
import { runTurn } from '../src/provider/turn.ts';
import { initWorkspace, readMarker, removeMarker, removeWorkspaceMember } from '../src/core/workspace.ts';
import { addTask, setTask, backlogInSync, renderBacklog, parseBacklog } from '../src/core/backlog.ts';
import { loadConfig } from '../src/core/config.ts';
import { acquireLock } from '../src/core/lock.ts';
import { fixture, git, writeConfig } from './w1-helpers.ts';
import { cli } from './p5-helpers.ts';
it('단일 레포 workspace 필드 없음, workspace doctor 정상·CLI 출력', async () => {
  const f = await fixture(); expect(await doctorWorkspace(f.root)).toBeUndefined();
  await initWorkspace({ cwd: f.root, repos: f.args });
  expect(await doctorWorkspace(f.root)).toMatchObject({ ok: true });
  expect(await doctor(f.root, { lockHeld: true })).toMatchObject({ ok: true, workspace: { ok: true } });
});
it.each(['missing-marker', 'mismatch-marker', 'live-lock', 'base', 'path', 'git-file', 'verify'])('doctor 실패 %s', async kind => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args }); let release: (() => Promise<void>) | undefined;
  if (kind === 'missing-marker') await removeMarker(join(f.member(), '.git'));
  if (kind === 'mismatch-marker') await writeFile(join(f.member(), '.git/fodh-workspace'), '/other\n');
  if (kind === 'live-lock') release = await acquireLock(join(f.member(), '.pi/harness.lock'), { startedAt: async () => 'fixture' });
  if (kind === 'base') await git(f.member(), 'branch', '-m', 'renamed');
  if (kind === 'path') f.repos.web.path = '../missing';
  if (kind === 'git-file') { await rm(join(f.member(), '.git'), { recursive: true }); await writeFile(join(f.member(), '.git'), 'gitdir: nowhere'); }
  if (kind === 'verify') f.repos.web.verify.commands = [];
  if (['path', 'verify'].includes(kind)) await writeConfig(f.root, f.candidate);
  try {
    expect((await doctorWorkspace(f.root))?.ok).toBe(false);
    vi.mocked(runTurn).mockClear(); await expect(doctor(f.root, { lockHeld: true })).rejects.toThrow('워크스페이스 doctor 실패'); expect(runTurn).not.toHaveBeenCalled();
    const notifications = (await readLedger(f.root)).filter(entry => entry.action === 'notify:doctor:fail');
    expect(notifications.length > 0).toBe(!['path', 'git-file', 'verify'].includes(kind));
  } finally { await release?.(); }
});
it('branch·trackedDirty·미등록 prefix는 경고, 등록된 branch 제외', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  for (const member of Object.values(f.repos)) member.verify.commands = ['git status --porcelain'];
  await writeConfig(f.root, f.candidate);
  await git(f.member(), 'checkout', '-b', 'wt-web-old'); await git(f.member(), 'commit', '--allow-empty', '-m', 'branch');
  await writeFile(join(f.member(), 'code.txt'), 'dirty\n');
  let report = await doctorWorkspace(f.root); expect(report?.ok).toBe(true);
  expect(report?.checks.filter(c => c.level === 'warning').map(c => c.check)).toEqual(['branch', 'tracked-dirty', 'unregistered-branches']);
  await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', worktrees: [{ repo: 'web', branch: 'wt-web-old', path: '../wt', taskId: 'T01' }] }));
  report = await doctorWorkspace(f.root); expect(report?.checks.some(c => c.check === 'unregistered-branches')).toBe(false);
});
it('기본 verify 명령만 있으면 정확한 warning, 실제 명령을 더하면 해제', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  const initial = await doctorWorkspace(f.root);
  expect(initial?.checks.filter(check => check.check === 'verify-default')).toEqual(Object.keys(f.repos).map(name => ({
    member: name, check: 'verify-default', level: 'warning',
    message: `멤버 ${name} 검증 명령이 기본값뿐입니다 — harness.json 의 workspace.repos.${name}.verify.commands 를 채우세요`,
  })));
  f.repos.web.verify.commands.push('git status --porcelain');
  f.repos.backend.verify.commands = ['git status --porcelain'];
  await writeConfig(f.root, f.candidate);
  const result = await doctor(f.root, { lockHeld: true });
  expect(result.ok).toBe(true);
  expect(result.workspace?.checks.filter(check => check.check === 'verify-default').map(check => check.member)).toEqual(['app']);
});
it('done 멤버 제거 뒤 sync·list·render·import·doctor 성공, 완료 레포 변경은 거부', async () => {
  const f = await fixture(); await initWorkspace({ cwd: f.root, repos: f.args });
  const task = await addTask(f.root, { title: '완료 기록', category: 'docs', repo: 'app' });
  const done = await setTask(f.root, task.id, { status: 'done', verify: { ok: true }, review: { high: 0, commit: 'review' },
    merge: { commit: 'merge' }, docs: { ok: true }, cleanup: { ok: true } });
  await removeWorkspaceMember(f.root, 'app', { approve: true });
  expect(await readMarker(join(f.member('app'), '.git'))).toBeUndefined();
  expect((await cli(f.root, ['backlog', 'sync'])).code).toBe(0);
  expect(await cli(f.root, ['backlog', 'list'])).toMatchObject({ code: 0, value: { tasks: [done] } });
  expect(await backlogInSync(f.root)).toBe(true);
  const config = await loadConfig(f.root), rendered = renderBacklog('', [done], config);
  expect(parseBacklog(rendered, [done], config)).toEqual([done]);
  expect((await cli(f.root, ['backlog', 'set', task.id, '--repo', 'web'])).value.error).toBe('진행 중 task T01의 레포는 바꿀 수 없습니다');
  expect(() => parseBacklog(rendered.replace(' | app | ', ' | web | '), [done], config)).toThrow('진행 중 task T01의 레포는 바꿀 수 없습니다');
  const result = await doctor(f.root, { lockHeld: true });
  expect(result.ok).toBe(true);
  expect(result.workspace?.checks.some(check => check.member === 'app' || check.message.includes(task.id))).toBe(false);
  expect((await cli(f.root, ['backlog', 'add', '--title', '새 작업', '--category', 'docs', '--repo', 'app'])).code).toBe(1);
  await expect(setTask(f.root, task.id, { status: 'ready' })).rejects.toThrow('--repo');
});
