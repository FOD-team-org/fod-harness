import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { startInterview, deferInterview, nextInterview, interviewStatus } from '../src/core/interview.ts';
import { readJudgment, answerJudgment, applyJudgments } from '../src/core/judgment.ts';

it('F1 추천 choice를 ①로 옮기고 applied는 선택지 텍스트로 해석한다', async () => {
  const root = await project(); await startInterview(root);
  const { judgmentId } = await deferInterview(root, 'Q03-02');
  expect((await readJudgment(root)).items[0]).toMatchObject({ options: ['2~4주', '1주 이내', '1~3개월', '미정'], recommend: '2~4주' });
  await answerJudgment(root, judgmentId!, '①');
  expect((await applyJudgments(root)).applied).toEqual([{ id: judgmentId, interpretation: '2~4주' }]);
});

it('N8 choice 판단 답은 인터뷰 결정기록 뷰에 번호 대신 선택지 텍스트로 쓴다', async () => {
  const root = await project(); await startInterview(root);
  const { judgmentId } = await deferInterview(root, 'Q03-02');
  await answerJudgment(root, judgmentId!, '①'); await applyJudgments(root);
  await nextInterview(root);
  const status = await interviewStatus(root);
  expect(status.questions['Q03-02'].answer).toBe('2~4주');
  const row = (await readFile(join(root, status.docFile!), 'utf8')).split('\n').find(line => line.startsWith('| Q03-02 |'));
  expect(row).toContain('| answered | 2~4주 |'); expect(row).not.toContain('①');
});

it.each([['두   번째', ['두 번째', '첫 번째']], ['별도 추천', ['첫 번째', '두 번째']]])(
  'F1 공백 정리 비교와 불일치 순서 유지: %s', async (recommend, options) => {
    const root = await project();
    await writeFile(join(root, '.pi/interview-bank.md'), `## 01 문제·목적\n- [필수] Q01-01 | choice: 첫 번째/두 번째 | 순서 | 추천: ${recommend}\n`);
    await startInterview(root); await deferInterview(root, 'Q01-01');
    expect((await readJudgment(root)).items[0]).toMatchObject({ options, recommend });
  },
);
