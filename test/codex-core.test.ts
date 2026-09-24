import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCodex, codexArgs, buildHeader, result, status, cancel, readMeta, resultDir, waitLimitMinutes, waitForResult } from '../src/core/codex.ts';
import * as configs from '../src/core/config.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { updateState, readState } from '../src/core/state.ts';
import { listProcs, removeProc } from '../src/core/procs.ts';
import { readLedger } from '../src/core/ledger.ts';
import { acquireSlot, slotsStatus, slotOwnerAlive } from '../src/core/slots.ts';
import { groupAlive } from '../src/provider/runner.ts';
import { tick } from '../src/core/watcher.ts';
import { buildPrompt } from '../src/provider/turn.ts';
import { main } from '../src/cli/index.ts';
import { parseGroupMembers, parseGroupRssMB, supervise } from '../src/core/codex-supervisor.ts';
import * as tree from '../src/core/proc-tree.ts';
import * as lock from '../src/core/lock.ts';
import * as runner from '../src/provider/runner.ts';
import * as identity from '../src/core/process-time.ts';
import * as codexReclaim from '../src/core/codex-reclaim.ts';
import { registerProc } from '../src/core/procs.ts';
import { parseProcessTree } from '../src/core/proc-tree.ts';
import { writeMeta } from '../src/core/codex-record.ts';
import { isProcessAlive } from '../src/core/lock.ts';
import { reclaimTask } from '../src/core/reclaim.ts';
import { addJudgment } from '../src/core/judgment.ts';
const roots: string[] = [], pids: number[] = [], detached: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  for (const pid of detached.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  await delay(30);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(state = 'IMPLEMENT') {
  const root = await mkdtemp(join(tmpdir(), 'fodh-codex-')); roots.push(root);
  vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  await configs.setConfig(root, 'delegate.codex.command', JSON.stringify([process.execPath, resolve('test/fake-codex/codex')]));
  const task = await addTask(root, { title: '시험', category: 'non-design' });
  await updateState(root, { state, taskId: task.id });
  await writeFile(join(root, 'spec.md'), '수용 기준 본문');
  return { root, task };
}
async function launch(root: string, taskId = 'T01', extra: Record<string, unknown> = {}) {
  const run: any = await startCodex(root, 'task', { spec: 'spec.md', taskId, ...extra });
  pids.push(run.pid); return run;
}
// Keep normal polling below Vitest's 5s guard; timeout tests pass their own longer limit.
async function finished(root: string, id: string, limit = 4000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { const meta = await readMeta(root, id); if (meta?.finishedAt) return meta; await delay(40); }
  throw new Error('fake supervisor did not finish');
}
it('그룹 출력에 감독과 조회 ps만 있으면 잔존은 0개다', () => {
  expect(parseGroupMembers(' 100 100\n 201 100\n 999 999\n', 100, [100, 201])).toEqual([]);
});
it('그룹 파싱은 제외 PID만 제거하고 실제 같은 그룹 자손을 보존한다', () => {
  const output = '\n 100 100\n 201 100\n 202 100\n 203 100\n 204 999\n 1 100\n bad 100\n';
  expect(parseGroupMembers(output, 100, [100, 201])).toEqual([202, 203]);
  expect(parseGroupMembers(output, 100, [100, undefined])).toEqual([201, 202, 203]);
});
it('RSS는 조회 ps PID만 제외하고 감독과 자식의 KiB를 MiB로 합산한다', () => {
  expect(parseGroupRssMB(' 100 1024\n 201 65536\n 202 2048\n', [201])).toBe(3);
  expect(parseGroupRssMB(' 201 65536\n', [201])).toBe(0);
});
it('빈 출력과 잘못된 RSS 행은 표본 합계에 포함하지 않는다', () => {
  expect(parseGroupMembers('', 100, [])).toEqual([]);
  expect(parseGroupRssMB('\n bad 1024\n 202 bad\n 203 -1\n 204 0\n', [])).toBe(0);
});
it('정상 fake 종료는 ok와 양수 실행 시간을 기록한다', async () => {
  const { root } = await setup();
  const run = await launch(root);
  const meta = await finished(root, run.runId);
  expect(meta).toMatchObject({ exit: 0, status: 'ok' });
  expect(meta.error).toBeUndefined();
  expect(meta.durationSeconds).toEqual(expect.any(Number));
  expect(meta.durationSeconds).toBeGreaterThan(0);
});
it.each(['task', 'review', 'research'] as const)('머리말 %s: 순서·치환·read-only·종류별 결과 형식', async kind => {
  const text = await buildHeader({ kind, runId: 'r1', cwd: '/project', sandbox: kind === 'task' ? 'workspace-write' : 'read-only', workerModel: 'worker', workerEffort: 'xhigh' }, 1, '스펙 {{literal}}');
  expect(text).toContain(`종류: ${kind} / 작업: 없음 / 실행 id: r1`); expect(text).toContain('동시 1개 이하, 모델 worker effort xhigh');
  expect(text).toContain('스펙 {{literal}}'); expect(text).toContain('## 결과');
  expect(text.includes('파일을 쓸 수 없다')).toBe(kind !== 'task');
  if (kind === 'review') expect(text).toContain('APPROVE|REQUEST_CHANGES');
  if (kind === 'research') expect(text).toContain('## 조사 결과');
});
it('새 스레드/재개 전체 인자, resume에는 -s·-C 없음', async () => {
  const cfg = (await configs.loadConfig('/unused')).delegate.codex;
  const input = { sandbox: 'read-only', cwd: '/project', resultDir: '/result' };
  expect(codexArgs(cfg, input)).toEqual(['codex', 'exec', '-s', 'read-only', '-C', '/project', '--skip-git-repo-check', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh', '--json', '-o', '/result/last-message.md', '-']);
  const resume = codexArgs(cfg, { ...input, resume: 'thread' });
  expect(resume.slice(0, 6)).toEqual(['codex', 'exec', 'resume', 'thread', '-c', 'sandbox_mode="read-only"']);
  expect(resume).not.toContain('-s'); expect(resume).not.toContain('-C'); expect(resume.at(-1)).toBe('-');
});
it('상태·task·spec·cwd 경계·심링크 탈출·resume last 검증', async () => {
  const { root, task } = await setup();
  const cases: [Record<string, unknown>, RegExp][] = [
    [{}, /--task T번호/], [{ taskId: 'bad' }, /--task T번호/], [{ taskId: 'T99' }, /백로그 task를 찾을 수 없습니다/],
    [{ taskId: task.id, spec: '../spec.md' }, /프로젝트 내부 상대 경로/], [{ taskId: task.id, spec: '/tmp/spec' }, /프로젝트 내부 상대 경로/],
    [{ taskId: task.id, cwd: tmpdir() }, /프로젝트 또는 등록된 워크트리/],
    [{ taskId: task.id, resume: 'last' }, /재개할 task.codexThread/], [{ taskId: task.id, resume: '--last' }, /재개 threadId/],
  ];
  for (const [options, message] of cases) await expect(startCodex(root, 'task', { spec: 'spec.md', ...options })).rejects.toThrow(message);
  await symlink(tmpdir(), join(root, 'escape'));
  await expect(startCodex(root, 'task', { spec: 'spec.md', taskId: task.id, cwd: 'escape' })).rejects.toThrow('등록된');
  await expect(startCodex(root, 'research', { spec: 'spec.md' })).rejects.toThrow('현재 상태');
  await expect(startCodex(root, 'review', { spec: 'spec.md' })).rejects.toThrow('현재 상태');
  await updateState(root, { state: 'VERIFY' });
  await expect(launch(root)).rejects.toThrow('현재 상태에서는 codex task');
  await expect(readdir(join(root, '.pi/codex'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('슬롯 점유 시 결과 파일·원장·state 변경 없이 owner 오류', async () => {
  const { root } = await setup();
  await acquireSlot('codex', { root, runId: 'occupied', pid: process.pid, startedAt: `spawn:${new Date().toISOString()}`, acquiredAt: new Date().toISOString() });
  const before = await readState(root), ledger = await readLedger(root);
  await expect(launch(root)).rejects.toMatchObject({ message: 'codex 슬롯 사용 중', details: { owner: { runId: 'occupied' } } });
  expect(await readState(root)).toEqual(before); expect(await readLedger(root)).toEqual(ledger);
  await expect(readdir(join(root, '.pi/codex'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('--wait fake 완료: 원장·thread·슬롯·레지스트리·결과·인박스·CLI', async () => {
  const { root, task } = await setup();
  vi.stubEnv('FAKE_CODEX_ARGS_FILE', join(root, 'args.json')); vi.stubEnv('FAKE_CODEX_STDIN_FILE', join(root, 'stdin.md'));
  vi.stubEnv('FAKE_CODEX_ENV_FILE', join(root, 'env.json'));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const output: any = await startCodex(root, 'task', { spec: 'spec.md', taskId: task.id, wait: true });
  expect(stderr.mock.calls.map(call => String(call[0]))).toContain(JSON.stringify({ runId: output.runId }) + '\n');
  expect((await stat(join(resultDir(root, output.runId), 'supervisor.log'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(root, 'env.json'), 'utf8'))).toEqual({ FODH_CODEX_CHILD: '1' });
  expect(output).toMatchObject({ status: 'ok', commands: 1, changedFiles: ['src/example.ts'], usage: { input_tokens: 10, output_tokens: 20 }, errors: [] });
  expect(output.threadId).toMatch(/^t-fake-/u); expect(output.lastMessage).toContain('## 결과');
  expect((await readMeta(root, output.runId))?.status).toBe('ok');
  expect(await getTask(root, task.id)).toMatchObject({ delegate: 'codex', codexThread: output.threadId });
  expect((await readLedger(root)).filter(item => item.action === 'codex:task').map(item => item.status)).toEqual(['pre', 'ok']);
  expect((await listProcs(root))).toEqual([]); expect((await slotsStatus()).codex).toBeNull(); expect((await readState(root)).delegation).toBeUndefined();
  expect(await readFile(join(root, 'stdin.md'), 'utf8')).toContain('수용 기준 본문');
  expect(JSON.parse(await readFile(join(root, 'args.json'), 'utf8')).at(-1)).toBe('-');
  const done = (await tick(root)).emitted.find(item => item.kind === 'codex-done');
  expect(done).toMatchObject({ codexRunId: output.runId, codexStatus: 'ok' });
  expect(await buildPrompt(root, 'next', 'brain-run')).toContain(`fodh codex result ${output.runId}`);
  expect((await tick(root)).emitted).toEqual([]);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await main(['codex', 'status', output.runId], root);
  expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({ status: 'ok', alive: false, command: expect.any(Array) });
  await main(['codex', 'result', '../escape'], root); expect(process.exitCode).toBe(1);
}, 15000);
it('exit 1 → fail; 새 호출은 새 thread, --resume last는 기존 thread', async () => {
  const { root } = await setup(); vi.stubEnv('FAKE_CODEX_EXIT', '1');
  const first = await launch(root); await finished(root, first.runId);
  expect((await result(root, first.runId)).status).toBe('fail');
  vi.stubEnv('FAKE_CODEX_EXIT', '0');
  const second = await launch(root, 'T01', { resume: 'last' }); await finished(root, second.runId);
  expect((await result(root, second.runId)).threadId).toBe((await result(root, first.runId)).threadId);
  const third = await launch(root); await finished(root, third.runId);
  expect((await result(root, third.runId)).threadId).not.toBe((await result(root, second.runId)).threadId);
}, 15000);
it('진행 중 중복 거부·부분 result 및 status', async () => {
  const { root } = await setup(); vi.stubEnv('FAKE_CODEX_SLEEP_MS', '250');
  const run = await launch(root);
  await expect(launch(root)).rejects.toThrow(`이미 위임이 진행 중입니다: ${run.runId}`);
  expect((await result(root, run.runId)).status).toBe('running');
  expect(await status(root)).toMatchObject({ delegation: { runId: run.runId }, slots: { codex: { runId: run.runId } } });
  await finished(root, run.runId);
});
it.each(['review', 'research'] as const)('%s는 항상 read-only, 등록 cwd와 routeHint 허용', async kind => {
  const { root, task } = await setup(kind === 'review' ? 'REVIEW' : 'RESEARCH');
  await setTask(root, task.id, { category: 'design', codexThread: 'implementation-thread' });
  const worktree = await mkdtemp(join(tmpdir(), 'fodh-codex-wt-')); roots.push(worktree);
  await updateState(root, { worktrees: [{ taskId: task.id, path: worktree, branch: 'wt-T01', createdAt: new Date().toISOString() }] });
  const run: any = await startCodex(root, kind, { spec: 'spec.md', taskId: task.id, cwd: worktree }); pids.push(run.pid);
  expect(run).toMatchObject({ cwd: await realpath(worktree), sandbox: 'read-only', routeHint: 'claude' }); await finished(root, run.runId);
  expect((await getTask(root, task.id)).codexThread).toBe('implementation-thread');
});
it('결과 fallback·오류 필터·부분 JSONL·중복 file change', async () => {
  const { root } = await setup(); const run = await launch(root); await finished(root, run.runId);
  const dir = resultDir(root, run.runId); await rm(join(dir, 'last-message.md'));
  await writeFile(join(dir, 'events.jsonl'), [
    { type: 'item.completed', item: { type: 'agent_message', text: 'fallback' } },
    { type: 'item.completed', item: { type: 'error', message: 'real error' } },
    ...Array.from({ length: 2 }, () => ({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a' }] } })),
  ].map(value => JSON.stringify(value)).join('\n') + '\n{"partial":');
  expect(await result(root, run.runId)).toMatchObject({ lastMessage: 'fallback', changedFiles: ['a'], errors: ['real error'] });
});
it('timeout: fake와 stubborn 자손 그룹 잔존 0 (실제 ps 필요)', async () => {
  // Do not conditionally skip: this assertion must expose sandbox ps restrictions.
  await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']);
  const { root } = await setup(); const cfg = await configs.loadConfig(root); cfg.delegate.codex.timeoutMinutes = 0.015;
  vi.spyOn(configs, 'loadConfig').mockResolvedValue(cfg);
  vi.stubEnv('FAKE_CODEX_SLEEP_MS', '15000'); vi.stubEnv('FAKE_CODEX_DESCENDANT', '1');
  vi.stubEnv('FAKE_CODEX_DETACHED_CHILD', '1'); vi.stubEnv('FAKE_CODEX_DETACHED_FILE', join(root, 'detached.pid'));
  const run = await launch(root); const tool = await detachedPid(root); const meta = await finished(root, run.runId, 14000);
  expect(isProcessAlive(tool)).toBe(false);
  expect(meta).toMatchObject({ status: 'timeout' }); expect(meta.error).toBeUndefined();
  await delay(100); expect(groupAlive(run.pid)).toBe(false); expect((await slotsStatus()).codex).toBeNull();
}, 20000);
it('cancel: 시작 시각 대조·회수·cancelled 원장·delegation 해제 (실제 ps 필요)', async () => {
  await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']);
  const { root } = await setup(); vi.stubEnv('FAKE_CODEX_SLEEP_MS', '15000');
  vi.stubEnv('FAKE_CODEX_DETACHED_CHILD', '1'); vi.stubEnv('FAKE_CODEX_DETACHED_FILE', join(root, 'detached.pid'));
  const run = await launch(root); const tool = await detachedPid(root);
  expect(await cancel(root, run.runId)).toMatchObject({ status: 'cancelled' });
  expect(isProcessAlive(tool)).toBe(false);
  expect((await readState(root)).delegation).toBeUndefined(); expect((await slotsStatus()).codex).toBeNull();
  expect((await readLedger(root)).filter(item => item.action === 'codex:task')).toEqual([
    expect.objectContaining({ status: 'pre' }), expect.objectContaining({ status: 'fail', evidence: expect.objectContaining({ cancelled: true }) }),
  ]);
  expect(groupAlive(run.pid)).toBe(false);
}, 20000);

it('cancel은 시작 시각을 검증할 수 없으면 신호 없이 기존 위임을 보존한다', async () => {
  const { root } = await setup(); vi.stubEnv('FAKE_CODEX_SLEEP_MS', '300');
  const run = await launch(root);
  const identity = await import('../src/core/process-time.ts');
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue(undefined);
  await expect(cancel(root, run.runId)).rejects.toThrow('소유권');
  expect((await readState(root)).delegation?.runId).toBe(run.runId);
  expect((await slotsStatus()).codex?.runId).toBe(run.runId);
  await finished(root, run.runId);
});
it('task는 등록된 워크트리에서 실행하고 design도 routeHint만 반환한다', async () => {
  const { root, task } = await setup();
  const worktree = await mkdtemp(join(tmpdir(), 'fodh-task-wt-')); roots.push(worktree);
  await setTask(root, task.id, { worktree, category: 'design' });
  await expect(launch(root)).rejects.toThrow('등록된');
  await updateState(root, { worktrees: [{ taskId: task.id, path: worktree, branch: 'wt-T01', createdAt: new Date().toISOString() }] });
  const run = await launch(root); expect(run).toMatchObject({ cwd: await realpath(worktree), routeHint: 'claude', worktree: await realpath(worktree) });
  await finished(root, run.runId);
  expect(await result(root, run.runId)).toMatchObject({ routeHint: 'claude', worktree: await realpath(worktree) });
});
it('완료 task 및 프로젝트 밖 spec 심링크는 실행 전에 거부한다', async () => {
  const { root, task } = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'fodh-spec-outside-')); roots.push(outside);
  await writeFile(join(outside, 'spec.md'), 'outside'); await symlink(join(outside, 'spec.md'), join(root, 'linked.md'));
  await expect(launch(root, task.id, { spec: 'linked.md' })).rejects.toThrow('내부 상대 경로');
  await setTask(root, task.id, { status: 'done', verify: { ok: true }, review: { high: 0, commit: 'sha' }, merge: { commit: 'sha' }, docs: { ok: true }, cleanup: { ok: true } });
  await expect(launch(root)).rejects.toThrow('완료된 task');
});

async function detachedPid(root: string) {
  for (let i = 0; i < 100; i++) {
    const pid = Number(await readFile(join(root, 'detached.pid'), 'utf8').catch(() => ''));
    if (pid > 1) { detached.push(pid); return pid; }
    await delay(20);
  }
  throw new Error('fake detached tool did not start');
}
it('프로세스 트리는 순서 무관 자손 폐쇄·별도 pgid·명시적 루트를 찾고 자기/ps를 제외한다', () => {
  const output = ' 302 301 302\n301 200 301\n100 1 100\n200 100 100\n400 999 400\n401 400 401\n500 1 500\n900 100 100\n';
  expect(parseProcessTree(output, 100, [400], [100, 900])).toEqual([302, 301, 200, 400, 401]);
  expect(parseProcessTree('100 1 100\n900 100 100\n', 100, [], [100, 900])).toEqual([]);
});
it('wait 상한은 위임 시간+1, 두뇌 시간-5 중 작은 값이며 최소 두뇌 여유 1분이다', () => {
  expect(waitLimitMinutes(90, 45, 90)).toBe(40);
  expect(waitLimitMinutes(90, 45)).toBe(8);
  expect(waitLimitMinutes(90, 45, 2)).toBe(2);
  expect(waitLimitMinutes(2, 45)).toBe(3);
  expect(waitLimitMinutes(90, 5)).toBe(1);
});
it('wait 상한 오류는 runId를 돌려주고 진행 중 위임을 보존한다', async () => {
  const { root } = await setup();
  await updateState(root, { delegation: { runId: 'waiting', kind: 'task', startedAt: new Date().toISOString() } });
  // Jump only the observed wall clock; no supervisor or real minute-long wait needed.
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(6000000);
  await expect(waitForResult(root, 'waiting', 90)).rejects.toMatchObject({ message: '위임이 아직 진행 중입니다', details: { runId: 'waiting' } });
  expect((await readState(root)).delegation?.runId).toBe('waiting');
});
it('meta 없는 위임은 취소로 대기를 지우고 재시작 시 stale 원장을 남긴다', async () => {
  const { root } = await setup(); const delegation = { runId: 'missing', kind: 'task' as const, taskId: 'T01', startedAt: new Date().toISOString() };
  await updateState(root, { delegation, awaitingDelegation: true });
  expect(await cancel(root, 'missing')).toEqual({ runId: 'missing', cancelled: true, meta: null });
  expect(await readState(root)).toMatchObject({ awaitingDelegation: false });
  expect((await readState(root)).delegation).toBeUndefined();
  await expect(cancel(root, 'other')).rejects.toThrow('위임 실행을 찾을 수 없습니다');
  await updateState(root, { delegation }); const run = await launch(root); await finished(root, run.runId);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'delegation:stale', status: 'ok', evidence: { runId: 'missing' } }));
});
it('result는 모든 오류 이벤트를 redact·중복 제거하고 cwd 안 절대 경로를 정규화한다', async () => {
  const { root } = await setup();
  await writeMeta(root, { runId: 'parsed', kind: 'research', cwd: root, sandbox: 'read-only', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh', command: ['fake'], startedAt: new Date().toISOString(), timeoutMinutes: 90, state: 'RESEARCH', status: 'running' });
  await writeFile(join(resultDir(root, 'parsed'), 'events.jsonl'), [
    { type: 'error', message: 'top-level error' },
    { type: 'turn.failed', error: { message: 'top-level error' } },
    { type: 'turn.failed', error: { message: 'sk-ant-fake-credential' } },
    { type: 'error', message: 'unrecognized configuration settings: example' },
    { type: 'item.completed', item: { type: 'error', message: 'UNRECOGNIZED CONFIGURATION SETTINGS' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: join(root, 'src/a.ts') }, { path: 'src/a.ts' }, { path: '/outside/a.ts' }] } },
  ].map(value => JSON.stringify(value)).join('\n'));
  const parsed = await result(root, 'parsed');
  expect(parsed.changedFiles).toEqual(['src/a.ts', '/outside/a.ts']);
  expect(parsed.errors).toHaveLength(2); expect(parsed.errors[0]).toBe('top-level error');
  expect(JSON.stringify(parsed.errors)).not.toContain('fake-credential');
});
it.each(['watcher', 'cancel', 'cancel-without-registry', 'reclaim'] as const)('감독 SIGKILL 고아: 슬롯 유지 후 %s 회수 (실제 ps 필요)', async mode => {
  await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']);
  const { root } = await setup(); vi.stubEnv('FAKE_CODEX_SLEEP_MS', '15000');
  vi.stubEnv('FAKE_CODEX_DETACHED_CHILD', '1'); vi.stubEnv('FAKE_CODEX_DETACHED_FILE', join(root, 'detached.pid'));
  const run = await launch(root); const tool = await detachedPid(root);
  for (let i = 0; i < 100 && !(await readMeta(root, run.runId))?.childStartedAt; i++) await delay(20);
  const owner = (await slotsStatus()).codex!;
  expect(owner.childPid).toEqual(expect.any(Number)); expect(owner.childStartedAt).toEqual(expect.any(String));
  process.kill(run.pid, 'SIGKILL');
  for (let i = 0; i < 100 && isProcessAlive(run.pid); i++) await delay(20);
  expect(isProcessAlive(run.pid)).toBe(false); expect(groupAlive(run.pid)).toBe(true);
  expect(await slotOwnerAlive(owner)).toBe(true);
  expect((await acquireSlot('codex', { ...owner, runId: 'replacement' })).acquired).toBe(false);
  if (mode === 'watcher') await tick(root, { now: Date.now() + 61000 });
  else if (mode === 'reclaim') {
    const { item } = await addJudgment(root, { title: '회수', background: '', options: ['진행'], recommend: '', blocks: 'T01' });
    expect(await reclaimTask(root, 'T01', item.id)).toMatchObject({ reclaimed: true });
    expect((await readState(root)).delegation).toBeUndefined();
  } else {
    if (mode === 'cancel-without-registry') await removeProc(root, run.pid, run.runId);
    await cancel(root, run.runId);
  }
  expect(groupAlive(run.pid)).toBe(false); expect(isProcessAlive(tool)).toBe(false);
  expect((await readMeta(root, run.runId))?.status).toBe(mode === 'watcher' ? 'lost' : 'cancelled');
}, 20000);
it('reclaim은 matching meta 없는 delegation을 지우고 task를 blocked로 돌린다', async () => {
  const { root, task } = await setup();
  const { item } = await addJudgment(root, { title: '승인', background: '', options: ['진행'], recommend: '', blocks: task.id });
  await updateState(root, { delegation: { runId: 'missing', kind: 'task', taskId: task.id, startedAt: new Date().toISOString() }, awaitingDelegation: true });
  expect(await reclaimTask(root, task.id, item.id)).toMatchObject({ reclaimed: true, next: 'PICK' });
  expect((await readState(root)).delegation).toBeUndefined(); expect((await readState(root)).awaitingDelegation).toBe(false);
});

it('고아 그룹은 자식 신원·pgid를 확인하고 재사용 리더에는 신호를 보내지 않는다', async () => {
  const { root } = await setup(); const context = { root, runId: 'identity' };
  const owner = { pid: 99999999, pgid: 99999999, startedAt: '2026-09-24T00:00:00Z', childPid: 99999998, childStartedAt: '2026-09-24T00:00:01Z' };
  const alive = vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === owner.childPid);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  const observed = vi.spyOn(identity, 'processStartedAt').mockResolvedValue(owner.childStartedAt);
  vi.spyOn(identity, 'processGroup').mockResolvedValue(owner.pgid);
  const reap = vi.spyOn(tree, 'reclaimCodexTree').mockResolvedValue(true);
  expect(await codexReclaim.reclaimCodexOwner(owner, context)).toMatchObject({ reclaimed: true, owner: 'orphan' });
  expect(observed).not.toHaveBeenCalledWith(owner.pid); expect(reap).toHaveBeenCalledWith(owner.pgid, [], []);
  alive.mockReturnValue(true); observed.mockResolvedValue('2026-09-24T01:00:00Z');
  expect(await codexReclaim.reclaimCodexOwner(owner, context)).toEqual({ reclaimed: true, owner: 'foreign', reason: 'pid-reused', skippedGroups: [] });
  expect(reap).toHaveBeenCalledTimes(1);
});
it.each(['owned', 'foreign', 'unverified'] as const)('reclaim은 %s codex에 공용 회수를 쓰고 delegation·meta를 함께 마감한다', async owner => {
  const { root, task } = await setup(); const startedAt = new Date().toISOString();
  await writeMeta(root, { runId: 'reclaimed', kind: 'task', taskId: task.id, pid: 99999999, cwd: root, sandbox: 'workspace-write', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh', command: ['fake'], startedAt, timeoutMinutes: 90, state: 'IMPLEMENT', status: 'running' });
  await registerProc(root, { runId: 'reclaimed', kind: 'codex', taskId: task.id, pid: 99999999, pgid: 99999999, startedAt });
  await updateState(root, { delegation: { runId: 'reclaimed', kind: 'task', taskId: task.id, startedAt }, awaitingDelegation: true });
  const { item } = await addJudgment(root, { title: '승인', background: '', options: ['진행'], recommend: '', blocks: task.id });
  const reason = owner === 'foreign' ? 'pid-reused' : owner === 'unverified' ? 'group-unverified' : undefined;
  const reap = vi.spyOn(codexReclaim, 'reclaimCodexOwner').mockResolvedValue({ reclaimed: true, owner, reason, skippedGroups: [] });
  expect(await reclaimTask(root, task.id, item.id)).toMatchObject({ reclaimed: true });
  expect(reap).toHaveBeenCalledWith(expect.objectContaining({ pid: 99999999, pgid: 99999999 }), { root, runId: 'reclaimed' });
  expect(await readMeta(root, 'reclaimed')).toMatchObject({ status: owner === 'unverified' ? 'lost' : 'cancelled' });
  if (reason) expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ reason }) }));
  expect((await readState(root)).delegation).toBeUndefined(); expect((await readState(root)).awaitingDelegation).toBe(false);
});

it('죽은 PID는 재스냅샷 루트에서 제외하고 PGID 폐쇄는 고정점까지 찾는다', () => {
  const output = '501 1 500\n301 1 300\n300 200 300\n200 100 100\n500 301 500\n900 1 900\n901 900 901\n';
  expect(parseProcessTree(output, 100, [900], [], [900])).toEqual([501, 301, 300, 200, 500]);
  expect(parseProcessTree('900 1 900\n901 900 901\n', 0, [900], [], [900])).toEqual([]);
});
it.each(['foreign', 'unverified'] as const)('%s 소유권이면 cancel은 신호 없이 마감하고 대기를 해제한다', async scenario => {
  const { root } = await setup(); const startedAt = new Date().toISOString();
  await writeMeta(root, { runId: 'reused', kind: 'task', taskId: 'T01', pid: 99999999, processStartedAt: startedAt,
    childPid: 99999998, childStartedAt: startedAt, toolGroups: [{ pgid: 99999997, pid: 99999997, startedAt }], cwd: root, sandbox: 'workspace-write', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh', command: ['fake'], startedAt, timeoutMinutes: 90, state: 'IMPLEMENT', status: 'running' });
  await updateState(root, { delegation: { runId: 'reused', kind: 'task', startedAt }, awaitingDelegation: true });
  await acquireSlot('codex', { root, runId: 'reused', pid: 99999999, startedAt, acquiredAt: startedAt });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || (scenario === 'foreign' || pid === 99999998));
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue('2000-01-01T00:00:00Z');
  vi.spyOn(identity, 'processGroup').mockResolvedValue(99999997);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  const reap = vi.spyOn(tree, 'reclaimCodexTree');
  const expected = scenario === 'foreign' ? 'pid-reused' : 'group-unverified';
  expect(await cancel(root, 'reused')).toMatchObject({ status: scenario === 'foreign' ? 'cancelled' : 'lost' });
  expect(reap).not.toHaveBeenCalled(); expect((await readState(root)).delegation).toBeUndefined();
  expect((await slotsStatus()).codex).toBeNull();
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ reason: expected }) }));
});
it('정상 종료 뒤 남긴 background 도구 그룹을 표본에 기록하고 회수한다 (실제 ps 필요)', async () => {
  await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']);
  const { root } = await setup(); vi.stubEnv('FAKE_CODEX_BACKGROUND_TOOL', '1');
  vi.stubEnv('FAKE_CODEX_DETACHED_FILE', join(root, 'detached.pid'));
  const run = await launch(root); const tool = await detachedPid(root);
  const meta = await finished(root, run.runId, 41000);
  expect(meta).toMatchObject({ status: 'ok', exit: 0 }); expect(meta.error).toBeUndefined();
  expect(meta.toolGroups).toContainEqual({ pgid: tool, pid: tool, startedAt: expect.any(String) }); expect(meta.childPid).toEqual(expect.any(Number));
  expect(meta.childStartedAt).toEqual(expect.any(String)); expect(isProcessAlive(tool)).toBe(false);
}, 45000);

it.each(['start', 'group'] as const)('자식 %s ps 조회 실패 시 cancel은 throw하고 실행·슬롯·위임을 보존한다', async failed => {
  const { root } = await setup(); const startedAt = new Date().toISOString();
  await writeMeta(root, { runId: 'unknown-child', kind: 'task', taskId: 'T01', pid: 99999999, processStartedAt: startedAt,
    childPid: 99999998, childStartedAt: startedAt, cwd: root, sandbox: 'workspace-write', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh', command: ['fake'], startedAt, timeoutMinutes: 90, state: 'IMPLEMENT', status: 'running' });
  await registerProc(root, { pid: 99999999, pgid: 99999999, runId: 'unknown-child', kind: 'codex', startedAt });
  await updateState(root, { delegation: { runId: 'unknown-child', kind: 'task', startedAt }, awaitingDelegation: true });
  await acquireSlot('codex', { root, runId: 'unknown-child', pid: 99999999, startedAt, acquiredAt: startedAt });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || pid === 99999998);
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue(failed === 'start' ? undefined : startedAt);
  vi.spyOn(identity, 'processGroup').mockResolvedValue(failed === 'group' ? undefined : 99999999);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  const reap = vi.spyOn(tree, 'reclaimCodexTree');
  await expect(cancel(root, 'unknown-child')).rejects.toThrow('소유권');
  expect(reap).not.toHaveBeenCalled();
  expect(await readMeta(root, 'unknown-child')).toMatchObject({ status: 'running' });
  expect((await readState(root)).delegation?.runId).toBe('unknown-child');
  expect((await slotsStatus()).codex?.runId).toBe('unknown-child');
  expect(await listProcs(root)).toHaveLength(1);
});

it.each(['available', 'unavailable', 'already-real'] as const)('감독 시작 시 spawn 신원을 meta·procs·슬롯에 갱신한다: %s (fake-codex)', async scenario => {
  const { root } = await setup(); const runId = 'spawn-identity', startedAt = new Date().toISOString();
  const observed = new Date().toUTCString(), initial = scenario === 'already-real' ? observed : `spawn:${startedAt}`;
  await writeMeta(root, { runId, kind: 'research', pid: process.pid, processStartedAt: initial, cwd: root,
    sandbox: 'read-only', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh',
    command: [process.execPath, resolve('test/fake-codex/codex'), 'exec', '--json', '-'], startedAt, timeoutMinutes: 90, state: 'RESEARCH', status: 'running' });
  await writeFile(join(resultDir(root, runId), 'prompt.md'), 'fake supervisor identity');
  await registerProc(root, { runId, pid: process.pid, pgid: process.pid, startedAt: initial, kind: 'codex' });
  await acquireSlot('codex', { root, runId, pid: process.pid, startedAt: initial, acquiredAt: startedAt });
  vi.stubEnv('FAKE_CODEX_SLEEP_MS', '300');
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue(scenario === 'unavailable' ? undefined : observed);
  vi.spyOn(identity, 'processGroup').mockResolvedValue(process.pid);
  vi.spyOn(tree, 'processTreeSnapshot').mockResolvedValue({ pids: [], toolGroups: [] });
  vi.spyOn(tree, 'processTree').mockResolvedValue([]);
  const running = supervise(root, runId);
  try {
    await vi.waitFor(async () => expect((await readMeta(root, runId))?.childPid).toEqual(expect.any(Number)));
    const expected = scenario === 'unavailable' ? initial : observed;
    expect(await readMeta(root, runId)).toMatchObject({ status: 'running', processStartedAt: expected });
    expect(await listProcs(root)).toContainEqual(expect.objectContaining({ pid: process.pid, runId, startedAt: expected }));
    expect((await slotsStatus()).codex).toMatchObject({ runId, startedAt: expected });
  } finally { await running; }
  expect(await readMeta(root, runId)).toMatchObject({ status: 'ok', exit: 0 });
});
