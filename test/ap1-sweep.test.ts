import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState, stopForJudgment } from '../src/core/state.ts';
import { notify } from '../src/core/notify.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addJudgment, readJudgment, answerJudgment, applyJudgments, beginJudgmentSnapshot, finishJudgmentSnapshot, JudgmentConflict } from '../src/core/judgment.ts';
import { autopilotOn, autopilotOff, autopilotSweep, readAutopilot, autopilotStatus, changeAutopilot, type SweepDeps } from '../src/core/autopilot.ts';
const input = { title: '색상', background: '', options: ['파랑', '초록'], recommend: '① 파랑', blocks: '-', origin: { kind: 'brain' as const } };
async function setup() {
  const root = await project('ARCH'); let clock = Date.parse('2026-09-27T00:00:00Z');
  await autopilotOn(root, { now: new Date(clock) });
  const deps: SweepDeps = { now: () => new Date(clock), idle: () => true, hasUI: true, notify: vi.fn(),
    apply: vi.fn(async (ids, expected) => ({ applied: (await applyJudgments(root, ids, expected)).applied.map(item => item.id) })) };
  return { root, deps, advance: (ms = 30000) => { clock += ms; }, sweep: () => autopilotSweep(root, deps) };
}
it('유예 후 일괄 적용 1회·고유 알림 키·200자 제한·원장·계수', async () => {
  const t = await setup();
  for (const title of ['색상', '글꼴']) await addJudgment(t.root, { ...input, title });
  expect((await t.sweep()).registered).toEqual(['A1', 'A2']);
  expect((await t.sweep()).answered).toEqual([]); t.advance();
  expect(await t.sweep()).toMatchObject({ answered: ['A1', 'A2'], applied: ['A1', 'A2'] });
  expect(t.deps.apply).toHaveBeenCalledTimes(1);
  expect(vi.mocked(t.deps.apply).mock.calls[0][1].A1).toContain('- 답 출처: 오토파일럿');
  const notifications = vi.mocked(t.deps.notify).mock.calls;
  expect(notifications.map(call => call[0])).toEqual(['autopilot:A1', 'autopilot:A2']);
  expect(notifications.every(call => call[1].length <= 200)).toBe(true);
  expect(await readAutopilot(t.root)).toMatchObject({ answered: 2, perScope: { 'ARCH:project': 2 }, pending: {} });
  expect((await readLedger(t.root)).filter(e => e.action === 'judgment:autopilot')).toHaveLength(2);
});
it.each(['answer', 'off', 'complete'])('유예 취소 %s', async kind => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep();
  if (kind === 'off') await autopilotOff(t.root);
  else { await answerJudgment(t.root, 'A1', '2'); if (kind === 'complete') await applyJudgments(t.root); }
  t.advance(); expect((await t.sweep()).answered).toEqual([]);
  expect((await readAutopilot(t.root)).pending).toEqual({});
  expect(t.deps.apply).not.toHaveBeenCalled();
});
it.each([['추천: ① 파랑', '추천: ② 초록'], ['배경:', '배경: 비교 변경'], ['(rev 1)', '(rev 2)']])('질문 변경 시 유예 재등록 %s', async (before, after) => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep(); t.advance();
  const p = join(t.root, 'docs/판단대기.md'); await writeFile(p, (await readFile(p, 'utf8')).replace(before, after));
  expect(await t.sweep()).toMatchObject({ registered: ['A1'], answered: [] });
  t.advance(); expect((await t.sweep()).answered).toEqual(['A1']);
});
it.each(['busy', 'snapshot', 'hold', 'aborted', 'headless'])('자동 답 안전 가드 %s', async mode => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep(); t.advance();
  if (mode === 'busy') t.deps.idle = () => false;
  if (mode === 'headless') t.deps.hasUI = false;
  if (mode === 'hold') await updateState(t.root, { userHold: true });
  if (mode === 'aborted') await updateState(t.root, { userAborted: true });
  if (mode === 'snapshot') await beginJudgmentSnapshot(t.root, { runId: 'turn', startedAt: t.deps.now().toISOString() });
  expect((await t.sweep()).answered).toEqual([]);
  expect((await readJudgment(t.root)).items[0].answer).toBe('');
  if (mode === 'snapshot') await finishJudgmentSnapshot(t.root);
});
it('적용 스냅샷 경합은 다음 tick에 exact raw 재시도, 계수 1회', async () => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep(); t.advance();
  const apply = t.deps.apply;
  t.deps.apply = vi.fn(async (...args: Parameters<SweepDeps['apply']>) => {
    await beginJudgmentSnapshot(t.root, { runId: 'late', startedAt: t.deps.now().toISOString() });
    return apply(...args);
  });
  expect((await t.sweep()).answered).toEqual(['A1']);
  expect((await readAutopilot(t.root)).answered).toBe(1);
  await finishJudgmentSnapshot(t.root); t.deps.apply = apply;
  expect((await t.sweep()).applied).toEqual(['A1']);
  expect((await readAutopilot(t.root)).answered).toBe(1);
});
it('적용 재시도 전 사용자가 답 수정하면 채택하지 않는다', async () => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep(); t.advance();
  t.deps.apply = vi.fn(async () => { throw new JudgmentConflict(); }); await t.sweep();
  await answerJudgment(t.root, 'A1', '2'); vi.mocked(t.deps.apply).mockClear();
  expect((await t.sweep()).applied).toEqual([]); expect(t.deps.apply).not.toHaveBeenCalled();
});
it('일반 적용 실패는 한 번 알리고 사용자 몫으로 남긴다', async () => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep(); t.advance();
  t.deps.apply = vi.fn(async () => { throw new Error('fixture'); }); await t.sweep(); await t.sweep();
  expect(t.deps.apply).toHaveBeenCalledTimes(1);
  expect(t.deps.notify).toHaveBeenCalledWith('autopilot:A1:failed', expect.stringContaining('직접 확인'), 'warning');
});
it('기간 만료와 한도 도달 시 취소·알림, 같은 batch에서 초과하지 않는다', async () => {
  const t = await setup(); await autopilotOn(t.root, { now: t.deps.now(), forMs: 60000 });
  await addJudgment(t.root, input); await t.sweep(); t.advance(60000);
  expect((await t.sweep()).answered).toEqual([]); expect((await readAutopilot(t.root)).enabled).toBe(false);
  expect(t.deps.notify).toHaveBeenCalledWith('autopilot:off', '오토파일럿이 꺼졌습니다 — 기간 만료', 'info');
  await autopilotOn(t.root, { now: t.deps.now(), max: 1 });
  await addJudgment(t.root, { ...input, title: '글꼴' }); await t.sweep(); t.advance();
  expect((await t.sweep()).answered).toEqual(['A1']);
  expect(await readAutopilot(t.root)).toMatchObject({ enabled: false, answered: 1, pending: {} });
  expect(t.deps.notify).toHaveBeenCalledWith('autopilot:off', '오토파일럿이 꺼졌습니다 — 한도 1개 도달', 'info');
});
it('정체 범위 최초 1회, 두 번째 프로젝트 정체 제외', async () => {
  const t = await setup(); await stopForJudgment(t.root); await t.sweep(); t.advance();
  expect((await t.sweep()).applied).toEqual(['A1']);
  await updateState(t.root, { state: 'ARCH', phase: 'project' }); await stopForJudgment(t.root);
  expect((await t.sweep()).skipped.A2).toBe('두 번째 정체');
  expect(t.deps.notify).toHaveBeenCalledWith('autopilot:A2:stall', expect.stringContaining('두 번째 정체'), 'warning');
});
it('동시 sweep은 답과 적용을 한 번만 실행, delay=0 지원', async () => {
  const t = await setup(); await setConfig(t.root, 'autopilot.delaySeconds', '0'); await addJudgment(t.root, input);
  await Promise.all([t.sweep(), t.sweep()]); expect(t.deps.apply).toHaveBeenCalledTimes(1);
  expect((await readAutopilot(t.root)).answered).toBe(1);
});
it('마지막 답의 적용이 경합해도 한도는 끄고 쓴 답을 보존한다', async () => {
  const t = await setup(); await autopilotOn(t.root, { now: t.deps.now(), max: 1 });
  await addJudgment(t.root, input); await t.sweep(); t.advance();
  t.deps.apply = vi.fn(async () => { throw new JudgmentConflict(); }); await t.sweep();
  expect(await readAutopilot(t.root)).toMatchObject({ enabled: false, answered: 1 });
  expect((await readJudgment(t.root)).items[0]).toMatchObject({ answer: '1', answerSource: 'autopilot' });
  await t.sweep(); expect(t.deps.apply).toHaveBeenCalledTimes(1);
});
it('한 tick에서 task·범위 한도와 반복 제목을 넘지 않는다', async () => {
  const t = await setup(); await setConfig(t.root, 'autopilot.perTaskMax', '1');
  await setConfig(t.root, 'autopilot.perScopeMax', '1'); await setConfig(t.root, 'autopilot.delaySeconds', '0');
  for (const [title, blocks] of [['색상', 'T01'], ['글꼴', 'T01'], ['여백', '-'], ['정렬', '-']]) await addJudgment(t.root, { ...input, title, blocks });
  const result = await t.sweep(); expect(result.answered).toEqual(['A1', 'A3']);
  expect(result.skipped).toMatchObject({ A2: 'task 한도', A4: '범위 한도' });
  await addJudgment(t.root, { ...input, title: 'A99 색상 (rev 9)', blocks: 'T02' });
  expect((await t.sweep()).skipped.A5).toBe('같은 질문이 되풀이됐다');
});

it('검수 M1: 두 번째 정체는 20회 스윕에도 알림·notify 원장 1회, 완료 후 표지 제거', async () => {
  const t = await setup(); await stopForJudgment(t.root); await t.sweep(); t.advance(); await t.sweep();
  await updateState(t.root, { state: 'ARCH', phase: 'project' }); await stopForJudgment(t.root);
  const delivered = vi.fn(), notifications: Promise<unknown>[] = [];
  await setConfig(t.root, 'notify.channels', ' ["tui"]');
  t.deps.notify = vi.fn((key, body, level) => {
    notifications.push(notify(t.root, { key, body, level, title: '오토파일럿' }, { hasUI: true, notify: delivered }, { now: t.deps.now().getTime() }));
  });
  const before = (await readLedger(t.root)).filter(entry => entry.action.startsWith('notify:')).length;
  for (let i = 0; i < 20; i++) { await t.sweep(); await Promise.all(notifications); t.advance(60001); }
  expect(t.deps.notify).toHaveBeenCalledTimes(1); expect(delivered).toHaveBeenCalledTimes(1);
  expect((await readLedger(t.root)).filter(entry => entry.action.startsWith('notify:'))).toHaveLength(before + 1);
  expect((await readLedger(t.root)).filter(entry => entry.action === 'notify:autopilot:A2:stall')).toHaveLength(1);
  expect((await readAutopilot(t.root)).stallNotified).toEqual({ A2: true });
  await answerJudgment(t.root, 'A2', '1'); await applyJudgments(t.root); await t.sweep();
  expect((await readAutopilot(t.root)).stallNotified).toEqual({});
});
it('검수 M1: 유예 재등록과 적용 실패도 판단·사유마다 알림 1회', async () => {
  const t = await setup(); await setConfig(t.root, 'autopilot.delaySeconds', '600'); await addJudgment(t.root, input);
  const file = join(t.root, 'docs/판단대기.md');
  for (let i = 0; i < 20; i++) {
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^- 배경:.*$/mu, `- 배경: 비교 ${i}`));
    expect((await t.sweep()).registered).toEqual(['A1']); t.advance(60001);
  }
  expect(t.deps.notify).toHaveBeenCalledTimes(1);
  t.deps.apply = vi.fn(async () => { throw new Error('fixture'); }); t.advance(600000);
  for (let i = 0; i < 20; i++) { await t.sweep(); t.advance(60001); }
  expect(vi.mocked(t.deps.notify).mock.calls.map(call => call[0])).toEqual(['autopilot:A1', 'autopilot:A1:failed']);
});
it.each(['approval', 'task', 'scope', 'max'])('검수 M1: 반복 제외·한도 %s 알림이 쌓이지 않는다', async mode => {
  const t = await setup(); await addJudgment(t.root, { ...input, blocks: mode === 'task' ? 'T01' : '-', requiresApproval: mode === 'approval' });
  await changeAutopilot(t.root, async auto => {
    if (mode === 'task') auto.perTask = { T01: 3 };
    if (mode === 'scope') auto.perScope = { 'ARCH:project': 3 };
    if (mode === 'max') auto.answered = 30;
  });
  for (let i = 0; i < 20; i++) { await t.sweep(); t.advance(60001); }
  expect(t.deps.notify).toHaveBeenCalledTimes(mode === 'max' ? 1 : 0);
});
it.each(['off', 'expiry', 'max'])('검수 L2: %s로 꺼지면 미적용 자동 답 알림·JSON·원문 보존', async mode => {
  const t = await setup();
  await autopilotOn(t.root, { now: t.deps.now(), ...(mode === 'max' ? { max: 1 } : { forMs: 60000 }) });
  await addJudgment(t.root, input); await t.sweep(); t.advance();
  t.deps.apply = vi.fn(async () => { throw new JudgmentConflict(); }); await t.sweep();
  const file = join(t.root, 'docs/판단대기.md'), raw = await readFile(file, 'utf8');
  const message = '오토파일럿이 꺼졌습니다 — A1 는 자동 답이 적혀 있지만 아직 적용되지 않았습니다. 확인 뒤 /judged A1 또는 답을 고치세요';
  if (mode === 'off') {
    const delivered = vi.fn(); await setConfig(t.root, 'notify.channels', '["tui"]');
    expect(await autopilotOff(t.root, { context: { hasUI: true, notify: delivered }, now: t.deps.now() }))
      .toMatchObject({ enabled: false, unappliedAutoAnswers: ['A1'] });
    await autopilotOff(t.root, { context: { hasUI: true, notify: delivered }, now: t.deps.now() });
    expect(delivered).toHaveBeenCalledExactlyOnceWith(message, 'warning');
  } else {
    if (mode === 'expiry') { t.advance(); await t.sweep(); }
    expect(t.deps.notify).toHaveBeenCalledWith('autopilot:off:A1', message, 'warning');
  }
  expect(await autopilotStatus(t.root, t.deps.now())).toMatchObject({ enabled: false, unappliedAutoAnswers: ['A1'] });
  expect(await readFile(file, 'utf8')).toBe(raw);
  await applyJudgments(t.root);
  expect((await autopilotStatus(t.root, t.deps.now())).unappliedAutoAnswers).toEqual([]);
});
it.each(['empty', 'error', 'conflict'])('검수 L4: 사용자 선행 적용 뒤 %s 결과는 실패가 아니다', async mode => {
  const t = await setup(); await addJudgment(t.root, input); await t.sweep(); t.advance();
  t.deps.apply = vi.fn(async () => {
    await applyJudgments(t.root, ['A1']);
    if (mode === 'error') throw new Error('late apply');
    if (mode === 'conflict') throw new JudgmentConflict();
    return { applied: [] };
  });
  const result = await t.sweep();
  expect(result.answered).toEqual(['A1']); expect(result.skipped.A1).toBeUndefined();
  expect((await readJudgment(t.root)).completed.map(item => item.id)).toContain('A1');
  expect((await readAutopilot(t.root)).pendingApply).toEqual({});
  expect((await readAutopilot(t.root)).failedApply ?? []).toEqual([]);
  expect(vi.mocked(t.deps.notify).mock.calls.filter(call => call[0].endsWith(':failed'))).toHaveLength(0);
  await t.sweep(); expect(t.deps.apply).toHaveBeenCalledTimes(1);
});
