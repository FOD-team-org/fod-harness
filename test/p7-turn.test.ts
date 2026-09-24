import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import * as runner from '../src/provider/runner.ts';
import { runTurn } from '../src/provider/turn.ts';
import { readState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { setConfig } from '../src/core/config.ts';
import { setNotifyContext } from '../src/core/notify.ts';
import * as notifications from '../src/core/notify.ts';
import * as ledger from '../src/core/ledger.ts';

it.each([
  ['assistant', '변경: 문서\n대기: 없음\n상태: PICK\n', true],
  ['stream', '변경: 문서\n대기: 없음\n상태: PICK\n', true],
  ['result', '변경: 문서\n대기: 없음\n상태: PICK\n', true],
  ['일치', '변경: 문서\n대기: 없음\n상태: DONE_ALL\n', false],
  ['꼬리 밖', '상태: PICK\n변경: 문서\n대기: 없음\n끝\n', false],
  ['백틱', '변경: 문서\n대기: 없음\n상태: `PICK`\n', true],
  ['꾸밈 일치', '변경: 문서\n대기: 없음\n **상태:** `DONE_ALL` \n', false],
])('F7 %s 마지막 3줄의 불일치만 원장 1건과 TUI info, 상태 불변', async (source, summary, mismatch) => {
  const root = await project('DONE_ALL');
  await setConfig(root, 'notify.channels', '["tui","ledger"]');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  const tui = vi.fn(); setNotifyContext(root, { hasUI: true, notify: tui });
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none',
      permissionMode: 'bypassPermissions', model: 'haiku' });
    if (source === 'stream') {
      await options.onEvent?.({ type: 'stream_event', event: { type: 'message_start' } });
      for (const text of [summary.slice(0, 20), summary.slice(20)]) await options.onEvent?.({ type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    } else if (source !== 'result') {
      await options.onEvent?.({ type: 'assistant', message: { content: [{ type: 'text', text: summary }] } });
    }
    await options.onEvent?.({ type: 'result', is_error: false, ...(source === 'result' ? { result: summary } : {}) });
    return { code: 0, cleaned: true, stderr: '' };
  });
  try {
    expect((await runTurn('fixture', { root, model: 'haiku', env: { HOME: root } })).reason).toBe('stop');
    expect((await readState(root)).state).toBe('DONE_ALL');
    const warnings = (await readLedger(root)).filter(e => e.action === 'report:state-mismatch');
    expect(warnings).toHaveLength(mismatch ? 1 : 0);
    if (mismatch) {
      expect(warnings[0]).toMatchObject({ status: 'warn', evidence: { reported: 'PICK', actual: 'DONE_ALL' } });
      expect(tui).toHaveBeenCalledExactlyOnceWith('두뇌 보고 상태 PICK ≠ 실제 DONE_ALL', 'info');
    } else expect(tui).not.toHaveBeenCalled();
  } finally { setNotifyContext(root); }
});

it.each(['notify', 'ledger', 'both'])('N4 %s 진단 실패가 정상 턴 결과와 후속 감사 알림을 덮지 않는다', async failure => {
  const root = await project('DONE_ALL');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  vi.spyOn(notifications, 'notify').mockRejectedValue(new Error('diagnostic notice failed'));
  const append = ledger.appendLedger;
  vi.spyOn(ledger, 'appendLedger').mockImplementation(async (root, entry) => {
    if (failure !== 'notify' && entry.action === 'report:state-mismatch'
      || failure === 'both' && entry.action === 'report:state-check') throw new Error('diagnostic ledger failed');
    return append(root, entry);
  });
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', permissionMode: 'bypassPermissions', model: 'haiku' });
    await options.onEvent?.({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Write', id: 'fixture', input: { file_path: 'src/suspected.ts' } },
      { type: 'text', text: '상태: PICK' },
    ] } });
    await options.onEvent?.({ type: 'result', is_error: false });
    return { code: 0, cleaned: true, stderr: '' };
  });
  const audit = vi.fn();
  expect((await runTurn('fixture', { root, model: 'haiku', env: { HOME: root }, notify: audit })).reason).toBe('stop');
  expect(audit).toHaveBeenCalledWith(expect.stringContaining('소스 쓰기 의심'));
  expect((await readState(root)).state).toBe('DONE_ALL');
  if (failure !== 'both') expect((await readLedger(root)).filter(e => e.action === 'report:state-check')).toEqual([
    expect.objectContaining({ status: 'fail' }),
  ]);
});
