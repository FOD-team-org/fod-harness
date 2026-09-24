import { setConfig } from '../src/core/config.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addTask, getTask, listBacklog, readBacklog, setTask, missingDoD, type Task } from '../src/core/backlog.ts';
import { allowedTransition, readState, updateState, transitionState } from '../src/core/state.ts';
import { decidePick, runPick } from '../src/core/pick.ts';
import { addJudgment, answerJudgment, applyJudgments, readJudgment } from '../src/core/judgment.ts';
import { readLedger } from '../src/core/ledger.ts';
import { main } from '../src/cli/index.ts';
import { atomicWrite, harnessPath } from '../src/core/storage.ts';

const roots: string[] = [];
async function project() { const root = await mkdtemp('/private/tmp/fodh-p1-'); roots.push(root); return root; }
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const input = { title: '작업 | 제목', category: 'docs' };
const evidence = { verify: { ok: true }, review: { commit: 'sha1', high: 0 }, merge: { commit: 'merge1' }, docs: { ok: true }, cleanup: { ok: true } };
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, category: 'docs', depends: [], status: 'ready', repair: 0,
  judgment: '', worktree: '', notes: '', ...patch });
const graph: Record<string, string[]> = {
  IDLE: ['INTERVIEW', 'PLANNING'], INTERVIEW: ['RESEARCH', 'WAIT_JUDGMENT'], RESEARCH: ['PRD_DRAFT', 'WAIT_JUDGMENT'],
  PRD_DRAFT: ['ARCH', 'WAIT_JUDGMENT'], ARCH: ['REVIEW', 'WAIT_JUDGMENT'],
  REVIEW: ['PROJECT_READY', 'INTERVIEW', 'WAIT_JUDGMENT', 'MERGE', 'FIX', 'RECLAIM'], PROJECT_READY: ['PLANNING'], READY: [],
  PLANNING: ['PICK'], PICK: ['SPEC', 'DONE_ALL', 'WAIT_JUDGMENT', 'WAIT_RETRY', 'WAIT_RESOURCE', 'DEADLOCK'],
  SPEC: ['IMPLEMENT', 'RECLAIM'], IMPLEMENT: ['VERIFY', 'RECLAIM'], VERIFY: ['REVIEW', 'FIX', 'RECLAIM'],
  FIX: ['VERIFY', 'RECLAIM'], MERGE: ['DOCS', 'RECLAIM'], DOCS: ['CLEANUP', 'RECLAIM'], CLEANUP: ['PICK', 'CLEANUP_FAILED'],
  CLEANUP_FAILED: ['CLEANUP'], RECLAIM: ['PICK', 'CLEANUP_FAILED'],
  WAIT_JUDGMENT: ['PICK', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'], WAIT_RETRY: ['PICK'], WAIT_RESOURCE: ['PICK'],
  DEADLOCK: ['WAIT_JUDGMENT'], DONE_ALL: ['IDLE', 'PLANNING'], recovering: ['PICK', 'IDLE'],
  ...Object.fromEntries(['billing', 'quota', 'error', 'memory', 'budget', 'cleanup'].map(reason => [`paused(${reason})`, ['recovering', 'PICK']])),
};
it.each(Object.entries(graph))('전수 전이 행 %s: 나열되지 않은 모든 목적지 거부', (from, expected) => {
  for (const to of Object.keys(graph)) expect(allowedTransition(from, to), `${from}→${to}`).toBe(expected.includes(to));
  for (const reason of ['billing', 'quota', 'error', 'memory', 'budget', 'cleanup']) {
    expect(allowedTransition(from, `paused(${reason})`, true)).toBe(true);
  }
});
it.each(Object.entries(graph).flatMap(([from, next]) => next.map(to => [from, to])))('허용 전이 실제 저장 %s→%s', async (from, to) => {
  const root = await project(), t = await addTask(root, input); await setTask(root, t.id, evidence);
  if (from === 'INTERVIEW' && to === 'RESEARCH') await setConfig(root, 'interview.enforce', 'false');
  const projectReview = from === 'REVIEW' && ['PROJECT_READY', 'INTERVIEW', 'WAIT_JUDGMENT'].includes(to);
  const projectResume = from === 'WAIT_JUDGMENT' && to !== 'PICK';
  await updateState(root, { state: from, phase: projectReview || projectResume ? 'project' : 'task',
    taskId: projectReview || projectResume ? undefined : t.id, resumeState: from === 'WAIT_JUDGMENT' ? to : undefined,
    doctor: { ok: true, checkedAt: new Date().toISOString() }, autoTurns: 2 });
  if (from === 'CLEANUP' && to === 'PICK') await setTask(root, t.id, { status: 'done' });
  if (from === 'REVIEW' && ['PROJECT_READY', 'MERGE'].includes(to)) await atomicWrite(harnessPath(root, 'codex/review-fixture/meta.json'),
    JSON.stringify({ kind: 'review', status: 'ok', taskId: to === 'MERGE' ? t.id : undefined, startedAt: (await readState(root)).reviewSince }));
  const result = await transitionState(root, to, { taskId: t.id, commit: 'sha1', system: from === 'WAIT_JUDGMENT' });
  expect(result.state).toBe(to); expect(result.autoTurns).toBe(0); expect(result.enteredAt).toBeTruthy();
  expect((await readLedger(root)).filter(entry => entry.action.startsWith('state:')).at(-1)).toMatchObject({ action: `state:${from}→${to}`, status: 'ok' });
  if (to.startsWith('WAIT_') || ['DONE_ALL', 'CLEANUP_FAILED'].includes(to)) {
    const entries = await readLedger(root);
    const stateIndex = entries.findLastIndex(entry => entry.action === `state:${from}→${to}`);
    const notifyIndex = entries.findLastIndex(entry => entry.action === `notify:state:${to}`);
    expect(notifyIndex).toBeGreaterThan(stateIndex);
  }
});
it('IDLE 무백로그 planning, 일반 paused, 그래프 우회와 task 교체를 거부한다', async () => {
  const root = await project(); await expect(transitionState(root, 'PLANNING')).rejects.toThrow('백로그');
  await expect(transitionState(root, 'paused(error)')).rejects.toThrow('허용되지');
  await expect(transitionState(root, 'MERGE', { system: true })).rejects.toThrow('허용되지');
  await transitionState(root, 'paused(error)', { system: true });
  expect((await readState(root)).lastPaused).toBe('error');
  const a = await addTask(root, input), b = await addTask(root, input);
  await updateState(root, { state: 'IMPLEMENT', taskId: a.id });
  await expect(transitionState(root, 'VERIFY', { taskId: b.id })).rejects.toThrow('바꿀 수');
});
it.each([['PICK','SPEC'], ['SPEC','IMPLEMENT'], ['IMPLEMENT','VERIFY'], ['VERIFY','REVIEW'], ['VERIFY','FIX'], ['REVIEW','MERGE'], ['MERGE','DOCS']])('task 가드 %s→%s', async (from,to) => {
  const root = await project(); await updateState(root, { state: from, taskId: 'T01', phase: 'task' });
  await expect(transitionState(root, to)).rejects.toThrow('--task');
  await expect(transitionState(root, to, 'T99')).rejects.toThrow('찾을 수');
});
it.each(['IMPLEMENT','MERGE'])('doctor 가드 %s: 누락·만료·미래는 불가', async to => {
  const root = await project(), t = await addTask(root,input);
  for (const checkedAt of [undefined, new Date(Date.now()-13*3600000).toISOString(), new Date(Date.now()+3600000).toISOString()]) {
    await updateState(root,{state:to==='IMPLEMENT'?'SPEC':'REVIEW',taskId:t.id,doctor:{ok:true,checkedAt}});
    await expect(transitionState(root,to,t.id)).rejects.toThrow('doctor');
  }
});
it('FIX 3회 제한은 task별 영속하며 네 번째 거부는 상태·repair를 보존한다', async () => {
  const root=await project(),t=await addTask(root,input);
  for(let i=1;i<=3;i++) { await updateState(root,{state:'VERIFY',taskId:t.id}); await transitionState(root,'FIX',t.id); expect((await getTask(root,t.id)).repair).toBe(i); }
  await transitionState(root,'VERIFY',t.id);
  await expect(transitionState(root,'FIX',t.id)).rejects.toMatchObject({message:'repair 초과',action:'reclaim'});
  expect((await readState(root)).state).toBe('VERIFY'); expect((await getTask(root,t.id)).repair).toBe(3);
});
it.each([undefined,'wrong','sha1'])('MERGE→DOCS는 현재 커밋 증거 %s를 검사한다', async commit => {
  const root=await project(),t=await addTask(root,input); await setTask(root,t.id,{review:{commit:'sha1',high:0}});
  await updateState(root,{state:'MERGE',taskId:t.id});
  if(commit==='sha1') expect((await transitionState(root,'DOCS',{taskId:t.id,commit})).state).toBe('DOCS');
  else await expect(transitionState(root,'DOCS',{taskId:t.id,commit})).rejects.toThrow('검수 증거');
});
it('프로젝트 REVIEW와 task REVIEW는 서로의 출구를 쓸 수 없다', async () => {
  const root=await project(),t=await addTask(root,input);
  await updateState(root,{state:'ARCH'}); await transitionState(root,'REVIEW');
  await expect(transitionState(root,'MERGE',t.id)).rejects.toThrow('프로젝트 검수');
  await transitionState(root,'WAIT_JUDGMENT'); expect((await readState(root)).resumeState).toBe('REVIEW');
  await expect(transitionState(root,'PICK')).rejects.toThrow('답이 필요');
  await expect(transitionState(root,'PICK',{system:true})).rejects.toThrow('resumeState');
  await transitionState(root,'REVIEW',{system:true});
  await updateState(root,{state:'REVIEW',taskId:t.id,phase:'task'});
  await expect(transitionState(root,'PROJECT_READY')).rejects.toThrow('프로젝트 검수');
});
it('표 왕복·사람 편집·부가 필드 보존·commit 변경시 high 무효화', async () => {
  const root=await project(),t=await addTask(root,input); await setTask(root,t.id,{...evidence,notes:'메모\n다음 | 줄'});
  const path=join(root,'docs/backlog.md'); let text=await readFile(path,'utf8');
  expect(text).toContain('작업 \\| 제목'); expect(text).toContain('<br>');
  await writeFile(path,'머리말 보존\n'+text.replace('작업 \\| 제목','사람 수정').replace('sha1','sha2'));
  expect((await getTask(root,t.id))).toMatchObject({title:'사람 수정',verify:{ok:true},review:{commit:'sha2'}});
  expect((await getTask(root,t.id)).review?.high).toBeUndefined();
  await setTask(root,t.id,{worktree:'wt-t01'}); expect(await readFile(path,'utf8')).toMatch(/^머리말 보존/u);
});
it('삭제한 ID는 자동·사람 편집에서 재사용하지 않고 동시 add도 고유하다', async () => {
  const root=await project(),t=await addTask(root,input),path=join(root,'docs/backlog.md');
  const before=await readFile(path,'utf8'); await writeFile(path,before.split('\n').filter(line=>!line.startsWith(`| ${t.id} |`)).join('\n'));
  expect(await listBacklog(root)).toEqual([]);
  const added=await Promise.all(Array.from({length:5},()=>addTask(root,input)));
  expect(new Set(added.map(t=>t.id)).size).toBe(5); expect(added.some(other=>other.id===t.id)).toBe(false);
  await writeFile(path,before); await expect(listBacklog(root)).rejects.toThrow('재사용');
});
it.each(['verify.ok','review.high','review.commit','merge.commit','docs.ok','cleanup.ok'])('DoD 누락 %s는 done 거부', async key => {
  const root=await project(),t=await addTask(root,input),patch=structuredClone(evidence) as any;
  const [group,field]=key.split('.'); delete patch[group][field]; await setTask(root,t.id,patch);
  expect(missingDoD(await getTask(root,t.id))).toContain(key);
  await expect(setTask(root,t.id,{status:'done'})).rejects.toMatchObject({missing:[key]});
});
it('DoD 충족 done과 spec 개정시 증거 무효화·repair 리셋', async () => {
  const root=await project(),t=await addTask(root,input); await setTask(root,t.id,{...evidence,status:'done'});
  expect((await getTask(root,t.id)).status).toBe('done');
  await setTask(root,t.id,{status:'ready',repair:3,spec:{rev:1}});
  expect((await getTask(root,t.id)).repair).toBe(0); expect(missingDoD(await getTask(root,t.id))).toHaveLength(6);
});
it('잘못된 사람 편집 done은 증거를 만들어내지 않으며 JSON 내용을 보존한다', async () => {
  const root=await project();await addTask(root,input); const md=join(root,'docs/backlog.md'),json=join(root,'.pi/harness-backlog.json');
  const before=await readFile(json,'utf8'); await writeFile(md,(await readFile(md,'utf8')).replace('| ready |','| done |'));
  const loaded=await readBacklog(root);expect(loaded.warnings[0]).toContain('DoD');
  expect(loaded.tasks[0].status).toBe('ready');expect(await readFile(json,'utf8')).toBe(before);
});
const now=Date.parse('2026-09-24T00:00:00Z');
it.each([
  [[task('T01')],{},'SPEC'], [[task('T01',{status:'done'}),task('T02',{depends:['T01']})],{},'SPEC'],
  [[],{},'EMPTY'],[[task('T01',{status:'done'})],{},'DONE_ALL'],
  [[task('T01',{status:'blocked(A1)'})],{},'WAIT_JUDGMENT'],
  [[task('T01',{status:'blocked(A1)'}),task('T02',{depends:['T01']})],{},'WAIT_JUDGMENT'],
  [[task('T01',{status:'doing'})],{lastPaused:'error'},'WAIT_RETRY'],[[task('T01',{status:'doing'})],{lastPaused:'quota'},'WAIT_RETRY'],
  [[task('T01')],{lastPaused:'memory'},'WAIT_RESOURCE'],[[task('T01')],{lastPaused:'budget'},'WAIT_RESOURCE'],
  [[task('T01',{depends:['T02']}),task('T02',{depends:['T01']})],{},'DEADLOCK'],[[task('T01',{depends:['T99']})],{},'DEADLOCK'],
] as const)('PICK 판정 %#', (backlog,patch,outcome) => {
  const before=JSON.stringify(backlog);expect(decidePick([...backlog],{state:'PICK',...patch},{slots:'ok',now}).outcome).toBe(outcome);
  expect(JSON.stringify(backlog)).toBe(before);
});
it('PICK 우선순위·슬롯·자기 순환·blocked와 잘못된 의존 혼합',()=>{
  expect(decidePick([task('T09'),task('T01')],{state:'PICK'},{slots:'ok'}).task?.id).toBe('T09');
  expect(decidePick([task('T01')],{state:'PICK'},{slots:false}).outcome).toBe('WAIT_RESOURCE');
  expect(decidePick([task('T01',{depends:['T01']})],{state:'PICK'},{slots:'ok'}).cycle).toEqual(['T01','T01']);
  expect(decidePick([task('T01',{status:'blocked(A1)'}),task('T02',{depends:['T99']})],{state:'PICK'},{slots:'ok'}).outcome).toBe('DEADLOCK');
});
it('PICK 백오프 5·15·60분·동일 시각 멱등·3회 소진',()=>{
  const backlog=[task('T01',{status:'doing'})];
  for(const [count,minutes] of [5,15,60].entries()) {
    const result=decidePick(backlog,{state:'PICK',lastPaused:'error',retry:{count}},{slots:'ok',now});
    expect(result.retry).toEqual({count:count+1,nextAt:new Date(now+minutes*60000).toISOString()});
    expect(decidePick(backlog,{state:'WAIT_RETRY',lastPaused:'error',retry:result.retry},{slots:'ok',now}).retry).toEqual(result.retry);
  }
  expect(decidePick(backlog,{state:'PICK',lastPaused:'quota',retry:{count:3}},{slots:'ok',now})).toMatchObject({outcome:'WAIT_JUDGMENT',exhausted:true});
});
it('runPick은 SPEC·doing과 교착 판단 생성·WAIT_JUDGMENT를 수행한다',async()=>{
  const root=await project(),t=await addTask(root,input); await updateState(root,{state:'PICK'});
  expect((await runPick(root)).outcome).toBe('SPEC'); expect((await getTask(root,t.id)).status).toBe('doing');
  await setTask(root,t.id,{status:'ready',depends:['T99']});await updateState(root,{state:'PICK'});
  expect((await runPick(root)).outcome).toBe('DEADLOCK'); expect((await readState(root)).state).toBe('WAIT_JUDGMENT');
  expect((await readJudgment(root)).items[0].background).toContain('T99');
});
it('runPick 재시도 예약 중 반복 호출은 백오프를 증가시키지 않는다',async()=>{
  const root=await project(),t=await addTask(root,input);await setTask(root,t.id,{status:'doing'});
  await updateState(root,{state:'PICK',lastPaused:'error'});
  const first=await runPick(root,{slots:'ok',now});const second=await runPick(root,{slots:'ok',now});
  expect(second.retry).toEqual(first.retry);
});
it.each([
  ['①','choice',true],['2, 단 검수 후','conditional',true],['테스트 먼저','freeform',true],
  ['1 또는 2','ambiguous',false],['rev','revision-mismatch',false],['','empty',false],
])('judgment apply 6분류 %s (%s)',async(answer,kind,applies)=>{
  const root=await project(),t=await addTask(root,input),added=await addJudgment(root,{title:'범위',background:'',options:['첫째','둘째'],recommend:'①',blocks:t.id});
  await setTask(root,t.id,{status:`blocked(${added.item.id})`,judgment:added.item.id});
  await answerJudgment(root,added.item.id,answer==='rev'?'1':answer);
  if(answer==='rev') {const path=join(root,'docs/판단대기.md');await writeFile(path,(await readFile(path,'utf8')).replace('— 범위','— 변경 범위'));}
  const result=await applyJudgments(root);expect(result.applied.length).toBe(applies?1:0);
  expect((await getTask(root,t.id)).status).toBe(applies?'ready':`blocked(${added.item.id})`);
  const doc=await readJudgment(root);
  if(applies) {expect(doc.completed[0].answer).toBe(answer);expect(doc.completed[0].interpretation).toBeTruthy();}
  else expect(doc.items.length).toBe(kind==='empty'?1:2);
});
it('승인 토큰 없는 필수 항목은 재질문하고 새 답으로 원 task를 해제한다',async()=>{
  const root=await project(),t=await addTask(root,input),{item}=await addJudgment(root,{title:'결제',background:'',options:['실행','유지'],recommend:'②',blocks:t.id,requiresApproval:true});
  await setTask(root,t.id,{status:`blocked(${item.id})`});await answerJudgment(root,item.id,'검수 후 처리해');
  expect((await applyJudgments(root)).applied).toHaveLength(0);
  const followup=(await readJudgment(root)).items.find(other=>other.reaskOf===item.id)!;
  await applyJudgments(root);expect((await readJudgment(root)).items).toHaveLength(2);
  await answerJudgment(root,followup.id,'승인 검수 후 처리해');expect((await applyJudgments(root,[followup.id])).applied).toHaveLength(1);
  expect((await getTask(root,t.id)).status).toBe('ready');expect((await getTask(root,t.id)).notes).toContain('검수 후');
  const closed=await readJudgment(root);expect(closed.items).toHaveLength(0);expect(closed.completed).toHaveLength(2);
  expect(closed.completed.find(row=>row.id===item.id)?.answer).toBe(`모호: 검수 후 처리해 → ${followup.id}: 승인 검수 후 처리해`);
});
it('ID 한정 apply는 미선택 답과 다른 열린 차단 판단을 보존한다',async()=>{
  const root=await project(),t=await addTask(root,input),items=[];
  for(let i=0;i<2;i++){const {item}=await addJudgment(root,{title:`범위${i}`,background:'',options:['유지'],recommend:'①',blocks:t.id});items.push(item);await answerJudgment(root,item.id,'1');}
  await setTask(root,t.id,{status:`blocked(${items[0].id})`});
  await applyJudgments(root,[items[0].id]);expect((await getTask(root,t.id)).status).toBe(`blocked(${items[1].id})`);
  await applyJudgments(root,[items[1].id]);expect((await getTask(root,t.id)).status).toBe('ready');
});
async function cli(root:string,args:string[]){let output='';const spy=vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{output+=chunk;return true;});process.exitCode=0;try{await main(args,root);return {code:process.exitCode,value:JSON.parse(output)};}finally{spy.mockRestore();}}
it('CLI 새 명령은 JSON·오류 상세·DoD 누락·repair action을 반환한다',async()=>{
  const root=await project();const t=(await cli(root,['backlog','add','--title','CLI','--category','docs'])).value;
  expect((await cli(root,['backlog','list','--json'])).value.tasks).toHaveLength(1);
  expect((await cli(root,['backlog','get',t.id])).value.id).toBe(t.id);
  expect((await cli(root,['backlog','set',t.id,'--status','done'])).value.error).toBe('상태는 전이로만 바뀝니다');
  await updateState(root,{state:'CLEANUP',taskId:t.id});
  expect((await cli(root,['backlog','set',t.id,'--status','done'])).value.missing).toHaveLength(6);
  expect((await cli(root,['backlog','set',t.id,'--repair','3'])).code).toBe(1);
  for(let n=0;n<3;n++){await updateState(root,{state:'VERIFY',taskId:t.id});await transitionState(root,'FIX',t.id);}
  await transitionState(root,'VERIFY',t.id);
  expect(await cli(root,['state','transition','FIX','--task',t.id])).toMatchObject({code:1,value:{error:'repair 초과',action:'reclaim'}});
  expect((await cli(root,['cleanup','report'])).value.ok).toBe(true);
});
it('재시도 소진 판단 적용은 재시도 이력을 초기화하고 회수하지 않은 doing 작업은 재실행하지 않는다',async()=>{
  const root=await project(),t=await addTask(root,input);await setTask(root,t.id,{status:'doing'});
  await updateState(root,{state:'PICK',lastPaused:'quota',retry:{count:3}});
  await runPick(root);const {items}=await readJudgment(root);await answerJudgment(root,items[0].id,'1');
  await applyJudgments(root);expect((await readState(root)).retry).toBeUndefined();
  expect((await readState(root)).state).toBe('PICK');
  await runPick(root);expect((await getTask(root,t.id)).status).toMatch(/^blocked\(A\d+\)$/u);
  expect((await readJudgment(root)).items[0].title).toContain(`고아 task ${t.id}`);
});
it('별도 Node fodh 프로세스에서 새 CLI 흐름을 실제 실행한다',async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {resolve}=await import('node:path');
  const root=await project();const execute=promisify(execFile);
  const cli=async(args:string[])=>JSON.parse((await execute(resolve('bin/fodh'),args,{cwd:root,env:{...process.env,FODH_PROJECT_ROOT:root}})).stdout);
  const t=await cli(['backlog','add','--title','새 명령','--category','docs']);
  await cli(['state','transition','PLANNING']);await cli(['state','transition','PICK']);
  expect((await cli(['pick'])).outcome).toBe('SPEC');
  const reclaimed=await cli(['judgment','add','--title','위임 필요','--background','P3 이전','--options','대기|검토','--recommend','대기','--blocks',t.id,'--reclaim']);
  expect(reclaimed).toMatchObject({reclaimed:true,next:'PICK'});
  await cli(['judgment','answer',reclaimed.judgment,'1']);expect((await cli(['judgment','apply',reclaimed.judgment])).applied).toHaveLength(1);
  expect((await cli(['backlog','get',t.id])).status).toBe('ready');
});
it.each([['DOCS','CLEANUP'],['IMPLEMENT','RECLAIM']])('task 비필수 전이 %s→%s도 다른 task 주입을 거부한다',async(from,to)=>{
  const root=await project(),a=await addTask(root,input),b=await addTask(root,input);
  await updateState(root,{state:from,taskId:a.id});
  await expect(transitionState(root,to,{taskId:b.id})).rejects.toThrow('바꿀 수');
  expect((await readState(root)).taskId).toBe(a.id);
});
it('메모리 대기는 pick 재호출로 해제되지 않고 명시적 WAIT_RESOURCE→PICK 뒤 해제된다',async()=>{
  const root=await project();await addTask(root,input);await updateState(root,{state:'PICK',lastPaused:'memory'});
  expect((await runPick(root)).outcome).toBe('WAIT_RESOURCE');
  expect((await runPick(root)).outcome).toBe('WAIT_RESOURCE');expect((await readState(root)).lastPaused).toBe('memory');
  await transitionState(root,'PICK');expect((await readState(root)).lastPaused).toBeUndefined();
  expect((await runPick(root)).outcome).toBe('SPEC');
});
it('CLI 빈 수치로 repair 또는 review.high=0을 만들 수 없다',async()=>{
  const root=await project(),t=await addTask(root,input);
  expect((await cli(root,['backlog','set',t.id,'--review-high',''])).code).toBe(1);
  expect((await cli(root,['backlog','set',t.id,'--repair',' '])).code).toBe(1);
  expect((await getTask(root,t.id)).review?.high).toBeUndefined();
});
it('과거 phase 없는 프로젝트 REVIEW도 WAIT에서 동일 REVIEW로만 복귀한다',async()=>{
  const root=await project();await updateState(root,{state:'REVIEW'});await transitionState(root,'WAIT_JUDGMENT');
  expect((await transitionState(root,'REVIEW',{system:true})).state).toBe('REVIEW');
});
it('설정된 승인 필수 동작은 read --answered와 apply가 같은 불가 판정을 쓴다',async()=>{
  const root=await project();const {setConfig}=await import('../src/core/config.ts');await setConfig(root,'requiresApproval','["custom-sensitive-action"]');
  const {item}=await addJudgment(root,{title:'custom-sensitive-action',background:'',options:['실행','유지'],recommend:'②',blocks:''});
  await answerJudgment(root,item.id,'검수 후 처리해');
  expect((await readJudgment(root,{answered:true})).items[0].classification?.applicable).toBe(false);
  expect((await applyJudgments(root)).applied).toHaveLength(0);
});
