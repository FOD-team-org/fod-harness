import { parseArgs } from 'node:util';
import { readState, transitionState } from '../core/state.ts';
import { readJudgment, addJudgment, answerJudgment, writeJudgmentStatus } from '../core/judgment.ts';
import { listInbox, ackInbox } from '../core/inbox.ts';
import { listProcs } from '../core/procs.ts';
import { doctor } from './doctor.ts';
import { redact } from '../../extensions/provider/privacy.ts';
export async function main(args = process.argv.slice(2), root = process.cwd()): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      task: { type: 'string' }, answered: { type: 'boolean' }, title: { type: 'string' }, background: { type: 'string' },
      options: { type: 'string' }, recommend: { type: 'string' }, blocks: { type: 'string' },
    } });
    const [group, action, ...rest] = positionals;
    const exact = (count: number) => { if (rest.length !== count) throw new Error('명령 인자 수를 확인하세요.'); };
    let result: unknown;
    if (group === 'doctor' && !action) result = await doctor(root);
    else if (group === 'state' && action === 'get') { exact(0); result = await readState(root); }
    else if (group === 'state' && action === 'transition') {
      exact(1);
      if (['IMPLEMENT', 'MERGE'].includes(rest[0])) await doctor(root);
      result = await transitionState(root, rest[0], values.task);
    } else if (group === 'judgment' && action === 'read') { exact(0); result = await readJudgment(root, { answered: values.answered }); }
    else if (group === 'judgment' && action === 'add') {
      exact(0);
      for (const key of ['title','background','options','recommend','blocks'] as const) if (values[key] === undefined) throw new Error(`--${key} 인자가 필요합니다.`);
      let choices: string[];
      try { choices = JSON.parse(values.options!); if (!Array.isArray(choices)) throw new Error(); }
      catch { choices = values.options!.split('|').map(value => value.trim()); }
      result = await addJudgment(root, { title: values.title!, background: values.background!, options: choices, recommend: values.recommend!, blocks: values.blocks! });
    } else if (group === 'judgment' && action === 'answer') { exact(2); result = await answerJudgment(root, rest[0], rest[1]); }
    else if (group === 'judgment' && action === 'write-status') { exact(1); result = await writeJudgmentStatus(root, rest[0]); }
    else if (group === 'inbox' && action === 'list') { exact(0); result = await listInbox(root); }
    else if (group === 'inbox' && action === 'ack' && rest.length) result = await ackInbox(root, rest);
    else if (group === 'proc' && action === 'list') { exact(0); result = await listProcs(root); }
    else throw new Error('지원하지 않는 fodh 명령입니다.');
    process.stdout.write(redact(JSON.stringify(result ?? { ok: true })) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: redact(error instanceof Error ? error.message : '하네스 명령 실행 실패') }) + '\n');
    process.exitCode = 1;
  }
}
