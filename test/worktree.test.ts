import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink, realpath } from 'node:fs/promises';
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
