import { expect, it } from 'vitest';
import { project } from './p5-helpers.ts';
import { addJudgment, answerJudgment, applyJudgments, classifyAnswer, readJudgment } from '../src/core/judgment.ts';
const options = ['웹', 'iOS', 'Android', '여러 플랫폼', '미정'];
const input = { title: '대상 플랫폼', background: '출시 범위', options, recommend: '2', blocks: '-' };
it.each(['2,3 1차 출시땐 무조건 ios 만', '2,3 1차에선 ios가 먼저 이후 2주 테스트 후에 안드로이드'])('복수 답 %s 적용·원문 보존·재질문 없음', async answer => {
  const root = await project('IDLE'), { item } = await addJudgment(root, input);
  await answerJudgment(root, item.id, answer);
  expect((await readJudgment(root, { answered: true })).items[0].classification).toMatchObject({ kind: 'freeform', selections: [2, 3] });
  expect(await applyJudgments(root, [item.id])).toMatchObject({ applied: [{ id: item.id, interpretation: `복수 선택: iOS, Android; 원문: ${answer}` }], unapplied: [] });
  expect((await readJudgment(root)).items).toHaveLength(0);
});
it('opt-in only, dedupe in occurrence order, invalid range and negatives', () => {
  expect(classifyAnswer('2,3', options)).toMatchObject({ kind: 'ambiguous', applicable: false });
  expect(classifyAnswer('③,2,3', options, 1, 1, false, { allowMulti: true })).toMatchObject({ selections: [3, 2] });
  for (const text of ['2,6', '2,⑩', '2,3 보류']) expect(classifyAnswer(text, options, 1, 1, false, { allowMulti: true })).toMatchObject({ kind: 'ambiguous', applicable: false });
});
it.each([{ requiresApproval: true }, { resolution: 'resume' as const }])('approval/resolution preserves reask: %j', async extra => {
  const root = await project('IDLE'), { item } = await addJudgment(root, { ...input, ...extra });
  await answerJudgment(root, item.id, '2,3 1차 출시땐 무조건 ios 만');
  expect((await applyJudgments(root, [item.id])).applied).toEqual([]);
  const reask = (await readJudgment(root)).items.find(i => i.reaskOf === item.id)!;
  expect(reask.background).toContain('번호 하나만 쓰세요(예: 2). 조건은 번호 뒤에(예: 2 iOS 먼저).');
});
it.each([false, true])('reask ambiguous answer, approval=%s', async requiresApproval => {
  const root = await project('IDLE'), { item } = await addJudgment(root, { ...input, requiresApproval });
  await answerJudgment(root, item.id, '나중에 정할게'); await applyJudgments(root, [item.id]);
  const reask = (await readJudgment(root)).items.find(i => i.reaskOf === item.id)!;
  await answerJudgment(root, reask.id, '나중에 정할게');
  const result = await applyJudgments(root, [reask.id]);
  if (requiresApproval) {
    expect(result.applied).toEqual([]); expect((await readJudgment(root)).items.some(i => i.reaskOf === reask.id)).toBe(true);
  } else {
    expect(result.applied).toEqual([{ id: reask.id, interpretation: '사용자 지시(재질문 뒤 자유 서술): 나중에 정할게' }]);
    expect((await readJudgment(root)).items).toHaveLength(0);
  }
});
it('multiple selection freeform still waits 60 seconds before automatic application', async () => {
  const { vi } = await import('vitest');
  const { tick } = await import('../src/core/watcher.ts');
  const { addInbox } = await import('../src/core/inbox.ts');
  const { decideInbox, clearDecisionTimers } = await import('../extensions/orchestrator/index.ts');
  const root = await project('IDLE'), { item } = await addJudgment(root, input), now = Date.now();
  await answerJudgment(root, item.id, '2,3 1차 출시땐 무조건 ios 만'); await tick(root, { now });
  const record = await addInbox(root, { kind: 'judgment-changed' });
  const pi = { sendMessage: vi.fn() } as unknown as import('@earendil-works/pi-coding-agent').ExtensionAPI;
  const context = { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } };
  try {
    expect(await decideInbox(pi, context as any, root, [record], { now: () => now + 59999, retry: async () => {} })).toEqual({ deferred: [record.id] });
    expect((await readJudgment(root)).items).toHaveLength(1);
    expect(await decideInbox(pi, context as any, root, [record], { now: () => now + 60000 })).toEqual({ deferred: [] });
    expect((await readJudgment(root)).items).toHaveLength(0);
  } finally { clearDecisionTimers(root); }
});

it.each(['2, 예산 100 만원', '1 단 30 분 이내', '2 2026 년 출시', '2,99', '2,0', '2,⑳'])('G4 keeps non-option numbers as conditions: %s', answer => {
  expect(classifyAnswer(answer, options, 1, 1, false, { allowMulti: true })).toMatchObject({ kind: 'conditional', applicable: true });
});
it('G4 recognized option outside available choices remains ambiguous', () => {
  expect(classifyAnswer('1, 3', ['one', 'two'], 1, 1, false, { allowMulti: true })).toMatchObject({ kind: 'ambiguous', applicable: false });
});
