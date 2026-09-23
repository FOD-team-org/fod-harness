import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState, transitionState, allowedTransition } from '../src/core/state.ts';
import { runPick } from '../src/core/pick.ts';
import { addJudgment, answerJudgment, applyJudgments, readJudgment, classifyAnswer } from '../src/core/judgment.ts';
import { setConfig } from '../src/core/config.ts';
import { main } from '../src/cli/index.ts';
import * as storage from '../src/core/storage.ts';
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp('/private/tmp/fodh-state-revision-'); roots.push(root);
  const task = await addTask(root, { title: '재개 작업', category: 'docs' });
  await updateState(root, { state: 'PICK', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  await transitionState(root, 'SPEC', task.id); await transitionState(root, 'IMPLEMENT', task.id);
  return { root, task };
}
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function cli(root: string, ...args: string[]) {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0; await main(args, root);
  const value = JSON.parse(String(output.mock.calls.at(-1)?.[0])); const code = process.exitCode;
  output.mockRestore(); return { value, code };
}
it.each(['paused(error)', 'recovering'])('H2: %s → PICK → 원 IMPLEMENT 재개와 doctor 가드', async paused => {
  const { root, task } = await setup(); await updateState(root, { state: paused });
  expect(await readState(root)).toMatchObject({ taskId: task.id, resumeState: 'IMPLEMENT' });
  await transitionState(root, 'PICK');
  expect(await readState(root)).toMatchObject({ taskId: task.id, resumeTask: { taskId: task.id, resumeState: 'IMPLEMENT' } });
  expect((await readState(root)).resumeState).toBeUndefined();
  expect(allowedTransition('PICK', 'IMPLEMENT')).toBe(false);
  await expect(transitionState(root, 'IMPLEMENT', task.id)).rejects.toThrow('허용되지');
  if (paused === 'paused(error)') {
    const now = Date.now(); const decision = await runPick(root, { slots: 'ok', now });
    expect(decision).toMatchObject({ outcome: 'WAIT_RETRY', retry: { count: 1, nextAt: new Date(now + 300000).toISOString() } });
    await expect(transitionState(root, 'PICK', { now })).rejects.toThrow('백오프');
    await transitionState(root, 'PICK', { now: now + 300000 });
  }
  await updateState(root, { doctor: undefined });
  await expect(runPick(root)).rejects.toThrow('doctor');
  expect((await readState(root)).state).toBe('PICK');
  await updateState(root, { doctor: { ok: true, checkedAt: new Date().toISOString() } });
  expect(await runPick(root)).toMatchObject({ outcome: 'RESUME', next: 'IMPLEMENT', task: { id: task.id } });
  expect(await readState(root)).toMatchObject({ state: 'IMPLEMENT', taskId: task.id });
  expect((await readState(root)).resumeTask).toBeUndefined(); expect((await getTask(root, task.id)).status).toBe('doing');
});
it('H2: 고아 여러 개를 각각 차단하고 ready를 선택하며 재개와 보류를 구별한다', async () => {
  const { root, task } = await setup(); const b = await addTask(root, { title: '고아2', category: 'docs' });
  const ready = await addTask(root, { title: '새 작업', category: 'docs' }); await setTask(root, b.id, { status: 'verify' });
  await updateState(root, { state: 'PICK', taskId: undefined });
  expect(await runPick(root)).toMatchObject({ outcome: 'SPEC', task: { id: ready.id } });
  const items = (await readJudgment(root)).items; expect(items).toHaveLength(2);
  expect(items.map(item => item.title)).toEqual([`고아 task ${task.id}: 재개 / 폐기`, `고아 task ${b.id}: 재개 / 폐기`]);
  await answerJudgment(root, items[0].id, '1'); await answerJudgment(root, items[1].id, '2');
  expect((await applyJudgments(root)).applied).toHaveLength(2);
  expect((await getTask(root, task.id)).status).toBe('ready');
  expect((await getTask(root, b.id)).status).toBe(`blocked(${items[1].id})`);
  expect((await readState(root)).taskId).toBe(ready.id);
});
it('M2: 각 task 전이는 백로그 상태도 기록하고 M3는 완료 전 PICK을 막는다', async () => {
  const { root, task } = await setup();
  for (const [to, status] of [['VERIFY', 'verify'], ['REVIEW', 'review'], ['FIX', 'fix'], ['VERIFY', 'verify'], ['REVIEW', 'review'], ['MERGE', 'merge'], ['DOCS', 'merge'], ['CLEANUP', 'merge']]) {
    if (to === 'DOCS') await setTask(root, task.id, { review: { commit: 'sha', high: 0 } });
    await transitionState(root, to, { taskId: task.id, commit: 'sha' });
    expect((await getTask(root, task.id)).status).toBe(status);
  }
  expect(await cli(root, 'state', 'transition', 'PICK')).toMatchObject({ code: 1, value: { error: 'task 미완료', missing: expect.arrayContaining(['verify.ok', 'merge.commit', 'docs.ok', 'cleanup.ok']) } });
  await setTask(root, task.id, { verify: { ok: true }, merge: { commit: 'merged' }, docs: { ok: true }, cleanup: { ok: true } });
  expect((await cli(root, 'backlog', 'set', task.id, '--status', 'done')).code).toBe(0);
  await transitionState(root, 'PICK'); expect((await readState(root)).taskId).toBeUndefined();
});
it('L7: 상태 저장 실패는 repair를 증가시키지 않는다', async () => {
  const { root, task } = await setup(); await transitionState(root, 'VERIFY', task.id);
  const original = storage.atomicWrite;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, text) => {
    if (path.endsWith('harness-state.json') && text.includes('"FIX"')) throw new Error('state write denied');
    return original(path, text);
  });
  await expect(transitionState(root, 'FIX', task.id)).rejects.toThrow('state write denied');
  expect((await getTask(root, task.id)).repair).toBe(0); expect((await readState(root)).state).toBe('VERIFY');
});
it.each([24, 0.5])('L3: doctor TTL %s시간은 CLI와 core가 동일하게 적용한다', async ttl => {
  const { root, task } = await setup(); await setConfig(root, 'brain.doctorTtlHours', String(ttl));
  await updateState(root, { state: 'SPEC', doctor: { ok: true, checkedAt: new Date(Date.now() - 13 * 3600000).toISOString() } });
  const result = await cli(root, 'state', 'transition', 'IMPLEMENT', '--task', task.id);
  if (ttl === 24) expect(result.value.state).toBe('IMPLEMENT');
  else { expect(result.value.error).toContain('doctor'); await expect(transitionState(root, 'IMPLEMENT', task.id)).rejects.toThrow('doctor'); }
});
it('F1/F3: add 검증은 항목 생성 전, 단독 add는 task만 차단하고 제목+task 중복을 제거한다', async () => {
  const { root, task } = await setup(); const other = await addTask(root, { title: '다른 작업', category: 'docs' });
  const args = ['judgment', 'add', '--title', '범위 선택', '--background', '설명', '--options', '1|2', '--recommend', '1'];
  expect((await cli(root, ...args, '--blocks', 'T99', '--reclaim')).code).toBe(1);
  expect((await cli(root, ...args, '--blocks', other.id, '--reclaim')).value.error).toContain('현재 task');
  expect((await readJudgment(root)).items).toEqual([]);
  const a = await cli(root, ...args, '--blocks', task.id);
  expect((await cli(root, ...args, '--blocks', task.id)).value.item.id).toBe(a.value.item.id);
  expect((await cli(root, ...args, '--blocks', other.id)).value.item.id).not.toBe(a.value.item.id);
  expect((await readJudgment(root)).items).toHaveLength(2);
  expect((await getTask(root, task.id)).status).toBe(`blocked(${a.value.item.id})`);
  expect((await readState(root)).state).toBe('IMPLEMENT');
});
it('F4/F5: 수동 탈출·미답·무관한 답은 WAIT를 유지하고 관련 적용만 메타데이터를 지운다', async () => {
  const { root } = await setup(); await updateState(root, { state: 'INTERVIEW', phase: 'project', taskId: undefined });
  const a = (await addJudgment(root, { title: '프로젝트 범위', background: '', options: ['하나'], recommend: '1', blocks: '-' })).item;
  await transitionState(root, 'WAIT_JUDGMENT');
  expect((await cli(root, 'state', 'transition', 'PICK')).value.error).toBe(`열린 판단 ${a.id} 답이 필요합니다`);
  expect((await applyJudgments(root)).applied).toHaveLength(0); expect((await readState(root)).state).toBe('WAIT_JUDGMENT');
  const b = (await addJudgment(root, { title: '무관', background: '', options: ['하나'], recommend: '1', blocks: '-' })).item;
  await answerJudgment(root, b.id, '1'); await applyJudgments(root, [b.id]); expect((await readState(root)).state).toBe('WAIT_JUDGMENT');
  await answerJudgment(root, a.id, '1'); await applyJudgments(root, [a.id]);
  const state = await readState(root); expect(state.state).toBe('INTERVIEW'); expect(state.resumeState).toBeUndefined(); expect(state.pickJudgment).toBeUndefined();
});
it('M1: await-user CLI는 대기 플래그와 autoTurns를 저장한다', async () => {
  const { root } = await setup(); await updateState(root, { autoTurns: 2 });
  expect((await cli(root, 'state', 'await-user')).value).toMatchObject({ awaitingUser: true, autoTurns: 0 });
});
it.each(['승인합니다', '승인해', '승인해요', '승인함', '진행해', '진행합니다', '진행해요'])('L5: 승인 어미 %s, 부정 우선', answer => {
  expect(classifyAnswer(answer, ['허용'], 1, 1, true).applicable).toBe(true);
  expect(classifyAnswer(`${answer} 하지만 승인하지 마`, ['허용'], 1, 1, true).applicable).toBe(false);
});
it('M7: 3단계 재질문 적용은 모든 원항목을 최종 답 원문으로 종결한다', async () => {
  const { root } = await setup();
  const first = (await addJudgment(root, { title: '배포 승인', background: '', options: ['배포', '보류'], recommend: '1', blocks: '-', requiresApproval: true })).item;
  await answerJudgment(root, first.id, '알아서'); await applyJudgments(root);
  const second = (await readJudgment(root)).items.find(item => item.reaskOf === first.id)!;
  await answerJudgment(root, second.id, '괜찮을듯'); await applyJudgments(root, [second.id]);
  const third = (await readJudgment(root)).items.find(item => item.reaskOf === second.id)!;
  await answerJudgment(root, third.id, '1 승인합니다'); await applyJudgments(root, [third.id]);
  const document = await readJudgment(root); expect(document.items).toHaveLength(0); expect(document.completed).toHaveLength(3);
  expect(document.completed.find(item => item.id === first.id)?.answer).toBe(`모호: 알아서 → ${third.id}: 1 승인합니다`);
  expect(document.completed.find(item => item.id === second.id)?.answer).toBe(`모호: 괜찮을듯 → ${third.id}: 1 승인합니다`);
});
it.each(['ready','doing','verify','review','fix','merge','blocked(A1)','done'])('M2/F2: IMPLEMENT의 CLI 상태 %s 직접 변경은 거부한다', async status => {
  const {root,task}=await setup();
  expect(await cli(root,'backlog','set',task.id,'--status',status)).toEqual({code:1,value:{error:'상태는 전이로만 바뀝니다'}});
  expect((await getTask(root,task.id)).status).toBe('doing');
});
it('M2/F2: 다른 task done과 제거된 repair 옵션은 거부한다',async()=>{
  const {root,task}=await setup();const other=await addTask(root,{title:'다른 작업',category:'docs'});
  await updateState(root,{state:'CLEANUP'});
  expect((await cli(root,'backlog','set',other.id,'--status','done')).value.error).toBe('상태는 전이로만 바뀝니다');
  expect((await cli(root,'backlog','set',task.id,'--repair','0')).code).toBe(1);
  expect((await getTask(root,task.id)).repair).toBe(0);
});
