import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { updateState } from '../src/core/state.ts';
import { setConfig } from '../src/core/config.ts';
import { scaffoldDoc } from '../src/core/docs.ts';
import { initialize } from '../extensions/orchestrator/index.ts';
it.each([
  ['prd','PRD.md'], ['arch','설계/아키텍처.md'], ['tools','설계/도구-스킬-MCP.md'], ['backlog-draft','설계/2026-09-24-백로그-초안.md'],
  ['spec','위임스펙/2026-09-24-T01.md'], ['fix-spec','위임스펙/2026-09-24-T01-수정.md'], ['review-request','검수/2026-09-24-T01-검수요청.md'],
  ['review','검수/2026-09-24-T01-검수.md'], ['research-q','조사/2026-09-24-시장-질문.md'], ['research-r','조사/2026-09-24-시장-결과.md'], ['backlog','backlog.md'], ['worklog','작업일지.md'],
])('kind %s의 경로·치환·덮어쓰기 금지', async (kind, target) => {
  const root = await project();
  if (!['backlog','worklog'].includes(kind)) await addTask(root, { title: '제목', category: 'docs' });
  await updateState(root, { projectName: '테스트 프로젝트' });
  const opts = { ...(kind.includes('spec') || kind.includes('review') ? { task: 'T01' } : {}), topic: '시장', date: '2026-09-24' };
  expect(await scaffoldDoc(root, kind, opts)).toEqual({ path: 'docs/'+target, created: true });
  const path = join(root, 'docs', target), before = await readFile(path, 'utf8'); expect(before).not.toMatch(/\{\{/u); if (['backlog','worklog'].includes(kind)) expect(before).not.toContain('> 채울 것'); else expect(before).toContain('> 채울 것:');
  expect(await scaffoldDoc(root, kind, opts)).toEqual({ path: 'docs/'+target, error: `이미 있는 문서입니다: docs/${target}. 기존 문서를 고치세요` });
  expect(await readFile(path, 'utf8')).toBe(before);
});
it.each(['spec','fix-spec','review','review-request','research-q','research-r'])('%s 필수 인자 누락', async kind => {
  await expect(scaffoldDoc(await project(), kind)).rejects.toThrow('필수 인자');
});
it('override·task title/rev·subject·docsRoot 및 backlog 고정', async () => {
  const root = await project(); const task = await addTask(root, { title: '제목 원문', category: 'docs' }); await setTask(root, task.id, { spec: { rev: 4 } });
  await mkdir(join(root, '.pi/templates/docs/위임스펙'), { recursive: true });
  await writeFile(join(root, '.pi/templates/docs/위임스펙/템플릿.md'), '{{taskTitle}} {{specRev}} {{subject}} {{judgmentFile}}');
  await setConfig(root, 'docs.root', '문서');
  const doc = await scaffoldDoc(root, 'spec', { task: task.id });
  expect(await readFile(join(root, doc.path), 'utf8')).toBe('제목 원문 4 T01 docs/판단대기.md');
  expect((await scaffoldDoc(root, 'review', { topic: '구조' })).path).toMatch(/^문서\/검수\/\d{4}-\d{2}-\d{2}-구조-검수.md$/u);
  expect((await scaffoldDoc(root, 'backlog', { ifMissing: true })).path).toBe('docs/backlog.md');
});
it.each(['{{unknown}}', '{{taskId}}'])('미정의·빈 치환 %s는 부분 파일 생성 없음', async template => {
  const root = await project(); await mkdir(join(root,'.pi/templates/docs'), { recursive: true }); await writeFile(join(root,'.pi/templates/docs/PRD.md'), template);
  await expect(scaffoldDoc(root, 'prd')).rejects.toThrow(`템플릿 치환 값이 없습니다: ${template}`);
  await expect(readFile(join(root,'docs/PRD.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['../escape','hello world','a/b','', 'a'.repeat(41)])('잘못된 topic %s', async topic => { await expect(scaffoldDoc(await project(), 'research-q', { topic })).rejects.toThrow('topic'); });
it('동시 생성은 하나만 성공·initialize 기존 바이트 유지·CLI exit 1', async () => {
  const root = await project(); const outcomes = await Promise.all([scaffoldDoc(root,'prd'),scaffoldDoc(root,'prd')]); expect(outcomes.filter(v => v.created)).toHaveLength(1);
  await initialize(root); const before = await readFile(join(root,'docs/backlog.md')); await initialize(root); expect(await readFile(join(root,'docs/backlog.md'))).toEqual(before);
  expect((await cli(root,['docs','scaffold','prd'])).code).toBe(1); expect((await cli(root,['docs','scaffold','worklog'])).code).toBe(1);
  await expect(scaffoldDoc(root,'prd', { date: '2026-02-30' })).rejects.toThrow('YYYY-MM-DD');
});
it('프로젝트 밖 symlink 원본과 대상 거부', async () => {
  const root = await project(), outside = await project(); await symlink(outside,join(root,'docs'));
  await expect(scaffoldDoc(root,'prd')).rejects.toThrow('심볼릭 링크');
  await expect(readFile(join(outside,'PRD.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('끊어진 외부 symlink도 거부하고 밖에 생성하지 않는다', async () => {
  const root = await project(), outside = await project(); await symlink(join(outside,'absent'),join(root,'docs'));
  await expect(scaffoldDoc(root,'prd')).rejects.toThrow('심볼릭 링크');
  await expect(readFile(join(outside,'absent/PRD.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('L7 프로젝트 검수 --subject는 task 없이 path를 반환하며 기존 --topic도 유지',async()=>{
  const root=await project();const result=await cli(root,['docs','scaffold','review-request','--subject','프로젝트','--date','2026-09-24']);
  expect(result).toEqual({code:0,value:{path:'docs/검수/2026-09-24-프로젝트-검수요청.md',created:true}});
  expect((await cli(root,['docs','scaffold','review','--subject','프로젝트'])).code).toBe(0);
  expect((await cli(root,['docs','scaffold','prd','--subject','프로젝트'])).code).toBe(1);
});
