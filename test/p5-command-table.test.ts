import { expect, it, vi } from 'vitest';
// Exercise real main dispatch while isolating commands that can start external work.
vi.mock('../src/cli/doctor.ts',()=>({doctor:vi.fn(async()=>({ok:true}))}));
vi.mock('../src/core/cleanup.ts',()=>({runCleanup:vi.fn(async()=>({ok:true}))}));
vi.mock('../src/core/verify.ts',()=>({runVerify:vi.fn(async()=>({ok:true}))}));
vi.mock('../src/core/worktree.ts',async original=>({...await original<object>(),listWorktrees:vi.fn(async()=>({worktrees:[]}))}));
vi.mock('../src/core/slots.ts',()=>({slotsStatus:vi.fn(async()=>({}))}));
vi.mock('../src/core/watcher.ts',async original=>({...await original<object>(),tick:vi.fn(async()=>({})),memoryStatus:vi.fn(async()=>({}))}));
import { commandTable } from '../src/cli/index.ts';
import { project,cli } from './p5-helpers.ts';
import { writeMeta } from '../src/core/codex-record.ts';
it.each(commandTable.map(c=>[c.group,c.action] as const))('빠진 테스트7: 명령 표 분기 %s %s',async(group,action)=>{
  const root=await project('IDLE');const result=await cli(root,[group,...action?[action]:[]]);
  expect(result.value.error??'').not.toContain('명령 표와 분기가 어긋났습니다');
  expect(result.value.error??'').not.toContain('지원하지 않는 fodh 명령입니다');
});
it('L4 codex status meta.error는 정상 조회 exit 0, docs 생성 오류만 exit 1',async()=>{
  const root=await project();await writeMeta(root,{runId:'failed-meta',kind:'task',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),cwd:root,sandbox:'workspace-write',model:'fake',effort:'xhigh',workerModel:'fake',workerEffort:'xhigh',command:['fake'],timeoutMinutes:1,state:'IMPLEMENT',status:'fail',error:'fixture failure'});
  const result=await cli(root,['codex','status','failed-meta']);expect(result).toMatchObject({code:0,value:{error:'fixture failure',status:'fail'}});
  expect((await cli(root,['docs','scaffold','prd'])).code).toBe(0);expect((await cli(root,['docs','scaffold','prd'])).code).toBe(1);
});
