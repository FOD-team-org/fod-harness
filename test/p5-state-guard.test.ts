import { expect, it } from 'vitest';
import { project } from './p5-helpers.ts';
import { setConfig } from '../src/core/config.ts';
import { readState, transitionState } from '../src/core/state.ts';
import { startInterview, loadBank, recordInterview, deferInterview } from '../src/core/interview.ts';
it('기록 없으면 action interview와 안내, 상태 불변', async () => {
  const root = await project();
  await expect(transitionState(root, 'RESEARCH')).rejects.toMatchObject({ action: 'interview', message: '인터뷰 기록이 없습니다. fodh interview start 를 먼저 실행하세요' });
  expect((await readState(root)).state).toBe('INTERVIEW');
});
it('미완 필수 영역 목록과 남은 수', async () => {
  const root = await project(); await startInterview(root);
  await expect(transitionState(root, 'RESEARCH')).rejects.toMatchObject({ action: 'interview', message: expect.stringContaining('영역 01(3), 02(3), 03(3)') });
});
it('필수 답 또는 판단 이관 완료면 RESEARCH', async () => {
  const root = await project(); await startInterview(root);
  for (const q of await loadBank(root)) if (q.must) {
    if (q.id === 'Q03-02') await deferInterview(root, q.id); else await recordInterview(root, q.id, '답');
  }
  expect((await transitionState(root, 'RESEARCH')).state).toBe('RESEARCH');
});
it('enforce false는 기존 전이를 허용', async () => {
  const root = await project(); await setConfig(root, 'interview.enforce', 'false'); expect((await transitionState(root, 'RESEARCH')).state).toBe('RESEARCH');
});
it('WAIT_JUDGMENT는 인터뷰 가드 없음', async () => {
  expect((await transitionState(await project(), 'WAIT_JUDGMENT')).state).toBe('WAIT_JUDGMENT');
});
it('L3 필수 완료여도 skipDue가 남으면 RESEARCH 거부 후 skip으로 해소',async()=>{
  const {nextInterview,skipInterview}=await import('../src/core/interview.ts');const root=await project();await startInterview(root);
  for(const q of await loadBank(root))if(q.must)await recordInterview(root,q.id,'답');
  const first=await nextInterview(root,2);await skipInterview(root,first.questions[0].id,'제외');const second=await nextInterview(root,2);await skipInterview(root,second.questions[1].id,'제외');
  await expect(transitionState(root,'RESEARCH')).rejects.toMatchObject({action:'interview',message:expect.stringContaining('선택 질문')});
  await skipInterview(root,first.questions[1].id,'한도');expect((await transitionState(root,'RESEARCH')).state).toBe('RESEARCH');
});
