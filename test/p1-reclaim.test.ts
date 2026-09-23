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
it('M4: cleanup report는 죽은 그룹만 제거하고 재사용 PID·brain을 보존한다',async()=>{
  const {root,record}=await setup();vi.mocked(groupAlive).mockReturnValue(false);
  await registerProc(root,{...record,pid:987655,pgid:987655,kind:'brain'});
  await registerProc(root,{...record,pid:987656,pgid:987656});
  vi.mocked(processStartedAt).mockImplementation(async pid=>pid===987656?'Thu Sep 24 00:05:00 2026':undefined);
  const report=await cleanupReport(root);
  expect(report.removed.map(proc=>proc.pid)).toEqual([record.pid]);expect(report.residual.map(proc=>proc.pid)).toEqual([987656]);
  expect(report.protected.map(proc=>proc.pid)).toEqual([987655]);expect(reclaimOwnedGroup).not.toHaveBeenCalled();
});
it.each(['1','2'])('M4: 연속 2회 실패는 paused(cleanup), 사용자 선택 %s 처리',async answer=>{
  const {root,task,item,record}=await setup();vi.mocked(reclaimOwnedGroup).mockResolvedValue(false);
  const {transitionState}=await import('../src/core/state.ts');
  const {readJudgment,answerJudgment,applyJudgments}=await import('../src/core/judgment.ts');
  expect((await reclaimTask(root,task.id,item.id)).next).toBe('CLEANUP_FAILED');
  await transitionState(root,'CLEANUP');
  expect((await reclaimTask(root,task.id,item.id)).next).toBe('paused(cleanup)');
  expect((await readState(root)).cleanupFailures).toBe(2);
  const decision=(await readJudgment(root)).items.find(item=>item.resolution==='cleanup')!;
  expect(decision.title).toBe(`정리 실패: 잔존 프로세스 ${record.pid}`);
  await answerJudgment(root,decision.id,answer);
  if(answer==='1')vi.mocked(groupAlive).mockReturnValue(false);
  expect((await applyJudgments(root,[decision.id])).applied).toHaveLength(1);
  expect((await readState(root)).state).toBe(answer==='1'?'PICK':'paused(cleanup)');
  expect((await readState(root)).cleanupFailures).toBe(answer==='1'?0:2);
  if(answer==='1') {
    expect((await readState(root)).pendingReclaim).toBeUndefined();
    expect((await getTask(root,task.id)).status).toBe(`blocked(${item.id})`);
  }
});
it('L4: add 이후 회수 실패 JSON은 생성된 판단 번호를 유지한다',async()=>{
  const {root,task}=await setup();vi.mocked(reclaimOwnedGroup).mockResolvedValue(false);
  const {main}=await import('../src/cli/index.ts');
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  try {
    await main(['judgment','add','--title','실패 판단','--background','','--options','유지|변경','--recommend','1','--blocks',task.id,'--reclaim'],root);
    const value=JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(value).toMatchObject({error:'프로세스 회수 실패',judgment:'A2',reclaimed:false,next:'CLEANUP_FAILED'});
    expect(process.exitCode).toBe(1);
  } finally {output.mockRestore();process.exitCode=0;}
});
it('M4: 정리했다고 답해도 살아 있는 잔존은 적용·PICK을 막고 답을 보존한다',async()=>{
  const {root,task,item}=await setup();vi.mocked(reclaimOwnedGroup).mockResolvedValue(false);
  const {transitionState}=await import('../src/core/state.ts');
  const {readJudgment,answerJudgment,applyJudgments}=await import('../src/core/judgment.ts');
  await reclaimTask(root,task.id,item.id);await transitionState(root,'CLEANUP');await reclaimTask(root,task.id,item.id);
  const decision=(await readJudgment(root)).items.find(item=>item.resolution==='cleanup')!;
  await answerJudgment(root,decision.id,'1');
  expect(await applyJudgments(root,[decision.id])).toEqual({applied:[],unapplied:[{id:decision.id,reason:'프로세스 레지스트리 잔존이 있습니다'}]});
  expect((await readState(root)).state).toBe('paused(cleanup)');
  expect((await readJudgment(root)).items.find(item=>item.id===decision.id)?.answer).toBe('1');
});
