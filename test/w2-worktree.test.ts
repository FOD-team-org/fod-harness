import { expect, it, vi } from 'vitest';
import { mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, git, writeConfig } from './w2-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { createWorktree, listWorktrees, removeWorktree } from '../src/core/worktree.ts';
import { updateState, readState } from '../src/core/state.ts';
import { appendLedger, readLedger } from '../src/core/ledger.ts';
import { loadConfig } from '../src/core/config.ts';
import { doctorWorkspace } from '../src/core/doctor.ts';
import { withWorktreeLock } from '../src/core/worktree-lock.ts';
import { acquireLock } from '../src/core/lock.ts';
import * as storage from '../src/core/storage.ts';

it('멤버 main 분기·형제 경로·links·setup·repo 증거·list·remove', async () => {
  const f = await workspace();
  await git(f.member(), 'checkout', '-b', 'other');
  await writeFile(join(f.member(), 'other.txt'), 'other'); await git(f.member(), 'add', '.'); await git(f.member(), 'commit', '-m', 'other');
  await mkdir(join(f.member(), 'node_modules')); await writeFile(join(f.member(), 'node_modules/source'), 'web');
  f.repos.web.worktrees.links = ['node_modules'];
  f.repos.web.worktrees.setup = ['test -f node_modules/source && printf web > prepared'];
  await writeConfig(f.root, f.candidate);
  const t = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  const made = await createWorktree(f.root, t.id);
  expect(made.path).toBe(join(f.parent, 'wt-web-T01'));
  expect(made.base).toBe(await git(f.member(), 'rev-parse', 'main')); expect(made.baseBranch).toBe('main');
  expect(await readFile(join(made.path, 'other.txt')).catch(() => null)).toBeNull();
  expect(await readlink(join(made.path, 'node_modules'))).toBe(join(f.member(), 'node_modules'));
  expect(await readFile(join(made.path, 'prepared'), 'utf8')).toBe('web');
  const listed = await listWorktrees(f.root); expect(Object.keys(listed.porcelain)).toEqual(['web', 'backend', 'app']);
  expect(listed.worktrees[0]).toMatchObject({ repo: 'web', registeredInGit: true, setupOk: true });
  expect(Object.keys((await readState(f.root)).worktrees![0])[0]).toBe('repo');
  for (const e of (await readLedger(f.root)).filter(e => /^worktree:(create|link|link-excluded|setup)$/u.test(e.action))) expect(e.evidence).toHaveProperty('repo', 'web');
  await updateState(f.root, { state: 'RECLAIM' }); await removeWorktree(f.root, t.id, true);
  expect(await git(f.member(), 'worktree', 'list', '--porcelain')).not.toContain(made.path);
});
it('사용자 옛 브랜치는 반복해도 거부하고 하네스 삭제 브랜치의 원래 base는 보존', async () => {
  const f = await workspace(); const t = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  await git(f.member(), 'branch', 'wt-web-T01');
  for (let i = 0; i < 2; i++) await expect(createWorktree(f.root, t.id)).rejects.toThrow('옛 브랜치 wt-web-T01이 남아 있습니다');
  await git(f.member(), 'branch', '-D', 'wt-web-T01');
  const wt = await createWorktree(f.root, t.id);
  await updateState(f.root, { state: 'RECLAIM' }); await removeWorktree(f.root, t.id);
  await writeFile(join(f.member(), 'later'), 'later'); await git(f.member(), 'add', '.'); await git(f.member(), 'commit', '-m', 'later');
  expect((await createWorktree(f.root, t.id)).base).toBe(wt.base);
});
it.each([true, false])('create pre 뒤 중단된 브랜치 복구, 폴더 존재=%s', async present => {
  const f = await workspace(); const t = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  const path = join(f.parent, 'wt-web-T01'), branch = 'wt-web-T01';
  await appendLedger(f.root, { runId: 'crashed', taskId: t.id, action: 'worktree:create', status: 'pre', evidence: { repo: 'web', branch, path } });
  await git(f.member(), 'worktree', 'add', '-b', branch, path, 'main');
  if (!present) await rm(path, { recursive: true });
  expect(await createWorktree(f.root, t.id)).toMatchObject({ repo: 'web', branch, path });
});
it('일반 fail로 끝난 create pre는 사용자 브랜치의 소유 근거가 아니다', async () => {
  const f = await workspace(), task = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  await appendLedger(f.root, { runId: 'failed', taskId: task.id, action: 'worktree:create', status: 'pre', evidence: { repo: 'web', branch: 'wt-web-T01' } });
  // Failure evidence need not repeat branch: terminal status is matched by runId.
  await appendLedger(f.root, { runId: 'failed', taskId: task.id, action: 'worktree:create', status: 'fail', evidence: { repo: 'web', error: 'before add' } });
  await git(f.member(), 'branch', 'wt-web-T01');
  await expect(createWorktree(f.root, task.id)).rejects.toThrow('옛 브랜치 wt-web-T01이 남아 있습니다');
});
it('복구할 작업 트리가 detached이면 Git 원문 대신 고정 안내', async () => {
  const f = await workspace(), task = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  const path = join(f.parent, 'wt-web-T01'), branch = 'wt-web-T01';
  await appendLedger(f.root, { runId: 'crashed', taskId: task.id, action: 'worktree:create', status: 'pre', evidence: { repo: 'web', branch, path } });
  await git(f.member(), 'worktree', 'add', '-b', branch, path, 'main');
  await git(path, 'checkout', '--detach');
  await expect(createWorktree(f.root, task.id)).rejects.toThrow('남은 워크트리가 브랜치 위에 있지 않습니다 — 사용자가 확인');
  expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
});
it.each([false, true])('워크트리 잠금 대기 실패는 다른 멤버 표시 파일이 있을 때만 안내, marker=%s', async marker => {
  const f = await workspace();
  if (marker) await writeFile(join(f.member('backend'), '.git/fodh-merge.json'), JSON.stringify({ taskId: 'T02' }));
  const release = await acquireLock(join(f.root, '.pi/harness-worktree.lock'), { startedAt: async () => '2026-09-27T00:00:00Z' });
  try {
    const action = vi.fn();
    await expect(withWorktreeLock(f.root, action, { waitMs: 0 })).rejects.toThrow(new Error('다른 하네스가 잠금을 사용 중입니다' + (marker ? ' — T02 병합이 진행 중입니다' : '')));
    expect(action).not.toHaveBeenCalled();
  } finally { await release(); }
});
it('create 명령도 병합 진행 잠금 안내를 사용한다', async () => {
  const f = await workspace(), task = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  await writeFile(join(f.member(), '.git/fodh-merge.json'), JSON.stringify({ taskId: 'T01' }));
  const original = storage.withFileLock;
  vi.spyOn(storage, 'withFileLock').mockImplementation((path, action, options) => path.endsWith('harness-worktree')
    ? Promise.reject(new Error('다른 하네스가 잠금을 사용 중입니다')) : original(path, action, options));
  await expect(createWorktree(f.root, task.id)).rejects.toThrow('다른 하네스가 잠금을 사용 중입니다 — T01 병합이 진행 중입니다');
});
it('기록이 있고 폴더만 없으면 저장된 base로 복구·repo 없는 remove는 불변', async () => {
  const f = await workspace(); const t = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  const wt = await createWorktree(f.root, t.id); await rm(wt.path, { recursive: true });
  expect((await createWorktree(f.root, t.id)).base).toBe(wt.base);
  await updateState(f.root, s => ({ state: 'RECLAIM', worktrees: s.worktrees?.map(w => ({ ...w, repo: undefined })) }));
  await expect(removeWorktree(f.root, t.id)).rejects.toThrow('워크트리 기록에 레포가 없습니다');
  expect(await git(f.member(), 'worktree', 'list', '--porcelain')).toContain(wt.path);
});
it.each(['../workspace', '.', '../backend/sub'])('loadConfig·doctor는 잘못된 worktrees.root %s를 거부', async root => {
  const f = await workspace(); f.repos.web.worktrees.root = root; await writeConfig(f.root, f.candidate);
  await expect(loadConfig(f.root)).rejects.toThrow('모든 멤버 밖');
  expect(await doctorWorkspace(f.root)).toMatchObject({ ok: false, checks: [{ check: 'config', level: 'error' }] });
});
it('workspace --base 및 없는 기준 브랜치를 거부', async () => {
  const f = await workspace(); const t = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  await expect(createWorktree(f.root, t.id, 'HEAD')).rejects.toThrow('워크스페이스 모드에서는 --base 를 쓸 수 없습니다');
  await git(f.member(), 'checkout', '-b', 'other'); await git(f.member(), 'branch', '-D', 'main');
  await expect(createWorktree(f.root, t.id)).rejects.toThrow('멤버 web에 기준 브랜치 main가 없습니다');
});
