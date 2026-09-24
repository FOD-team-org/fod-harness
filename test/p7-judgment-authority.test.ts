import { expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addJudgment, readJudgment, answerJudgment, applyJudgments } from '../src/core/judgment.ts';
import { setConfig } from '../src/core/config.ts';
import * as processes from '../src/core/process-time.ts';
it.each(['env', 'ancestor'])('F24 %s 두뇌는 일반 판단의 answer/apply 불가, 사용자 허용', async mode => {
  const root = await project('RESEARCH');
  const { item } = await addJudgment(root, { title: '사용자 판단', background: '', options: ['진행', '보류'], recommend: '①', blocks: '-' });
  if (mode === 'env') vi.stubEnv('FODH_BRAIN', '1');
  else {
    await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: process.ppid, startedAt: 'owner-start', token: 'fixture' }));
    vi.spyOn(processes, 'processStartedAt').mockResolvedValue('owner-start');
    vi.spyOn(processes, 'descendantOf').mockResolvedValue(true);
  }
  for (const args of [['answer', item.id, '1'], ['apply', item.id]]) expect(await cli(root, ['judgment', ...args]))
    .toMatchObject({ code: 1, value: { error: '판단은 사용자만 답합니다: docs/판단대기.md 의 `- 답:` 줄을 사용자가 채운다' } });
  await expect(answerJudgment(root, item.id, '1')).rejects.toThrow('판단은 사용자만');
  await expect(applyJudgments(root)).rejects.toThrow('판단은 사용자만');
  expect((await readJudgment(root)).items[0].answer).toBe('');
  expect((await cli(root, ['judgment', 'read'])).code).toBe(0);
  expect((await cli(root, ['judgment', 'write-status', '대기'])).code).toBe(0);
  expect((await cli(root, ['judgment', 'add', '--title', '새 판단', '--background', '', '--options', '진행|보류', '--recommend', '①', '--blocks', '-'])).code).toBe(0);
  vi.stubEnv('FODH_BRAIN', '');
  if (mode === 'ancestor') vi.mocked(processes.descendantOf).mockResolvedValue(false);
  expect((await cli(root, ['judgment', 'answer', item.id, '1'])).code).toBe(0);
  expect(await cli(root, ['judgment', 'apply', item.id])).toMatchObject({ code: 0, value: { applied: [{ id: item.id }] } });
});

it('R1 Pi 잠금 소유자 자신은 코어 답변·적용 가능', async () => {
  const root = await project('RESEARCH');
  await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: process.pid, startedAt: 'owner', token: 'fixture' }));
  const { item } = await addJudgment(root, { title: 'Pi', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await answerJudgment(root, item.id, '1');
  expect((await applyJudgments(root)).applied.map(item => item.id)).toEqual([item.id]);
});
it('R5 CLI·코어 거부 문구는 설정 판단 경로를 안내한다', async () => {
  const root = await project('RESEARCH');
  await setConfig(root, 'judgment.file', 'notes/사용자결정.md');
  vi.stubEnv('FODH_BRAIN', '1');
  await expect(answerJudgment(root, 'A1', '1')).rejects.toThrow('notes/사용자결정.md');
  await expect(applyJudgments(root)).rejects.toThrow('notes/사용자결정.md');
  expect(await cli(root, ['judgment', 'apply'])).toMatchObject({ code: 1, value: { error: expect.stringContaining('notes/사용자결정.md') } });
});

it('N4 state await-user는 두뇌 거부·사용자 허용', async () => {
  const root = await project('IMPLEMENT');
  vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['state', 'await-user'])).toMatchObject({ code: 1, value: { error: expect.stringContaining('사용자 대기 표시') } });
  vi.stubEnv('FODH_BRAIN', '');
  expect(await cli(root, ['state', 'await-user'])).toMatchObject({ code: 0, value: { awaitingUser: true } });
});
