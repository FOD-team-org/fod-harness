import { expect, it } from 'vitest';
import { project, cli } from './p5-helpers.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { runPick } from '../src/core/pick.ts';
import { classifyAnswer, answerJudgment, applyJudgments, readJudgment } from '../src/core/judgment.ts';
import { readLedger } from '../src/core/ledger.ts';

const prose = '② review.commit 은 바꾸지 않는다. DOCS 전이는 `fodh state transition DOCS --task T02 --commit fce149f…` 로 한다';
it('F21 원문자와 선두 숫자만 선택 번호로 해석한다', () => {
  expect(classifyAnswer(prose, ['변경', '유지'])).toMatchObject({ applicable: true, selection: 2 });
  expect(classifyAnswer('1 2', ['변경', '유지'])).toMatchObject({ applicable: false, reason: '선택 번호가 여러 개입니다' });
  expect(classifyAnswer('T02 만 다시', ['변경', '유지'])).toEqual({ kind: 'freeform', applicable: true });
  expect(classifyAnswer('답은 ② T02 유지', ['변경', '유지'])).toMatchObject({ selection: 2 });
  expect(classifyAnswer('2 T02 commit fce149f', ['변경', '유지'])).toMatchObject({ selection: 2 });
});
it('F22 MERGE 회수→답 적용→PICK은 증거를 보존하고 MERGE로 복귀한다', async () => {
  const root = await project('PICK');
  const other = await addTask(root, { title: '다른 작업', category: 'docs' });
  const task = await addTask(root, { title: '병합 재개', category: 'docs' });
  const evidence = { verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' } };
  await setTask(root, task.id, { status: 'merge', ...evidence });
  await updateState(root, { state: 'MERGE', taskId: task.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  const result = await cli(root, ['judgment', 'add', '--title', '재개', '--background', '병합 후', '--options', '변경|유지', '--recommend', '②', '--blocks', task.id, '--reclaim']);
  expect(result).toMatchObject({ code: 0, value: { reclaimed: true, next: 'PICK' } });
  expect((await readState(root)).resumeTask).toBeUndefined();
  expect(await getTask(root, task.id)).toMatchObject({ status: `blocked(${result.value.judgment})`, resume: { status: 'merge', state: 'MERGE' }, ...evidence });
  // An intervening judgment wait must retain task.resume, without a state checkpoint.
  await transitionState(root, 'WAIT_JUDGMENT');
  await answerJudgment(root, result.value.judgment, prose);
  expect((await applyJudgments(root)).applied).toHaveLength(1);
  expect((await readJudgment(root)).completed[0].answer).toBe(prose);
  expect(await getTask(root, task.id)).toMatchObject({ status: 'merge', ...evidence });
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: 'MERGE', task: { id: task.id } });
  expect(await readState(root)).toMatchObject({ state: 'MERGE', taskId: task.id });
  expect((await getTask(root, other.id)).status).toBe('ready');
  expect((await readJudgment(root)).items).toHaveLength(0);
});
it.each(['ready', 'merge'])('F22 현재 taskId의 %s 작업을 다른 ready보다 우선한다', async status => {
  const root = await project('PICK');
  await addTask(root, { title: '먼저 등록한 작업', category: 'docs' });
  const task = await addTask(root, { title: '현재 작업', category: 'docs' });
  await setTask(root, task.id, { status });
  await updateState(root, { state: 'MERGE', taskId: task.id });
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: 'MERGE', task: { id: task.id } });
});
it.each(['EMPTY', 'DONE_ALL', 'WAIT_JUDGMENT'])('P2 %s도 lastPaused를 정리한다', async outcome => {
  const root = await project('PICK');
  if (outcome !== 'EMPTY') {
    const task = await addTask(root, { title: '선택', category: 'docs' });
    await setTask(root, task.id, outcome === 'DONE_ALL' ? { status: 'done', verify: { ok: true }, review: { high: 0, commit: 'none' }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } } : { status: 'blocked(A1)' });
  }
  await updateState(root, { lastPaused: 'slot' });
  expect((await runPick(root)).outcome).toBe(outcome);
  expect((await readState(root)).lastPaused).toBeUndefined();
});
it.each([
  [undefined, 0, '--commit <검수 커밋 sha> 를 넘기세요(현재 review.commit = none)'],
  ['other', 0, '--commit 이 review.commit 과 다릅니다'],
  ['none', undefined, '검수 결과(--review-high 0)가 없습니다'],
] as const)('F19 MERGE→DOCS 원인별 거부: %s %s', async (commit, high, message) => {
  const root = await project('MERGE'), task = await addTask(root, { title: '병합', category: 'docs' });
  await setTask(root, task.id, { review: { commit: 'none', high } });
  await updateState(root, { taskId: task.id });
  await expect(transitionState(root, 'DOCS', { taskId: task.id, commit })).rejects.toThrow(message);
});
it.each(['VERIFY', 'REVIEW'])('P4 %s→FIX 검수 커밋·검증 증거를 무효화한다', async stage => {
  const root = await project(stage), task = await addTask(root, { title: '수정', category: 'docs' });
  await setTask(root, task.id, { review: { commit: 'none', high: 0 } });
  await updateState(root, { taskId: task.id, phase: 'task' });
  await transitionState(root, 'FIX', task.id);
  expect((await getTask(root, task.id)).review?.commit).toBeUndefined();
  expect((await readState(root)).verify).toBeUndefined();
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'review-commit:cleared', taskId: task.id }));
});

it.each(['VERIFY', 'REVIEW', 'FIX'])('F22 %s 회수와 재개는 검증·검수 시계와 증거를 보존한다', async stage => {
  const root = await project('PICK'), task = await addTask(root, { title: '증거 보존', category: 'docs' });
  await setTask(root, task.id, { status: stage.toLowerCase(), verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' } });
  await updateState(root, { state: stage, taskId: task.id, phase: 'task' });
  const entered = await readState(root);
  const proof = { runId: 'fixture', taskId: task.id, ok: true, at: new Date().toISOString(), heavy: false, cwd: root, since: entered.verifySince };
  await updateState(root, { verify: proof });
  const result = await cli(root, ['judgment', 'add', '--title', '재개', '--background', stage, '--options', '재개|보류', '--recommend', '①', '--blocks', task.id, '--reclaim']);
  expect(result.value.reclaimed).toBe(true);
  await answerJudgment(root, result.value.judgment, '1');
  await applyJudgments(root);
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: stage });
  expect((await readState(root)).verify).toEqual(proof);
  if (stage === 'VERIFY') expect((await readState(root)).verifySince).toBe(entered.verifySince);
  if (stage === 'REVIEW') expect((await readState(root)).reviewSince).toBe(entered.reviewSince);
  expect(await getTask(root, task.id)).toMatchObject({ verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' } });
});

it('Q1/Q5 다른 task 중 판단 적용→정지 복귀→완료 뒤 회수 task 재개', async () => {
  const root = await project('PICK');
  const first = await addTask(root, { title: '병합 회수', category: 'docs' });
  const second = await addTask(root, { title: '다음 구현', category: 'docs' });
  await setTask(root, first.id, { status: 'merge', review: { commit: 'none', high: 0 }, merge: { commit: 'none' } });
  await updateState(root, { state: 'MERGE', taskId: first.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  const result = await cli(root, ['judgment', 'add', '--title', '재개', '--background', '대기', '--options', '재개|보류', '--recommend', '①', '--blocks', first.id, '--reclaim']);
  expect(result.value.reclaimed).toBe(true);
  expect(await runPick(root)).toMatchObject({ outcome: 'SPEC', task: { id: second.id } });
  await transitionState(root, 'IMPLEMENT', second.id);
  const checkpoint = (await readState(root)).resumeTask;
  await answerJudgment(root, result.value.judgment, '1');
  expect((await applyJudgments(root)).applied).toHaveLength(1);
  expect((await readState(root)).resumeTask).toEqual(checkpoint);
  await transitionState(root, 'paused(slot)', { system: true });
  await transitionState(root, 'PICK');
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: 'IMPLEMENT', task: { id: second.id } });
  expect((await getTask(root, first.id)).resume?.state).toBe('MERGE');
  await setTask(root, second.id, { status: 'done', verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } });
  await updateState(root, { state: 'CLEANUP' });
  await transitionState(root, 'PICK');
  expect((await readState(root)).resumeTask).toBeUndefined();
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: 'MERGE', task: { id: first.id } });
  expect((await getTask(root, first.id)).resume).toBeUndefined();
  expect((await readJudgment(root)).items).toHaveLength(0);
});
it('Q1 정지 복귀는 다른 task의 낡은 checkpoint를 무시하고 원장에 남긴다', async () => {
  const root = await project('PICK'), task = await addTask(root, { title: '현재', category: 'docs' });
  await setTask(root, task.id, { status: 'doing' });
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id, doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await transitionState(root, 'paused(slot)', { system: true });
  await updateState(root, { resumeTask: { taskId: 'T99', resumeState: 'MERGE' } });
  await transitionState(root, 'PICK');
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: 'IMPLEMENT', task: { id: task.id } });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'pick:stale-resume-task', evidence: { ignored: { taskId: 'T99', resumeState: 'MERGE' } } }));
});
it('Q1/Q5 회수 후보는 오래된 순이며 실패한 RESUME에는 resume을 보존한다', async () => {
  const root = await project('PICK');
  const newer = await addTask(root, { title: '신규', category: 'docs' }), older = await addTask(root, { title: '이전', category: 'docs' });
  for (const [task, at] of [[newer, '2026-09-24T02:00:00Z'], [older, '2026-09-24T01:00:00Z']] as const) {
    await setTask(root, task.id, { status: 'merge', resume: { status: 'merge', state: 'MERGE', at } });
  }
  await expect(runPick(root)).rejects.toThrow('doctor');
  expect((await getTask(root, older.id)).resume).toBeDefined();
  await updateState(root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', task: { id: older.id } });
  expect((await getTask(root, older.id)).resume).toBeUndefined();
  expect((await getTask(root, newer.id)).resume).toBeDefined();
});
it.each(['1또는2', '1번과2번', '선택지는 1 혹은 2', '1과 2 제외', '① 2', '1이나2'])('Q2 복수 독립 토큰은 재질문: %s', answer => {
  expect(classifyAnswer(answer, ['진행', '보류'])).toMatchObject({ kind: 'ambiguous', applicable: false });
});
it.each([['2번', 2], ['2번으로 진행', 2], ['1번 선택', 1], ['② 그대로', 2]] as const)('Q2 선택 접미사: %s', (answer, selection) => {
  expect(classifyAnswer(answer, ['진행', '보류'])).toMatchObject({ applicable: true, selection });
});
it.each(['T02 를 fce149f 로 진행', '1.5배로', 'v2 그대로'])('Q2/N3 식별자·소수는 번호가 아니다: %s', answer => {
  expect(classifyAnswer(answer, ['진행', '보류'])).toEqual({ kind: 'freeform', applicable: true });
});
it('Q1 현재 taskId는 더 오래된 회수 후보보다 우선한다', async () => {
  const root = await project('PICK');
  const older = await addTask(root, { title: '이전 회수', category: 'docs' });
  const current = await addTask(root, { title: '현재 회수', category: 'docs' });
  await setTask(root, older.id, { status: 'merge', resume: { status: 'merge', state: 'MERGE', at: '2026-09-24T01:00:00Z' } });
  await setTask(root, current.id, { status: 'merge', resume: { status: 'merge', state: 'MERGE', at: '2026-09-24T02:00:00Z' } });
  await updateState(root, { taskId: current.id, doctor: { ok: true, checkedAt: new Date().toISOString() } });
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', task: { id: current.id } });
  expect((await getTask(root, older.id)).resume).toBeDefined();
});
it('Q1 RECLAIM의 임시 checkpoint가 오래된 회수 후보를 앞지르지 않는다', async () => {
  const root = await project('PICK');
  const older = await addTask(root, { title: '먼저 회수', category: 'docs' });
  const newer = await addTask(root, { title: '나중 회수', category: 'docs' });
  await setTask(root, older.id, { status: 'merge', resume: { status: 'merge', state: 'MERGE', at: '2026-09-24T01:00:00Z' } });
  await setTask(root, newer.id, { status: 'merge' });
  await updateState(root, { state: 'MERGE', taskId: newer.id, phase: 'task', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  const result = await cli(root, ['judgment', 'add', '--title', '나중 회수', '--background', '', '--options', '재개|보류', '--recommend', '①', '--blocks', newer.id, '--reclaim']);
  expect(result.value.reclaimed).toBe(true);
  await answerJudgment(root, result.value.judgment, '1'); await applyJudgments(root);
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', task: { id: older.id } });
});
