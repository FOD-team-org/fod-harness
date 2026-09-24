import * as processTime from '../src/core/process-time.ts';
import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { addJudgment, answerJudgment, beginJudgmentSnapshot, recoverJudgmentSnapshot, readJudgment } from '../src/core/judgment.ts';
import { readState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';

it.each(['live', 'dead', 'legacy', 'reused'])('N2 다른 pid %s 스냅숏은 생존 여부에 따라 보호·정산', async kind => {
  const root = await project();
  const { item } = await addJudgment(root, { title: '잔존', background: '', options: ['진행'], recommend: '', blocks: '-' });
  await beginJudgmentSnapshot(root, { runId: 'other', startedAt: new Date().toISOString() });
  await answerJudgment(root, item.id, '1');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const closed = once(child, 'close'); await once(child, 'spawn');
  try {
    if (kind !== 'live' && kind !== 'reused') { child.kill(); await closed; }
    const path = join(root, '.pi/harness-judgment-snapshot.json');
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'legacy') delete snapshot.pid; else { snapshot.pid = child.pid; snapshot.startedAt = await processTime.processStartedAt(child.pid!) ?? ''; }
    if (kind === 'reused') { snapshot.startedAt = 'old-process'; vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('new-process'); }
    await writeFile(path, JSON.stringify(snapshot)); const before = await readFile(path, 'utf8');
    await recoverJudgmentSnapshot(root); await recoverJudgmentSnapshot(root);
    if (kind === 'live') {
      expect(await readFile(path, 'utf8')).toBe(before);
      expect((await readState(root)).brainTurn?.endedAt).toBeUndefined();
      expect((await readJudgment(root)).items[0].held).toBeUndefined();
      expect((await readLedger(root)).filter(e => e.action === 'judgment:snapshot-skip')).toEqual([
        expect.objectContaining({ evidence: { pid: child.pid } }),
      ]);
    } else {
      expect((await readJudgment(root)).items[0].held?.runId).toBe('other');
      expect((await readState(root)).brainTurn?.endedAt).toBeTruthy();
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
});
