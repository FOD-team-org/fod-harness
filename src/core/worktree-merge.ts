import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTask } from './backlog.ts';
import { loadConfig } from './config.ts';
import { addJudgment } from './judgment.ts';
import { appendLedger, unknownEntries } from './ledger.ts';
import { readState } from './state.ts';
import { atomicWrite, readJson } from './storage.ts';
import { withWorktreeLock } from './worktree-lock.ts';
import { validateTaskCommit } from './worktree.ts';
import { taskGit as git, executionTask, taskMember, assertRecordRepo, repoEvidence, isAncestor } from './workspace-task.ts';
import { redact } from '../provider/privacy.ts';

export type MergeFailureReason = 'dirty' | 'branch' | 'tip' | 'base' | 'merge-head' | 'already-in-base'
  | 'conflict' | 'hook' | 'not-started' | 'timeout' | 'record';
export interface MergeMarker { runId: string; taskId: string; review: string; at: string; ino?: number; mtimeMs?: number }
interface StageResult { exitCode: number; timedOut: boolean; stderrTail: string }
// Only our freshly spawned group is signalled. No process-table permissions are required.
function runStage(path: string, args: string[], timeoutMs: number): Promise<StageResult> {
  return new Promise(done => {
    const child = spawn('git', ['-C', path, ...args], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = Buffer.alloc(0), truncated = false, timedOut = false, settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } } };
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const handlers = signals.map(signal => {
      const handler = () => { kill(); process.off(signal, handler); if (!process.listenerCount(signal)) process.kill(process.pid, signal); };
      process.on(signal, handler); return handler;
    });
    process.once('exit', kill);
    const timer = setTimeout(() => { timedOut = true; kill(); drain = setTimeout(() => finish(124), 200); }, timeoutMs);
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drain); child.stderr.destroy();
      process.off('exit', kill); signals.forEach((signal, i) => process.off(signal, handlers[i]));
      // Drop a truncated first line so a token whose prefix was discarded cannot leak.
      const text = tail.toString('utf8');
      const complete = truncated ? text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '' : text;
      done({ exitCode: timedOut ? 124 : exitCode, timedOut, stderrTail: redact(complete) });
    };
    child.stderr.on('data', (chunk: Buffer) => {
      const joined = Buffer.concat([tail, chunk]);
      if (joined.length > 4096) truncated = true;
      tail = Buffer.from(joined.subarray(Math.max(0, joined.length - 4096)));
    });
    child.once('error', () => { kill(); finish(127); });
    child.once('exit', code => { kill(); clearTimeout(timer); clearTimeout(drain); drain = setTimeout(() => finish(code ?? 1), 150); });
    child.once('close', code => finish(code ?? 1));
  });
}

export async function mergeWorktree(root: string, taskId: string, options: { timeoutMs?: number } = {}) {
  return withWorktreeLock(root, async () => {
    const config = await loadConfig(root), task = await executionTask(root, taskId, config), state = await readState(root);
    const member = await taskMember(root, config, task), repo = repoEvidence(config, member);
    const record = state.worktrees?.find(item => item.taskId === taskId);
    const currentBranch = () => git(member.path, ['rev-parse', '--abbrev-ref', 'HEAD']).then(value => value.trim());
    const branch = config.workspace ? member.baseBranch! : record?.baseBranch ?? await currentBranch().catch(() => '');
    const tipRef = `refs/heads/${branch}`, review = task.review?.commit;
    const baseTip = await git(member.path, ['rev-parse', '--verify', `${tipRef}^{commit}`]).then(value => value.trim()).catch(() => null);
    // Capture old unknown entries BEFORE this run's pre; the new pre must not claim an older merge.
    const unfinished = (await unknownEntries(root)).filter(entry => entry.taskId === taskId && entry.action === 'worktree:merge').at(-1);
    const runId = randomUUID();
    let success = false;
    let failure: { reason: MergeFailureReason; stage?: 'merge' | 'commit'; exitCode?: number; aborted?: boolean; stderrTail?: string } = { reason: 'record' };
    await appendLedger(root, { runId, taskId, action: 'worktree:merge', status: 'pre', evidence: { ...repo, branch, review, baseTip } });
    const refuse = (reason: MergeFailureReason, message: string): never => { failure.reason = reason; throw new Error(message); };
    try {
      if (state.state !== 'MERGE' || state.taskId !== taskId) refuse('record', '현재 task의 MERGE 상태에서만 병합할 수 있습니다');
      if (!review || task.review?.high !== 0) refuse('record', '검수 커밋과 review.high 0이 필요합니다');
      if (!record) refuse('record', '등록된 워크트리가 없습니다');
      assertRecordRepo(config, task, record);
      try { await access(resolve(member.path, '.git')); } catch { refuse('record', 'git 저장소가 아닙니다'); }
      if (!config.workspace && !record!.baseBranch) await appendLedger(root, { runId, taskId, action: 'merge-commit:base-branch-unknown', status: 'warn' });
      if (!baseTip) refuse('base', `기준 브랜치(${branch}) 끝을 읽을 수 없습니다`);
      const reviewed = await git(member.path, ['rev-parse', '--verify', `${review}^{commit}`]).then(s => s.trim()).catch(() => '');
      if (!reviewed) refuse('tip', '검수 커밋을 읽을 수 없습니다');
      const common = resolve(member.path, (await git(member.path, ['rev-parse', '--git-common-dir'])).trim());
      const markerPath = resolve(common, 'fodh-merge.json');
      const mergeHeadPath = resolve(member.path, (await git(member.path, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim());
      const mergeHead = () => git(member.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(s => s.trim()).catch(() => '');
      const removeMarker = () => unlink(markerPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const abort = async () => {
        try { await git(member.path, ['merge', '--abort']); if (await mergeHead()) return false; await removeMarker(); return true; }
        catch { return false; }
      };
      let base = task.merge?.base ?? (!config.workspace ? state.mergeBase : undefined);
      let mergeCommit: string | undefined, fastForward = false, alreadyMerged = false;
      const commitWarnings: { commitTimedOut?: true; commitHookFailedAfterCommit?: true } = {};
      const history = await git(member.path, ['rev-list', '--first-parent', ...(base ? ['--merges', `${base}..${tipRef}`] : ['--max-count=200', tipRef])]).catch(() => '');
      for (const sha of history.trim().split(/\s+/u).filter(Boolean)) {
        const parents = (await git(member.path, ['rev-list', '--parents', '-n', '1', sha])).trim().split(/\s+/u);
        if (parents[2] === reviewed) { mergeCommit = sha; alreadyMerged = true; break; }
      }
      if (!mergeCommit && await isAncestor(member.path, reviewed, baseTip!)) { mergeCommit = reviewed; alreadyMerged = fastForward = true; }
      const warnings: { untracked?: { count: number; paths: string[] } } = {};
      if (!alreadyMerged) {
        const head = await mergeHead();
        if (head) {
          const marker = await readJson<MergeMarker | null>(markerPath, null).catch(() => null);
          const info = await stat(mergeHeadPath).catch(() => null);
          const ownedFile = !!(marker && info && (marker.ino !== undefined
            ? marker.ino === info.ino && marker.mtimeMs === info.mtimeMs
            : info.mtimeMs >= Date.parse(marker.at) && info.mtimeMs <= Date.parse(marker.at) + 600000));
          if (head === reviewed && marker?.taskId === taskId && marker.review === review && marker.runId === unfinished?.runId && ownedFile) {
            const aborted = await abort();
            if (!aborted) refuse('merge-head', '진행 중인 병합을 되돌리지 못했습니다 — 되돌리기도 실패했습니다, 사용자가 확인');
            await appendLedger(root, { runId: marker.runId, taskId, action: 'worktree:merge', status: 'fail', evidence: { ...repo, reason: 'merge-head', aborted: true } });
          } else {
            await addJudgment(root, { title: `진행 중인 병합 ${taskId}·${member.name}: 정리 뒤 재시도 / 보류`,
              background: '사용자가 진행 중인 병합을 먼저 정리해야 합니다.', options: ['사용자가 병합을 끝내거나 되돌렸다 — 다시 시도', '보류'],
              recommend: '① 병합 정리 뒤 재시도', blocks: taskId, dedupeKey: `merge-head:${taskId}:${head}` });
            refuse('merge-head', `멤버 ${member.name}에 진행 중인 병합이 있습니다 — 사용자가 정리한 뒤 다시`);
          }
        }
        if (await currentBranch() !== branch) refuse('branch', config.workspace ? `멤버 ${member.name} 브랜치가 기준 브랜치(${branch})가 아닙니다` : `루트 브랜치가 base 브랜치(${branch})가 아닙니다`);
        if (config.workspace && (await git(member.path, ['status', '--porcelain', '--untracked-files=no'])).trim()) refuse('dirty', '기준 브랜치에 추적 파일 미커밋 변경이 있습니다');
        if ((await git(member.path, ['rev-parse', `refs/heads/${record!.branch}`])).trim() !== reviewed) refuse('tip', 'task 브랜치 끝이 검수 커밋과 다릅니다');
        if (!base && config.workspace) {
          base = baseTip!; await setTask(root, taskId, { merge: { base } });
          await appendLedger(root, { runId, taskId, action: 'merge-base:reset', status: 'warn', evidence: { ...repo, reason: 'missing' } });
        }
        if (base && !await isAncestor(member.path, base, baseTip!)) refuse('base', '병합 기준점이 기준 브랜치 끝의 조상이 아닙니다');
        if (config.workspace) {
          const paths = (await git(member.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
          if (paths.length) {
            warnings.untracked = { count: paths.length, paths: paths.slice(0, 5).map(redact) };
            await appendLedger(root, { runId, taskId, action: 'worktree:merge:untracked', status: 'warn', evidence: { ...repo, ...warnings.untracked } });
          }
        }
        const marker: MergeMarker = { runId, taskId, review: review!, at: new Date().toISOString() };
        await atomicWrite(markerPath, JSON.stringify(marker) + '\n');
        for (const stage of ['merge', 'commit'] as const) {
          const result = await runStage(member.path, stage === 'merge'
            ? ['merge', '--no-ff', '--no-commit', '--no-autostash', reviewed]
            : ['commit', '-m', `merge(${taskId}): ${task.title}`], options.timeoutMs ?? 600000);
          const head = await mergeHead();
          if (stage === 'merge' && head) {
            const { ino, mtimeMs } = await stat(mergeHeadPath);
            await atomicWrite(markerPath, JSON.stringify({ ...marker, ino, mtimeMs }) + '\n');
          }
          if (result.exitCode === 0 && !result.timedOut) continue;
          if (stage === 'commit' && !head) {
            const parents = await git(member.path, ['rev-list', '--parents', '-n', '1', tipRef]).then(value => value.trim().split(/\s+/u)).catch(() => []);
            if (parents[2] === reviewed) {
              mergeCommit = parents[0];
              if (result.timedOut) commitWarnings.commitTimedOut = true;
              else commitWarnings.commitHookFailedAfterCommit = true;
              break;
            }
          }
          const reason = result.timedOut ? 'timeout' : stage === 'commit' ? 'hook' : head ? 'conflict' : 'not-started';
          const aborted = head ? await abort() : false;
          if (!head) await removeMarker();
          failure = { reason, stage, exitCode: result.exitCode, aborted, ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}) };
          const target = `${config.workspace ? member.name + ' ' : ''}${branch}`;
          let message = reason === 'timeout' ? '병합이 10분 안에 끝나지 않았습니다 — 되돌렸습니다'
            : reason === 'hook' ? '레포 커밋 훅이 거부했습니다 — 명의·훅을 확인(되돌렸습니다)'
            : reason === 'conflict' ? `충돌: ${taskId} 를 ${target}에 병합할 수 없습니다 — 되돌렸습니다`
            : `병합을 시작하지 못했습니다: ${taskId} → ${target} — 기준 브랜치의 로컬 변경·잠금을 확인`;
          if (stage === 'commit' && !head) message = message.replace(' — 되돌렸습니다', '').replace('(되돌렸습니다)', '') + ' — 병합이 남았는지 사용자가 확인';
          throw new Error(message + (head && !aborted ? ' — 되돌리기도 실패했습니다, 사용자가 확인' : ''));
        }
        await removeMarker();
        mergeCommit ??= (await git(member.path, ['rev-parse', tipRef])).trim();
      }
      try {
        if (fastForward) {
          if (await currentBranch() !== branch || !await isAncestor(member.path, reviewed, tipRef)
            || (await git(member.path, ['rev-parse', `refs/heads/${record!.branch}`])).trim() !== reviewed) throw new Error();
        } else await validateTaskCommit(root, taskId, mergeCommit!, 'merge');
      } catch {
        refuse(alreadyMerged ? 'already-in-base' : 'record', alreadyMerged
          ? `검수 커밋이 이미 ${branch}에 들어 있지만 병합 기록으로 확인할 수 없습니다 — 사용자가 확인` : '병합 커밋을 기록으로 확인할 수 없습니다 — 사용자가 확인');
      }
      failure.reason = 'record';
      if (alreadyMerged) {
        const marker = await readJson<MergeMarker | null>(markerPath, null).catch(() => null);
        if (marker?.taskId === taskId && marker.review === review && marker.runId === unfinished?.runId) await removeMarker();
      }
      await setTask(root, taskId, { merge: { commit: mergeCommit! } });
      await appendLedger(root, { runId, taskId, action: 'worktree:merge', status: 'ok', evidence: {
        ...repo, branch, review, mergeCommit, ...(alreadyMerged ? { alreadyMerged: true } : {}), ...(fastForward ? { fastForward: true } : {}), ...commitWarnings } });
      success = true;
      return { taskId, ...repo, branch, mergeCommit: mergeCommit!, ...(alreadyMerged ? { alreadyMerged: true } : {}), ...(warnings.untracked ? { warnings } : {}) };
    } finally {
      if (!success) await appendLedger(root, { runId, taskId, action: 'worktree:merge', status: 'fail', evidence: { ...repo, ...failure } });
    }
  });
}
