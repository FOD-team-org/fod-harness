import { expect,it } from 'vitest';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { project } from './p5-helpers.ts';
import { setConfig } from '../src/core/config.ts';
import { runTurn } from '../src/provider/turn.ts';
import { childEnv } from '../src/provider/runner.ts';
it('M2 일반 두뇌 턴도 보호 표지와 설정 경로를 강제 전달한다',async()=>{
  const root=await project();await setConfig(root,'brain.command',JSON.stringify(resolve('test/fake-claude/claude')));await setConfig(root,'brain.model','haiku');await setConfig(root,'docs.root','notes');
  await setConfig(root,'interview.extraBankFile','custom/questions.md');await setConfig(root,'docs.overrideDir','custom/templates');
  await mkdir(join(root,'.claude'));await writeFile(join(root,'.claude/settings.json'),await readFile('templates/claude-settings.json'));
  const result=await runTurn('일반 fake 턴',{root,env:{...childEnv(),HOME:root,FAKE_CLAUDE_SCENARIO:'first',FODH_BRAIN:'0',FODH_PROTECTED_EXTRA:'ignored'}});
  expect(result.reason).toBe('stop');const call=JSON.parse((await readFile(join(root,'.pi/fake-calls.jsonl'),'utf8')).trim().split('\n')[0]);
  expect(call).toMatchObject({brain:'1',docsRoot:'notes',protectedExtra:'custom/questions.md:custom/templates'});
});
