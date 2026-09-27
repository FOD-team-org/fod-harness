import { expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeReady, git } from './w2-helpers.ts';
import { mergeWorktree, validateTaskCommit } from '../src/core/worktree.ts';
import { getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { appendLedger, readLedger, unknownEntries } from '../src/core/ledger.ts';
import { readJudgment } from '../src/core/judgment.ts';
import { atomicWrite } from '../src/core/storage.ts';
import { main } from '../src/cli/index.ts';
async function hook(path: string, body: string) { await writeFile(join(path, '.git/hooks/pre-commit'), '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); }
async function terminal(root: string, reason?: string) {
  expect((await unknownEntries(root)).filter(e => e.action === 'worktree:merge')).toEqual([]);
  if (reason) expect((await readLedger(root)).findLast(e => e.action === 'worktree:merge')).toMatchObject({ status: 'fail', evidence: { reason } });
}
it('두 단계 병합은 훅·닫힌 stdin·부모·메시지·기준점·원장을 보존하며 전이하지 않는다', async () => {
  const f = await mergeReady(); await hook(f.member(), 'read value && exit 7\nprintf ran > .git/hook-ran');
  const result = await mergeWorktree(f.root, f.task.id);
  expect(result).toMatchObject({ repo: 'web', taskId: f.task.id, branch: 'main' });
  expect(await readFile(join(f.member(), '.git/hook-ran'), 'utf8')).toBe('ran');
  expect((await git(f.member(), 'rev-list', '--parents', '-n', '1', result.mergeCommit)).split(' ').slice(1)).toEqual([f.base, f.review]);
  expect(await git(f.member(), 'log', '-1', '--format=%s')).toBe('merge(T01): 구현');
  expect((await getTask(f.root, f.task.id)).merge).toEqual({ base: f.base, commit: result.mergeCommit });
  expect((await readState(f.root)).state).toBe('MERGE'); await terminal(f.root);
});
it.each(['merge', 'later', 'ff', 'ff-later'])('기록 누락 재실행 %s는 Git을 바꾸지 않고 기록', async mode => {
  const f = await mergeReady();
  await git(f.member(), 'merge', mode.startsWith('ff') ? '--ff-only' : '--no-ff', f.review, '-m', 'manual');
  const merged = await git(f.member(), 'rev-parse', 'HEAD');
  if (mode.includes('later')) { await writeFile(join(f.member(), 'later.txt'), 'later'); await git(f.member(), 'add', '.'); await git(f.member(), 'commit', '-m', 'later'); }
  const head = await git(f.member(), 'rev-parse', 'HEAD');
  expect(await mergeWorktree(f.root, f.task.id)).toMatchObject({ mergeCommit: mode.startsWith('ff') ? f.review : merged, alreadyMerged: true });
  expect(await git(f.member(), 'rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(f.member(), '.git/fodh-merge.json')).catch(() => null)).toBeNull();
  await terminal(f.root);
  if (mode.startsWith('ff')) expect((await readLedger(f.root)).at(-1)?.evidence).toHaveProperty('fastForward', true);
});
it.each(['dirty', 'branch', 'tip', 'base', 'state', 'high', 'repo'])('거부 %s는 pre를 fail로 닫고 Git 불변', async kind => {
  const f = await mergeReady();
  if (kind === 'dirty') await writeFile(join(f.member(), 'code.txt'), 'dirty');
  if (kind === 'branch') await git(f.member(), 'checkout', '-b', 'other');
  if (kind === 'tip') { await writeFile(join(f.wt.path, 'extra'), 'x'); await git(f.wt.path, 'add', '.'); await git(f.wt.path, 'commit', '-m', 'extra'); }
  if (kind === 'base') await setTask(f.root, f.task.id, { merge: { base: f.review } });
  if (kind === 'state') await updateState(f.root, { state: 'DOCS' });
  if (kind === 'high') await setTask(f.root, f.task.id, { review: { high: 1 } });
  if (kind === 'repo') await updateState(f.root, s => ({ worktrees: s.worktrees?.map(w => ({ ...w, repo: 'backend' })) }));
  const head = await git(f.member(), 'rev-parse', 'HEAD');
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow(kind === 'repo' ? '레포(backend)가 task 레포(web)와 다릅니다' : /.+/);
  expect(await git(f.member(), 'rev-parse', 'HEAD')).toBe(head);
  await terminal(f.root, ['state', 'high', 'repo'].includes(kind) ? 'record' : kind);
});
it('추적 안 된 파일은 앞 5개만 경고하고 missing base는 재설정', async () => {
  const f = await mergeReady(); await setTask(f.root, f.task.id, { merge: { base: undefined } });
  for (let i = 0; i < 7; i++) await writeFile(join(f.member(), `u${i}`), 'untracked');
  const result = await mergeWorktree(f.root, f.task.id);
  expect(result.warnings?.untracked).toEqual({ count: 7, paths: ['u0', 'u1', 'u2', 'u3', 'u4'] });
  expect((await getTask(f.root, f.task.id)).merge?.base).toBe(f.base);
  expect(await readLedger(f.root)).toContainEqual(expect.objectContaining({ action: 'merge-base:reset', evidence: { repo: 'web', reason: 'missing' } }));
});
it.each(['owned', 'user', 'wrong-run'])('MERGE_HEAD 소유 판정 %s', async kind => {
  const f = await mergeReady();
  await appendLedger(f.root, { runId: 'old', taskId: f.task.id, action: 'worktree:merge', status: 'pre', evidence: { repo: 'web' } });
  await git(f.member(), 'merge', '--no-ff', '--no-commit', f.review);
  const { ino, mtimeMs } = await stat(join(f.member(), '.git/MERGE_HEAD'));
  if (kind !== 'user') await atomicWrite(join(f.member(), '.git/fodh-merge.json'), JSON.stringify({ runId: kind === 'owned' ? 'old' : 'wrong', taskId: f.task.id, review: f.review, at: 'fixture', ino, mtimeMs }));
  if (kind === 'owned') {
    await mergeWorktree(f.root, f.task.id); await terminal(f.root);
    expect(await readLedger(f.root)).toContainEqual(expect.objectContaining({ runId: 'old', status: 'fail', evidence: { repo: 'web', reason: 'merge-head', aborted: true } }));
  } else {
    await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('진행 중인 병합이 있습니다');
    expect(await git(f.member(), 'rev-parse', 'MERGE_HEAD')).toBe(f.review);
    expect((await readJudgment(f.root)).items[0]).toMatchObject({ blocks: f.task.id, resolution: undefined });
    expect((await readJudgment(f.root)).items[0].origin).toBeUndefined();
    expect((await getTask(f.root, f.task.id)).status).toBe('merge');
    expect((await unknownEntries(f.root)).filter(e => e.action === 'worktree:merge').map(e => e.runId)).toEqual(['old']);
  }
});
it('충돌은 abort하고 고정 오류·종료 증거를 남긴다', async () => {
  const f = await mergeReady();
  await writeFile(join(f.member(), 'feature.txt'), 'main conflict'); await git(f.member(), 'add', '.'); await git(f.member(), 'commit', '-m', 'conflict');
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('충돌: T01 를 web main에 병합할 수 없습니다 — 되돌렸습니다');
  expect(await git(f.member(), 'rev-parse', '-q', '--verify', 'MERGE_HEAD').catch(() => '')).toBe('');
  expect(await readFile(join(f.member(), '.git/fodh-merge.json')).catch(() => null)).toBeNull(); await terminal(f.root, 'conflict');
});
it('pre-commit 거부의 비밀 모양 stderr는 redaction, 고정 오류, abort', async () => {
  const f = await mergeReady(), secret = 'sk-ant-FAKE_W2_HOOK_SECRET';
  await hook(f.member(), `printf '${secret}' >&2\nexit 1`);
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('레포 커밋 훅이 거부했습니다 — 명의·훅을 확인(되돌렸습니다)');
  expect(JSON.stringify(await readLedger(f.root))).not.toContain(secret);
  expect((await readLedger(f.root)).at(-1)?.evidence).toMatchObject({ reason: 'hook', stage: 'commit', aborted: true, stderrTail: '[비밀값 제거]' });
  expect(await git(f.member(), 'rev-parse', 'HEAD')).toBe(f.base); await terminal(f.root, 'hook');
});
it('시간 초과는 자손 그룹을 죽이고 abort한다', async () => {
  const f = await mergeReady();
  await hook(f.member(), `"${process.execPath}" -e 'require("fs").writeFileSync(".git/child.pid",String(process.pid));setInterval(()=>{},1000)' &\nwait`);
  await expect(mergeWorktree(f.root, f.task.id, { timeoutMs: 1500 })).rejects.toThrow('병합이 10분 안에 끝나지 않았습니다');
  const pid = Number(await readFile(join(f.member(), '.git/child.pid'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) { try { process.kill(pid, 0); } catch { alive = false; } if (alive) await new Promise(r => setTimeout(r, 30)); }
  expect(alive).toBe(false); expect(await git(f.member(), 'rev-parse', '-q', '--verify', 'MERGE_HEAD').catch(() => '')).toBe('');
  await terminal(f.root, 'timeout');
});
it('이미 포함됐지만 task tip이 다르면 사용자 확인 오류', async () => {
  const f = await mergeReady(); await git(f.member(), 'merge', '--ff-only', f.review);
  await writeFile(join(f.wt.path, 'later'), 'later'); await git(f.wt.path, 'add', '.'); await git(f.wt.path, 'commit', '-m', 'later');
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('병합 기록으로 확인할 수 없습니다 — 사용자가 확인');
  await terminal(f.root, 'already-in-base');
});
it('abort 실패는 표시 파일·MERGE_HEAD를 보존하고 고정 안내를 덧붙인다', async () => {
  const f = await mergeReady(); await hook(f.member(), 'printf lock > .git/index.lock\nexit 1');
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('— 되돌리기도 실패했습니다, 사용자가 확인');
  const { ino, mtimeMs } = await stat(join(f.member(), '.git/MERGE_HEAD'));
  expect(JSON.parse(await readFile(join(f.member(), '.git/fodh-merge.json'), 'utf8'))).toMatchObject({ taskId: f.task.id, review: f.review, ino, mtimeMs });
  expect(await git(f.member(), 'rev-parse', 'MERGE_HEAD')).toBe(f.review);
  expect((await readLedger(f.root)).at(-1)?.evidence).toMatchObject({ reason: 'hook', aborted: false }); await terminal(f.root, 'hook');
});
it('커밋 뒤 기록 실패는 Git을 보존하고 재실행으로 복구한다', async () => {
  const { vi } = await import('vitest');
  const backlog = await import('../src/core/backlog.ts');
  const f = await mergeReady(), original = backlog.setTask;
  const spy = vi.spyOn(backlog, 'setTask').mockImplementation(async (root, id, patch) => {
    if (patch.merge?.commit) throw new Error('fixture record failure');
    return original(root, id, patch);
  });
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('fixture record failure');
  const commit = await git(f.member(), 'rev-parse', 'HEAD'); expect(commit).not.toBe(f.base);
  await terminal(f.root, 'record'); spy.mockRestore();
  expect(await mergeWorktree(f.root, f.task.id)).toMatchObject({ mergeCommit: commit, alreadyMerged: true });
});
it('커밋 직후 죽은 실행의 표시 파일은 확인된 재실행에서 제거한다', async () => {
  const f = await mergeReady();
  await appendLedger(f.root, { runId: 'committed-before-crash', taskId: f.task.id, action: 'worktree:merge', status: 'pre' });
  await atomicWrite(join(f.member(), '.git/fodh-merge.json'), JSON.stringify({ runId: 'committed-before-crash', taskId: f.task.id, review: f.review, at: 'fixture' }));
  await git(f.member(), 'merge', '--no-ff', f.review, '-m', 'commit before crash');
  expect(await mergeWorktree(f.root, f.task.id)).toHaveProperty('alreadyMerged', true);
  expect(await readFile(join(f.member(), '.git/fodh-merge.json')).catch(() => null)).toBeNull();
});
it.each(['timeout', 'hook'])('커밋 뒤 post-commit %s에도 부모가 맞으면 성공 기록', async kind => {
  const f = await mergeReady();
  await writeFile(join(f.member(), '.git/hooks/post-commit'), '#!/bin/sh\n' + (kind === 'timeout' ? '/bin/sleep 30' : 'kill -TERM "$PPID"') + '\n', { mode: 0o755 });
  const result = await mergeWorktree(f.root, f.task.id, { timeoutMs: 1500 });
  expect((await getTask(f.root, f.task.id)).merge?.commit).toBe(result.mergeCommit);
  expect((await git(f.member(), 'rev-list', '--parents', '-n', '1', result.mergeCommit)).split(' ')[2]).toBe(f.review);
  expect((await readLedger(f.root)).at(-1)).toMatchObject({ status: 'ok', evidence: kind === 'timeout' ? { commitTimedOut: true } : { commitHookFailedAfterCommit: true } });
  expect(await readFile(join(f.member(), '.git/fodh-merge.json')).catch(() => null)).toBeNull();
  await terminal(f.root);
});
it.each(['timeout', 'hook'])('commit %s·MERGE_HEAD 없음·부모 불일치는 되돌림을 주장하지 않는다', async kind => {
  const f = await mergeReady();
  await hook(f.member(), '/bin/rm .git/MERGE_HEAD\n' + (kind === 'timeout' ? '/bin/sleep 30' : 'exit 1'));
  const error = await mergeWorktree(f.root, f.task.id, { timeoutMs: 1500 }).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('— 병합이 남았는지 사용자가 확인');
  expect((error as Error).message).not.toContain('되돌렸습니다');
  expect((await readLedger(f.root)).at(-1)?.evidence).toMatchObject({ reason: kind, aborted: false });
  expect((await getTask(f.root, f.task.id)).merge?.commit).toBeUndefined();
});
it('workspace not-started는 abort 없이 표시 파일 제거·로컬 파일 보존', async () => {
  const f = await mergeReady();
  await writeFile(join(f.member(), 'feature.txt'), 'untracked user file');
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('병합을 시작하지 못했습니다: T01 → web main');
  expect((await readLedger(f.root)).at(-1)?.evidence).toMatchObject({ reason: 'not-started', stage: 'merge', aborted: false });
  expect(await readFile(join(f.member(), 'feature.txt'), 'utf8')).toBe('untracked user file');
  expect(await readFile(join(f.member(), '.git/fodh-merge.json')).catch(() => null)).toBeNull();
  expect(await git(f.member(), 'rev-parse', '-q', '--verify', 'MERGE_HEAD').catch(() => '')).toBe('');
  await terminal(f.root, 'not-started');
});
it('여러 unknown 중 오래된 표시 파일은 사용자 병합으로 취급하고 옛 pre를 닫지 않는다', async () => {
  const f = await mergeReady();
  for (const runId of ['old', 'newer']) await appendLedger(f.root, { runId, taskId: f.task.id, action: 'worktree:merge', status: 'pre' });
  await git(f.member(), 'merge', '--no-ff', '--no-commit', f.review);
  const { ino, mtimeMs } = await stat(join(f.member(), '.git/MERGE_HEAD'));
  await atomicWrite(join(f.member(), '.git/fodh-merge.json'), JSON.stringify({ runId: 'old', taskId: f.task.id, review: f.review, at: new Date().toISOString(), ino, mtimeMs }));
  await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('진행 중인 병합이 있습니다');
  expect(await git(f.member(), 'rev-parse', 'MERGE_HEAD')).toBe(f.review);
  expect((await unknownEntries(f.root)).map(e => e.runId)).toEqual(['old', 'newer']);
  const terminalEntries = (await readLedger(f.root)).filter(e => e.action === 'worktree:merge' && e.status !== 'pre');
  expect(terminalEntries).toHaveLength(1); expect(terminalEntries[0].status).toBe('fail');
  expect(['old', 'newer']).not.toContain(terminalEntries[0].runId);
});
it.each(['inode', 'mtime', 'in-window', 'too-old', 'before-marker'])('MERGE_HEAD 파일 소유 판정 %s', async mode => {
  const f = await mergeReady(), path = join(f.member(), '.git/MERGE_HEAD');
  await appendLedger(f.root, { runId: 'old', taskId: f.task.id, action: 'worktree:merge', status: 'pre' });
  await git(f.member(), 'merge', '--no-ff', '--no-commit', f.review);
  const info = await stat(path), exact = mode === 'inode' || mode === 'mtime';
  const at = info.mtimeMs - (mode === 'too-old' ? 600001 : mode === 'before-marker' ? -1000 : 1000);
  await atomicWrite(join(f.member(), '.git/fodh-merge.json'), JSON.stringify({ runId: 'old', taskId: f.task.id, review: f.review, at: new Date(at).toISOString(), ...(exact ? { ino: info.ino, mtimeMs: info.mtimeMs } : {}) }));
  if (mode === 'inode') {
    await rename(path, path + '.old'); await writeFile(path, f.review + '\n');
    expect((await stat(path)).ino).not.toBe(info.ino);
  }
  if (mode === 'mtime') await utimes(path, new Date(), new Date(info.mtimeMs + 2000));
  if (mode === 'in-window') { await mergeWorktree(f.root, f.task.id); await terminal(f.root); }
  else {
    await expect(mergeWorktree(f.root, f.task.id)).rejects.toThrow('진행 중인 병합이 있습니다');
    expect(await git(f.member(), 'rev-parse', 'MERGE_HEAD')).toBe(f.review);
    expect((await unknownEntries(f.root)).map(e => e.runId)).toEqual(['old']);
    expect((await readJudgment(f.root)).items[0].title).toContain('진행 중인 병합');
  }
});
it('CLI merge stdout·stderr 전체에는 훅 비밀 모양 출력이 없다', async () => {
  const f = await mergeReady(), secret = 'sk-ant-FAKE_W2_CLI_HOOK_SECRET';
  await hook(f.member(), `printf '${secret}' >&2\nprintf '${secret}'\nexit 1`);
  let stdout = '', stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(value => { stdout += value; return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(value => { stderr += value; return true; });
  try {
    await main(['worktree', 'merge', f.task.id], f.root);
    expect(process.exitCode).toBe(1);
    expect(stdout + stderr).not.toContain(secret);
    expect(stdout + stderr).toContain('레포 커밋 훅이 거부했습니다');
  } finally { out.mockRestore(); err.mockRestore(); process.exitCode = 0; }
  expect(JSON.stringify(await readLedger(f.root))).not.toContain(secret);
});
