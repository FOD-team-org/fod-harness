import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addTask, getTask } from '../src/core/backlog.ts';
import { addJudgment } from '../src/core/judgment.ts';
import { updateState } from '../src/core/state.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import { reclaimTask } from '../src/core/reclaim.ts';
it('실제 fake-claude task 소유 그룹 회수→레지스트리 0→blocked',async()=>{
  const root=await mkdtemp('/private/tmp/fodh-reclaim-live-');
  const child=spawn(process.execPath,[resolve('test/fake-claude/claude'),'--hang-grandchild'],{cwd:root,detached:true,stdio:'ignore'});
  const closed=once(child,'close');
  try{
    const task=await addTask(root,{title:'가짜 자식 회수',category:'docs'});
    const {item}=await addJudgment(root,{title:'범위',background:'',options:['유지'],recommend:'①',blocks:task.id});
    const startedAt=await processStartedAt(child.pid!);
    expect(startedAt,'/bin/ps lstart 조회 권한이 필요합니다').toBeTruthy();
    await registerProc(root,{pid:child.pid!,pgid:child.pid!,startedAt:startedAt!,runId:'reclaim-integration',kind:'worker',taskId:task.id});
    await updateState(root,{state:'IMPLEMENT',taskId:task.id});
    expect((await reclaimTask(root,task.id,item.id)).reclaimed).toBe(true);
    expect(await listProcs(root)).toEqual([]);expect((await getTask(root,task.id)).status).toBe(`blocked(${item.id})`);
  }finally{try{process.kill(-child.pid!,'SIGKILL');}catch{}await closed;await rm(root,{recursive:true,force:true});}
},15000);
