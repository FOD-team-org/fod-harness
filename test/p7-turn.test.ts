import { createRequire } from 'node:module';
import * as judgments from '../src/core/judgment.ts';
import { expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project as baseProject } from './p5-helpers.ts';
import * as runner from '../src/provider/runner.ts';
import { runTurn, isTurnInProgress } from '../src/provider/turn.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addJudgment, answerJudgment, readJudgment } from '../src/core/judgment.ts';
import { setConfig } from '../src/core/config.ts';
import { setNotifyContext } from '../src/core/notify.ts';
import * as notifications from '../src/core/notify.ts';
import * as ledger from '../src/core/ledger.ts';

async function project(state?: string) {
  const root = await baseProject(state);
  await setConfig(root, 'brain.allowedModels', JSON.stringify(['claude-opus-5-5', 'claude-fable-5-1', 'haiku', 'sonnet']));
  return root;
}

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

it.each([{ throws: false, doctor: false }, { throws: true, doctor: false }, { throws: false, doctor: true }, { throws: true, doctor: true }])('S1 두뇌·doctor 스냅숏 $doctor / throw $throws', async ({ throws, doctor }) => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  const { item } = await addJudgment(root, { title: '답 변경', background: '', options: ['진행'], recommend: '', blocks: '-' });
  vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
    const snapshot = JSON.parse(await readFile(join(root, '.pi/harness-judgment-snapshot.json'), 'utf8'));
    expect(snapshot).toMatchObject({ runId: (await readState(root)).brainTurn?.runId, answers: { [item.id]: '- 답:' } });
    await answerJudgment(root, item.id, '1');
    expect((await readState(root)).brainTurn).toMatchObject({ runId: expect.any(String), startedAt: expect.any(String) });
    expect((await readState(root)).brainTurn?.endedAt).toBeUndefined();
    if (throws) throw new Error('stub crash');
    return { code: 1, cleaned: true, stderr: '' };
  });
  const call = runTurn('fixture', { root, doctor, env: { HOME: root } });
  if (throws) await expect(call).rejects.toThrow('stub crash'); else await call;
  const window = (await readState(root)).brainTurn!;
  expect(Date.parse(window.endedAt!)).toBeGreaterThanOrEqual(Date.parse(window.startedAt));
  expect((await readLedger(root)).some(entry => entry.action === 'brain:window')).toBe(false);
  expect((await readJudgment(root)).items[0].held?.runId).toBe(window.runId);
  await expect(readFile(join(root, '.pi/harness-judgment-snapshot.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([false, true])('F27 allowPlugins=%s에 따른 MCP 제한 옵션', async allowPlugins => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  if (allowPlugins) await setConfig(root, 'brain.allowPlugins', 'true');
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    expect(options.args!.includes('--strict-mcp-config')).toBe(!allowPlugins);
    expect(options.args!.includes('--setting-sources')).toBe(!allowPlugins);
    if (!allowPlugins) expect(options.args![options.args!.indexOf('--setting-sources') + 1]).toBe('project,local');
    if (!allowPlugins) expect(options.args![options.args!.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    else expect(options.args).not.toContain('--mcp-config');
    return { code: 1, cleaned: true, stderr: '' };
  });
  await runTurn('fixture', { root, env: { HOME: root } });
});

it('N2 doctor begin은 잔존 답을 먼저 정산하고 자기 진행 중 recover는 건너뛴다', async () => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  const { item } = await addJudgment(root, { title: '잔존 답', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await judgments.beginJudgmentSnapshot(root, { runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' });
  await answerJudgment(root, item.id, '1');
  await updateState(root, { lastEventAt: '2026-01-01T00:01:00.000Z' });
  const path = join(root, '.pi/harness-judgment-snapshot.json');
  vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
    expect((await readJudgment(root)).items[0].held).toMatchObject({ runId: 'old', at: '2026-01-01T00:01:00.000Z' });
    const snapshot = await readFile(path, 'utf8');
    expect(JSON.parse(snapshot)).toMatchObject({ pid: process.pid, answers: { [item.id]: '- 답: 1' } });
    expect(JSON.parse(snapshot).runId).not.toBe('old');
    expect(isTurnInProgress(root)).toBe(true);
    await judgments.recoverJudgmentSnapshot(root);
    expect(await readFile(path, 'utf8')).toBe(snapshot);
    expect((await readState(root)).brainTurn?.endedAt).toBeUndefined();
    return { code: 1, cleaned: true, stderr: '' };
  });
  await runTurn('fixture', { root, doctor: true, env: { HOME: root } });
  expect(isTurnInProgress(root)).toBe(false);
  expect((await readLedger(root)).filter(e => e.action === 'judgment:held')).toEqual([expect.objectContaining({ runId: 'old' })]);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('N2 begin 직후 원장 예외도 finally 정산으로 스냅숏을 지운다', async () => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  const append = ledger.appendLedger;
  vi.spyOn(ledger, 'appendLedger').mockImplementation(async (root, entry) => {
    if (entry.action === 'brain:0' && entry.status === 'pre') throw new Error('pre ledger failure');
    return append(root, entry);
  });
  const run = vi.spyOn(runner, 'runProcess');
  await expect(runTurn('fixture', { root, env: { HOME: root } })).rejects.toThrow('pre ledger failure');
  expect(run).not.toHaveBeenCalled();
  expect((await readState(root)).brainTurn?.endedAt).toBeTruthy();
  expect(isTurnInProgress(root)).toBe(false);
  await expect(readFile(join(root, '.pi/harness-judgment-snapshot.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([false, true])('N2 finish 예외는 runner 결과(throw=%s)를 덮지 않고 실패 원장에 남긴다', async throws => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  vi.spyOn(judgments, 'finishJudgmentSnapshot').mockRejectedValue(new Error('snapshot compare failure'));
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', permissionMode: 'bypassPermissions', model: 'haiku' });
    if (throws) throw new Error('runner failure');
    await options.onEvent?.({ type: 'result', is_error: false });
    return { code: 0, cleaned: true, stderr: '' };
  });
  const result = runTurn('fixture', { root, model: 'haiku', env: { HOME: root } });
  if (throws) await expect(result).rejects.toThrow('runner failure');
  else expect(await result).toMatchObject({ reason: 'stop' });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'judgment:snapshot-finish', status: 'fail', evidence: { error: 'snapshot compare failure' } }));
  expect(isTurnInProgress(root)).toBe(false);
});

it.each([false, true])('L2 finish 실패 뒤 recover 재시도 실패=%s도 활성 턴을 끝낸다', async retryFails => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  vi.spyOn(judgments, 'finishJudgmentSnapshot').mockRejectedValue(new Error('finish failed'));
  const recover = vi.spyOn(judgments, 'recoverJudgmentSnapshot');
  vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    if (retryFails) recover.mockRejectedValue(new Error('recover failed'));
    const args = options.args!, sid = args[args.indexOf('--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', permissionMode: 'bypassPermissions', model: 'haiku' });
    await options.onEvent?.({ type: 'result', is_error: false });
    return { code: 0, cleaned: true, stderr: '' };
  });
  await runTurn('fixture', { root, env: { HOME: root } });
  expect(recover).toHaveBeenCalled();
  expect(isTurnInProgress(root)).toBe(false);
  expect((await readState(root)).brainTurn?.endedAt).toBeTruthy();
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'judgment:snapshot-finish', status: 'fail' }));
  const { item } = await addJudgment(root, { title: '턴 밖 사용자 답', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await answerJudgment(root, item.id, '1');
  expect((await judgments.applyJudgments(root)).applied.map(item => item.id)).toContain(item.id);
});
it('참고 jiti 모듈 재평가도 global Symbol의 진행 턴을 공유한다', async () => {
  const root = await project('RESEARCH');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  const piRequire = createRequire(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url));
  const { createJiti } = piRequire('jiti');
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  const other = await jiti.import('../src/provider/turn.ts') as typeof import('../src/provider/turn.ts');
  vi.spyOn(runner, 'runProcess').mockImplementation(async () => {
    expect(isTurnInProgress(root)).toBe(true); expect(other.isTurnInProgress(root)).toBe(true);
    return { code: 1, cleaned: true, stderr: '' };
  });
  await runTurn('fixture', { root, env: { HOME: root } });
  expect(other.isTurnInProgress(root)).toBe(false);
});
