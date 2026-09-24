import { expect, it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addTask, getTask } from '../src/core/backlog.ts';
import { readState, transitionState, updateState } from '../src/core/state.ts';
import { runVerify } from '../src/core/verify.ts';
import { setConfig } from '../src/core/config.ts';
import { runCleanup } from '../src/core/cleanup.ts';
import { todayKst } from '../src/core/template-values.ts';

async function taskProject(state = 'VERIFY') {
  const root = await project('PICK'), task = await addTask(root, { title: '하네스 증거', category: 'docs' });
  await updateState(root, { state, taskId: task.id });
  return { root, task };
}
it.each(['missing', 'fail', 'other', 'old'])('F12 %s 검증 증거는 REVIEW를 거부한다', async kind => {
  const { root, task } = await taskProject();
  if (kind !== 'missing') await updateState(root, { verify: { runId: 'fixture', taskId: kind === 'other' ? 'T99' : task.id,
    ok: kind !== 'fail', at: kind === 'old' ? '2000-01-01T00:00:00Z' : new Date().toISOString(), heavy: false, cwd: root } });
  await expect(transitionState(root, 'REVIEW', task.id)).rejects.toThrow('검증 증거가 없습니다');
  expect((await getTask(root, task.id)).verify?.ok).not.toBe(true);
});
it('F12 실행 결과 파일·마지막 상태·자동 DoD와 FIX 재진입 무효화', async () => {
  const { root, task } = await taskProject();
  await setConfig(root, 'verify.commands', JSON.stringify([`${process.execPath} -e "process.exit(0)"`]));
  const report = await runVerify(root);
  expect(report).toMatchObject({ ok: true, taskId: task.id, heavy: false, cwd: root, head: null, clean: null });
  if (!('runId' in report)) throw new Error('결과 없음');
  expect(JSON.parse(await readFile(join(root, '.pi/verify', report.runId, 'result.json'), 'utf8'))).toEqual(report);
  await transitionState(root, 'REVIEW', task.id);
  expect((await getTask(root, task.id)).verify).toEqual({ ok: true, runId: report.runId, at: report.finishedAt });
  await transitionState(root, 'FIX', task.id);
  await transitionState(root, 'VERIFY', task.id);
  expect((await readState(root)).verify).toBeUndefined();
  await expect(transitionState(root, 'REVIEW', task.id)).rejects.toThrow('검증 증거');
  await runVerify(root);
  await setConfig(root, 'verify.commands', '[]');
  expect((await runVerify(root)).ok).toBe(false);
  await expect(transitionState(root, 'REVIEW', task.id)).rejects.toThrow('검증 증거');
});
it('F12 paused→PICK→VERIFY 복귀는 검증 시계를 보존한다', async () => {
  const { root, task } = await taskProject();
  const since = (await readState(root)).verifySince;
  await updateState(root, { verify: { runId: 'ok', taskId: task.id, ok: true, at: new Date().toISOString(), heavy: false, cwd: root } });
  await updateState(root, { state: 'paused(error)' });
  await transitionState(root, 'PICK');
  await transitionState(root, 'VERIFY', { taskId: task.id, resume: true });
  expect((await readState(root)).verifySince).toBe(since);
  await transitionState(root, 'REVIEW', task.id);
});
it.each(['verify-ok', 'docs-ok', 'cleanup-ok'])('F12/F15 %s 자기 보고 옵션은 거부한다', async flag => {
  const { root, task } = await taskProject();
  expect(await cli(root, ['backlog', 'set', task.id, `--${flag}`])).toMatchObject({ code: 1, value: { error: expect.stringContaining('Unknown option') } });
});
it('F15 DOCS는 오늘 작업일지·taskId·백로그 동기화를 모두 요구한다', async () => {
  const { root, task } = await taskProject('DOCS');
  const transition = () => transitionState(root, 'CLEANUP', task.id);
  await expect(transition()).rejects.toThrow('작업일지·백로그 갱신이 없습니다');
  await mkdir(join(root, 'docs/작업일지'));
  await writeFile(join(root, 'docs/작업일지/2000-01-01.md'), task.id);
  await expect(transition()).rejects.toThrow('작업일지·백로그 갱신이 없습니다');
  const path = join(root, `docs/작업일지/${todayKst()}.md`);
  await writeFile(path, 'T99');
  await expect(transition()).rejects.toThrow('작업일지·백로그 갱신이 없습니다');
  await writeFile(path, task.id);
  const backlog = await readFile(join(root, 'docs/backlog.md'), 'utf8');
  const jsonBefore = await readFile(join(root, '.pi/harness-backlog.json'), 'utf8');
  await writeFile(join(root, 'docs/backlog.md'), backlog.replace('하네스 증거', '수동 수정'));
  await expect(transition()).rejects.toThrow('작업일지·백로그 갱신이 없습니다');
  expect(await readFile(join(root, '.pi/harness-backlog.json'), 'utf8')).toBe(jsonBefore);
  await writeFile(join(root, 'docs/backlog.md'), backlog);
  await transition();
  expect((await getTask(root, task.id)).docs?.ok).toBe(true);
});
it('F15 cleanup 성공은 현재 task에만 자동 기록하고 dry-run·진입 전 실행은 제외한다', async () => {
  const { root, task } = await taskProject('DOCS');
  await runCleanup(root, { scope: 'processes', taskId: task.id });
  expect((await getTask(root, task.id)).cleanup?.ok).not.toBe(true);
  await updateState(root, { state: 'CLEANUP' });
  await runCleanup(root, { scope: 'processes', taskId: task.id, dryRun: true });
  const other = await addTask(root, { title: '다른 task', category: 'docs' });
  await runCleanup(root, { scope: 'processes', taskId: other.id });
  expect((await getTask(root, task.id)).cleanup?.ok).not.toBe(true);
  expect((await getTask(root, other.id)).cleanup?.ok).not.toBe(true);
  await runCleanup(root, { scope: 'storage', taskId: task.id });
  expect((await getTask(root, task.id)).cleanup?.ok).not.toBe(true);
  const report = await runCleanup(root, { scope: 'all', taskId: task.id });
  expect(report).toMatchObject({ ok: true, taskId: task.id });
  expect(JSON.parse(await readFile(join(root, '.pi/cleanup-last.json'), 'utf8'))).toEqual(report);
  expect((await getTask(root, task.id)).cleanup?.ok).toBe(true);
});
it.each([0, 1, 2])('M1 설정 경로 scaffold 및 KST %i일 전 작업일지 게이트', async days => {
  const { scaffoldDoc } = await import('../src/core/docs.ts');
  const { root, task } = await taskProject('DOCS');
  await setConfig(root, 'docs.root', '문서');
  const date = todayKst(new Date(Date.now() - days * 86400000));
  const doc = await scaffoldDoc(root, 'worklog', { date });
  expect(doc.path).toBe(`문서/작업일지/${date}.md`);
  await writeFile(join(root, doc.path), task.id);
  expect(await scaffoldDoc(root, 'worklog', { date })).toEqual({ path: doc.path, created: false });
  expect(await readFile(join(root, doc.path), 'utf8')).toBe(task.id);
  if (days < 2) await transitionState(root, 'CLEANUP', task.id);
  else await expect(transitionState(root, 'CLEANUP', task.id)).rejects.toThrow('작업일지·백로그');
});
it('M2 확인 불가 잔존은 all 증거와 CLEANUP→PICK 모두 차단한다', async () => {
  const { vi } = await import('vitest');
  const identity = await import('../src/core/process-identity.ts');
  const { registerProc } = await import('../src/core/procs.ts');
  const { setTask } = await import('../src/core/backlog.ts');
  const { root, task } = await taskProject('CLEANUP');
  vi.spyOn(identity, 'processIdentity').mockResolvedValue('unknown');
  await registerProc(root, { pid: 99999999, pgid: 99999999, kind: 'verify', runId: 'residual', taskId: task.id, startedAt: 'spawn:unknown' });
  const report = await runCleanup(root, { scope: 'all', taskId: task.id });
  expect(report.ok).toBe(false);
  expect(report.processes?.unverified).toHaveLength(1);
  expect((await getTask(root, task.id)).cleanup?.ok).not.toBe(true);
  // A stale successful DoD must not bypass a later residual report.
  await setTask(root, task.id, { verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } });
  await setTask(root, task.id, { status: 'done' });
  await expect(transitionState(root, 'PICK')).rejects.toThrow('정리 잔존');
});
it('L1 T1 작업일지 게이트는 T10을 같은 task로 보지 않는다', async () => {
  const { scaffoldDoc } = await import('../src/core/docs.ts');
  const { root, task } = await taskProject('DOCS');
  const doc = await scaffoldDoc(root, 'worklog');
  await writeFile(join(root, doc.path), `${task.id}0`);
  await expect(transitionState(root, 'CLEANUP', task.id)).rejects.toThrow('작업일지·백로그');
  await writeFile(join(root, doc.path), `완료: [${task.id}]`);
  await transitionState(root, 'CLEANUP', task.id);
});
it('S3 processes 실패 후 CLEANUP 재진입·부분 재시도·all 성공으로 완료한다', async () => {
  const { vi } = await import('vitest');
  const identity = await import('../src/core/process-identity.ts');
  const { registerProc, removeProc } = await import('../src/core/procs.ts');
  const { setTask } = await import('../src/core/backlog.ts');
  const { root, task } = await taskProject('CLEANUP');
  await updateState(root, { enteredAt: '2000-01-01T00:00:00Z' });
  vi.spyOn(identity, 'processIdentity').mockResolvedValue('unknown');
  await registerProc(root, { pid: 99999999, pgid: 99999999, kind: 'verify', runId: 'retry', taskId: task.id, startedAt: 'spawn:unknown' });
  expect((await runCleanup(root, { scope: 'processes', taskId: task.id })).ok).toBe(false);
  await transitionState(root, 'CLEANUP_FAILED');
  await transitionState(root, 'CLEANUP', task.id);
  const enteredAt = (await readState(root)).enteredAt!;
  expect(Date.parse(enteredAt)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00Z'));
  await removeProc(root, 99999999, 'retry');
  expect((await runCleanup(root, { scope: 'processes', taskId: task.id })).ok).toBe(true);
  expect((await getTask(root, task.id)).cleanup?.ok).not.toBe(true);
  const all = await runCleanup(root, { scope: 'all', taskId: task.id });
  expect(all.ok).toBe(true); expect(Date.parse(all.startedAt)).toBeGreaterThanOrEqual(Date.parse(enteredAt));
  expect((await getTask(root, task.id)).cleanup?.ok).toBe(true);
  await setTask(root, task.id, { verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' }, docs: { ok: true } });
  expect((await cli(root, ['backlog', 'set', task.id, '--status', 'done'])).code).toBe(0);
  await transitionState(root, 'PICK');
});
