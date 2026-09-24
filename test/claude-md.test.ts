import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { generateClaudeMd } from '../src/core/claude-md.ts';
import { installSkills } from '../src/core/skills.ts';
import { setConfig } from '../src/core/config.ts';
const begin = '<!-- fodh:managed:begin v1 -->', end = '<!-- fodh:managed:end -->';
it('생성·idempotent·스킬/명령/승인/verify 반영·check 미쓰기', async () => {
  const root = await project(); await installSkills(root);
  await setConfig(root,'verify.commands','["node --version"]'); await setConfig(root,'verify.heavy','["npm test"]'); await setConfig(root,'requiresApproval','["custom-approval"]');
  expect(await generateClaudeMd(root,{check:true})).toEqual({upToDate:false}); await expect(readFile(join(root,'CLAUDE.md'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await generateClaudeMd(root)).toEqual({files:[{path:'CLAUDE.md',changed:true}]});
  const text=await readFile(join(root,'CLAUDE.md'),'utf8'); for(const v of ['fodh-workflow','fodh interview start','custom-approval','node --version','fodh verify run --heavy','DoD 6항','시스템 설정']) expect(text).toContain(v);
  expect(text).toMatch(/설정 해시: [a-f0-9]{8}/u); expect(await generateClaudeMd(root)).toEqual({files:[{path:'CLAUDE.md',changed:false}]});
  expect((await cli(root,['claude-md','generate','--check'])).code).toBe(0);
  await setConfig(root,'delegate.codex.workerModel','custom-worker'); expect((await cli(root,['claude-md','generate','--check'])).code).toBe(1); expect(await readFile(join(root,'CLAUDE.md'),'utf8')).toBe(text);
  await expect(readFile(join(root,'AGENTS.md'))).rejects.toMatchObject({code:'ENOENT'});
});
it('관리 블록 앞뒤 사용자 바이트 CRLF·공백 보존', async () => {
  const root=await project(), prefix='# 사용자\r\n\r\n  앞  \r\n', suffix='\r\n  뒤\r\n';
  await writeFile(join(root,'CLAUDE.md'),prefix+begin+'\nold\n'+end+suffix); await generateClaudeMd(root);
  const text=await readFile(join(root,'CLAUDE.md'),'utf8'); expect(text.slice(0,prefix.length)).toBe(prefix); expect(text.slice(-suffix.length)).toBe(suffix);
});
it('표지 없는 파일에 원문 그대로 추가', async () => {
  const root=await project(), original='# 사람이 쓴 규칙\r\n끝 공백  ';await writeFile(join(root,'CLAUDE.md'),original); await generateClaudeMd(root);
  expect((await readFile(join(root,'CLAUDE.md'),'utf8')).startsWith(original+'\n\n'+begin)).toBe(true);
});
it.each([begin, end, end+begin, begin+end+begin+end, '<!-- fodh:managed:begin v2 -->'+end])('표지 오류 시 쓰기 없음: %s', async original => {
  const root=await project();await writeFile(join(root,'CLAUDE.md'),original); await expect(generateClaudeMd(root)).rejects.toThrow('관리 블록 표지가 올바르지 않습니다'); expect(await readFile(join(root,'CLAUDE.md'),'utf8')).toBe(original);
});
it('AGENTS 선택 경로는 검증·금지·문서와 실행 금지만; 다중 대상 선검증', async () => {
  const root=await project();await setConfig(root,'claudeMd.targets','["CLAUDE.md","AGENTS.md"]');await writeFile(join(root,'AGENTS.md'),begin);
  await expect(generateClaudeMd(root)).rejects.toThrow('관리 블록');await expect(readFile(join(root,'CLAUDE.md'))).rejects.toMatchObject({code:'ENOENT'});
  await writeFile(join(root,'AGENTS.md'),'# 사용자 지침\n');await generateClaudeMd(root);
  const text=await readFile(join(root,'AGENTS.md'),'utf8');expect(text).not.toContain('하네스 흐름');expect(text).not.toContain('INTERVIEW');expect(text).toContain('`fodh` 를 실행하지 않는다, git 을 쓰지 않는다');
});

it('L5 verify 명령은 redaction, L6 무관한 timeout은 해시·파일 불변, M2/L11 역할 명시',async()=>{
  const root=await project(),prefix='sk-'+'ant-';
  await setConfig(root,'verify.commands',JSON.stringify(['echo '+prefix]));await setConfig(root,'verify.heavy',JSON.stringify(['echo '+prefix]));
  await generateClaudeMd(root);const before=await readFile(join(root,'CLAUDE.md'),'utf8');
  expect(before.includes(prefix)).toBe(false);expect(before).toContain('[비밀값 제거]');expect(before).not.toContain('fodh config set');
  expect(before).toContain('하네스 두뇌 세션 전용. 위임 수행자(Codex·Claude Agent)는 위임 프롬프트를 따르고 이 흐름표의 fodh 명령을 치지 않는다');
  expect(before).toMatch(/- doctor 표식: FODH-DOC-[a-f0-9]{8}/u);
  await setConfig(root,'brain.maxTurnMinutes','23');expect(await generateClaudeMd(root)).toEqual({files:[{path:'CLAUDE.md',changed:false}]});expect(await readFile(join(root,'CLAUDE.md'),'utf8')).toBe(before);
});
