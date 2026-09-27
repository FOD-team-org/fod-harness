import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitProject, git } from './p7-git-helpers.ts';
import { project } from './p5-helpers.ts';
import { mergeWorktree, commitWorktree } from '../src/core/worktree.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { readLedger, unknownEntries } from '../src/core/ledger.ts';
import { atomicWrite } from '../src/core/storage.ts';
import { metaPath } from '../src/core/codex-record.ts';
import { buildHeader } from '../src/core/codex.ts';
import { workspace } from './w2-helpers.ts';
import { loadConfig } from '../src/core/config.ts';
import { repoOf } from '../src/core/workspace.ts';
import { runPick } from '../src/core/pick.ts';
import { readJudgment } from '../src/core/judgment.ts';
vi.mock('../src/core/process-time.ts', async original => ({ ...await original<object>(), processStartedAt: async () => '2026-09-27T00:00:00Z' }));
it.each([false, true])('한 레포 merge·추적 문서 dirty 허용·덮어쓸 dirty not-started=%s', async overwrite => {
  const { root, path, task, base } = await gitProject();
  await git(root, 'add', '-f', 'docs/backlog.md'); await git(root, 'commit', '-m', 'track docs');
  await writeFile(join(path, 'code.txt'), 'implementation'); const c = await commitWorktree(root, task.id, 'impl');
  if (!('commit' in c)) throw new Error('fixture');
  await setTask(root, task.id, { status: 'merge', review: { commit: c.commit, high: 0 } });
  await updateState(root, { state: 'MERGE', taskId: task.id, mergeBase: base });
  if (overwrite) await writeFile(join(root, 'code.txt'), 'local dirty');
  if (overwrite) {
    await expect(mergeWorktree(root, task.id)).rejects.toThrow('병합을 시작하지 못했습니다: T01 → main — 기준 브랜치의 로컬 변경·잠금을 확인');
    expect((await readLedger(root)).at(-1)?.evidence).toMatchObject({ reason: 'not-started', aborted: false });
    expect(await git(root, 'diff', '--', 'code.txt')).toContain('local dirty');
  } else {
    const result = await mergeWorktree(root, task.id); expect(result).not.toHaveProperty('repo');
    expect(await git(root, 'status', '--porcelain', '--', 'docs/backlog.md')).not.toBe('');
    expect((await getTask(root, task.id)).merge?.commit).toBe(result.mergeCommit);
  }
  expect(await unknownEntries(root)).toEqual([]);
});
it('비-git REVIEW→MERGE는 merge.base를 만들지 않고 기존 null mergeBase를 기록', async () => {
  const root = await project('REVIEW'), task = await addTask(root, { title: 'plain', category: 'docs' });
  await updateState(root, { taskId: task.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await atomicWrite(metaPath(root, 'proof'), JSON.stringify({ kind: 'task', taskId: task.id, status: 'ok' }));
  await transitionState(root, 'MERGE', task.id);
  expect((await getTask(root, task.id)).merge?.base).toBeUndefined();
  expect((await readState(root)).mergeBase).toBeNull();
});
it('머리말 템플릿은 W2 이전 고정본과 바이트 동일하고 대상 레포는 작업 폴더 바로 다음 줄', async () => {
  expect(await readFile('templates/codex-header.md')).toEqual(await readFile(new URL('./w2-header-template.fixture.md', import.meta.url)));
  const f = await workspace(), member = await repoOf(f.root, await loadConfig(f.root), { repo: 'web' });
  const meta = { kind: 'task' as const, taskId: 'T01', runId: 'fixed', cwd: '/tmp/wt', sandbox: 'workspace-write' as const, workerModel: 'worker', workerEffort: 'high' };
  const lines = (await buildHeader(meta, 1, 'spec', member)).split('\n');
  const folder = lines.findIndex(line => line.startsWith('- 작업 폴더:'));
  expect(folder).toBeGreaterThanOrEqual(0);
  expect(lines[folder + 1]).toBe(`- 대상 레포: web (${member.path}) — 다른 멤버 레포는 읽기만 한다. 그 레포의 AGENTS.md 규칙을 따른다.`);
  expect(await buildHeader({ ...meta, kind: 'research' }, 1, 'spec', member)).not.toContain('- 대상 레포:');
});
it('한 레포 기준점 어긋남은 repo 점 표시 없이 판단으로 막힌다', async () => {
  const { root, task } = await gitProject();
  await setTask(root, task.id, { status: 'merge', merge: { base: 'deadbeef' }, resume: { status: 'merge', state: 'MERGE', at: '2026-09-27' } });
  await updateState(root, { state: 'PICK', taskId: undefined, resumeTask: undefined });
  expect((await runPick(root)).outcome).toBe('WAIT_JUDGMENT');
  const item = (await readJudgment(root)).items.find(item => item.title.startsWith('병합 기준점'))!;
  expect(item.title).toBe(`병합 기준점 어긋남 ${task.id}: 새 기준점으로 병합 / 보류`);
  expect(item.background).toBe('main가 검수 때 기준점(deadbee) 뒤로 되돌려졌습니다. 확인 없이 병합하지 않습니다.');
  expect(item.title).not.toContain('·.'); expect(item.background).not.toMatch(/^\. /u);
  expect((await getTask(root, task.id)).status).toBe(`blocked(${item.id})`);
});
