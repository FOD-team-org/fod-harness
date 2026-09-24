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
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-watcher-')); roots.push(root);
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
  const t = await setup(); const startedAt = iso(now - 31 * 60000);
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
  const t = await setup(); const defaults = { stallMinutes: 10, childTimeoutMinutes: 30, pollSeconds: 5, stableSeconds: 10, freeTextStableSeconds: 60, tickSeconds: 30 };
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
