import { randomUUID } from 'node:crypto';
import { setTask, type Task } from './backlog.ts';
import { loadConfig } from './config.ts';
import { addJudgment, classifyAnswer, readJudgment } from './judgment.ts';
import { appendLedger } from './ledger.ts';
import { updateState } from './state.ts';
import { taskMember, baseTip, isAncestor, taskGit, repoEvidence } from './workspace-task.ts';

const choices = ['지금 기준 브랜치 끝을 새 기준점으로 삼아 병합 재개', '보류(task 를 막힌 채로 둔다)'];
export async function checkMergeResume(root: string, task: Task): Promise<boolean> {
  const config = await loadConfig(root), member = await taskMember(root, config, task);
  const base = task.merge?.base;
  if (!base && !config.workspace) return true;
  let tip: string | undefined;
  try { tip = config.workspace ? await baseTip(member) : (await taskGit(member.path, ['rev-parse', 'HEAD'])).trim(); }
  catch { /* Missing refs and Git errors must block the resume. */ }
  if (base && tip && await isAncestor(member.path, base, tip)) return true;
  const judgment = task.merge?.baseJudgment;
  const answer = judgment ? (await readJudgment(root)).completed.find(item => item.id === judgment)?.answer : undefined;
  const approved = answer !== undefined && classifyAnswer(answer, choices).selection === 1;
  if (tip && (!base || approved)) {
    await setTask(root, task.id, { merge: { base: tip, baseJudgment: undefined } });
    await appendLedger(root, { runId: randomUUID(), taskId: task.id, action: 'merge-base:reset', status: 'warn',
      evidence: { ...repoEvidence(config, member), reason: base ? 'judged' : 'missing', ...(base ? { judgment } : {}) } });
    return true;
  }
  const branch = member.baseBranch ?? (await taskGit(member.path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const { item } = await addJudgment(root, {
    title: `병합 기준점 어긋남 ${task.id}${config.workspace ? `·${member.name}` : ''}: 새 기준점으로 병합 / 보류`,
    background: `${config.workspace ? member.name + ' ' : ''}${branch}가 검수 때 기준점(${base?.slice(0, 7) ?? '없음'}) 뒤로 되돌려졌습니다. 확인 없이 병합하지 않습니다.`,
    options: choices, recommend: '① 되돌림이 의도한 것이면 새 기준점으로 병합',
    blocks: task.id, resolution: 'resume', dedupeKey: `merge-base:${task.id}:${base}`,
  });
  await setTask(root, task.id, { status: `blocked(${item.id})`, judgment: item.id, merge: { baseJudgment: item.id },
    resume: task.resume ?? { status: task.status, state: 'MERGE', at: new Date().toISOString() } });
  await updateState(root, current => ({
    ...(current.resumeTask?.taskId === task.id ? { resumeTask: undefined } : {}),
    ...(current.taskId === task.id ? { resumeState: undefined } : {}),
  }));
  return false;
}
