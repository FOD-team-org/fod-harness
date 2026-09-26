#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { startPlan, startShell, implicitStart } from '../src/cli/start.ts';
import { commandTable } from '../src/cli/commands.ts';
import { HarnessHookRequired } from '../src/core/claude-settings.ts';
import { redact } from '../src/provider/privacy.ts';
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
try {
  const { values, positionals } = parseArgs({ options: { model: { type: 'string' }, print: { type: 'boolean' },
    implicit: { type: 'boolean' }, interactive: { type: 'boolean' } } });
  if (positionals.length || !values.print) throw new Error('내부 런처는 --print 가 필요합니다');
  const plan = values.implicit ? await implicitStart({ interactive: values.interactive,
    ask: async question => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const closed = new Promise(resolve => rl.once('close', () => resolve('')));
        const answer = rl.question(question).catch(error => {
          if (error?.name === 'AbortError' || /Aborted with Ctrl\+D/.test(error?.message ?? '')) return '';
          throw error;
        });
        return await Promise.race([answer, closed]);
      } finally { rl.close(); }
    }, report: summary => process.stderr.write(summary + '\n'),
  }) : await startPlan({ model: values.model });
  const help = JSON.stringify({ help: commandTable.map(({ usage, summary }) => ({ usage, summary })),
    ...(process.env.FODH_BRAIN === '1' ? {} : { next: '프로젝트 폴더에서 fodh init 으로 설치한 뒤 fodh 를 실행하세요' }) });
  process.stdout.write(plan ? startShell(plan) + '\n' : `printf '%s\\n' ${quote(help)}\n`);
} catch (error) {
  const message = redact(error instanceof Error ? error.message : '시작 실패');
  process.stderr.write(error instanceof HarnessHookRequired ? message + '\n' : JSON.stringify({ error: message }) + '\n');
  process.exitCode = 1;
}
