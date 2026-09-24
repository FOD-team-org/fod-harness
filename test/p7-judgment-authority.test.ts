import { expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addJudgment, readJudgment } from '../src/core/judgment.ts';
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
  expect((await readJudgment(root)).items[0].answer).toBe('');
  expect((await cli(root, ['judgment', 'read'])).code).toBe(0);
  expect((await cli(root, ['judgment', 'write-status', '대기'])).code).toBe(0);
  expect((await cli(root, ['judgment', 'add', '--title', '새 판단', '--background', '', '--options', '진행|보류', '--recommend', '①', '--blocks', '-'])).code).toBe(0);
  vi.stubEnv('FODH_BRAIN', '');
  if (mode === 'ancestor') vi.mocked(processes.descendantOf).mockResolvedValue(false);
  expect((await cli(root, ['judgment', 'answer', item.id, '1'])).code).toBe(0);
  expect(await cli(root, ['judgment', 'apply', item.id])).toMatchObject({ code: 0, value: { applied: [{ id: item.id }] } });
});
