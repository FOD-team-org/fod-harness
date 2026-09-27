import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeReady, workspace, git } from './w2-helpers.ts';
import { addTask, getTask, setTask, syncBacklog, listBacklog } from '../src/core/backlog.ts';
import { runPick } from '../src/core/pick.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { answerJudgment, applyJudgments, readJudgment, addJudgment } from '../src/core/judgment.ts';
import { readLedger } from '../src/core/ledger.ts';
import { atomicWrite } from '../src/core/storage.ts';
import { metaPath } from '../src/core/codex-record.ts';
import { mergeWorktree, createWorktree, commitWorktree } from '../src/core/worktree.ts';
import { reclaimTask } from '../src/core/reclaim.ts';
import * as storage from '../src/core/storage.ts';
import * as mergeBase from '../src/core/merge-base.ts';
async function rewind(f: Awaited<ReturnType<typeof mergeReady>>) {
  await writeFile(join(f.member(), 'later'), 'later'); await git(f.member(), 'add', '.'); await git(f.member(), 'commit', '-m', 'later');
  await setTask(f.root, f.task.id, { merge: { base: await git(f.member(), 'rev-parse', 'HEAD') } });
  await git(f.member(), 'reset', '--hard', f.base);
}
async function suspend(f: Awaited<ReturnType<typeof mergeReady>>) {
  await transitionState(f.root, 'paused(slot)', { system: true }); await transitionState(f.root, 'PICK');
}
it('REVIEW 전이 콜백 재시도 안에서 끝을 다시 읽고 state.mergeBase는 보존', async () => {
  const f = await mergeReady(); await updateState(f.root, { state: 'REVIEW', phase: 'task', mergeBase: 'another-repo-base' });
  await atomicWrite(metaPath(f.root, 'review-proof'), JSON.stringify({ kind: 'task', taskId: f.task.id, status: 'ok' }));
  await setTask(f.root, f.task.id, { merge: { base: 'old', baseJudgment: 'A1' } });
  const original = storage.withFileLock; let raced = false;
  vi.spyOn(storage, 'withFileLock').mockImplementation(async (path, action, options) => {
    if (!raced && path === join(f.root, '.pi/harness-state.json')) {
      raced = true; const state = JSON.parse(await readFile(path, 'utf8')); state.race = true; await writeFile(path, JSON.stringify(state));
      await writeFile(join(f.member(), 'later'), 'later'); await git(f.member(), 'add', '.'); await git(f.member(), 'commit', '-m', 'during callback retry');
    }
    return original(path, action, options);
  });
  await transitionState(f.root, 'MERGE', f.task.id);
  expect((await getTask(f.root, f.task.id)).merge).toMatchObject({ base: await git(f.member(), 'rev-parse', 'main') });
  expect((await getTask(f.root, f.task.id)).merge?.baseJudgment).toBeUndefined();
  expect((await readState(f.root)).mergeBase).toBe('another-repo-base');
});
it.each(['1', '2'])('회수 없는 paused 복귀·되돌림 판단·선택 %s', async answer => {
  const f = await mergeReady(); await rewind(f); await suspend(f);
  expect((await runPick(f.root)).outcome).toBe('WAIT_JUDGMENT');
  const task = await getTask(f.root, f.task.id), id = task.merge!.baseJudgment!;
  expect(task).toMatchObject({ status: `blocked(${id})`, resume: { status: 'merge', state: 'MERGE' } });
  const item = (await readJudgment(f.root)).items[0]; expect(item.title).toContain('병합 기준점 어긋남 T01·web');
  expect(item.resolution).toBe('resume'); expect(item.origin).toBeUndefined();
  expect((await readState(f.root)).resumeTask).toBeUndefined();
  await answerJudgment(f.root, id, answer); await applyJudgments(f.root);
  if (answer === '1') {
    expect(await runPick(f.root)).toMatchObject({ outcome: 'RESUME', next: 'MERGE' });
    expect((await getTask(f.root, f.task.id)).merge?.base).toBe(f.base);
    expect(await readLedger(f.root)).toContainEqual(expect.objectContaining({ action: 'merge-base:reset', evidence: { repo: 'web', reason: 'judged', judgment: id } }));
  } else {
    expect((await getTask(f.root, f.task.id)).status).toBe(`blocked(${id})`);
    await setTask(f.root, f.task.id, { status: 'merge' }); await transitionState(f.root, 'PICK', { system: true });
    expect((await runPick(f.root)).outcome).toBe('WAIT_JUDGMENT');
    expect((await getTask(f.root, f.task.id)).merge?.baseJudgment).not.toBe(id);
  }
});
it('기준 브랜치가 없으면 ① 완료에도 막는 쪽으로 닫힌다', async () => {
  const f = await mergeReady(); await suspend(f);
  await git(f.member(), 'checkout', '-b', 'other'); await git(f.member(), 'branch', '-D', 'main');
  expect((await runPick(f.root)).outcome).toBe('WAIT_JUDGMENT');
  const id = (await getTask(f.root, f.task.id)).judgment;
  await answerJudgment(f.root, id, '1'); await applyJudgments(f.root);
  expect((await runPick(f.root)).outcome).toBe('WAIT_JUDGMENT');
});
it('missing base 재설정·백로그 md 들여오기/sync 보존·spec rev 초기화', async () => {
  const f = await mergeReady(); await setTask(f.root, f.task.id, { merge: { base: undefined } }); await suspend(f);
  expect((await runPick(f.root)).outcome).toBe('RESUME');
  const path = join(f.root, 'docs/backlog.md'); await writeFile(path, (await readFile(path, 'utf8')).replace('구현', '제목 수정'));
  expect((await listBacklog(f.root))[0].merge?.base).toBe(f.base);
  await syncBacklog(f.root); expect((await getTask(f.root, f.task.id)).merge?.base).toBe(f.base);
  await setTask(f.root, f.task.id, { spec: { rev: 1 } }); expect((await getTask(f.root, f.task.id)).merge).toEqual({});
});
it('재계산한 두 번째 MERGE도 차단한다', async () => {
  const f = await mergeReady(); await rewind(f); await suspend(f);
  const other = await addTask(f.root, { repo: 'backend', title: 'other', category: 'docs' });
  await setTask(f.root, other.id, { status: 'merge', merge: { base: 'deadbeef' }, resume: { status: 'merge', state: 'MERGE', at: '2020-01-01' } });
  expect((await runPick(f.root)).outcome).toBe('WAIT_JUDGMENT');
  expect((await listBacklog(f.root)).every(t => t.status.startsWith('blocked('))).toBe(true);
  expect((await readJudgment(f.root)).items).toHaveLength(2);
});
it('MERGE 재개 차단 뒤 재계산에서 발견한 orphan도 판단과 blocked를 남긴다', async () => {
  const f = await mergeReady(); await rewind(f); await suspend(f);
  const orphan = await addTask(f.root, { repo: 'backend', title: 'orphan', category: 'docs' });
  await setTask(f.root, orphan.id, { status: 'doing' });
  expect((await runPick(f.root)).outcome).toBe('WAIT_JUDGMENT');
  const items = (await readJudgment(f.root)).items;
  const judgment = items.find(item => item.title === `고아 task ${orphan.id}: 재개 / 폐기`)!;
  expect(judgment).toBeDefined();
  expect((await getTask(f.root, orphan.id)).status).toBe(`blocked(${judgment.id})`);
  expect(items).toHaveLength(2);
});
it('재계산이 진전하지 않으면 task 수 한도로 멈춘다', async () => {
  const f = await mergeReady(); await suspend(f);
  await setTask(f.root, f.task.id, { resume: { status: 'merge', state: 'MERGE', at: '2020-01-01' } });
  vi.spyOn(mergeBase, 'checkMergeResume').mockResolvedValue(false);
  expect(await runPick(f.root)).toMatchObject({ outcome: 'WAIT_JUDGMENT', reason: expect.stringContaining('pick:merge-base-loop') });
});
it('web MERGE 회수 사이 backend가 병합되어도 web 기준점·재개·병합이 독립적', async () => {
  const f = await mergeReady();
  const { item } = await addJudgment(f.root, { title: '대기', background: 'fixture', options: ['재개', '보류'], recommend: '①', blocks: f.task.id, resolution: 'resume' });
  expect((await reclaimTask(f.root, f.task.id, item.id)).reclaimed).toBe(true);
  const other = await addTask(f.root, { repo: 'backend', title: 'backend', category: 'docs' });
  const wt = await createWorktree(f.root, other.id); await writeFile(join(wt.path, 'feature'), 'backend');
  const c = await commitWorktree(f.root, other.id, 'backend'); if (!('commit' in c)) throw new Error('fixture');
  await setTask(f.root, other.id, { review: { commit: c.commit, high: 0 } });
  await updateState(f.root, { state: 'REVIEW', taskId: other.id, phase: 'task' });
  await atomicWrite(metaPath(f.root, 'other-proof'), JSON.stringify({ kind: 'task', taskId: other.id, status: 'ok' }));
  await transitionState(f.root, 'MERGE', other.id); await mergeWorktree(f.root, other.id);
  await setTask(f.root, other.id, { status: 'done', verify: { ok: true }, docs: { ok: true }, cleanup: { ok: true } });
  await answerJudgment(f.root, item.id, '1'); await applyJudgments(f.root); await updateState(f.root, { state: 'PICK', taskId: undefined });
  expect(await runPick(f.root)).toMatchObject({ outcome: 'RESUME', next: 'MERGE', task: { id: f.task.id } });
  await createWorktree(f.root, f.task.id);
  expect(await mergeWorktree(f.root, f.task.id)).toHaveProperty('mergeCommit');
  expect((await getTask(f.root, f.task.id)).merge?.base).toBe(f.base);
});
