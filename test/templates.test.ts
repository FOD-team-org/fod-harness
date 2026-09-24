import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { commandTable } from '../src/cli/index.ts';
import { instruction } from '../extensions/orchestrator/resume.ts';
import { startInterview, recordInterview } from '../src/core/interview.ts';
import { setConfig } from '../src/core/config.ts';
import { substitute } from '../src/core/template-values.ts';
const headings=['지금 할 일','산출물','끝내는 조건','다음 fodh 명령','금지'];
const promptKeys=['taskId','judgmentFile','backlogFile','docsRoot','today','interviewSummary'];
const docsKeys=['date','taskId','taskTitle','specRev','topic','subject','projectName','judgmentFile'];
async function files(dir:string):Promise<string[]> { const result:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})) if(e.isDirectory())result.push(...await files(join(dir,e.name)));else result.push(join(dir,e.name));return result; }
it('모든 상태 프롬프트 5절 순서·25줄·금지 첫 줄·허용 치환',async()=>{
  expect(await files('templates/prompts')).toContain('templates/prompts/PROJECT_READY.md');
  for(const file of await files('templates/prompts')){
    const text=await readFile(file,'utf8');expect([...text.matchAll(/^## (.+)$/gmu)].map(m=>m[1]),file).toEqual(headings);
    expect(text.trimEnd().split('\n').length,file).toBeLessThanOrEqual(25);
    expect(text,file).toContain('## 금지\n두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.');
    for(const m of text.matchAll(/\{\{([^{}]+)\}\}/gu))expect(promptKeys,file).toContain(m[1]);
    expect(text).not.toMatch(/P[34] 전/u);
  }
});
it('P7 준비 완료 정지·백로그 등록 확인·조사 주제와 필수 인자를 안내한다', async () => {
  expect(await readFile('templates/prompts/PICK.md', 'utf8')).toContain('EMPTY(백로그 비어 있음)면 `fodh state transition PLANNING` 은 하지 말고 `대기: 사용자` 로 끝낸다');
  expect(await readFile('templates/prompts/IMPLEMENT.md', 'utf8')).toContain('git 프로젝트면 `fodh worktree create {{taskId}}` 가 **필수**');
  const ready = await readFile('templates/prompts/PROJECT_READY.md', 'utf8');
  expect(ready).toContain('마지막 3줄에 `대기: 사용자`');
  expect(ready).toContain('없음(사용자 `/develop-start`)');
  expect(ready).toContain('`fodh state transition PLANNING` 호출');
  expect(await readFile('templates/prompts/REVIEW.md', 'utf8')).toContain('PROJECT_READY` 이후 `대기: 사용자`');
  expect(await readFile('templates/prompts/PLANNING.md', 'utf8')).toContain('`fodh backlog list` 로 등록 수를 확인');
  const research = await readFile('templates/prompts/RESEARCH.md', 'utf8');
  expect(research).toContain('인터뷰 핵심 결정에서 스스로 정한다(사용자에게 묻지 않는다)');
  expect(research).toContain('`--topic` 은 필수'); expect(research).toContain('`--spec` 도 필수');
});
it('템플릿·스킬의 명시 명령은 commandTable과 일치, 표 중복 없음',async()=>{
  expect(new Set(commandTable.map(c=>c.group+':'+c.action)).size).toBe(commandTable.length);
  for(const file of [...await files('templates'),...await files('skills')].filter(f=>f.endsWith('.md'))){
    const text=await readFile(file,'utf8');
    for(const m of text.matchAll(/\bfodh ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/gu)) {
      expect(commandTable.some(c=>c.group===m[1] && (!m[2] || c.action===m[2])),`${file}: ${m[0]}`).toBe(true);
    }
  }
});
it('scaffold 및 codex-header 치환은 각각 허용 목록',async()=>{
  for(const file of await files('templates/docs')) for(const m of (await readFile(file,'utf8')).matchAll(/\{\{([^{}]+)\}\}/gu))expect(docsKeys,file).toContain(m[1]);
  const header=await readFile('templates/codex-header.md','utf8');
  for(const m of header.matchAll(/\{\{([^{}]+)\}\}/gu))expect(['kind','runId','taskId','cwd','sandbox','readOnly','maxChildAgents','workerModel','workerEffort','kindFormat','spec'],m[1]).toContain(m[1]);
  expect(()=>substitute('{{unknown}}',{taskId:''},false)).toThrow('템플릿 치환 값이 없습니다: {{unknown}}');
});
it('지원 밖 명령은 같은 그룹 가능한 명령 안내',async()=>{
  const root=await project(), result=await cli(root,['interview','finish']);
  expect(result.code).toBe(1);expect(result.value.error).toContain('지원하지 않는 fodh 명령입니다. 가능한 명령: fodh interview start');expect(result.value.error).not.toContain('fodh codex');
  expect((await cli(root,['missing'])).value.error).toContain('fodh interview status');
});
it('INTERVIEW 요약·docsRoot·날짜 치환, 그 외 인터뷰 없이 렌더',async()=>{
  const root=await project();expect(await instruction(root,{state:'INTERVIEW'})).toContain('인터뷰 기록 없음');
  await startInterview(root);await recordInterview(root,'Q01-01','답');expect(await instruction(root,{state:'INTERVIEW'})).toContain('영역 01(2)');
  await setConfig(root,'docs.root','문서');const text=await instruction(root,{state:'RESEARCH'});expect(text).toContain('문서/조사/');expect(text).toContain('scaffold 결과의 `path`');expect(text).not.toContain('{{today}}');expect(text).not.toContain('{{');
});

it('M4/F3/L7/L11 운영 지시·필수 플래그·scaffold path 회귀',async()=>{
  const cleanup=await readFile('templates/prompts/CLEANUP.md','utf8');for(const value of ['pendingReclaim','fodh reclaim --task','fodh state transition CLEANUP --task','1회 재시도','paused(cleanup)'])expect(cleanup).toContain(value);
  expect(cleanup).toContain('`fodh cleanup run --task {{taskId}} --scope processes` 1회 재시도');expect(cleanup).toContain('첫 실패가 storage·worktrees였으면');expect(cleanup).toContain('등록하고 `fodh state transition CLEANUP_FAILED` 후 `대기: 사용자`');
  for(const file of await files('templates/prompts'))for(const command of (await readFile(file,'utf8')).matchAll(/`(fodh judgment add[^`]*)`/gu))for(const flag of ['--title','--background','--options','--recommend','--blocks'])expect(command[1],file).toContain(flag);
  const interview=await readFile('templates/prompts/INTERVIEW.md','utf8');expect(interview).toContain('`next`가 이미 판단대기로 넘겼다');expect(interview).toContain('결과 `deferred`');expect(interview).toContain('질문을 그대로 다시 보여 주고');expect(interview).toContain('`repeated:true`');expect(interview).toContain('같은 라운드');expect(interview).toContain('skipDue');expect(interview).toContain('은행 파일·템플릿을 바꾸지 않는다');
  for(const state of ['RESEARCH','FIX','SPEC','PLANNING']){const text=await readFile(`templates/prompts/${state}.md`,'utf8');expect(text).not.toContain('{{today}}');expect(text).toContain('scaffold 결과의 `path`');expect(text).toContain('`--spec`');}
  const review=await readFile('templates/prompts/REVIEW.md','utf8'), branch=review.split('\n').find(l=>l.startsWith('2. task면'))!.split('프로젝트면')[1];
  expect(review.split('\n')[2]).toBe('1. `fodh state get`으로 프로젝트 또는 task 검수를 구분한다.');expect(branch).toContain('--subject');expect(branch).not.toContain('--task');expect(review).toContain('lastMessage');
  expect(await readFile('templates/prompts/RESEARCH.md','utf8')).toContain('read-only 위임이므로 보고서 저장은 두뇌가 한다');
  expect(await readFile('templates/prompts/IMPLEMENT.md','utf8')).toContain('하네스 두뇌 세션 전용. 위임 수행자');
});

it('H1 승인만 판단하고 경계는 위임·보호는 포기하도록 지시한다', async () => {
  const text = await readFile('templates/brain-rules.md', 'utf8');
  expect(text).toContain('승인 필수 차단(`[승인]`)만');
  expect(text).toContain('`[경계]` 차단은 판단을 만들지 않고 같은 동작을 재시도하지 않으며 위임');
  expect(text).toContain('`[보호]` 차단은 그 동작을 포기한다');
});
it('L4 storage 첫 실패 지시는 판단 1회·CLEANUP_FAILED 1회, processes 재시도 없음', async () => {
  const text = await readFile('templates/prompts/CLEANUP.md', 'utf8');
  const storage = text.split('\n').find(line => line.startsWith('- 첫 실패가 storage'))!;
  expect(storage).toContain('processes 재시도 없이');
  expect(storage.match(/fodh judgment add/g)).toHaveLength(1);
  expect(storage.match(/fodh state transition CLEANUP_FAILED/g)).toHaveLength(1);
  expect(storage.indexOf('fodh judgment add')).toBeLessThan(storage.indexOf('fodh state transition CLEANUP_FAILED'));
  expect(storage).toContain('후 `대기: 사용자`');
  expect(storage).not.toContain('fodh cleanup run');
  expect(text).toContain('- 첫 실패가 processes →'); expect(text).toContain('- processes 재실패 →');
});
it('N4 processes 재실패는 자동 판단에 맡기고 사용자 대기한다', async () => {
  const text = await readFile('templates/prompts/CLEANUP.md', 'utf8');
  const retryFailure = text.split('\n').find(line => line.startsWith('- processes 재실패'))!;
  expect(retryFailure.match(/fodh state transition CLEANUP_FAILED/g)).toHaveLength(1);
  expect(retryFailure).toContain('(paused(cleanup)); 자동 판단에 맡기고 `대기: 사용자`');
  expect(retryFailure).not.toMatch(/원인 판단 등록|fodh judgment add/);
});

it('F12/F15 자기 보고 플래그 대신 하네스 증거를 안내한다', async () => {
  for (const state of ['VERIFY', 'DOCS', 'CLEANUP']) {
    const text = await readFile(`templates/prompts/${state}.md`, 'utf8');
    expect(text).not.toMatch(/--(?:verify|docs|cleanup)-ok/u);
    expect(text).toContain('하네스');
  }
  const verify = await readFile('templates/prompts/VERIFY.md', 'utf8');
  expect(verify).toContain('두뇌가 면제하지 않는다');
  expect(verify.indexOf('fodh worktree commit')).toBeLessThan(verify.indexOf('fodh verify run'));
  expect(verify.indexOf('fodh verify run')).toBeLessThan(verify.indexOf('fodh state transition REVIEW'));
  expect(verify).toContain('커밋할 변경이 없습니다');
});

it('F16 위임 템플릿은 공식 슬롯 대기만 안내한다', async () => {
  for (const state of ['IMPLEMENT', 'REVIEW', 'RESEARCH', 'FIX']) {
    const text = await readFile(`templates/prompts/${state}.md`, 'utf8');
    expect(text).toContain('codex 슬롯 사용 중');
    expect(text).toContain('대기: 슬롯 codex');
    expect(text).toContain('가짜 runId 금지');
  }
});

it('F19 MERGE는 루트 병합·커밋 기록·검수 SHA 전이를 순서대로 안내한다', async () => {
  const text = await readFile('templates/prompts/MERGE.md', 'utf8');
  const commands = ['fodh backlog get {{taskId}}', 'git merge --no-ff <task 브랜치>',
    'fodh backlog set {{taskId}} --merge-commit $(git rev-parse HEAD)',
    'fodh state transition DOCS --task {{taskId}} --commit <review.commit>'];
  expect(commands.map(command => text.indexOf(command))).toEqual([...commands.map(command => text.indexOf(command))].sort((a, b) => a - b));
  for (const command of commands) expect(text).toContain(command);
  expect(text).toContain('프로젝트 루트(워크트리 아님)');
  expect(text).toContain('review.commit 을 바꾸는 판단을 만들지 않는다');
  expect(text).toContain('--reclaim');
});
