import { expect, it, vi } from 'vitest';
vi.mock('../src/provider/turn.ts', () => ({ runTurn: vi.fn(async () => ({ reason: 'stop', hookDenials: [], init: {} })) }));
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { doctor } from '../src/cli/doctor.ts';
import { readLedger } from '../src/core/ledger.ts';
it.each(['## 결정 완료\n\n옛 기록', '## 열린 판단\n\n### A19 — 날짜 질문 (2026-09-25)\n- 답: 1', '## 열린 판단\n\n### A1 — 질문 (rev 1)\n- 선택지: ① 하나 ② 둘\n- 답:'])('J1 doctor legacy 경고는 실패가 아니다(두뇌 실행은 mock): %s', async legacy => {
  const root = await project(); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/판단대기.md'), `# 판단대기\n\n${legacy}\n`);
  expect(await doctor(root)).toMatchObject({ ok: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:judgment:legacy-format', evidence: expect.objectContaining({ level: 'warning', body: '사용자 터미널에서 fodh judgment migrate' }) }));
});
