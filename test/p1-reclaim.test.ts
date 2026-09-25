import { acquireLock, ownerAt } from '../src/core/lock.ts';
import { harnessPath } from '../src/core/storage.ts';
import { reclaimCodexTree } from '../src/core/proc-tree.ts';
vi.mock('../src/core/proc-tree.ts', () => ({ reclaimCodexTree: vi.fn() }));
vi.mock('../src/core/lock.ts', async original => ({ ...await original<typeof import('../src/core/lock.ts')>(), isProcessAlive: (pid: number) => pid === process.pid || groupAlive(pid) }));
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { addJudgment } from '../src/core/judgment.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { updateState, readState } from '../src/core/state.ts';
import { processStartedAt } from '../src/core/process-time.ts';
import { groupAlive } from '../src/provider/runner.ts';
import { reclaimTask, cleanupReport } from '../src/core/reclaim.ts';
vi.mock('../src/core/process-time.ts',()=>({processStartedAt:vi.fn()}));
vi.mock('../src/provider/runner.ts',async original=>({...await original<typeof import('../src/provider/runner.ts')>(),groupAlive:vi.fn()}));
const roots:string[]=[], releases:(() => Promise<void>)[]=[];
afterEach(async()=>{for(const release of releases.splice(0))await release();vi.resetAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(protectBrain=false){const root=await mkdtemp('/private/tmp/fodh-reclaim-');roots.push(root);const task=await addTask(root,{title:'회수',category:'docs'});
  await setTask(root,task.id,{worktree:'wt-preserved',review:{commit:'review-sha',high:0}});
  const {item}=await addJudgment(root,{title:'범위',background:'',options:['유지'],recommend:'①',blocks:task.id});
  await updateState(root,{state:'IMPLEMENT',taskId:task.id});
  const record={pid:987654,pgid:987654,startedAt:'Thu Sep 24 00:00:00 2026',runId:'task-run',kind:'worker',taskId:task.id};
  await registerProc(root,record);vi.mocked(groupAlive).mockReturnValue(true);vi.mocked(processStartedAt).mockResolvedValue(record.startedAt);vi.mocked(reclaimCodexTree).mockResolvedValue(true);
  if(protectBrain){
    const path=harnessPath(root,'harness.lock');releases.push(await acquireLock(path));
    const owner=(await ownerAt(path))!;
    vi.mocked(processStartedAt).mockImplementation(async pid=>pid===process.pid?owner.startedAt:record.startedAt);
    await updateState(root,{brainTurn:{runId:record.runId,startedAt:new Date().toISOString()}});
  }
  return{root,task,item,record};}
it('소유 시각 검증→그룹 회수→레지스트리 0→blocked, 워크트리·검수 증거 보존',async()=>{
  const {root,task,item,record}=await setup();expect(await reclaimTask(root,task.id,item.id)).toEqual({judgment:item.id,reclaimed:true,next:'PICK'});
  expect(reclaimCodexTree).toHaveBeenCalledWith(record.pgid, [record.pid], []);expect(await listProcs(root)).toEqual([]);
  expect(await getTask(root,task.id)).toMatchObject({status:`blocked(${item.id})`,worktree:'wt-preserved',review:{commit:'review-sha',high:0}});
  expect((await readState(root)).state).toBe('PICK');
});
it('회수 mismatch(foreign)는 신호 없이 stale 제거 후 PICK',async()=>{
  const {root,task,item}=await setup();
  vi.mocked(processStartedAt).mockResolvedValue('Thu Sep 24 00:01:00 2026');
  expect(await reclaimTask(root,task.id,item.id)).toEqual({judgment:item.id,reclaimed:true,next:'PICK'});
  expect(reclaimCodexTree).not.toHaveBeenCalled();expect(await listProcs(root)).toEqual([]);
  expect(await getTask(root,task.id)).toMatchObject({status:`blocked(${item.id})`,worktree:'wt-preserved',review:{commit:'review-sha',high:0}});
  expect(await readState(root)).toMatchObject({state:'PICK',cleanupFailures:0});
  expect((await readState(root)).pendingReclaim).toBeUndefined();
});
it.each(['unknown','failure','exception'])('회수 %s는 레지스트리·task를 보존하고 CLEANUP_FAILED',async kind=>{
  const {root,task,item}=await setup();
  if(kind==='unknown')vi.mocked(processStartedAt).mockResolvedValue(undefined);
  if(kind==='failure')vi.mocked(reclaimCodexTree).mockResolvedValue(false);
  if(kind==='exception')vi.mocked(reclaimCodexTree).mockRejectedValue(new Error('signal denied'));
  expect(await reclaimTask(root,task.id,item.id)).toMatchObject({reclaimed:false,next:'CLEANUP_FAILED'});
  expect(await listProcs(root)).toHaveLength(1);expect((await getTask(root,task.id)).status).toBe('ready');
  if(kind==='unknown')expect(reclaimCodexTree).not.toHaveBeenCalled();
});
it('brain과 같은 그룹은 신호하지 않고 다른 task 프로세스는 보존한다',async()=>{
  const {root,task,item,record}=await setup(true);await registerProc(root,{...record,pid:987655,kind:'brain'});
  await registerProc(root,{...record,pid:987656,pgid:987656,taskId:'T99'});
  expect((await reclaimTask(root,task.id,item.id)).reclaimed).toBe(false);expect(reclaimCodexTree).not.toHaveBeenCalled();
  const report=await cleanupReport(root);
  expect(report).toMatchObject({ok:false,remaining:1});expect(report.stale).toEqual([]);
  expect(report.residual).toEqual([{...record,pid:987656,pgid:987656,taskId:'T99'}]);
  expect(report.protected).toEqual([record,{...record,pid:987655,kind:'brain'}]);
  expect(await listProcs(root)).toHaveLength(3);
});
it('죽은 소유 그룹은 신호 없이 등록 제거, brain은 보고에서 보호로 분리',async()=>{
  const {root,task,item,record}=await setup(true);vi.mocked(groupAlive).mockReturnValue(false);
  await registerProc(root,{...record,pid:987655,pgid:987655,kind:'brain'});
  await reclaimTask(root,task.id,item.id);expect(reclaimCodexTree).not.toHaveBeenCalled();
  expect(await cleanupReport(root)).toMatchObject({ok:true,remaining:0,protected:[{kind:'brain'}]});
});
it('다른 task 또는 없는 판단은 회수 전에 거부한다',async()=>{
  const {root,task,item}=await setup();await expect(reclaimTask(root,task.id,'A99')).rejects.toThrow('열린 판단');
  await updateState(root,{taskId:'T99'});await expect(reclaimTask(root,task.id,item.id)).rejects.toThrow('현재 task');
  expect(reclaimCodexTree).not.toHaveBeenCalled();
});
it('RECLAIM 실패 후 CLEANUP 재시도는 done으로 넘어가지 않고 원 판단으로 blocked한다',async()=>{
  const {root,task,item}=await setup();vi.mocked(reclaimCodexTree).mockResolvedValue(false);
  await reclaimTask(root,task.id,item.id);
  const {transitionState}=await import('../src/core/state.ts');await transitionState(root,'CLEANUP');
  await expect(transitionState(root,'PICK')).rejects.toThrow('RECLAIM');
  vi.mocked(reclaimCodexTree).mockResolvedValue(true);
  expect((await reclaimTask(root,task.id,item.id)).reclaimed).toBe(true);
  expect((await getTask(root,task.id)).status).toBe(`blocked(${item.id})`);
  expect((await readState(root)).pendingReclaim).toBeUndefined();
});
it('다른 task 잔존은 종료하지 않고 성공을 막는다',async()=>{
  const {root,task,item,record}=await setup();await registerProc(root,{...record,pid:987656,pgid:987656,taskId:'T99'});
  expect((await reclaimTask(root,task.id,item.id)).next).toBe('CLEANUP_FAILED');
  expect(reclaimCodexTree).toHaveBeenCalledTimes(1);expect(reclaimCodexTree).toHaveBeenCalledWith(record.pgid, [record.pid], []);
  expect((await listProcs(root))[0].taskId).toBe('T99');
});
it('M4·M1: cleanup report는 죽은 그룹과 재사용 PID를 stale로 제거, brain 보존',async()=>{
  const {root,record}=await setup(true);vi.mocked(groupAlive).mockImplementation(pgid=>pgid===987656);
  await registerProc(root,{...record,pid:987655,pgid:987655,kind:'brain'});
  await registerProc(root,{...record,pid:987656,pgid:987656});
  vi.mocked(processStartedAt).mockImplementation(async pid=>pid===987656?'Thu Sep 24 00:05:00 2026':undefined);
  const report=await cleanupReport(root);
  const stale=[record,{...record,pid:987656,pgid:987656}];
  expect(report).toMatchObject({ok:true,remaining:0});expect(report.removed).toEqual(stale);expect(report.stale).toEqual(stale);
  expect(report.residual).toEqual([]);expect(report.protected).toEqual([{...record,pid:987655,pgid:987655,kind:'brain'}]);
  expect(await listProcs(root)).toEqual(report.protected);expect(reclaimCodexTree).not.toHaveBeenCalled();
});
it.each(['1','2'])('M4: 연속 2회 실패는 paused(cleanup), 사용자 선택 %s 처리',async answer=>{
  const {root,task,item,record}=await setup();vi.mocked(reclaimCodexTree).mockResolvedValue(false);
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
it('L4: same-task dedupe 이후 회수 실패 JSON은 기존 판단 번호를 유지한다',async()=>{
  const {root,task,item}=await setup();vi.mocked(reclaimCodexTree).mockResolvedValue(false);
  const {main}=await import('../src/cli/index.ts');
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  try {
    await main(['judgment','add','--title','실패 판단','--background','','--options','유지|변경','--recommend','1','--blocks',task.id,'--reclaim'],root);
    const value=JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(value).toMatchObject({error:'프로세스 회수 실패',judgment:item.id,reclaimed:false,next:'CLEANUP_FAILED'});
    expect(process.exitCode).toBe(1);
  } finally {output.mockRestore();process.exitCode=0;}
});
it('M4: 정리했다고 답해도 살아 있는 잔존은 적용·PICK을 막고 답을 보존한다',async()=>{
  const {root,task,item}=await setup();vi.mocked(reclaimCodexTree).mockResolvedValue(false);
  const {transitionState}=await import('../src/core/state.ts');
  const {readJudgment,answerJudgment,applyJudgments}=await import('../src/core/judgment.ts');
  await reclaimTask(root,task.id,item.id);await transitionState(root,'CLEANUP');await reclaimTask(root,task.id,item.id);
  const decision=(await readJudgment(root)).items.find(item=>item.resolution==='cleanup')!;
  await answerJudgment(root,decision.id,'1');
  expect(await applyJudgments(root,[decision.id])).toEqual({applied:[],unapplied:[{id:decision.id,reason:'프로세스 레지스트리 잔존이 있습니다'}]});
  expect((await readState(root)).state).toBe('paused(cleanup)');
  expect((await readJudgment(root)).items.find(item=>item.id===decision.id)?.answer).toBe('1');
});

it('F30-4 잠금 소유자가 없으면 일치하는 brain도 보고에서 보호하지 않고 stale로 제거한다',async()=>{
  const {root,record}=await setup();
  const brain={...record,kind:'brain'};
  await registerProc(root,brain);
  await updateState(root,{brainTurn:{runId:brain.runId,startedAt:new Date().toISOString()}});
  expect(await ownerAt(harnessPath(root,'harness.lock'))).toBeUndefined();
  vi.mocked(groupAlive).mockReturnValue(false);
  const report=await cleanupReport(root);
  expect(report).toMatchObject({ok:true,remaining:0,protected:[],residual:[],stale:[brain],removed:[brain]});
  expect(await listProcs(root)).toEqual([]);expect(reclaimCodexTree).not.toHaveBeenCalled();
});

it('P8-c L4: 새 task의 판단 생성 뒤 회수 실패도 새 판단 번호와 재시도 상태를 보존한다', async () => {
  const { root, item, record } = await setup();
  const task = await addTask(root, { title: '새 작업', category: 'docs' });
  await setTask(root, task.id, { status: 'doing' });
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id });
  await registerProc(root, { ...record, taskId: task.id });
  vi.mocked(reclaimCodexTree).mockResolvedValue(false);
  const { main } = await import('../src/cli/index.ts');
  const { readJudgment } = await import('../src/core/judgment.ts');
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await main(['judgment', 'add', '--title', '검증 실패 판단', '--background', '', '--options', '유지|변경', '--recommend', '1', '--blocks', task.id, '--reclaim'], root);
    const value = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    const items = (await readJudgment(root)).items;
    expect(items).toHaveLength(2);
    const created = items.find(judgment => judgment.id !== item.id)!;
    expect(created).toMatchObject({ title: '검증 실패 판단', blocks: task.id });
    expect(value).toMatchObject({ error: '프로세스 회수 실패', judgment: created.id, reclaimed: false, next: 'CLEANUP_FAILED' });
    expect(value.deduped).toBeUndefined(); expect(process.exitCode).toBe(1);
    expect(await readState(root)).toMatchObject({ state: 'CLEANUP_FAILED', pendingReclaim: { taskId: task.id, judgmentId: created.id } });
    expect((await getTask(root, task.id)).status).toBe('doing');
    expect(await listProcs(root)).toEqual([{ ...record, taskId: task.id }]);
  } finally { output.mockRestore(); process.exitCode = 0; }
});
