import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { addJudgment } from '../src/core/judgment.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { updateState, readState } from '../src/core/state.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import { reclaimOwnedGroup, groupAlive } from '../src/provider/runner.ts';
import { reclaimTask, cleanupReport } from '../src/core/reclaim.ts';
vi.mock('../src/core/process-time.ts',()=>({processStartedAt:vi.fn()}));
vi.mock('../src/provider/runner.ts',async original=>({...await original<typeof import('../src/provider/runner.ts')>(),reclaimOwnedGroup:vi.fn(),groupAlive:vi.fn()}));
const roots:string[]=[];
afterEach(async()=>{vi.resetAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp('/private/tmp/fodh-reclaim-');roots.push(root);const task=await addTask(root,{title:'회수',category:'docs'});
  await setTask(root,task.id,{worktree:'wt-preserved',review:{commit:'review-sha',high:0}});
  const {item}=await addJudgment(root,{title:'범위',background:'',options:['유지'],recommend:'①',blocks:task.id});
  await updateState(root,{state:'IMPLEMENT',taskId:task.id});
  const record={pid:987654,pgid:987654,startedAt:'Thu Sep 24 00:00:00 2026',runId:'task-run',kind:'worker',taskId:task.id};
  await registerProc(root,record);vi.mocked(groupAlive).mockReturnValue(true);vi.mocked(processStartedAt).mockResolvedValue(record.startedAt);vi.mocked(reclaimOwnedGroup).mockResolvedValue(true);
  return{root,task,item,record};}
it('소유 시각 검증→그룹 회수→레지스트리 0→blocked, 워크트리·검수 증거 보존',async()=>{
  const {root,task,item,record}=await setup();expect(await reclaimTask(root,task.id,item.id)).toEqual({judgment:item.id,reclaimed:true,next:'PICK'});
  expect(reclaimOwnedGroup).toHaveBeenCalledWith(record.pgid);expect(await listProcs(root)).toEqual([]);
  expect(await getTask(root,task.id)).toMatchObject({status:`blocked(${item.id})`,worktree:'wt-preserved',review:{commit:'review-sha',high:0}});
  expect((await readState(root)).state).toBe('PICK');
});
it.each(['mismatch','unknown','failure','exception'])('회수 %s는 레지스트리·task를 보존하고 CLEANUP_FAILED',async kind=>{
  const {root,task,item}=await setup();
  if(kind==='mismatch')vi.mocked(processStartedAt).mockResolvedValue('Thu Sep 24 00:01:00 2026');
  if(kind==='unknown')vi.mocked(processStartedAt).mockResolvedValue(undefined);
  if(kind==='failure')vi.mocked(reclaimOwnedGroup).mockResolvedValue(false);
  if(kind==='exception')vi.mocked(reclaimOwnedGroup).mockRejectedValue(new Error('signal denied'));
  expect(await reclaimTask(root,task.id,item.id)).toMatchObject({reclaimed:false,next:'CLEANUP_FAILED'});
  expect(await listProcs(root)).toHaveLength(1);expect((await getTask(root,task.id)).status).toBe('ready');
  if(kind==='mismatch'||kind==='unknown')expect(reclaimOwnedGroup).not.toHaveBeenCalled();
});
it('brain과 같은 그룹은 신호하지 않고 다른 task 프로세스는 보존한다',async()=>{
  const {root,task,item,record}=await setup();await registerProc(root,{...record,pid:987655,kind:'brain'});
  await registerProc(root,{...record,pid:987656,pgid:987656,taskId:'T99'});
  expect((await reclaimTask(root,task.id,item.id)).reclaimed).toBe(false);expect(reclaimOwnedGroup).not.toHaveBeenCalled();
  expect(await cleanupReport(root)).toMatchObject({ok:false,remaining:2});expect(await listProcs(root)).toHaveLength(3);
});
it('죽은 소유 그룹은 신호 없이 등록 제거, brain은 보고에서 보호로 분리',async()=>{
  const {root,task,item,record}=await setup();vi.mocked(groupAlive).mockReturnValue(false);
  await registerProc(root,{...record,pid:987655,pgid:987655,kind:'brain'});
  await reclaimTask(root,task.id,item.id);expect(reclaimOwnedGroup).not.toHaveBeenCalled();
  expect(await cleanupReport(root)).toMatchObject({ok:true,remaining:0,protected:[{kind:'brain'}]});
});
it('다른 task 또는 없는 판단은 회수 전에 거부한다',async()=>{
  const {root,task,item}=await setup();await expect(reclaimTask(root,task.id,'A99')).rejects.toThrow('열린 판단');
  await updateState(root,{taskId:'T99'});await expect(reclaimTask(root,task.id,item.id)).rejects.toThrow('현재 task');
  expect(reclaimOwnedGroup).not.toHaveBeenCalled();
});
it('RECLAIM 실패 후 CLEANUP 재시도는 done으로 넘어가지 않고 원 판단으로 blocked한다',async()=>{
  const {root,task,item}=await setup();vi.mocked(reclaimOwnedGroup).mockResolvedValue(false);
  await reclaimTask(root,task.id,item.id);
  const {transitionState}=await import('../src/core/state.ts');await transitionState(root,'CLEANUP');
  await expect(transitionState(root,'PICK')).rejects.toThrow('RECLAIM');
  vi.mocked(reclaimOwnedGroup).mockResolvedValue(true);
  expect((await reclaimTask(root,task.id,item.id)).reclaimed).toBe(true);
  expect((await getTask(root,task.id)).status).toBe(`blocked(${item.id})`);
  expect((await readState(root)).pendingReclaim).toBeUndefined();
});
it('다른 task 잔존은 종료하지 않고 성공을 막는다',async()=>{
  const {root,task,item,record}=await setup();await registerProc(root,{...record,pid:987656,pgid:987656,taskId:'T99'});
  expect((await reclaimTask(root,task.id,item.id)).next).toBe('CLEANUP_FAILED');
  expect(reclaimOwnedGroup).toHaveBeenCalledTimes(1);expect(reclaimOwnedGroup).toHaveBeenCalledWith(record.pgid);
  expect((await listProcs(root))[0].taskId).toBe('T99');
});
