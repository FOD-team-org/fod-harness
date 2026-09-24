import * as procTree from '../src/core/proc-tree.ts';
import * as identity from '../src/core/process-time.ts';
import * as lock from '../src/core/lock.ts';
import { result } from '../src/core/codex-record.ts';
import * as runner from '../src/provider/runner.ts';
import * as codexReclaim from '../src/core/codex-reclaim.ts';
import { readLedger } from '../src/core/ledger.ts';
import { updateState, readState } from '../src/core/state.ts';
import { writeMeta, readMeta, type CodexMeta } from '../src/core/codex-record.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick, detectRecovery, watcherStatus } from '../src/core/watcher.ts';
import { addInboxOnce, ackInbox, deliverInbox, listInbox } from '../src/core/inbox.ts';
import { addJudgment, answerJudgment } from '../src/core/judgment.ts';
import { loadConfig, getConfig, setConfig } from '../src/core/config.ts';
import { registerProc, listProcs } from '../src/core/procs.ts';
import { atomicWrite, harnessPath, readJson } from '../src/core/storage.ts';
import { activeStates } from '../src/core/state.ts';
import { main } from '../src/cli/index.ts';
const roots: string[] = [];
const now = Date.parse('2026-09-24T00:00:00Z');
const iso = (value: number) => new Date(value).toISOString();
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-watcher-')); roots.push(root); vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  const { item } = await addJudgment(root, { title: '방식', background: '', options: ['진행', '보류'], recommend: '', blocks: '' });
  const path = join(root, 'docs/판단대기.md');
  const text = await readFile(path, 'utf8');
  await tick(root, { now });
  return { root, item, path, text };
}
it('변경 후 안정화 경계·queued·해시·바이트 크기와 기존 판단 메타데이터 보존', async () => {
  const t = await setup(); const before = await readJson<any>(harnessPath(t.root, 'harness-watcher.json'), {});
  await writeFile(t.path, t.text.replace('- 답:', '- 답: 1'));
  expect((await tick(t.root, { now: now + 1000 })).emitted).toEqual([]);
  expect((await tick(t.root, { now: now + 10999 })).emitted).toEqual([]);
  const result = await tick(t.root, { now: now + 11000 });
  expect(result.emitted).toHaveLength(1);
  expect(result.emitted[0]).toMatchObject({ kind: 'judgment-changed', status: 'queued', path: t.path,
    hashBefore: before.judgment.expectedHash, size: Buffer.byteLength(await readFile(t.path, 'utf8')) });
  expect(result.status.judgment.stableFor).toBe(10);
  expect(result.status.judgment.observedHash).toBe(String(result.emitted[0].hashAfter).slice(0, 12));
  expect((await readJson<any>(harnessPath(t.root, 'harness-watcher.json'), {})).judgment).toEqual(before.judgment);
});
it('기대 해시 자기 수정·같은 해시 재저장·되돌리기는 기존 미적용 인박스를 취소하지 않는다', async () => {
  const t = await setup();
  await answerJudgment(t.root, t.item.id, '1');
  expect((await tick(t.root, { now: now + 100000 })).emitted).toEqual([]);
  const selfText = await readFile(t.path, 'utf8');
  await writeFile(t.path, selfText + '\n외부 변경\n');
  await tick(t.root, { now: now + 101000 });
  const { emitted } = await tick(t.root, { now: now + 111000 });
  expect(emitted).toHaveLength(1);
  await writeFile(t.path, selfText + '\n외부 변경\n');
  expect((await tick(t.root, { now: now + 200000 })).emitted).toEqual([]);
  await writeFile(t.path, selfText); await tick(t.root, { now: now + 201000 });
  expect(await listInbox(t.root)).toEqual(emitted);
  await writeFile(t.path, selfText + '\n외부 변경\n'); await tick(t.root, { now: now + 202000 });
  expect((await tick(t.root, { now: now + 212000 })).emitted).toEqual([]);
  expect(await listInbox(t.root)).toEqual(emitted);
});
it('ENOENT는 관측 null·무발행, 다시 생성하면 안정화부터 시작한다', async () => {
  const t = await setup(); await rm(t.path);
  const missing = await tick(t.root, { now: now + 1000 });
  expect(missing.emitted).toEqual([]); expect(missing.status.judgment.observedHash).toBeNull();
  await writeFile(t.path, '다시 생성');
  expect((await tick(t.root, { now: now + 20000 })).emitted).toEqual([]);
  expect((await tick(t.root, { now: now + 30000 })).emitted).toHaveLength(1);
});
it('설정 경로를 매 tick 재해석하고 시계·해시를 주입한다', async () => {
  const t = await setup(); await setConfig(t.root, 'judgment.file', 'docs/새판단.md');
  const path = join(t.root, 'docs/새판단.md'); await writeFile(path, '새 문서');
  await tick(t.root, { now: () => now, hash: () => 'test-hash' });
  expect((await tick(t.root, { now: () => now + 10000, hash: () => 'test-hash' })).emitted[0]).toMatchObject({ path, hashAfter: 'test-hash' });
});
it.each([...activeStates].filter(state => state !== 'recovering'))('%s 활동 상태는 heartbeat 최댓값 이후 한계 초과에서만 감지한다', async state => {
  const t = await setup();
  await atomicWrite(harnessPath(t.root, 'harness-state.json'), JSON.stringify({ state, runId: 'r1',
    enteredAt: iso(now - 1200000), lastEventAt: iso(now - 900000), savedAt: iso(now - 600000) }));
  expect((await tick(t.root, { now })).emitted).toEqual([]);
  expect((await tick(t.root, { now: now + 1 })).emitted[0]).toMatchObject({ kind: 'stalled', state, runId: 'r1' });
});
it.each(['IDLE', 'PROJECT_READY', 'DONE_ALL', 'WAIT_JUDGMENT', 'WAIT_RETRY', 'WAIT_RESOURCE', 'paused(error)', 'recovering'])('%s 정지 상태는 stalled 미발행', async state => {
  const t = await setup(); await atomicWrite(harnessPath(t.root, 'harness-state.json'), JSON.stringify({ state, savedAt: iso(now - 3600000) }));
  expect((await tick(t.root, { now })).emitted).toEqual([]);
});
it('awaitingUser·지속 중복 방지·runId/상태 변경·runId 없는 재진입', async () => {
  const t = await setup(); const path = harnessPath(t.root, 'harness-state.json');
  const state = { state: 'INTERVIEW', savedAt: iso(now - 3600000), enteredAt: iso(now - 3600000), runId: 'r1', awaitingUser: true };
  await atomicWrite(path, JSON.stringify(state)); expect((await tick(t.root, { now })).emitted).toEqual([]);
  state.awaitingUser = false; await atomicWrite(path, JSON.stringify(state));
  const first = (await tick(t.root, { now })).emitted; expect(first).toHaveLength(1);
  await deliverInbox(t.root, first.map(r => r.id), 'delivery'); await ackInbox(t.root, first.map(r => r.id), 'delivery');
  expect((await tick(t.root, { now: now + 1000 })).emitted).toEqual([]);
  for (const patch of [{ runId: 'r2' }, { state: 'RESEARCH' }, { runId: undefined }, { enteredAt: iso(now - 4000000) }]) {
    Object.assign(state, patch); await atomicWrite(path, JSON.stringify(state)); expect((await tick(t.root, { now })).emitted).toHaveLength(1);
  }
});
it('brain/자식 한계·gone·종류별 중복·PID 재사용·레지스트리 보존', async () => {
  const t = await setup(); await setConfig(t.root, 'watch.childTimeoutMinutes', '30'); const startedAt = iso(now - 31 * 60000);
  for (const [pid, kind] of [[201, 'brain'], [202, 'codex'], [203, 'worker']] as const) {
    await registerProc(t.root, { pid, pgid: pid, startedAt, runId: `r${pid}`, kind });
  }
  const alive = (pid: number) => pid !== 203;
  const original = await listProcs(t.root);
  const first = await tick(t.root, { now, isProcessAlive: alive });
  expect(first.emitted.map(r => r.kind)).toEqual(['child-timeout', 'child-gone']);
  expect(first.emitted[0]).toMatchObject({ pid: 202, procKind: 'codex', minutes: 31 });
  expect(first.status.childTimeouts).toBe(1);
  expect((await tick(t.root, { now: now + 14 * 60000, isProcessAlive: alive })).emitted).toEqual([]);
  expect((await tick(t.root, { now: now + 14 * 60000 + 1, isProcessAlive: alive })).emitted[0]).toMatchObject({ pid: 201, kind: 'child-timeout' });
  expect((await tick(t.root, { now, isProcessAlive: () => false })).emitted.map(r => r.pid)).toEqual([201, 202]);
  expect(await listProcs(t.root)).toEqual(original);
  await atomicWrite(harnessPath(t.root, 'harness-procs.json'), JSON.stringify([{ ...original[1], startedAt: iso(now - 32 * 60000) }]));
  expect((await tick(t.root, { now, isProcessAlive: () => true })).emitted).toHaveLength(1);
});
it('judgmentOnly 폴링은 두뇌·자식 감지를 전체 tick에 남긴다', async () => {
  const t = await setup(); await registerProc(t.root, { pid: 201, pgid: 201, startedAt: iso(now - 3600000), runId: 'r', kind: 'brain' });
  const alive = vi.fn(() => false);
  expect((await tick(t.root, { now, judgmentOnly: true, isProcessAlive: alive })).emitted).toEqual([]);
  expect(alive).not.toHaveBeenCalled(); expect((await tick(t.root, { now, isProcessAlive: alive })).emitted).toHaveLength(1);
});
it('인박스는 미적용 dedupeKey만 재사용하고 applied 이후 신규 생성한다', async () => {
  const t = await setup();
  const a = await addInboxOnce(t.root, { kind: 'test', dedupeKey: 'same' });
  expect(a.created).toBe(true);
  const b = await addInboxOnce(t.root, { kind: 'test', dedupeKey: 'same' }); expect(b).toEqual({ record: a.record, created: false });
  await deliverInbox(t.root, [a.record.id], 'r'); await ackInbox(t.root, [a.record.id], 'r');
  const c = await addInboxOnce(t.root, { kind: 'test', dedupeKey: 'same' }); expect(c.created).toBe(true); expect(c.record.id).not.toBe(a.record.id);
});
it.each(['IDLE', 'PROJECT_READY', 'DONE_ALL', 'INTERVIEW', 'recovering', 'paused(error)', 'WAIT_JUDGMENT'])('%s 복구 대상과 세션 dedupe', async state => {
  const t = await setup(); await atomicWrite(harnessPath(t.root, 'harness-state.json'), JSON.stringify({ state, taskId: 'T01', savedAt: iso(now), resumeState: 'SPEC' }));
  const records = await detectRecovery(t.root, 'session');
  if (['IDLE', 'PROJECT_READY', 'DONE_ALL'].includes(state)) expect(records).toEqual([]);
  else {
    expect(records[0]).toMatchObject({ kind: 'recover', status: 'queued', state, task: 'T01', savedAt: iso(now), resumeState: 'SPEC' });
    expect(await detectRecovery(t.root, 'session')).toEqual([]);
    expect(await detectRecovery(t.root, 'next-session')).toHaveLength(1);
  }
});
it.each([
  ['stallMinutes', 0, '양의 정수'], ['stallMinutes', 1.5, '양의 정수'], ['childTimeoutMinutes', -1, '양의 정수'],
  ['childTimeoutMinutes', '3', '양의 정수'], ['pollSeconds', 0, '양수'], ['stableSeconds', null, '양수'], ['tickSeconds', Infinity, '양수'],
])('watch.%s 설정 검증', async (key, value, expected) => {
  await expect(loadConfig('/unused', { watch: { [key]: value } })).rejects.toThrow(`watch.${key}는 ${expected}여야 합니다`);
});
it('watch 기본값과 CLI tick/status/config get 출력', async () => {
  const t = await setup(); const defaults = { stallMinutes: 10, childTimeoutMinutes: 90, pollSeconds: 5, stableSeconds: 10, freeTextStableSeconds: 60, tickSeconds: 30 };
  expect(await getConfig(t.root, 'watch')).toEqual(defaults);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await main(['config', 'get', 'watch'], t.root); expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(defaults);
  await main(['watch', 'tick'], t.root); expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ emitted: [], status: { childTimeouts: 0 } });
  await main(['watch', 'status'], t.root); const status = JSON.parse(String(output.mock.calls.at(-1)![0]));
  expect(status.judgment.observedHash).toHaveLength(12); expect(status.lastTickAt).toBe((await watcherStatus(t.root)).lastTickAt);
  await main(['watch', 'tick', 'extra'], t.root); expect(JSON.parse(String(output.mock.calls.at(-1)![0])).error).toContain('인자 수');
});
it('동시 tick도 같은 해시 이벤트는 하나만 발행한다', async () => {
  const t = await setup(); await writeFile(t.path, '외부 문서'); await tick(t.root, { now });
  const results = await Promise.all([tick(t.root, { now: now + 10000 }), tick(t.root, { now: now + 10000 })]);
  expect(results.flatMap(result => result.emitted)).toHaveLength(1); expect(await listInbox(t.root)).toHaveLength(1);
});
it('ps 제한 fallback spawn 시각도 시간 초과 계산에 사용한다', async () => {
  const t = await setup(); await registerProc(t.root, { pid: 201, pgid: 201, runId: 'r', kind: 'brain', startedAt: `spawn:${iso(now - 46 * 60000)}` });
  expect((await tick(t.root, { now, isProcessAlive: () => true })).emitted[0]).toMatchObject({ kind: 'child-timeout', minutes: 46 });
});
it('recover는 applied 이후에도 같은 세션에서 두 번 기록하지 않는다', async () => {
  const t = await setup(); await atomicWrite(harnessPath(t.root, 'harness-state.json'), JSON.stringify({ state: 'INTERVIEW' }));
  const records = await detectRecovery(t.root, 's'); await deliverInbox(t.root, records.map(r => r.id), 'r');
  await ackInbox(t.root, records.map(r => r.id), 'r'); expect(await detectRecovery(t.root, 's')).toEqual([]);
});

async function codexFixture(root: string, runId: string, patch: Partial<CodexMeta> = {}) {
  await writeMeta(root, { runId, kind: 'research', cwd: root, sandbox: 'read-only', model: 'fake', effort: 'xhigh', workerModel: 'fake', workerEffort: 'xhigh', command: ['fake'], startedAt: iso(now), timeoutMinutes: 90, state: 'RESEARCH', status: 'running', ...patch });
}
it('P3 codex-done 완료 감지·ack/delivery 이후에도 중복 없음·최근 50개', async () => {
  const { root } = await setup();
  for (let i = 0; i < 52; i++) await codexFixture(root, `done-${i}`, { finishedAt: iso(now), status: 'ok', exit: 0, threadId: 'thread' });
  const emitted = (await tick(root, { now })).emitted; expect(emitted).toHaveLength(52);
  expect(emitted[0]).toMatchObject({ kind: 'codex-done', codexStatus: 'ok', threadId: 'thread', status: 'queued' });
  await deliverInbox(root, emitted.map(item => item.id), 'brain'); await ackInbox(root, emitted.map(item => item.id), 'brain');
  expect((await tick(root, { now: now + 1000 })).emitted).toEqual([]);
  expect((await readJson<any>(harnessPath(root, 'harness-watcher.json'), {})).watch.codexEmitted).toHaveLength(50);
});
it('P3 lost는 60초 경계 이후 죽은 감독만 마감하고 위임 중 stalled 제외', async () => {
  const { root } = await setup();
  await codexFixture(root, 'lost');
  await atomicWrite(harnessPath(root, 'harness-state.json'), JSON.stringify({ state: 'RESEARCH', savedAt: iso(now - 3600000), delegation: { runId: 'lost', kind: 'research', startedAt: iso(now) } }));
  expect((await tick(root, { now: now + 59999 })).emitted).toEqual([]);
  const completed = (await tick(root, { now: now + 60000 })).emitted;
  expect(completed).toHaveLength(1); expect(completed[0]).toMatchObject({ kind: 'codex-done', codexStatus: 'lost' });
  expect((await readMeta(root, 'lost'))?.status).toBe('lost');
  expect((await tick(root, { now: now + 3600000 })).emitted).toEqual([]);
});
it('P3 살아 있는 감독 및 judgmentOnly는 lost를 만들지 않는다', async () => {
  const { root } = await setup(); await codexFixture(root, 'alive');
  await registerProc(root, { pid: 202, pgid: 202, kind: 'codex', runId: 'alive', startedAt: iso(now) });
  const startedAt = vi.spyOn(identity, 'processStartedAt').mockResolvedValue(iso(now));
  expect((await tick(root, { now: now + 60001, isProcessAlive: () => true })).emitted).toEqual([]);
  expect(startedAt).toHaveBeenCalledWith(202);
  expect((await tick(root, { now: now + 60001, judgmentOnly: true, isProcessAlive: () => false })).emitted).toEqual([]);
  expect((await readMeta(root, 'alive'))?.status).toBe('running');
});

it('meta 없는 delegation은 60초 후 resultDir 없는 lost를 한 번 발행한다', async () => {
  const { root } = await setup();
  await updateState(root, { delegation: { runId: 'no-meta', kind: 'research', startedAt: iso(now) }, awaitingDelegation: true });
  expect((await tick(root, { now: now + 59999 })).emitted).toEqual([]);
  const events = (await tick(root, { now: now + 60000 })).emitted;
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ kind: 'codex-done', codexRunId: 'no-meta', codexStatus: 'lost' });
  expect(events[0]).not.toHaveProperty('resultDir');
  await deliverInbox(root, events.map(item => item.id), 'brain'); await ackInbox(root, events.map(item => item.id), 'brain');
  expect((await tick(root, { now: now + 60001 })).emitted).toEqual([]);
});
it('죽은 감독 그룹 회수 실패는 첫 기록 후 10분 간격, 성공한 다음 tick에서만 lost', async () => {
  const { root } = await setup(); await codexFixture(root, 'orphan', { pid: 99999999 });
  await updateState(root, { delegation: { runId: 'orphan', kind: 'research', startedAt: iso(now) } });
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  const reap = vi.spyOn(codexReclaim, 'reclaimCodexOwner').mockResolvedValue({ reclaimed: false, owner: 'orphan', skippedGroups: [] });
  for (const time of [60000, 61000, 62000]) {
    expect((await tick(root, { now: now + time, isProcessAlive: () => false })).emitted).toEqual([]);
    expect((await readMeta(root, 'orphan'))?.status).toBe('running');
  }
  const failures = (await readLedger(root)).filter(item => item.action === 'codex:lost');
  expect(failures).toHaveLength(1); expect(failures[0]).toMatchObject({ status: 'fail', evidence: { reason: 'group-alive' } });
  expect((await readJson<any>(harnessPath(root, 'harness-watcher.json'), {})).watch).not.toHaveProperty('codexLostFailed');
  await tick(root, { now: now + 659999, isProcessAlive: () => false });
  expect((await readLedger(root)).filter(item => item.action === 'codex:lost')).toHaveLength(1);
  await tick(root, { now: now + 660000, isProcessAlive: () => false });
  expect((await readLedger(root)).filter(item => item.action === 'codex:lost')).toHaveLength(2);
  reap.mockResolvedValue({ reclaimed: true, owner: 'orphan', skippedGroups: [] });
  // A completion event cannot turn a run into ok when a live orphan tree had to be reclaimed.
  await writeFile(join(root, '.pi/codex/orphan/events.jsonl'), '{"type":"turn.completed"}\n');
  expect((await tick(root, { now: now + 661000, isProcessAlive: () => false })).emitted[0]).toMatchObject({ codexStatus: 'lost' });
});
it('감독·그룹 부재와 turn.completed 증거는 supervisorLost ok로 복구한다', async () => {
  const { root } = await setup(); await codexFixture(root, 'completed', { pid: 99999999 });
  vi.spyOn(runner, 'groupAlive').mockReturnValue(false);
  vi.spyOn(procTree, 'processTree').mockResolvedValue([]);
  await writeFile(join(root, '.pi/codex/completed/events.jsonl'), '{"type":"turn.completed","usage":{"output_tokens":1}}\n');
  expect((await tick(root, { now: now + 60000, isProcessAlive: () => false })).emitted[0]).toMatchObject({ codexStatus: 'ok', exit: null, supervisorLost: true });
  expect(await result(root, 'completed')).toMatchObject({ supervisorLost: true });
  expect(await readMeta(root, 'completed')).toMatchObject({ status: 'ok', exit: null, supervisorLost: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'codex:research', status: 'ok', evidence: expect.objectContaining({ supervisorLost: true }) }));
});
it('codex child-timeout은 해당 meta의 timeout+5 경계를 쓰고 meta 없으면 기본값을 쓴다', async () => {
  const { root } = await setup(); await codexFixture(root, 'custom', { timeoutMinutes: 120 });
  await registerProc(root, { pid: 301, pgid: 301, runId: 'custom', kind: 'codex', startedAt: iso(now) });
  await registerProc(root, { pid: 302, pgid: 302, runId: 'no-meta', kind: 'codex', startedAt: iso(now) });
  const startedAt = vi.spyOn(identity, 'processStartedAt').mockResolvedValue(iso(now));
  const alive = () => true;
  expect((await tick(root, { now: now + 90 * 60000, isProcessAlive: alive })).emitted).toEqual([]);
  expect(startedAt).toHaveBeenCalledWith(301);
  expect((await tick(root, { now: now + 90 * 60000 + 1, isProcessAlive: alive })).emitted.map(item => item.pid)).toEqual([302]);
  expect((await tick(root, { now: now + 125 * 60000, isProcessAlive: alive })).emitted).toEqual([]);
  expect((await tick(root, { now: now + 125 * 60000 + 1, isProcessAlive: alive })).emitted.map(item => item.pid)).toEqual([301]);
});

it('그룹이 없으면 죽은 pid 트리를 조회하지 않고 완료 증거로 복구한다', async () => {
  const { root } = await setup(); await codexFixture(root, 'unverified', { pid: 99999999 });
  vi.spyOn(runner, 'groupAlive').mockReturnValue(false);
  const tree = vi.spyOn(procTree, 'processTree').mockRejectedValue(new Error('must not query dead leader'));
  const snapshot = vi.spyOn(procTree, 'processTreeSnapshot').mockRejectedValue(new Error('must not query dead leader'));
  await writeFile(join(root, '.pi/codex/unverified/events.jsonl'), '{"type":"turn.completed"}\n');
  expect((await tick(root, { now: now + 60000, isProcessAlive: () => false })).emitted[0]).toMatchObject({ codexStatus: 'ok', supervisorLost: true });
  expect(tree).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
});
it.each(['foreign', 'unverified'] as const)('%s 감독은 워처가 신호 없이 lost로 마감하고 이유를 기록한다', async scenario => {
  const { root } = await setup(); await codexFixture(root, 'identity', { pid: 99999999, processStartedAt: iso(now), childPid: 99999998, childStartedAt: iso(now), toolGroups: [{ pgid: 99999997, pid: 99999997, startedAt: iso(now) }] });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || scenario === 'foreign' || pid === 99999998);
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue(iso(now - 3600000));
  vi.spyOn(identity, 'processGroup').mockResolvedValue(99999997);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  const reap = vi.spyOn(procTree, 'reclaimCodexTree');
  expect((await tick(root, { now: now + 60000 })).emitted[0]).toMatchObject({ codexStatus: 'lost' });
  expect(reap).not.toHaveBeenCalled();
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ reason: scenario === 'foreign' ? 'pid-reused' : 'group-unverified' }) }));
});
it.each(['legacy', 'matching', 'mismatch'] as const)('감독 그룹 부재 시 %s 도구 그룹은 신원을 확인한 경우만 회수한다', async scenario => {
  const { root } = await setup(); await codexFixture(root, 'tools', { pid: 99999999, toolGroups: scenario === 'legacy' ? [99999998] : [{ pgid: 99999998, pid: 99999997, startedAt: iso(now) }] });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || pid === 99999997);
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue(iso(scenario === 'mismatch' ? now - 3600000 : now));
  vi.spyOn(identity, 'processGroup').mockResolvedValue(99999998);
  vi.spyOn(runner, 'groupAlive').mockImplementation(pgid => pgid === 99999998);
  const reap = vi.spyOn(procTree, 'reclaimCodexTree').mockResolvedValue(true);
  await writeFile(join(root, '.pi/codex/tools/events.jsonl'), '{"type":"turn.completed"}\n');
  expect((await tick(root, { now: now + 60000 })).emitted[0]).toMatchObject({ codexStatus: 'ok', supervisorLost: true });
  if (scenario === 'matching') expect(reap).toHaveBeenCalledWith(0, [], [99999998]);
  else {
    expect(reap).not.toHaveBeenCalled();
    expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: { reason: 'tool-group-unverified', skippedGroups: [99999998] } }));
  }
});

it.each(['start', 'group'] as const)('자식 %s ps 조회 실패 시 워처는 회수·lost 없이 보존한다', async failed => {
  const { root } = await setup();
  await codexFixture(root, 'unknown-child', { pid: 99999999, processStartedAt: iso(now), childPid: 99999998, childStartedAt: iso(now) });
  await updateState(root, { delegation: { runId: 'unknown-child', kind: 'research', startedAt: iso(now) }, awaitingDelegation: true });
  vi.spyOn(lock, 'isProcessAlive').mockImplementation(pid => pid === process.pid || pid === 99999998);
  vi.spyOn(runner, 'groupAlive').mockReturnValue(true);
  vi.spyOn(identity, 'processStartedAt').mockResolvedValue(failed === 'start' ? undefined : iso(now));
  vi.spyOn(identity, 'processGroup').mockResolvedValue(failed === 'group' ? undefined : 99999999);
  const reap = vi.spyOn(codexReclaim, 'reclaimCodexOwner');
  expect((await tick(root, { now: now + 60000 })).emitted).toEqual([]);
  expect(reap).not.toHaveBeenCalled();
  expect(await readMeta(root, 'unknown-child')).toMatchObject({ status: 'running' });
  expect((await readState(root)).delegation?.runId).toBe('unknown-child');
  expect(await readLedger(root)).not.toContainEqual(expect.objectContaining({ action: 'codex:lost' }));
});
