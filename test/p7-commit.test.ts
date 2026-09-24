import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitProject, git } from './p7-git-helpers.ts';
import { project, cli } from './p5-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { commitWorktree, validateTaskCommit } from '../src/core/worktree.ts';
import { runVerify } from '../src/core/verify.ts';
import { setConfig } from '../src/core/config.ts';
import { readLedger } from '../src/core/ledger.ts';

async function verify(root: string) {
  await setConfig(root, 'verify.commands', JSON.stringify([`${process.execPath} -e "process.exit(0)"`]));
  expect((await runVerify(root)).ok).toBe(true);
}
async function implement(root: string, path: string, taskId: string) {
  await writeFile(join(path, 'code.txt'), 'implemented\n');
  const result = await commitWorktree(root, taskId, 'implementation');
  if (!('commit' in result)) throw new Error('commit missing');
  await verify(root);
  return result.commit;
}
it('H1 실제 git: base·없는 SHA·dirty·과거 SHA 거부, 새 HEAD만 검수 허용', { timeout: 60_000 }, async () => {
  const { root, path, task, base, worktree } = await gitProject();
  expect((await readState(root)).worktrees?.[0]).toMatchObject({ base, branch: worktree.branch });
  await verify(root);
  await expect(validateTaskCommit(root, task.id, base, 'review')).rejects.toThrow('검수 대상');
  await expect(validateTaskCommit(root, task.id, 'deadbeef', 'review')).rejects.toThrow();
  const commit = await implement(root, path, task.id);
  await expect(validateTaskCommit(root, task.id, base, 'review')).rejects.toThrow('검증 시점 HEAD');
  await writeFile(join(path, 'dirty.txt'), 'dirty');
  expect((await cli(root, ['backlog', 'set', task.id, '--review-commit', commit])).code).toBe(1);
  await git(path, 'add', '.'); await git(path, 'commit', '-m', 'followup');
  const head = await git(path, 'rev-parse', 'HEAD');
  await verify(root);
  await expect(validateTaskCommit(root, task.id, commit, 'review')).rejects.toThrow('검증 시점 HEAD');
  expect((await cli(root, ['backlog', 'set', task.id, '--review-commit', head])).code).toBe(0);
});
it.each(['merge', 'ff'])('H1 실제 %s 병합 전 review 자체는 거부하고 병합 뒤 루트 HEAD만 인정한다', { timeout: 60_000 }, async mode => {
  const { root, path, task } = await gitProject();
  const review = await implement(root, path, task.id);
  await setTask(root, task.id, { review: { commit: review } });
  await expect(validateTaskCommit(root, task.id, review, 'merge')).rejects.toThrow('병합 커밋');
  await git(root, 'merge', mode === 'ff' ? '--ff-only' : '--no-ff', review, '-m', 'merge implementation');
  const merged = await git(root, 'rev-parse', 'HEAD');
  expect((await cli(root, ['backlog', 'set', task.id, '--merge-commit', merged])).code).toBe(0);
  if (mode === 'merge') await expect(validateTaskCommit(root, task.id, review, 'merge')).rejects.toThrow('병합 커밋');
});
it('H1 기존 등록의 base 누락은 루트 브랜치와 merge-base로 보완한다', { timeout: 60_000 }, async () => {
  const { root, path, task, base } = await gitProject();
  const commit = await implement(root, path, task.id);
  await updateState(root, state => ({ worktrees: state.worktrees?.map(item => ({ ...item, base: undefined })) }));
  await validateTaskCommit(root, task.id, commit, 'review');
  expect((await readState(root)).worktrees?.[0].base).toBe(base);
});
it('H1 다른 브랜치·detached HEAD 검수는 거부한다', { timeout: 60_000 }, async () => {
  const { root, path, task } = await gitProject(); const commit = await implement(root, path, task.id);
  await git(path, 'checkout', '-b', 'other');
  await expect(validateTaskCommit(root, task.id, commit, 'review')).rejects.toThrow('검수 대상');
  await git(path, 'checkout', '--detach');
  await expect(validateTaskCommit(root, task.id, commit, 'review')).rejects.toThrow('검수 대상');
});
it('F14 비-git은 none만 허용한다', async () => {
  const root = await project(), task = await addTask(root, { title: 'plain', category: 'docs' });
  for (const kind of ['review', 'merge'] as const) {
    await expect(validateTaskCommit(root, task.id, 'aaaa1111', kind)).rejects.toThrow('none');
    await validateTaskCommit(root, task.id, 'none', kind);
  }
});
it.each(['tracked', 'untracked', 'staged'])('F14 실제 git %s 비밀 추가는 커밋을 거부한다', { timeout: 60_000 }, async kind => {
  const { root, path, task, base } = await gitProject();
  const secret = 'sk-ant-FAKE_TEST_CREDENTIAL';
  await writeFile(join(path, kind === 'untracked' ? 'new.txt' : 'code.txt'), kind === 'staged' ? `++${secret}` : secret);
  if (kind === 'staged') await git(path, 'add', '.');
  await expect(commitWorktree(root, task.id, 'unsafe')).rejects.toThrow('비밀값');
  expect(await git(path, 'rev-parse', 'HEAD')).toBe(base);
  const ledger = await readLedger(root);
  expect(JSON.stringify(ledger)).not.toContain(secret);
  expect(ledger.findLast(e => e.action === 'worktree:commit')?.status).toBe('fail');
});
it('L4 등록 브랜치가 아니면 커밋 전에 거부한다', { timeout: 60_000 }, async () => {
  const { root, path, task, base } = await gitProject();
  await git(path, 'checkout', '-b', 'wrong');
  await writeFile(join(path, 'code.txt'), 'change');
  await expect(commitWorktree(root, task.id, 'wrong branch')).rejects.toThrow('등록된 task 브랜치');
  expect(await git(path, 'rev-parse', 'HEAD')).toBe(base);
  expect(await git(path, 'diff', '--cached', '--name-only')).toBe('');
});
it('L4 큰 untracked·바이너리는 내용 대신 이름만 원장에 남긴다', { timeout: 60_000 }, async () => {
  const { root, path, task } = await gitProject();
  const secret = 'sk-ant-FAKE_TEST_CREDENTIAL';
  await writeFile(join(path, 'large.txt'), secret + 'x'.repeat(1024 * 1024));
  await writeFile(join(path, 'binary.dat'), Buffer.from(`\0${secret}`));
  expect(await commitWorktree(root, task.id, 'assets')).toHaveProperty('commit');
  const ledger = await readLedger(root);
  expect(ledger.find(e => e.action === 'worktree:commit:unscanned')?.evidence).toEqual({ files: ['binary.dat', 'large.txt'] });
  expect(JSON.stringify(ledger)).not.toContain(secret);
});
it('L4 기존 비밀 문맥·삭제 줄은 새 추가 검사에 포함하지 않는다', { timeout: 60_000 }, async () => {
  const { root, path, task } = await gitProject();
  await writeFile(join(path, 'code.txt'), 'sk-ant-FAKE_OLD_CREDENTIAL\nold\nsk-ant-FAKE_REMOVED_CREDENTIAL\n');
  await git(path, 'add', '.'); await git(path, 'commit', '-m', 'legacy fixture');
  await writeFile(join(path, 'code.txt'), 'sk-ant-FAKE_OLD_CREDENTIAL\nnew\n');
  expect(await commitWorktree(root, task.id, 'safe edit')).toHaveProperty('commit');
});
it('L4 .pi는 add에서 제외하고 변경 없으면 구조화된 결과를 반환한다', { timeout: 60_000 }, async () => {
  const { mkdir } = await import('node:fs/promises');
  const { root, path, task, base } = await gitProject();
  expect(await commitWorktree(root, task.id, 'empty')).toEqual({ ok: false, error: '커밋할 변경이 없습니다' });
  expect(await git(path, 'rev-parse', 'HEAD')).toBe(base);
  await writeFile(join(path, '.gitignore'), 'docs/\n');
  await mkdir(join(path, '.pi'));
  await writeFile(join(path, '.pi/private.txt'), 'sk-ant-FAKE_TEST_CREDENTIAL');
  expect(await commitWorktree(root, task.id, 'exclude harness')).toHaveProperty('commit');
  expect(await git(path, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.pi/');
  expect(await commitWorktree(root, task.id, 'only pi')).toEqual({ ok: false, error: '커밋할 변경이 없습니다' });
});
it('S1 루트의 task 브랜치 checkout 우회를 막고 base 브랜치의 실제 병합만 허용한다', { timeout: 60_000 }, async () => {
  const { root, path, task, worktree } = await gitProject();
  expect((await readState(root)).worktrees?.[0].baseBranch).toBe('main');
  const review = await implement(root, path, task.id);
  await setTask(root, task.id, { review: { commit: review } });
  await git(root, 'checkout', '--ignore-other-worktrees', worktree.branch);
  await expect(validateTaskCommit(root, task.id, review, 'merge')).rejects.toThrow('루트 브랜치가 base 브랜치(main)가 아닙니다');
  await git(root, 'checkout', 'main');
  await git(root, 'merge', '--ff-only', review);
  await validateTaskCommit(root, task.id, review, 'merge');
});
it('S1 detached 루트의 create는 거부하고 기존 baseBranch 누락은 경고 원장을 남긴다', { timeout: 60_000 }, async () => {
  const { createWorktree } = await import('../src/core/worktree.ts');
  const { root, path, task } = await gitProject();
  await git(root, 'checkout', '--detach');
  const next = await addTask(root, { title: 'detached', category: 'docs' });
  await expect(createWorktree(root, next.id)).rejects.toThrow('루트가 브랜치 위에 있어야 합니다');
  await git(root, 'checkout', 'main');
  const review = await implement(root, path, task.id);
  await git(root, 'merge', '--ff-only', review);
  await updateState(root, state => ({ worktrees: state.worktrees?.map(item => ({ ...item, baseBranch: undefined })) }));
  await validateTaskCommit(root, task.id, review, 'merge', review);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'merge-commit:base-branch-unknown', taskId: task.id }));
});

it('P3 MERGE 진입 루트 HEAD를 보존하고 base 브랜치 강제 이동을 거부한다', { timeout: 60_000 }, async () => {
  const { transitionState } = await import('../src/core/state.ts');
  const { atomicWrite } = await import('../src/core/storage.ts');
  const { metaPath } = await import('../src/core/codex-record.ts');
  const { root, path, task } = await gitProject();
  const review = await implement(root, path, task.id);
  await setTask(root, task.id, { review: { commit: review, high: 0 } });
  await writeFile(join(root, 'root.txt'), 'root advancement');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'root advancement');
  const beforeMerge = await git(root, 'rev-parse', 'HEAD');
  await updateState(root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await transitionState(root, 'REVIEW', task.id);
  await atomicWrite(metaPath(root, 'evidence'), JSON.stringify({ kind: 'task', taskId: task.id, status: 'ok' }));
  await transitionState(root, 'MERGE', task.id);
  expect((await readState(root)).mergeBase).toBe(beforeMerge);
  await git(root, 'checkout', '--detach');
  await git(root, 'branch', '-f', 'main', review);
  await git(root, 'checkout', 'main');
  await expect(validateTaskCommit(root, task.id, review, 'merge')).rejects.toThrow('병합 커밋');
  await git(root, 'checkout', '--detach'); await git(root, 'branch', '-f', 'main', beforeMerge); await git(root, 'checkout', 'main');
  await git(root, 'merge', '--no-ff', review, '-m', 'proper merge');
  await writeFile(join(root, 'uncommitted-harness.txt'), 'root need not be clean');
  await validateTaskCommit(root, task.id, await git(root, 'rev-parse', 'HEAD'), 'merge');
});
it('P4 검증 증거 필수·다른 task/과거 증거 거부·짧은 SHA 허용', { timeout: 60_000 }, async () => {
  const { root, path, task } = await gitProject();
  await writeFile(join(path, 'code.txt'), 'implementation');
  const commit = await commitWorktree(root, task.id, 'implementation');
  if (!('commit' in commit)) throw new Error('commit missing');
  await expect(validateTaskCommit(root, task.id, commit.commit, 'review')).rejects.toThrow('검증 증거가 없습니다');
  await verify(root);
  const proof = (await readState(root)).verify!;
  for (const patch of [{ taskId: 'T99' }, { at: '2000-01-01T00:00:00Z' }, { ok: false }]) {
    await updateState(root, { verify: { ...proof, ...patch } });
    await expect(validateTaskCommit(root, task.id, commit.commit, 'review')).rejects.toThrow('검증 증거가 없습니다');
  }
  await updateState(root, { verify: proof });
  expect((await cli(root, ['backlog', 'set', task.id, '--review-commit', commit.commit.slice(0, 7)])).code).toBe(0);
});
it('P6 검증이 만든 dirty 경로는 결과·상태·검수 거부 진단에 남는다', { timeout: 60_000 }, async () => {
  const { readFile } = await import('node:fs/promises');
  const { root, path, task } = await gitProject();
  const commit = await implement(root, path, task.id);
  await setConfig(root, 'verify.commands', JSON.stringify([`${process.execPath} -e "require('node:fs').writeFileSync('verify-output.txt','generated')"`]));
  const report = await runVerify(root);
  expect(report).toMatchObject({ ok: true, dirtyAfter: ['verify-output.txt'] });
  expect((await readState(root)).verify?.dirtyAfter).toEqual(['verify-output.txt']);
  if (!('runId' in report)) throw new Error('result missing');
  expect(JSON.parse(await readFile(join(root, '.pi/verify', report.runId, 'result.json'), 'utf8')).dirtyAfter).toEqual(['verify-output.txt']);
  await expect(validateTaskCommit(root, task.id, commit, 'review')).rejects.toThrow('verify-output.txt — 검증 산출물이면 프로젝트 .gitignore 에 추가(위임)');
});
