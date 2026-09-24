import { generateClaudeMd, claudeMdMarker } from '../src/core/claude-md.ts';
import { loadConfig } from '../src/core/config.ts';
import { expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile, symlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { installSkills, skillsStatus } from '../src/core/skills.ts';
import { bundledSkills, setConfig } from '../src/core/config.ts';
import { doctor } from '../src/cli/doctor.ts';
import { childEnv } from '../src/provider/runner.ts';
import { readLedger } from '../src/core/ledger.ts';
it('4개 스킬 frontmatter·이름·설명·본문 표준과 pi.skills', async () => {
  expect(await readdir('skills')).toEqual(expect.arrayContaining(bundledSkills));
  for(const name of bundledSkills){
    const text=await readFile(`skills/${name}/SKILL.md`,'utf8'), match=/^---\nname: (.+)\ndescription: (.+)\n---\n([\s\S]*)$/u.exec(text);
    expect(match).toBeTruthy();expect(match![1]).toBe(name);expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);expect(name.length).toBeLessThanOrEqual(64);
    expect(match![2].length).toBeLessThanOrEqual(1024);expect(match![2]).toContain('때');expect(match![3].trim().split('\n').length).toBeLessThanOrEqual(150);
    expect(await readdir(`skills/${name}`)).toEqual(['SKILL.md']);
  }
  expect(JSON.parse(await readFile('package.json','utf8')).pi.skills).toEqual(['./skills']);
});
it('읽기 전용 status·install·unchanged·해시 변경 update·실제 파일 훼손 복구', async () => {
  const root=await project();expect((await skillsStatus(root)).installed).toEqual(bundledSkills); await expect(readdir(join(root,'.claude'))).rejects.toMatchObject({code:'ENOENT'});
  expect((await installSkills(root)).installed).toEqual(bundledSkills);expect((await installSkills(root)).unchanged).toEqual(bundledSkills);
  const base=join(root,'.claude/skills',bundledSkills[0]);const marker=JSON.parse(await readFile(join(base,'.fodh-managed'),'utf8'));expect(marker).toMatchObject({package:'fod-harness',version:'0.1.5',hash:expect.any(String)});
  await writeFile(join(base,'.fodh-managed'),JSON.stringify({...marker,hash:'stale'}));expect((await skillsStatus(root)).updated).toEqual([bundledSkills[0]]);expect((await installSkills(root)).updated).toEqual([bundledSkills[0]]);
  await writeFile(join(base,'SKILL.md'),'corrupt');expect((await installSkills(root)).updated).toEqual([bundledSkills[0]]);expect(await readFile(join(base,'SKILL.md'),'utf8')).toBe(await readFile(`skills/${bundledSkills[0]}/SKILL.md`,'utf8'));
});
it('표지 없는 동명 디렉터리는 원문 보존·conflict; CLI 상태', async () => {
  const root=await project(), path=join(root,'.claude/skills/fodh-workflow');await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),'사용자 스킬');
  expect((await installSkills(root)).conflicts).toEqual(['fodh-workflow']);expect(await readFile(join(path,'SKILL.md'),'utf8')).toBe('사용자 스킬');expect((await cli(root,['skills','status'])).value.conflicts).toEqual(['fodh-workflow']);
});
it('skills.install 없는 스킬 거부·선택 설치', async () => {
  const root=await project();await expect(setConfig(root,'skills.install','["missing"]')).rejects.toThrow('skills.install 에 없는 스킬: missing');await setConfig(root,'skills.install','["fodh-workflow"]');expect((await installSkills(root)).installed).toEqual(['fodh-workflow']);
});
it.each([false,true])('가짜 claude doctor init.skills/memory_paths 로드=%s는 실패 아닌 경고', async loaded => {
  const root=await project();await setConfig(root,'brain.command',JSON.stringify(resolve('test/fake-claude/claude'))); await setConfig(root,'brain.switchCommand',JSON.stringify([resolve('test/fake-claude/switch')]));
  await mkdir(join(root,'.claude'),{recursive:true});await writeFile(join(root,'.claude/settings.json'),await readFile('templates/claude-settings.json'));
  if (loaded) await generateClaudeMd(root);
  const result=await doctor(root,{env:{...childEnv(),HOME:root,FAKE_CLAUDE_SCENARIO:loaded?'p5-skills-loaded':'p5-skills-missing'}});
  expect(result.ok).toBe(true);expect(result.skillsMissing).toEqual(loaded?[]:bundledSkills);expect(result.claudeMdLoaded).toBe(loaded);expect(result.claudeMdStale).toBe(false);expect(result.claudeMdMarker).toBe(claudeMdMarker(await loadConfig(root)));
  expect(result.skills).toEqual(loaded?bundledSkills:[]);expect(result.memory_paths).toEqual(loaded?[join(root,'auto-memory')]:[]);
  const entries=await readLedger(root);expect(entries.some(e=>e.action==='notify:doctor:skills-memory')).toBe(!loaded);
  if (!loaded) expect(entries.find(e=>e.action==='notify:doctor:skills-memory')?.evidence).toMatchObject({body:expect.stringContaining('CLAUDE.md 로드: false')});
  expect(entries.find(e=>e.action.startsWith('system.init:'))?.evidence).toMatchObject({skills:result.skills,memory_paths:loaded?{auto:join(root,'auto-memory')}:[]});
});
it('해시가 같으면 표지 version 차이만으로 덮어쓰지 않는다', async () => {
  const root=await project();await installSkills(root);const path=join(root,'.claude/skills/fodh-workflow/.fodh-managed');
  const marker=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...marker,version:'older'}));const before=await readFile(path);
  expect((await installSkills(root)).unchanged).toContain('fodh-workflow');expect(await readFile(path)).toEqual(before);
});

it('F1 오래된 표식 응답은 stale, 자동 메모리 객체는 원장 원형·결과 배열',async()=>{
  const root=await project();await setConfig(root,'brain.command',JSON.stringify(resolve('test/fake-claude/claude')));await setConfig(root,'brain.switchCommand',JSON.stringify([resolve('test/fake-claude/switch')]));
  await mkdir(join(root,'.claude'),{recursive:true});await writeFile(join(root,'.claude/settings.json'),await readFile('templates/claude-settings.json'));
  await writeFile(join(root,'CLAUDE.md'),'- doctor 표식: FODH-DOC-deadbeef\n');
  const result=await doctor(root,{env:{...childEnv(),HOME:root,FAKE_CLAUDE_SCENARIO:'p5-skills-stale'}});
  expect(result).toMatchObject({ok:true,claudeMdLoaded:true,claudeMdStale:true,claudeMdMarker:claudeMdMarker(await loadConfig(root))});
  expect(result.memory_paths).toEqual([join(root,'auto-memory')]);
  expect((await readLedger(root)).find(e=>e.action==='notify:doctor:skills-memory')?.evidence).toMatchObject({body:expect.stringContaining('CLAUDE.md 로드: true, 낡음(재생성 필요)')});
  expect((await readLedger(root)).find(e=>e.action.startsWith('system.init:'))?.evidence).toMatchObject({memory_paths:{auto:join(root,'auto-memory')}});
  const calls=(await readFile(join(root,'.pi/fake-calls.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  expect(calls[0]).toMatchObject({brain:'1',protectedExtra:'.pi/interview-bank.md:.pi/templates/docs'});
  expect(calls[0].prompt).toContain('문서 확인 <값>');expect(calls[0].prompt).not.toContain(result.claudeMdMarker);
});
it.each(['file','symlink','outside-symlink'])('빠진 테스트9: 스킬 대상 %s는 conflict이며 기존 대상 보존',async kind=>{
  const root=await project(),base=join(root,'.claude/skills');await mkdir(base,{recursive:true});const target=join(base,'fodh-workflow');
  const other=kind==='outside-symlink'?await project():join(root,'user-skill');await mkdir(other,{recursive:true});await writeFile(join(other,'SKILL.md'),'사용자');
  if(kind==='file')await writeFile(target,'사용자 파일');else await symlink(other,target);
  expect((await skillsStatus(root)).conflicts).toContain('fodh-workflow');expect((await installSkills(root)).conflicts).toContain('fodh-workflow');
  expect(await readFile(join(other,'SKILL.md'),'utf8')).toBe('사용자');if(kind==='file')expect(await readFile(target,'utf8')).toBe('사용자 파일');else expect((await lstat(target)).isSymbolicLink()).toBe(true);
});
