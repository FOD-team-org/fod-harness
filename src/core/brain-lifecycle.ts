import { unlink } from 'node:fs/promises';
import { acquireLock, ownerAt, lockOwnerAlive, isProcessAlive } from './lock.ts';
import { readState, updateState } from './state.ts';
import { listProcs, removeProc } from './procs.ts';
import { groupAlive, reclaimOwnedGroup } from '../provider/runner.ts';
import { recoverJudgmentSnapshot } from './judgment.ts';
import { harnessPath, readJson } from './storage.ts';
import { appendLedger } from './ledger.ts';
import { notify } from './notify.ts';

// Provider calls immediately after acquisition, before doctor can replace the old turn.
// Standalone orchestrator startup may temporarily acquire an abandoned session lock.
export async function recoverOrphanBrain(root: string, newlyAcquired = false): Promise<void> {
  const path = harnessPath(root, 'harness.lock');
  const owner = await ownerAt(path);
  let release: (() => Promise<void>) | undefined;
  if (newlyAcquired) {
    if (!owner || owner.pid !== process.pid || !await lockOwnerAlive(owner)) return;
  } else {
    if (owner && await lockOwnerAlive(owner)) return;
    try { release = await acquireLock(path, { waitMs: 0 }); }
    catch { return; } // Another live session won acquisition.
  }
  try {
    const state = await readState(root), turn = state.brainTurn;
    let recovered = false;
    if (turn && !turn.endedAt) {
      for (const record of await listProcs(root)) {
        if (record.kind !== 'brain' || record.runId !== turn.runId || !groupAlive(record.pgid)) continue;
        // Do not signal a PID that now belongs to a different process.
        if (isProcessAlive(record.pid) && !await lockOwnerAlive({ pid: record.pid, startedAt: record.startedAt.startsWith('spawn:') ? '' : record.startedAt, token: record.runId })) continue;
        if (!await reclaimOwnedGroup(record.pgid)) throw new Error('고아 두뇌 프로세스 회수에 실패했습니다');
        await removeProc(root, record.pid, record.runId);
        await appendLedger(root, { runId: record.runId, action: 'brain:orphan-reclaimed', status: 'ok', evidence: { pgid: record.pgid, runId: record.runId, alive: true } });
        recovered = true;
      }
    }
    const orphanPath = harnessPath(root, 'harness-brain-orphan.json');
    const orphan = await readJson<{ pgid: number; signal: string; at: string } | null>(orphanPath, null);
    if (orphan) {
      await appendLedger(root, { runId: turn?.runId ?? `orphan-${orphan.pgid}`, action: 'brain:orphan-reclaimed', status: 'ok', evidence: { ...orphan, alive: false } });
      await unlink(orphanPath);
      recovered = true;
    }
    if (recovered) {
      await notify(root, { key: 'brain:orphan-reclaimed', title: '두뇌 회수', level: 'warning', body: '고아 두뇌 프로세스를 회수했습니다' });
      await recoverJudgmentSnapshot(root);
      await updateState(root, { state: 'recovering' });
    }
  } finally { await release?.(); }
}
