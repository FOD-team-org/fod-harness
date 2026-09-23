import { getConfig, setConfig, loadConfig } from '../core/config.ts';
import { addTask, getTask, readBacklog, syncBacklog, setTask, BacklogError, type Task } from '../core/backlog.ts';
import { runPick } from '../core/pick.ts';
import { cleanupReport, reclaimTask } from '../core/reclaim.ts';
import { parseArgs } from 'node:util';
import { readState, updateState, transitionState, doctorFresh, TransitionError } from '../core/state.ts';
import { readJudgment, addJudgment, answerJudgment, writeJudgmentStatus, applyJudgments } from '../core/judgment.ts';
import { listInbox, ackInbox } from '../core/inbox.ts';
import { listProcs } from '../core/procs.ts';
import { readLedger, unknownEntries, resolveLedger } from '../core/ledger.ts';
import { safeValue } from '../provider/privacy.ts';
import { doctor } from './doctor.ts';
import { redact } from '../provider/privacy.ts';
export async function main(args = process.argv.slice(2), root = process.cwd()): Promise<void> {
  let createdJudgment: string | undefined;
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      unknown: { type: 'boolean' }, json: { type: 'boolean' }, system: { type: 'boolean' }, reclaim: { type: 'boolean' },
      commit: { type: 'string' }, status: { type: 'string' }, depends: { type: 'string' }, category: { type: 'string' },
      judgment: { type: 'string' }, worktree: { type: 'string' },
      'review-commit': { type: 'string' }, 'review-high': { type: 'string' }, 'verify-ok': { type: 'boolean' },
      'merge-commit': { type: 'string' }, 'docs-ok': { type: 'boolean' }, 'cleanup-ok': { type: 'boolean' },
      'spec-rev': { type: 'string' }, 'requires-approval': { type: 'boolean' }, evidence: { type: 'string' },
      task: { type: 'string' }, answered: { type: 'boolean' }, title: { type: 'string' }, background: { type: 'string' },
      options: { type: 'string' }, recommend: { type: 'string' }, blocks: { type: 'string' },
    } });
    const [group, action, ...rest] = positionals;
    const exact = (count: number) => { if (rest.length !== count) throw new Error('명령 인자 수를 확인하세요.'); };
    const integer = (value: string, name: string): number => {
      if (!/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name}는 0 이상의 정수여야 합니다`);
      return Number(value);
    };
    let result: unknown;
    if (group === 'doctor' && !action) result = await doctor(root);
    else if (group === 'config' && action === 'get') {
      if (rest.length > 1) throw new Error('명령 인자 수를 확인하세요.');
      result = await getConfig(root, rest[0]);
    } else if (group === 'config' && action === 'set') {
      exact(2); result = await setConfig(root, rest[0], rest[1]);
    }
    else if (group === 'state' && action === 'get') { exact(0); result = await readState(root); }
    else if (group === 'state' && action === 'await-user') { exact(0); result = await updateState(root, { awaitingUser: true, autoTurns: 0 }); }
    else if (group === 'state' && action === 'transition') {
      exact(1);
      if (['IMPLEMENT', 'MERGE'].includes(rest[0]) && !doctorFresh(await readState(root), (await loadConfig(root)).brain.doctorTtlHours)) {
        throw new Error('doctor 검증이 없거나 오래되었습니다. Pi 세션을 재시작하거나 fodh doctor 를 실행하세요.');
      }
      result = await transitionState(root, rest[0], { taskId: values.task, commit: values.commit, system: values.system });
    } else if (group === 'backlog' && action === 'list') { exact(0); result = await readBacklog(root); }
    else if (group === 'backlog' && action === 'sync') { exact(0); result = await syncBacklog(root); }
    else if (group === 'backlog' && action === 'get') { exact(1); result = await getTask(root, rest[0]); }
    else if (group === 'backlog' && action === 'add') {
      exact(0);
      if (!values.title || !values.category) throw new Error('--title 및 --category가 필요합니다');
      result = await addTask(root, { title: values.title, category: values.category,
        depends: values.depends?.split(',').map(value => value.trim()).filter(Boolean) });
    } else if (group === 'backlog' && action === 'set') {
      exact(1); const patch: Partial<Task> = {};
      if (values.status !== undefined) {
        const state = await readState(root);
        if (values.status !== 'done' || state.state !== 'CLEANUP' || state.taskId !== rest[0]) {
          throw new Error('상태는 전이로만 바뀝니다');
        }
      }
      for (const key of ['title', 'category', 'status', 'judgment', 'worktree'] as const) {
        if (values[key] !== undefined) patch[key] = values[key];
      }
      if (values.depends !== undefined) patch.depends = values.depends.split(',').map(value => value.trim()).filter(Boolean);

      if (values['review-commit'] !== undefined || values['review-high'] !== undefined) patch.review = {
        ...(values['review-commit'] !== undefined ? { commit: values['review-commit'] } : {}),
        ...(values['review-high'] !== undefined ? { high: integer(values['review-high'], 'review.high') } : {}),
      };
      if (values['verify-ok']) patch.verify = { ok: true };
      if (values['merge-commit'] !== undefined) patch.merge = { commit: values['merge-commit'] };
      if (values['docs-ok']) patch.docs = { ok: true };
      if (values['cleanup-ok']) {
        if (!(await cleanupReport(root)).ok) throw new Error('프로세스 레지스트리 잔존이 있습니다');
        patch.cleanup = { ok: true };
      }
      if (values['spec-rev'] !== undefined) patch.spec = { rev: integer(values['spec-rev'], 'spec.rev') };
      result = await setTask(root, rest[0], patch);
    } else if (group === 'pick' && !action) result = await runPick(root);
    else if (group === 'reclaim' && !action) {
      if (!values.task || !values.judgment) throw new Error('--task 및 --judgment가 필요합니다');
      result = await reclaimTask(root, values.task, values.judgment);
    } else if (group === 'cleanup' && action === 'report') { exact(0); result = await cleanupReport(root); }
    else if (group === 'judgment' && action === 'apply') result = await applyJudgments(root, rest);
    else if (group === 'judgment' && action === 'read') { exact(0); result = await readJudgment(root, { answered: values.answered }); }
    else if (group === 'judgment' && action === 'add') {
      exact(0);
      for (const key of ['title', 'background', 'options', 'recommend', 'blocks'] as const) {
        if (values[key] === undefined) throw new Error(`--${key} 인자가 필요합니다.`);
      }
      let choices: string[];
      try { choices = JSON.parse(values.options!); if (!Array.isArray(choices)) throw new Error(); }
      catch { choices = values.options!.split('|').map(value => value.trim()); }
      if (values.reclaim && !/^T\d+$/u.test(values.blocks!)) throw new Error('--reclaim은 단일 task가 필요합니다');
      if (/^T\d+$/u.test(values.blocks!)) {
        const task = await getTask(root, values.blocks!);
        if (task.status === 'done') throw new Error('완료 task는 새 작업으로 등록해야 합니다');
        if (values.reclaim && (await readState(root)).taskId !== task.id) throw new Error('현재 task만 회수할 수 있습니다');
      }
      const added = await addJudgment(root, {
        title: values.title!, background: values.background!, options: choices,
        recommend: values.recommend!, blocks: values.blocks!, requiresApproval: values['requires-approval'],
        dedupeKey: JSON.stringify([values.title, values.blocks]),
      });
      createdJudgment = added.item.id;
      if (values.reclaim) {
        result = await reclaimTask(root, values.blocks!, added.item.id);
        if (!(result as { reclaimed: boolean }).reclaimed) process.exitCode = 1;
      } else {
        if (/^T\d+$/u.test(values.blocks!)) await setTask(root, values.blocks!, { status: `blocked(${added.item.id})`, judgment: added.item.id });
        result = added;
      }
    } else if (group === 'judgment' && action === 'answer') { exact(2); result = await answerJudgment(root, rest[0], rest[1]); }
    else if (group === 'judgment' && action === 'write-status') { exact(1); result = await writeJudgmentStatus(root, rest[0]); }
    else if (group === 'inbox' && action === 'list') { exact(0); result = await listInbox(root); }
    else if (group === 'inbox' && action === 'ack' && rest.length) result = await ackInbox(root, rest);
    else if (group === 'ledger' && action === 'list') {
      exact(0); result = await (values.unknown ? unknownEntries(root) : readLedger(root));
    } else if (group === 'ledger' && action === 'resolve') {
      exact(3); result = await resolveLedger(root, rest[0], rest[1], rest[2], redact(values.evidence ?? ''));
    }
    else if (group === 'proc' && action === 'list') { exact(0); result = await listProcs(root); }
    else throw new Error('지원하지 않는 fodh 명령입니다.');
    process.stdout.write(JSON.stringify(safeValue(result === undefined ? { ok: true } : result)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: redact(error instanceof Error ? error.message : '하네스 명령 실행 실패'),
      ...(createdJudgment ? { judgment: createdJudgment } : {}),
      ...(error instanceof TransitionError && error.action ? { action: error.action } : {}),
      ...(error instanceof BacklogError && error.missing ? { missing: error.missing } : {}),
    }) + '\n');
    process.exitCode = 1;
  }
}
