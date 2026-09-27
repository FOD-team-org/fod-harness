import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendLedger } from './ledger.ts';
import { atomicWrite, harnessPath, readJson } from './storage.ts';
import { recordMember, repoEvidence } from './workspace-task.ts';
import { loadConfig } from './config.ts';
import { readState, updateState } from './state.ts';
import { redact } from '../provider/privacy.ts';

export async function assertSetupMemory(root: string) {
  const state = await readState(root);
  const watch = await readJson<{ watch?: { memory?: { critical?: boolean } } }>(harnessPath(root, 'harness-watcher.json'), {});
  if (state.lastPaused === 'memory' || state.state === 'paused(memory)' || watch.watch?.memory?.critical) {
    throw new Error('메모리 회복 전에는 worktree 준비를 시작할 수 없습니다');
  }
}
// The caller owns harness-worktree. Each command owns a process group, including its descendants.
export async function setupWorktree(root: string, taskId: string, options: { timeoutMs?: number } = {}) {
  const config = await loadConfig(root), state = await readState(root);
  const record = state.worktrees?.find(item => item.taskId === taskId);
  if (!record) throw new Error('등록된 task 워크트리가 필요합니다');
  const member = await recordMember(root, config, record), repo = repoEvidence(config, member);
  const setup = member.worktrees.setup ?? [];
  if (record.setupOk || !setup.length) return record;
  await assertSetupMemory(root);
  const runId = randomUUID(), log = `.pi/worktree-setup/${taskId}-${runId}.log`;
  let output = '';
  await atomicWrite(join(root, log), '');
  for (let index = 0; index < setup.length; index++) {
    await assertSetupMemory(root);
    const started = Date.now(), order = index + 1;
    await appendLedger(root, { runId, taskId, action: 'worktree:setup', status: 'pre', evidence: { ...repo, order, log } });
    const result = await new Promise<{ exitCode: number; output: string }>(ok => {
      const child = spawn('/bin/sh', ['-c', setup[index]], {
        cwd: record.path, env: { ...process.env, FODH_WORKTREE: record.path, FODH_TASK: taskId },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let captured = '', timedOut = false, tooLarge = false, settled = false;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } } };
      const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
      const signalHandlers = signals.map(signal => {
        const handler = () => {
          kill();
          process.removeListener(signal, handler);
          // Preserve any pre-existing shutdown handler; otherwise restore default signal termination.
          if (!process.listenerCount(signal)) process.kill(process.pid, signal);
        };
        process.on(signal, handler); return handler;
      });
      process.once('exit', kill);
      const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? (member.worktrees.setupTimeoutMinutes ?? 10) * 60000);
      const finish = (code: number, error = '') => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(drain);
        process.removeListener('exit', kill);
        signals.forEach((signal, i) => process.removeListener(signal, signalHandlers[i]));
        child.stdout.destroy(); child.stderr.destroy();
        ok({ exitCode: timedOut ? 124 : tooLarge ? 125 : code,
          output: captured + error + (timedOut ? '\n시간 초과: 프로세스 그룹 종료\n' : tooLarge ? '\n로그 8 MiB 상한: 프로세스 그룹 종료\n' : '') });
      };
      const capture = (chunk: string) => {
        if (tooLarge) return;
        captured += chunk;
        if (Buffer.byteLength(captured) > 8 * 1024 * 1024) { tooLarge = true; kill(); }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.once('error', () => { kill(); finish(127, '\n준비 명령 실행 실패\n'); });
      child.once('exit', code => {
        clearTimeout(timer); kill();
        // A detached descendant may hold inherited pipes open indefinitely.
        drain = setTimeout(() => finish(code ?? 1), 150);
      });
      child.once('close', code => finish(code ?? 1));
    });
    // Redact once after joining chunks, so secrets split across stream chunks are still removed.
    output += `\n[명령 ${order}]\n${redact(result.output)}`;
    await atomicWrite(join(root, log), output);
    await appendLedger(root, { runId, taskId, action: 'worktree:setup', status: result.exitCode === 0 ? 'ok' : 'fail',
      evidence: { ...repo, order, exitCode: result.exitCode, durationMs: Date.now() - started, log } });
    if (result.exitCode !== 0) throw new Error(`worktree 준비 실패: ${order} exit ${result.exitCode} (로그 ${log})`);
  }
  const complete = { ...record, setupOk: true, setupAt: new Date().toISOString() };
  await updateState(root, current => ({ worktrees: current.worktrees?.map(item => item.taskId === taskId && item.path === record.path ? complete : item) }));
  return complete;
}
