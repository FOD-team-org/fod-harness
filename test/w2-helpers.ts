import { vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, writeConfig, git } from './w1-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { updateState } from '../src/core/state.ts';
import { createWorktree, commitWorktree } from '../src/core/worktree.ts';
export { git, writeConfig };
export async function workspace(names = ['web', 'backend', 'app']) {
  const f = await fixture(names);
  vi.stubEnv('FODH_NOTIFY_OS', 'off'); vi.stubEnv('FODH_SLOTS_DIR', join(f.parent, 'slots'));
  for (const repo of Object.values(f.repos)) repo.verify.commands = [`${process.execPath} -e "process.exit(0)"`];
  await writeConfig(f.root, { ...f.candidate, notify: { channels: ['ledger'] }, delegate: { codex: { externalGuard: false } } });
  await updateState(f.root, { state: 'PICK', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  return f;
}
export async function mergeReady(repo = 'web') {
  const f = await workspace();
  const task = await addTask(f.root, { repo, title: '구현', category: 'non-design' });
  const wt = await createWorktree(f.root, task.id);
  await writeFile(join(wt.path, 'feature.txt'), 'implemented\n');
  const committed = await commitWorktree(f.root, task.id, 'implementation');
  if (!('commit' in committed)) throw new Error('fixture commit failed');
  const base = await git(f.member(repo), 'rev-parse', 'main');
  await setTask(f.root, task.id, { status: 'merge', review: { commit: committed.commit, high: 0 }, merge: { base } });
  await updateState(f.root, { state: 'MERGE', taskId: task.id });
  return { ...f, task, wt, review: committed.commit, base };
}
