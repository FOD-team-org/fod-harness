import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { parseBank, loadBank, startInterview, readInterview, nextInterview, recordInterview, skipInterview, addInterview, deferInterview, interviewStatus } from '../src/core/interview.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState } from '../src/core/state.ts';
import { readJudgment, answerJudgment, completeJudgment } from '../src/core/judgment.ts';
import { readLedger } from '../src/core/ledger.ts';
it('은행 18영역 각각 필수 2~4·선택 1~3·모든 추천', async () => {
  const bank = await loadBank(await project());
  expect(new Set(bank.map(q => q.area)).size).toBe(18);
  for (let i = 1; i <= 18; i++) {
    const qs = bank.filter(q => Number(q.area) === i);
    expect(qs.filter(q => q.must).length).toBeGreaterThanOrEqual(2); expect(qs.filter(q => q.must).length).toBeLessThanOrEqual(4);
    expect(qs.filter(q => !q.must).length).toBeGreaterThanOrEqual(1); expect(qs.every(q => q.recommend)).toBe(true);
  }
});
it.each(['## 19 없음', '## 01 다른 이름', '- [필수] Q02-01 | free | 질문 | 추천: 값', '- [필수] Q01-01 | free | 질문', '잘못된 줄', '- [필수] Q01-01 | choice: 하나/ | 질문 | 추천: 값', '- [필수] Q01-01 | free | 질문 | 추천: {{unknown}}'])('파서 오류 줄 번호: %s', line => {
  expect(() => parseBank('## 01 문제·목적\n'+line, 'extra.md')).toThrow('인터뷰 은행 형식 오류: extra.md:2');
});
it('extraBank 덮어쓰기·신규 추가, start는 재호출 무변경', async () => {
  const root = await project();
  await writeFile(join(root, '.pi/interview-bank.md'), '## 01 문제·목적\n- [필수] Q01-01 | free | 새 질문 | 추천: 새 추천\n- [선택] Q01-99 | free | 추가 | 추천: 없음\n');
  const bank = await loadBank(root); expect(bank.find(q => q.id === 'Q01-01')?.text).toBe('새 질문'); expect(bank.find(q => q.id === 'Q01-99')).toBeTruthy();
  expect((await startInterview(root)).created).toBe(true);
  const before = await readFile(join(root, '.pi/harness-interview.json'));
  expect((await startInterview(root)).created).toBe(false); expect(await readFile(join(root, '.pi/harness-interview.json'))).toEqual(before);
});
it('미답 필수 우선·askCount·round·maxAsks mustDefer·선택 순서·종료 불변식', async () => {
  const root = await project(); await startInterview(root);
  const first = await nextInterview(root); expect(first.questions.map(q => q.id)).toEqual(['Q01-01','Q01-02','Q01-03','Q02-01','Q02-02','Q02-03']);
  for (let i = 0; i < 3; i++) {
    const repeated = await nextInterview(root); expect(repeated).toMatchObject({ round: 1, questions: first.questions, repeated: true });
    expect((await readInterview(root))?.questions['Q01-02'].askCount).toBe(1);
  }
  await recordInterview(root, 'Q01-01', '원문');
  expect((await readInterview(root))?.openRound?.ids).not.toContain('Q01-01');
  const second = await nextInterview(root); expect(second.questions[0].id).toBe('Q01-02'); expect(second.round).toBe(2);
  for (const id of first.questions.slice(1).map(q => q.id)) expect((await readInterview(root))?.questions[id].askCount).toBe(2);
  expect((await nextInterview(root)).repeated).toBe(true);
  await recordInterview(root, 'Q03-01', '새 라운드 답');
  const third = await nextInterview(root); expect(third.mustDefer).toContain('Q01-02'); expect(third.questions.map(q => q.id)).not.toContain('Q01-02');
  expect((await readInterview(root))?.questions['Q01-02'].askCount).toBe(2);
  for (const q of await loadBank(root)) if (q.must) await recordInterview(root, q.id, '명시 답'); else await skipInterview(root, q.id, '범위 제외');
  const end = await nextInterview(root); expect(end).toMatchObject({ questions: [], mustDefer: [], complete: true });
});
it('record·선택 skip·필수 skip 거부·add와 문서 요약·원장에는 답 없음', async () => {
  const root = await project(); await startInterview(root);
  await expect(skipInterview(root, 'Q01-01', '제외')).rejects.toThrow('필수 질문은 건너뛸 수 없습니다. 답을 받거나 fodh interview defer 로 판단대기에 넘기세요');
  await recordInterview(root, 'Q01-01', '원문 | 답\n다음 줄', 'user');
  await skipInterview(root, 'Q01-04', '해당 없음');
  const added = await addInterview(root, { area: '03', text: '추가 질문', must: true }); expect(added.id).toBe('Q03-x01');
  expect((await addInterview(root, { area: '03', text: '두 번째' })).id).toBe('Q03-x02');
  const status = await interviewStatus(root), text = await readFile(join(root, status.docFile!), 'utf8');
  expect(text).toContain(`남은 필수 ${status.remainingMust}개`); expect(text).toContain('원문 \\| 답 다음 줄'); expect(text).toContain('사람이 편집한 내용은 보존하지 않습니다');
  expect(JSON.stringify(await readLedger(root))).not.toContain('원문');
  expect((await readLedger(root)).filter(e => e.action.startsWith('interview:')).map(e => e.action)).toEqual(['interview:record','interview:skip','interview:add','interview:add']);
});
it('defer dedupe, 완료 표를 answered로 읽고 파일은 쓰지 않는다', async () => {
  const root = await project(); await startInterview(root);
  const first = await deferInterview(root, 'Q03-02'), second = await deferInterview(root, 'Q03-02');
  expect(second.judgmentId).toBe(first.judgmentId);
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await readJudgment(root)).items[0]).toMatchObject({ blocks: '-', background: '인터뷰 영역 03', options: ['2~4주','1주 이내','1~3개월','미정'] });
  await answerJudgment(root, first.judgmentId!, '1'); await completeJudgment(root, first.judgmentId!, { interpretation: '2~4주', commit: '문서 반영' });
  const before = await readFile(join(root, '.pi/harness-interview.json'));
  const status = await interviewStatus(root); expect(status.questions['Q03-02']).toMatchObject({ status: 'answered', source: `judgment:${first.judgmentId}`, answer: '2~4주' });
  expect(await readFile(join(root, '.pi/harness-interview.json'))).toEqual(before);
  await deferInterview(root, 'Q01-01'); expect((await readJudgment(root)).items[0].options).toEqual(['추천안 채택','직접 답하기']);
});
it('config 추천은 현재 설정으로 치환한다', async () => {
  const root = await project(); await startInterview(root); await setConfig(root, 'delegate.codex.workerModel', 'custom-worker');
  for (const q of await loadBank(root)) if (Number(q.area) < 17 && q.must) await recordInterview(root, q.id, '답');
  const next = await nextInterview(root);
  expect(next.questions.find(q => q.id === 'Q17-01')?.recommend).toContain('design');
  expect(next.questions.find(q => q.id === 'Q17-02')?.recommend).toContain('custom-worker'); expect(JSON.stringify(next)).not.toContain('{{config:');
});
it('동시 추가·기록은 유실되지 않는다', async () => {
  const root = await project(); await startInterview(root);
  await Promise.all([recordInterview(root, 'Q01-01', '답1'), recordInterview(root, 'Q01-02', '답2'), addInterview(root, { area: '01', text: '추가1' }), addInterview(root, { area: '01', text: '추가2' })]);
  const data = await readInterview(root); expect(data?.added.map(q => q.id)).toEqual(['Q01-x01','Q01-x02']); expect(data?.questions['Q01-02'].answer).toBe('답2');
});
it.each(['IDLE','RESEARCH','REVIEW','VERIFY'])('상태 %s에서 변이 제한; REVIEW record/add 허용', async state => {
  const root = await project(); await startInterview(root); await updateState(root, { state });
  for (const action of [() => startInterview(root), () => nextInterview(root), () => deferInterview(root, 'Q01-01'), () => skipInterview(root, 'Q01-04', '이유')]) await expect(action()).rejects.toThrow('현재 상태');
  if (state === 'REVIEW') { await recordInterview(root, 'Q01-01', '답'); await addInterview(root, { area: '01', text: '검수 질문' }); }
  else { await expect(recordInterview(root, 'Q01-01', '답')).rejects.toThrow('현재 상태'); await expect(addInterview(root, { area: '01', text: '검수 질문' })).rejects.toThrow('현재 상태'); }
  expect(await interviewStatus(root)).toBeTruthy();
});
it('CLI start/next/record/add/skip/defer/status와 잘못된 인자', async () => {
  const root = await project();
  for (const args of [['start'],['next','--count','1'],['record','Q01-01','--answer','답'],['add','--area','02','--text','추가','--must'],['skip','Q01-04','--reason','제외'],['defer','Q03-02'],['status']]) expect((await cli(root, ['interview', ...args])).code).toBe(0);
  expect((await cli(root, ['interview','next','--count','0'])).code).toBe(1);
  expect((await cli(root, ['interview','record','Q01-01','--answer','답','--source','guess'])).code).toBe(1);
  expect((await cli(root, ['interview','defer','missing'])).code).toBe(1);
});

it.each(['2','②','직접 답하기'])('L2 free defer 완료 답 %s는 실제 답을 다시 묻는다', async answer => {
  const root=await project();await startInterview(root);const deferred=await deferInterview(root,'Q01-01');
  await answerJudgment(root,deferred.judgmentId!,answer);await completeJudgment(root,deferred.judgmentId!,{interpretation:'직접 답하기',commit:'판단 적용'});
  expect((await interviewStatus(root)).questions['Q01-01']).toMatchObject({status:'open',askCount:0});
  expect((await nextInterview(root)).questions.map(q=>q.id)).toContain('Q01-01');
  expect((await readInterview(root))?.questions['Q01-01']).toMatchObject({status:'asked',askCount:1});
});
it('L3 선택 한도는 skipDue이며 필수 완료 후에도 skip 전 complete false', async () => {
  const root=await project();await startInterview(root);
  for(const q of await loadBank(root)) if(q.must) await recordInterview(root,q.id,'명시 답');
  const first=await nextInterview(root,2);expect(first.questions.every(q=>!q.must)).toBe(true);
  await skipInterview(root,first.questions[0].id,'제외');const second=await nextInterview(root,2);
  await skipInterview(root,second.questions[1].id,'제외');const third=await nextInterview(root,2);
  expect(third).toMatchObject({mustDefer:[],skipDue:[first.questions[1].id],complete:false});
  await skipInterview(root,first.questions[1].id,'한도');expect((await interviewStatus(root)).complete).toBe(true);
});
it('L5 비밀 접두 패턴 답은 거부하고 기존 상태·뷰·원장 보존; 기존 답도 뷰에서 제거', async () => {
  const root=await project();await startInterview(root);const path=join(root,'.pi/harness-interview.json'), before=await readFile(path);
  const secretPrefix='sk-'+'ant-'; // 자격증명이 아닌 검사용 접두만 사용한다.
  const doc=(await readInterview(root))!.docFile,beforeDoc=await readFile(join(root,doc)),ledger=await readLedger(root);
  await expect(recordInterview(root,'Q01-01',secretPrefix)).rejects.toThrow('답에 비밀값으로 보이는 문자열이 있습니다. 값을 빼고 다시 기록하세요');
  expect(await readFile(path)).toEqual(before);expect(await readFile(join(root,doc))).toEqual(beforeDoc);expect(await readLedger(root)).toEqual(ledger);
  const state=(await readInterview(root))!;state.questions['Q01-01']={status:'answered',askCount:1,answer:secretPrefix};await writeFile(path,JSON.stringify(state));
  await addInterview(root,{area:'01',text:'추가'});const rendered=await readFile(join(root,doc),'utf8');expect(rendered.includes(secretPrefix)).toBe(false);expect(rendered).toContain('[비밀값 제거]');
});
it('L8 answered·skipped defer 거부와 답 보존', async () => {
  const root=await project();await startInterview(root);await recordInterview(root,'Q01-01','답');await skipInterview(root,'Q01-04','제외');
  const before=await readFile(join(root,'.pi/harness-interview.json'));
  for(const id of ['Q01-01','Q01-04'])await expect(deferInterview(root,id)).rejects.toThrow('이미 답하거나 건너뛴 질문');
  expect(await readFile(join(root,'.pi/harness-interview.json'))).toEqual(before);
});
it('L9 선택 skip 이후 extraBank에서 필수로 바뀌면 pending',async()=>{
  const root=await project();await startInterview(root);await skipInterview(root,'Q01-04','제외');
  await writeFile(join(root,'.pi/interview-bank.md'),'## 01 문제·목적\n- [필수] Q01-04 | free | 이제 필수 | 추천: 직접 답하기\n');
  expect((await interviewStatus(root)).questions['Q01-04'].status).toBe('open');
  expect((await nextInterview(root)).questions.map(q=>q.id)).toContain('Q01-04');
});
it('M1 defer·skip도 열린 라운드 ID를 빼고 마지막 처리에서 해제한다',async()=>{
  const root=await project();await startInterview(root);await nextInterview(root,1);await deferInterview(root,'Q01-01');expect((await readInterview(root))?.openRound).toBeUndefined();
  for(const q of await loadBank(root))if(q.must && q.id!=='Q01-01')await recordInterview(root,q.id,'답');
  const next=await nextInterview(root,1);await skipInterview(root,next.questions[0].id,'선택 제외');expect((await readInterview(root))?.openRound).toBeUndefined();
});

it.each([true, false])('N1 필수=%s choice 자동 이관은 free 라운드 멱등성을 깨지 않는다', async must => {
  const root = await project();
  await writeFile(join(root, '.pi/interview-bank.md'), `## 01 문제·목적\n- [${must ? '필수' : '선택'}] Q01-02 | choice: 예/아니오 | 결정 | 추천: 예\n`);
  await startInterview(root);
  const ids = ['Q01-01', 'Q01-02', 'Q01-03', 'Q02-01', 'Q02-02', 'Q02-03'];
  for (const q of await loadBank(root)) if (!ids.includes(q.id)) await recordInterview(root, q.id, '답');
  const first = await nextInterview(root);
  expect(first.questions).toHaveLength(5); expect(first.questions.every(q => q.kind === 'free')).toBe(true);
  expect(first.deferred).toEqual([{ id: 'Q01-02', judgmentId: expect.stringMatching(/^A\d+$/) }]);
  const judgment = (await readJudgment(root)).items;
  expect(judgment).toHaveLength(1); expect(judgment[0]).toMatchObject({ id: first.deferred[0].judgmentId, options: ['예', '아니오'] });
  expect((await readInterview(root))?.questions['Q01-02']).toMatchObject({ status: 'judgment', judgmentId: first.deferred[0].judgmentId, askCount: 0 });
  expect((await readInterview(root))?.openRound?.ids).toEqual(first.questions.map(q => q.id));
  await deferInterview(root, 'Q01-02'); // 이미 이관된 choice를 재호출해도 free 처리 표지는 그대로다.
  for (let i = 0; i < 2; i++) {
    expect(await nextInterview(root)).toMatchObject({ round: first.round, questions: first.questions, deferred: [], repeated: true });
    for (const q of first.questions) expect((await readInterview(root))?.questions[q.id].askCount).toBe(1);
  }
  expect((await readJudgment(root)).items).toHaveLength(1);
  await recordInterview(root, first.questions[0].id, '실제 답');
  expect((await nextInterview(root)).repeated).toBe(false);
});
it.each([true, false])('N1 choice뿐인 최초 묶음 뒤 free 잔여=%s 보정', async hasFree => {
  const root = await project(); await startInterview(root);
  for (const q of await loadBank(root)) if (!['Q03-02','Q04-01', ...(hasFree ? ['Q04-02'] : [])].includes(q.id)) await recordInterview(root,q.id,'답');
  const next = await nextInterview(root, 1);
  expect(next.deferred.map(q => q.id)).toEqual(['Q03-02', 'Q04-01']);
  expect(next.questions.map(q => q.id)).toEqual(hasFree ? ['Q04-02'] : []);
  expect(next.complete).toBe(!hasFree);
  if (hasFree) expect(await nextInterview(root, 1)).toMatchObject({ round: next.round, questions: next.questions, repeated: true });
  else { expect((await readInterview(root))?.openRound).toBeUndefined(); expect((await nextInterview(root)).deferred).toEqual([]); }
  expect((await readJudgment(root)).items).toHaveLength(2);
});
it('N8 확장 비밀 패턴은 인터뷰 기록 전에 거부한다', async () => {
  const root = await project(); await startInterview(root);
  const before = await readFile(join(root, '.pi/harness-interview.json'));
  // 전부 합성 접두/반복 문자이며 실제 자격증명은 사용하지 않는다.
  for (const sample of ['sk-'+'proj-'+'x'.repeat(8), 'sk_'+'live_'+'x'.repeat(8), 'sk_'+'test_'+'x'.repeat(8), 'AIza'+'x'.repeat(20), 'xoxb-'+'x'.repeat(8), 'Bearer '+'x'.repeat(20)]) {
    await expect(recordInterview(root, 'Q01-01', sample)).rejects.toThrow('답에 비밀값으로 보이는 문자열');
  }
  expect(await readFile(join(root, '.pi/harness-interview.json'))).toEqual(before);
});
it('N1 이전 버전의 choice 포함 openRound도 free 횟수를 보존하며 정규화한다', async () => {
  const root = await project(); await startInterview(root);
  const data = (await readInterview(root))!;
  data.round = 2; data.openRound = { round: 2, ids: ['Q03-01', 'Q03-02'] };
  for (const id of data.openRound.ids) data.questions[id] = { status: 'asked', askCount: 1, round: 2 };
  await writeFile(join(root, '.pi/harness-interview.json'), JSON.stringify(data));
  const next = await nextInterview(root);
  expect(next).toMatchObject({ round: 2, repeated: true, deferred: [{ id: 'Q03-02', judgmentId: expect.any(String) }] });
  expect(next.questions.map(q => q.id)).toEqual(['Q03-01']);
  expect((await readInterview(root))?.questions['Q03-01'].askCount).toBe(1);
  expect((await readInterview(root))?.openRound).toEqual({ round: 2, ids: ['Q03-01'] });
});
it('보정2 짧은 비밀 패턴 접두는 일반 답으로 보존한다', async () => {
  const root = await project(); await startInterview(root);
  const answer = 'AKIA_short ghp_short sk-proj- sk_live_ sk_test_ AIza xoxb- Bearer short';
  await recordInterview(root, 'Q01-01', answer);
  const data = (await readInterview(root))!;
  expect(data.questions['Q01-01'].answer).toBe(answer);
  expect(await readFile(join(root, data.docFile), 'utf8')).toContain(answer);
});
