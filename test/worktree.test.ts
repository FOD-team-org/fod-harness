import { runCleanup } from '../src/core/cleanup.ts';
import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createWorktree, removeWorktree, listWorktrees } from '../src/core/worktree.ts';
import { addTask, getTask } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';
const roots: string[] = [], execute = promisify(execFile);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(git = true) {
  const parent = await mkdtemp(join(tmpdir(), 'fodh-worktree-')); roots.push(parent);
  const root = join(parent, 'project'); await mkdir(root);
  const task = await addTask(root, { title: 'worktree', category: 'docs' });
  if (git) {
    await execute('git', ['init', root]);
    // Seed an empty HEAD without git commit: the task permits only temporary init/worktree operations.
    const object = async (kind: string, content: string) => {
      const bytes = Buffer.from(`${kind} ${Buffer.byteLength(content)}\0${content}`), id = createHash('sha1').update(bytes).digest('hex');
      const path = join(root, '.git/objects', id.slice(0, 2), id.slice(2)); await mkdir(dirname(path), { recursive: true }); await writeFile(path, deflateSync(bytes)); return id;
    };
    const tree = await object('tree', '');
    const commit = await object('commit', `tree ${tree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nfixture\n`);
    await mkdir(join(root, '.git/refs/heads'), { recursive: true });
    await writeFile(join(root, '.git/refs/heads/main'), commit + '\n'); await writeFile(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  }
  return { root, parent, task };
}
it('create 등록·원장·중복·porcelain 대조·remove·브랜치 유지', async () => {
  const { root, parent, task } = await setup();
  const created = await createWorktree(root, task.id); expect(created).toMatchObject({ created: true, path: join(await realpath(parent), 'wt-T01'), branch: 'wt-T01' });
  expect((await getTask(root, task.id)).worktree).toBe(created.path);
  expect((await readState(root)).worktrees).toHaveLength(1);
  expect(await createWorktree(root, task.id)).toMatchObject({ created: false, path: created.path });
  expect((await listWorktrees(root)).worktrees[0]).toMatchObject({ exists: true, registeredInGit: true });
  await expect(removeWorktree(root, task.id)).rejects.toThrow('현재 상태');
  await updateState(root, { state: 'DOCS' }); expect(await removeWorktree(root, task.id)).toMatchObject({ removed: true });
  expect((await getTask(root, task.id)).worktree).toBe(''); expect((await readState(root)).worktrees).toEqual([]);
  expect(await readFile(join(root, '.git/refs/heads/wt-T01'), 'utf8')).toMatch(/^[a-f0-9]+\n$/u);
  expect((await readLedger(root)).filter(item => item.action.startsWith('worktree:')).map(item => item.status)).toEqual(['pre', 'ok', 'pre', 'ok']);
  // The retained branch is reused, not recreated with -b.
  expect(await createWorktree(root, task.id)).toMatchObject({ created: true });
});
it('dirty worktree는 기본 보존, --force만 제거', async () => {
  const { root, task } = await setup(); const created = await createWorktree(root, task.id);
  await writeFile(join(created.path, 'untracked.txt'), 'keep'); await updateState(root, { state: 'CLEANUP' });
  await expect(removeWorktree(root, task.id)).rejects.toThrow(); expect((await readState(root)).worktrees).toHaveLength(1);
  expect(await removeWorktree(root, task.id, true)).toMatchObject({ removed: true });
});
it('미완 위임 task의 worktree 제거 거부', async () => {
  const { root, task } = await setup(); await createWorktree(root, task.id);
  await updateState(root, { state: 'RECLAIM', delegation: { runId: 'active', taskId: task.id, kind: 'task', startedAt: new Date().toISOString() } });
  await expect(removeWorktree(root, task.id)).rejects.toThrow('위임 진행 중');
});
it('비-git 오류는 worktree:null, 등록 없음', async () => {
  const { root, task } = await setup(false);
  await expect(createWorktree(root, task.id)).rejects.toMatchObject({ message: 'git 저장소가 아닙니다', details: { worktree: null } });
  expect((await readState(root)).worktrees).toBeUndefined();
});
it('루트 내부·심링크로 루트 내부 경로 거부', async () => {
  const { root, parent, task } = await setup(false); await setConfig(root, 'worktrees.root', '.');
  await expect(createWorktree(root, task.id)).rejects.toThrow('루트 밖');
  await symlink(root, join(parent, 'alias')); await setConfig(root, 'worktrees.root', '../alias');
  await expect(createWorktree(root, task.id)).rejects.toThrow('루트 밖');
});
it('base 옵션 주입과 task ID 거부', async () => {
  const { root, task } = await setup(false);
  await expect(createWorktree(root, task.id, '--detach')).rejects.toThrow('--base');
  await expect(createWorktree(root, '../bad')).rejects.toThrow('task ID');
});

it('디렉터리만 삭제된 stale worktree는 prune 후 같은 경로에 다시 생성한다', async () => {
  const { root, task } = await setup();
  const first = await createWorktree(root, task.id);
  await rm(first.path, { recursive: true, force: true });
  const second = await createWorktree(root, task.id);
  expect(second.path).toBe(first.path); expect(await realpath(second.path)).toBe(second.path);
  expect((await listWorktrees(root)).worktrees).toHaveLength(1);
});

it.each([false, true])('H10 의존성 링크·디렉터리 ignore=%s·공통 exclude·remove 원본 보존', async directoryIgnore => {
  const { root, task } = await setup();
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules/pkg/keep.txt'), 'original dependency');
  if (directoryIgnore) {
    await writeFile(join(root, '.gitignore'), 'node_modules/\n');
    await execute('git', ['-C', root, 'add', '.gitignore']);
    await execute('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture ignore']);
  }
  await setConfig(root, 'worktrees.links', '["node_modules","missing-deps"]');
  const created = await createWorktree(root, task.id);
  expect((await lstat(join(created.path, 'node_modules'))).isSymbolicLink()).toBe(true);
  expect(await realpath(join(created.path, 'node_modules'))).toBe(await realpath(join(root, 'node_modules')));
  await execute('git', ['-C', created.path, 'check-ignore', '-q', 'node_modules']);
  expect((await readFile(join(root, '.git/info/exclude'), 'utf8')).split('\n').filter(line => line === '/node_modules')).toHaveLength(1);
  expect((await readLedger(root)).filter(e => e.action === 'worktree:link')).toEqual([
    expect.objectContaining({ evidence: { taskId: task.id, linked: ['node_modules'], skipped: ['missing-deps'] } }),
  ]);
  await updateState(root, { state: 'DOCS' });
  expect(await removeWorktree(root, task.id)).toMatchObject({ removed: true });
  expect(await readFile(join(root, 'node_modules/pkg/keep.txt'), 'utf8')).toBe('original dependency');
  await createWorktree(root, task.id);
  expect((await readFile(join(root, '.git/info/exclude'), 'utf8')).split('\n').filter(line => line === '/node_modules')).toHaveLength(1);
  expect((await readLedger(root)).filter(e => e.action === 'worktree:link-excluded')).toHaveLength(1);
});
it('H10 checkout 기존 파일은 덮지 않고 skipped', async () => {
  const { root, task } = await setup();
  await writeFile(join(root, 'dependency.txt'), 'tracked');
  await execute('git', ['-C', root, 'add', 'dependency.txt']);
  await execute('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture dependency']);
  await setConfig(root, 'worktrees.links', '["dependency.txt"]');
  const created = await createWorktree(root, task.id);
  expect((await lstat(join(created.path, 'dependency.txt'))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(created.path, 'dependency.txt'), 'utf8')).toBe('tracked');
  expect((await readLedger(root)).find(e => e.action === 'worktree:link')?.evidence).toEqual({ taskId: task.id, linked: [], skipped: ['dependency.txt'] });
});
it('H10 CLEANUP·디스크 집계는 링크를 따라가지 않고 root 원본을 보존한다', async () => {
  const { root, task } = await setup();
  await mkdir(join(root, 'server/node_modules/pkg'), { recursive: true });
  await writeFile(join(root, 'server/node_modules/pkg/large.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
  await setConfig(root, 'worktrees.links', '["server/node_modules"]');
  const created = await createWorktree(root, task.id);
  await setConfig(root, 'cleanup.sharedCaches', JSON.stringify({ enabled: true, paths: [join(created.path, 'server/node_modules')] }));
  const report = await runCleanup(root, { scope: 'storage', dryRun: true });
  const cache = report.storage!.sharedCaches[0];
  expect(cache.sizeKB).not.toBeNull(); expect(cache.sizeKB!).toBeLessThan(4096);
  await updateState(root, { state: 'CLEANUP', taskId: task.id });
  const cleaned = await runCleanup(root, { scope: 'worktrees', taskId: task.id });
  expect(cleaned).toMatchObject({ ok: true, worktrees: { removed: [created.path], kept: [] } });
  expect((await readFile(join(root, 'server/node_modules/pkg/large.bin'))).length).toBe(4 * 1024 * 1024);
});
it('R8 등록 워크트리 재시도는 누락 링크·exclude를 보완하고 올바른 링크를 보존한다', async () => {
  const { root, task } = await setup();
  await mkdir(join(root, 'node_modules')); await mkdir(join(root, 'deps'));
  await setConfig(root, 'worktrees.links', '["node_modules","deps"]');
  const created = await createWorktree(root, task.id);
  const unchanged = await lstat(join(created.path, 'node_modules'));
  await rm(join(created.path, 'deps'));
  await writeFile(join(root, '.git/info/exclude'), '');
  expect(await createWorktree(root, task.id)).toMatchObject({ created: false });
  expect((await lstat(join(created.path, 'node_modules'))).ino).toBe(unchanged.ino);
  expect(await realpath(join(created.path, 'deps'))).toBe(await realpath(join(root, 'deps')));
  expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toContain('/node_modules\n');
  expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toContain('/deps\n');
});
