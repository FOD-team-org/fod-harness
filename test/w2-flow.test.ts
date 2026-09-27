import { expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { workspace, git } from './w2-helpers.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { runPick } from '../src/core/pick.ts';
import { transitionState, readState, updateState } from '../src/core/state.ts';
import { createWorktree, commitWorktree, mergeWorktree, validateTaskCommit } from '../src/core/worktree.ts';
import { runVerify } from '../src/core/verify.ts';
import { startCodex, readMeta, resultDir } from '../src/core/codex.ts';
import { setConfig } from '../src/core/config.ts';
import { runCleanup } from '../src/core/cleanup.ts';
import { readLedger } from '../src/core/ledger.ts';
import { todayKst } from '../src/core/template-values.ts';

it('멤버 3개 의존 PICK→SPEC→IMPLEMENT(fake Codex)→VERIFY→REVIEW→MERGE→DOCS→CLEANUP', { timeout: 60000 }, async () => {
  const f = await workspace();
  await setConfig(f.root, 'delegate.codex.command', JSON.stringify([process.execPath, resolve('test/fake-codex/codex')]));
  const first = await addTask(f.root, { repo: 'web', title: 'web 구현', category: 'non-design' });
  const second = await addTask(f.root, { repo: 'backend', title: 'backend 구현', category: 'non-design', depends: [first.id] });
  const third = await addTask(f.root, { repo: 'app', title: 'app 구현', category: 'non-design', depends: [second.id] });
  await writeFile(join(f.root, 'spec.md'), '세 멤버 fixture spec');
  const order: string[] = [];
  for (const task of [first, second, third]) {
    if (task.id === second.id) expect((await getTask(f.root, first.id)).merge?.commit).toBeTruthy();
    expect(await runPick(f.root)).toMatchObject({ outcome: 'SPEC', task: { id: task.id } });
    order.push(`pick:${task.id}`);
    const wt = await createWorktree(f.root, task.id); await transitionState(f.root, 'IMPLEMENT', task.id);
    // Existing fake Codex can write its received prompt; use this fixture capability as the implementation change.
    vi.stubEnv('FAKE_CODEX_STDIN_FILE', join(wt.path, 'code.txt'));
    const run = await startCodex(f.root, 'task', { taskId: task.id, spec: 'spec.md' });
    try {
      await vi.waitFor(async () => expect((await readMeta(f.root, run.runId))?.status).toBe('ok'), { timeout: 10000, interval: 40 });
    } finally { if ('pid' in run && typeof run.pid === 'number') { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* already exited */ } } }
    expect(await readFile(join(wt.path, 'code.txt'), 'utf8')).toContain(`대상 레포: ${task.repo}`);
    await updateState(f.root, { delegation: undefined });
    const commit = await commitWorktree(f.root, task.id, 'implementation'); if (!('commit' in commit)) throw new Error('fixture commit');
    await transitionState(f.root, 'VERIFY', task.id); expect((await runVerify(f.root)).ok).toBe(true);
    await validateTaskCommit(f.root, task.id, commit.commit, 'review');
    await setTask(f.root, task.id, { review: { commit: commit.commit, high: 0 } });
    await transitionState(f.root, 'REVIEW', task.id); await transitionState(f.root, 'MERGE', task.id);
    if (task.id === first.id) {
      expect((await getTask(f.root, first.id)).merge?.commit).toBeUndefined();
      expect((await runPick(f.root)).task?.id).toBe(first.id);
      expect(order).not.toContain(`pick:${second.id}`);
    }
    const merged = await mergeWorktree(f.root, task.id);
    expect((await getTask(f.root, task.id)).merge?.commit).toBe(merged.mergeCommit);
    order.push(`record-merge:${task.id}`);
    expect((await git(f.member(task.repo), 'rev-list', '--parents', '-n', '1', merged.mergeCommit)).split(' ')[2]).toBe(commit.commit);
    expect(await git(f.member(task.repo), 'log', '-1', '--format=%s')).toBe(`merge(${task.id}): ${task.title}`);
    await transitionState(f.root, 'DOCS', { taskId: task.id, commit: commit.commit });
    await mkdir(join(f.root, 'docs/작업일지'), { recursive: true });
    await writeFile(join(f.root, `docs/작업일지/${todayKst()}.md`), task.id);
    await transitionState(f.root, 'CLEANUP', task.id);
    expect((await runCleanup(f.root, { scope: 'all', taskId: task.id })).ok).toBe(true);
    await setTask(f.root, task.id, { status: 'done' });
    expect(await git(f.member(task.repo), 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
    await transitionState(f.root, 'PICK');
  }
  expect((await runPick(f.root)).outcome).toBe('DONE_ALL');
  expect(order.indexOf(`record-merge:${first.id}`)).toBeLessThan(order.indexOf(`pick:${second.id}`));
  expect(order.indexOf(`record-merge:${second.id}`)).toBeLessThan(order.indexOf(`pick:${third.id}`));
  expect(await readFile(join(f.root, 'code.txt')).catch(() => null)).toBeNull();
  expect((await readState(f.root)).worktrees).toEqual([]);
  for (const e of (await readLedger(f.root)).filter(e => /^(worktree:(create|remove|commit|merge)|verify:run)$/u.test(e.action))) expect(e.evidence).toHaveProperty('repo');
});
