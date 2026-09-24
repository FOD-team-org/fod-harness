import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as judgments from '../src/core/judgment.ts';
import * as storage from '../src/core/storage.ts';
import { addJudgment, readJudgment, answerJudgment, applyJudgments, writeJudgmentStatus, JudgmentConflict } from '../src/core/judgment.ts';
import { tick, pendingDecisions, recordDecision, watcherStatus } from '../src/core/watcher.ts';
import { readState, updateState } from '../src/core/state.ts';
import { addInbox, listInbox, resolveInbox, deliverInbox, ackInbox } from '../src/core/inbox.ts';
import { registerProc } from '../src/core/procs.ts';
import { readLedger } from '../src/core/ledger.ts';
import { loadConfig } from '../src/core/config.ts';
import watcherExtension from '../extensions/watcher/index.ts';
import orchestrator, { decideInbox, clearDecisionTimers } from '../extensions/orchestrator/index.ts';
import { autoResume } from '../extensions/orchestrator/resume.ts';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});
const roots: string[] = [];
const question = { title: '방식', background: '', options: ['웹', '앱'], recommend: '', blocks: '' };
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) { clearDecisionTimers(root); await rm(root, { recursive: true, force: true }); }
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fodh-p2-revision-')); roots.push(root);
  const { item } = await addJudgment(root, question);
  const path = join(root, 'docs/판단대기.md'), metadata = storage.harnessPath(root, 'harness-watcher.json');
  const ctx = { cwd: root, hasUI: true, isIdle: vi.fn(() => true), ui: { notify: vi.fn() } };
  const commands = new Map<string, any>(), handlers = new Map<string, any>();
  const pi = { sendMessage: vi.fn(), on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command) } as unknown as ExtensionAPI;
  orchestrator(pi);
  return { root, path, metadata, item, ctx, pi, commands, handlers,
    decide: (records: Awaited<ReturnType<typeof listInbox>>, options = {}) => decideInbox(pi, ctx as any, root, records, options) };
}
it('H1: 외부 답 관측→다른 판단 추가가 답을 흡수해도 20초 뒤 한 건 발행', async () => {
  const t = await setup(); const now = Date.now(); await tick(t.root, { now });
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('- 답:', '- 답: 1'));
  await tick(t.root, { now: now + 2000 });
  await addJudgment(t.root, { ...question, title: '다른 판단' });
  const before = await storage.readJson<any>(t.metadata, {});
  expect(before.judgment.externalPending).toMatchObject({ hash: expect.any(String), at: new Date(now + 2000).toISOString() });
  const result = await tick(t.root, { now: now + 20000 });
  expect(result.emitted).toHaveLength(1);
  expect(result.emitted[0]).toMatchObject({ kind: 'judgment-changed', hashAfter: before.judgment.expectedHash, external: before.judgment.externalPending.hash });
  expect((await readJudgment(t.root, { answered: true })).items[0]).toMatchObject({ id: 'A1', classification: { applicable: true } });
  expect((await storage.readJson<any>(t.metadata, {})).judgment.externalPending).toBeUndefined();
  expect((await tick(t.root, { now: now + 30000 })).emitted).toEqual([]);
});
it('H1: readJudgment 무변경 읽기는 외부 답과 기대 해시를 다시 쓰지 않는다', async () => {
  const t = await setup(); const before = await readFile(t.metadata, 'utf8');
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('- 답:', '- 답: 1'));
  const document = await readFile(t.path, 'utf8'); await readJudgment(t.root, { answered: true });
  expect(await readFile(t.path, 'utf8')).toBe(document); expect(await readFile(t.metadata, 'utf8')).toBe(before);
});
it.each(['add', 'answer', 'status'])('M4: %s 저장 직전 외부 수정은 다시 읽어 한 번 재시도·보존', async operation => {
  const t = await setup(); const originalWrite = storage.atomicWrite; let collisions = 0;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, text, beforeRename) => {
    if (path === t.path && beforeRename && collisions++ === 0) await writeFile(path, (await readFile(path, 'utf8')) + '\n사용자 추가 내용\n');
    return originalWrite(path, text, beforeRename);
  });
  if (operation === 'add') await addJudgment(t.root, { ...question, title: '추가' });
  if (operation === 'answer') await answerJudgment(t.root, t.item.id, '1');
  if (operation === 'status') await writeJudgmentStatus(t.root, '상태 표시');
  expect(collisions).toBe(2); expect(await readFile(t.path, 'utf8')).toContain('사용자 추가 내용');
  const doc = await readJudgment(t.root);
  if (operation === 'add') expect(doc.items.map(item => item.title)).toEqual(['방식', '추가']);
  if (operation === 'answer') expect(doc.items[0].answer).toBe('1');
  if (operation === 'status') expect(await readFile(t.path, 'utf8')).toContain('상태 표시');
});
it('M4: 적용 저장 경합은 최신 답으로 재분류하고 완료 행을 한 번만 쓴다', async () => {
  const t = await setup(); await answerJudgment(t.root, t.item.id, '1');
  const originalWrite = storage.atomicWrite; let collisions = 0;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, text, beforeRename) => {
    if (path === t.path && beforeRename && collisions++ === 0) await writeFile(path, (await readFile(path, 'utf8')).replace('- 답: 1', '- 답: 2'));
    return originalWrite(path, text, beforeRename);
  });
  expect((await applyJudgments(t.root)).applied).toEqual([{ id: t.item.id, interpretation: '앱' }]);
  expect(collisions).toBe(2); expect((await readJudgment(t.root)).completed).toEqual([expect.objectContaining({ answer: '2', interpretation: '앱' })]);
});
it('M4: 두 번 충돌하면 중단하며 사용자 문서와 기존 기대 해시는 보존', async () => {
  const t = await setup(); const before = await readFile(t.metadata, 'utf8'); const originalWrite = storage.atomicWrite; let attempts = 0;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, text, beforeRename) => {
    if (path === t.path && beforeRename) { attempts++; await writeFile(path, (await readFile(path, 'utf8')) + `\n수정 ${attempts}\n`); }
    return originalWrite(path, text, beforeRename);
  });
  await expect(addJudgment(t.root, { ...question, title: '충돌' })).rejects.toBeInstanceOf(JudgmentConflict);
  expect(attempts).toBe(2); expect(await readFile(t.path, 'utf8')).toContain('수정 2');
  expect(await readFile(t.metadata, 'utf8')).toBe(before); expect((await readJudgment(t.root)).items).toHaveLength(1);
});
it.each([{ state: 'recovering' }, { state: 'INTERVIEW', userAborted: true }])('H2: %j는 stalled 감지와 결정에서 모두 제외', async patch => {
  const t = await setup(); const now = Date.now();
  await storage.atomicWrite(storage.harnessPath(t.root, 'harness-state.json'), JSON.stringify({ ...patch, savedAt: new Date(now - 3600000).toISOString() }));
  expect((await tick(t.root, { now })).emitted.filter(item => item.kind === 'stalled')).toEqual([]);
  const record = await addInbox(t.root, { kind: 'stalled' }); await t.decide([record]);
  expect(t.pi.sendMessage).not.toHaveBeenCalled(); expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('사용자 중단'), 'info');
  expect((await listInbox(t.root))[0]).toMatchObject({ status: 'applied', resolvedBy: 'orchestrator' });
});
it('H2: aborted 표시·extension 입력 보존·사용자 입력 해제', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' });
  await t.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'aborted' }] }, t.ctx);
  expect((await readState(t.root)).userAborted).toBe(true);
  await t.handlers.get('input')({ source: 'extension' }, t.ctx); expect((await readState(t.root)).userAborted).toBe(true);
  await t.handlers.get('input')({ source: 'interactive' }, t.ctx); expect((await readState(t.root)).userAborted).toBe(false);
});
it.each(['project-start', 'develop-start', 'judged'])('H2: /%s 명령은 중단 표시를 해제', async name => {
  const t = await setup(); await updateState(t.root, { state: 'IDLE', userAborted: true });
  await t.commands.get(name).handler('', t.ctx); expect((await readState(t.root)).userAborted).toBe(false);
});
it('M1: 지시문 준비 뒤 busy가 되면 autoTurns 원복, 전송 없음', async () => {
  const t = await setup(); await updateState(t.root, { state: 'INTERVIEW' }); await updateState(t.root, { autoTurns: 1 });
  const isIdle = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
  expect(await autoResume(t.pi, t.root, { cwd: t.root, hasUI: true, isIdle, notify: t.ctx.ui.notify }, 'stalled')).toEqual({ skipped: 'busy' });
  expect(t.pi.sendMessage).not.toHaveBeenCalled(); expect((await readState(t.root)).autoTurns).toBe(1);
});
it('M2: CLI형 tick 발행·미결정 재조회·완료 기록·applied 필터·실패 3회 영속', async () => {
  const t = await setup(); const now = Date.now(); await tick(t.root, { now });
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('- 답:', '- 답: 1'));
  await tick(t.root, { now: now + 1 }); const result = await tick(t.root, { now: now + 10001 });
  expect(await pendingDecisions(t.root)).toEqual(result.emitted);
  await t.decide(result.emitted); await recordDecision(t.root, result.emitted[0]);
  expect(await pendingDecisions(t.root)).toEqual([]);
  const broken = await addInbox(t.root, { kind: 'child-gone' });
  await recordDecision(t.root, broken, new Error('broken')); await recordDecision(t.root, broken, new Error('broken'));
  expect(await pendingDecisions(t.root)).toEqual([broken]);
  await recordDecision(t.root, broken, new Error('broken')); expect(await pendingDecisions(t.root)).toEqual([]);
  expect((await readLedger(t.root)).at(-1)).toMatchObject({ action: 'watcher:decide:child-gone', status: 'fail', evidence: { attempts: 3, ids: [broken.id] } });
  expect((await storage.readJson<any>(t.metadata, {})).watch.decided).toEqual([result.emitted[0].id, broken.id]);
  const other = await addInbox(t.root, { kind: 'non-watcher' }); expect(await pendingDecisions(t.root)).toEqual([]);
  expect(other.status).toBe('detected');
});
it.each(['detected', 'queued', 'delivered', 'applied'])('F9: resolveInbox는 %s 항목을 닫고 ack의 기존 규칙은 유지', async status => {
  const t = await setup(); const r = await addInbox(t.root, { kind: 'test' });
  await storage.atomicWrite(storage.harnessPath(t.root, 'harness-inbox.jsonl'), JSON.stringify({ ...r, status }) + '\n');
  const resolved = await resolveInbox(t.root, [r.id], 'orchestrator', '완료'); expect(resolved[0].status).toBe('applied');
  expect(resolved[0]).toMatchObject({ resolvedBy: 'orchestrator', resolutionNote: '완료' });
  const other = await addInbox(t.root, { kind: 'test' }); await expect(ackInbox(t.root, [other.id])).rejects.toThrow('전달되지 않은');
});
it('F9: 적용/답 없음/recover는 닫고 재개한 stalled와 자식은 두뇌 ack를 기다린다', async () => {
  const t = await setup(); await answerJudgment(t.root, t.item.id, '1');
  for (const kind of ['judgment-changed', 'judgment-changed', 'recover']) {
    const r = await addInbox(t.root, { kind }); await t.decide([r]); expect((await listInbox(t.root)).find(item => item.id === r.id)).toMatchObject({ status: 'applied', resolvedBy: 'orchestrator' });
  }
  await updateState(t.root, { state: 'INTERVIEW' });
  for (const kind of ['stalled', 'child-timeout', 'child-gone']) {
    const r = await addInbox(t.root, { kind }); await t.decide([r]); expect((await listInbox(t.root)).find(item => item.id === r.id)!.status).not.toBe('applied');
    await deliverInbox(t.root, [r.id], 'brain'); await ackInbox(t.root, [r.id], 'brain');
  }
});
it('M5: 번호/승인은 즉시, 자유 서술은 60초·재편집 시 안정화 다시 시작·타이머 unref/clear', async () => {
  const t = await setup(); const now = Date.now(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(now);
  const second = await addJudgment(t.root, { ...question, title: '자유 서술' });
  const third = await addJudgment(t.root, { ...question, title: '승인', requiresApproval: true });
  await answerJudgment(t.root, t.item.id, '1'); await answerJudgment(t.root, second.item.id, '웹으로 하되'); await answerJudgment(t.root, third.item.id, '승인합니다');
  await tick(t.root, { now }); const r = await addInbox(t.root, { kind: 'judgment-changed' }); const retry = vi.fn(async () => {});
  vi.setSystemTime(now + 10000); const timeout = vi.spyOn(globalThis, 'setTimeout');
  expect(await t.decide([r], { retry })).toEqual({ deferred: [r.id] });
  expect((await readJudgment(t.root)).completed.map(item => item.id)).toEqual([t.item.id, third.item.id]);
  expect((await readJudgment(t.root)).items[0].id).toBe(second.item.id);
  expect(t.ctx.ui.notify).toHaveBeenCalledWith('자유 서술 답 50초 뒤 적용 예정', 'info');
  expect(timeout.mock.results.at(-1)!.value.hasRef()).toBe(false); expect((await listInbox(t.root))[0].status).not.toBe('applied');
  clearDecisionTimers(t.root); expect(vi.getTimerCount()).toBe(0);
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('웹으로 하되', '웹으로 하되 앱 기능도 포함'));
  await tick(t.root, { now: now + 20000 }); vi.setSystemTime(now + 70000);
  expect(await t.decide([r], { retry })).toEqual({ deferred: [r.id] });
  await vi.advanceTimersByTimeAsync(9999); expect(retry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(1);
});
it('M5: 자유 서술 59.999초 미적용·60초 적용 후 인박스 applied', async () => {
  const t = await setup(); const now = Date.now();
  await answerJudgment(t.root, t.item.id, '웹 버전으로 만들어 주세요'); await tick(t.root, { now });
  const r = await addInbox(t.root, { kind: 'judgment-changed' });
  expect(await t.decide([r], { now: () => now + 59999, retry: async () => {} })).toEqual({ deferred: [r.id] });
  expect((await readJudgment(t.root)).items).toHaveLength(1);
  expect(await t.decide([r], { now: () => now + 60000 })).toEqual({ deferred: [] });
  expect((await readJudgment(t.root)).completed).toHaveLength(1); expect((await listInbox(t.root))[0].status).toBe('applied');
});
it('L5: followup 원문은 적용하지 않고 알림 한 번·skip', async () => {
  const t = await setup(); await answerJudgment(t.root, t.item.id, '하지 마'); await applyJudgments(t.root);
  const r = await addInbox(t.root, { kind: 'judgment-changed' }); await t.decide([r]);
  expect(t.ctx.ui.notify).toHaveBeenCalledTimes(1); expect((await readLedger(t.root)).at(-1)).toMatchObject({ status: 'skip', evidence: { applied: [], resumed: false } });
  expect((await readJudgment(t.root)).items).toHaveLength(2);
});
it('L2: 현재 키 보존·오래된 자식/정체 키 최근 200개로 제한', async () => {
  const t = await setup(); const file = await storage.readJson<any>(t.metadata, {});
  const old = Array.from({ length: 250 }, (_, i) => `stalled:${JSON.stringify(['SPEC', `old-${i}`, 1])}`);
  const current = `stalled:${JSON.stringify(['INTERVIEW', 'current', 1])}`;
  await updateState(t.root, { state: 'INTERVIEW', runId: 'current' });
  file.watch = { judgment: { observed: { hash: null, since: new Date().toISOString() } }, emittedKeys: [current, ...old], decided: [], childTimeouts: 0 };
  await storage.atomicWrite(t.metadata, JSON.stringify(file)); await tick(t.root);
  expect((await storage.readJson<any>(t.metadata, {})).watch.emittedKeys).toEqual([current, ...old.slice(-200)]);
});
it('L3: 무변경 poll은 파일 바이트 그대로·메모리 lastTick 우선·전체 tick 영속', async () => {
  const t = await setup(); const now = Date.now(); await tick(t.root, { now }); const before = await readFile(t.metadata, 'utf8');
  await tick(t.root, { now: now + 5000, judgmentOnly: true }); expect(await readFile(t.metadata, 'utf8')).toBe(before);
  expect((await watcherStatus(t.root)).lastTickAt).toBe(new Date(now + 5000).toISOString());
  vi.resetModules(); const separate = await import('../src/core/watcher.ts');
  expect((await separate.watcherStatus(t.root)).lastTickAt).toBe(new Date(now + 5000).toISOString());
  await tick(t.root, { now: now + 30000 }); expect((await storage.readJson<any>(t.metadata, {})).watch.lastTickAt).toBe(new Date(now + 30000).toISOString());
});
it('L7: 살아 있는 brain은 stalled 대신 timeout, heartbeat가 바뀌면 새 정체 감지', async () => {
  const t = await setup(); const now = Date.now(), savedAt = new Date(now - 3600000).toISOString();
  await storage.atomicWrite(storage.harnessPath(t.root, 'harness-state.json'), JSON.stringify({ state: 'INTERVIEW', runId: 'same', savedAt }));
  await registerProc(t.root, { pid: 201, pgid: 201, runId: 'same', kind: 'brain', startedAt: savedAt });
  expect((await tick(t.root, { now, isProcessAlive: () => true })).emitted.map(r => r.kind)).toEqual(['child-timeout']);
  const first = await tick(t.root, { now, isProcessAlive: () => false }); expect(first.emitted.map(r => r.kind)).toContain('stalled');
  await storage.atomicWrite(storage.harnessPath(t.root, 'harness-state.json'), JSON.stringify({ state: 'INTERVIEW', runId: 'same', savedAt, lastEventAt: new Date(now - 1200000).toISOString() }));
  expect((await tick(t.root, { now, isProcessAlive: () => false })).emitted.map(r => r.kind)).toEqual(['stalled']);
});
it('M5: freeTextStableSeconds 기본 60·양수 검증', async () => {
  expect((await loadConfig('/unused', {})).watch.freeTextStableSeconds).toBe(60);
  await expect(loadConfig('/unused', { watch: { freeTextStableSeconds: 0 } })).rejects.toThrow('watch.freeTextStableSeconds는 양수여야 합니다');
});
it('M4/M5: 안정화 검사 뒤 번호가 자유 서술로 바뀌면 자동 적용을 중단한다', async () => {
  const t = await setup(); await answerJudgment(t.root, t.item.id, '1');
  const answered = (await readJudgment(t.root, { answered: true })).items;
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('- 답: 1', '- 답: 웹 버전으로 만들어 주세요'));
  await expect(applyJudgments(t.root, [t.item.id], { [t.item.id]: answered[0].raw })).rejects.toBeInstanceOf(JudgmentConflict);
  expect((await readJudgment(t.root)).completed).toEqual([]);
  expect((await readJudgment(t.root)).items[0].answer).toBe('웹 버전으로 만들어 주세요');
});
it('M2/F9 통합: CLI가 먼저 발행한 답을 실제 워처 session_start가 적용하고 재시작에도 중복하지 않는다', async () => {
  const t = await setup(); const { default: watcher } = await import('../extensions/watcher/index.ts');
  await updateState(t.root, { state: 'WAIT_JUDGMENT', pickJudgment: t.item.id, resumeState: 'INTERVIEW' });
  const now = Date.now(); await tick(t.root, { now: now - 20000 });
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('- 답:', '- 답: 1'));
  await tick(t.root, { now: now - 19000 }); const { emitted } = await tick(t.root, { now: now - 9000 });
  expect(emitted).toHaveLength(1);
  watcher(t.pi);
  try {
    await t.handlers.get('session_start')({}, t.ctx);
    expect((await readJudgment(t.root)).completed).toHaveLength(1);
    expect(t.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect((await listInbox(t.root)).find(item => item.id === emitted[0].id)).toMatchObject({ status: 'applied', resolvedBy: 'orchestrator' });
    expect((await storage.readJson<any>(t.metadata, {})).watch.decided).toContain(emitted[0].id);
    await t.handlers.get('session_shutdown')({}, t.ctx);
    await t.handlers.get('session_start')({}, t.ctx);
    expect(t.pi.sendMessage).toHaveBeenCalledTimes(1); expect((await readJudgment(t.root)).completed).toHaveLength(1);
    expect(await pendingDecisions(t.root)).toEqual([]);
  } finally { await t.handlers.get('session_shutdown')({}, t.ctx); }
});
it('N3: 전체 tick은 applied 결정 ID를 제거하고 미적용 최근 200개만 보존', async () => {
  const t = await setup(); await tick(t.root);
  const records = Array.from({ length: 260 }, (_, i) => ({ id: `entry-${i}`, kind: 'child-gone', at: 'now', status: i % 7 === 0 ? 'applied' : 'queued' }));
  await storage.atomicWrite(storage.harnessPath(t.root, 'harness-inbox.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const file = await storage.readJson<any>(t.metadata, {}); file.watch.decided = records.map(record => record.id);
  await storage.atomicWrite(t.metadata, JSON.stringify(file));
  await tick(t.root, { judgmentOnly: true }); expect((await storage.readJson<any>(t.metadata, {})).watch.decided).toHaveLength(260);
  await tick(t.root);
  expect((await storage.readJson<any>(t.metadata, {})).watch.decided).toEqual(records.filter(record => record.status !== 'applied').slice(-200).map(record => record.id));
  expect(await listInbox(t.root)).toEqual(records);
});
it('N4: 자유 서술 대기 skip은 ID당 최초 한 번, 모듈 재로드 뒤에도 중복 없음', async () => {
  const t = await setup(); const now = Date.now(); await answerJudgment(t.root, t.item.id, '웹 버전으로 만들어 주세요');
  await tick(t.root, { now }); const r = await addInbox(t.root, { kind: 'judgment-changed' });
  for (const seconds of [10, 15, 20, 25]) expect(await t.decide([r], { now: () => now + seconds * 1000, retry: async () => {} })).toEqual({ deferred: [r.id] });
  const decisions = () => readLedger(t.root).then(entries => entries.filter(entry => entry.action === 'watcher:decide:judgment-changed'));
  expect(await decisions()).toEqual([expect.objectContaining({ status: 'skip', evidence: { ids: [r.id], applied: [], resumed: false } })]);
  vi.resetModules(); const separate = await import('../src/core/watcher.ts'); await separate.logDeferredDecision(t.root, [r], [], false);
  expect(await decisions()).toHaveLength(1);
  await t.decide([r], { now: () => now + 60000 }); expect((await decisions()).map(entry => entry.status)).toEqual(['skip', 'ok']);
  await tick(t.root); expect((await storage.readJson<any>(t.metadata, {})).watch.deferredLogged).toEqual([]);
});
it('N5: 수동 추가 항목 읽기는 questions만 병합, 질문 수정 시 rev 상승', async () => {
  const t = await setup(); await tick(t.root); const before = await storage.readJson<any>(t.metadata, {});
  const section = '### A7 — 수동 질문 (rev 1)\n- 배경: 직접 추가\n- 선택지: ① 웹 ② 앱\n- 추천: 웹\n- 막힌 작업:\n- 답: 1\n\n';
  await writeFile(t.path, (await readFile(t.path, 'utf8')).replace('## 결정 완료', section + '## 결정 완료'));
  const text = await readFile(t.path, 'utf8'); await readJudgment(t.root);
  expect(await readFile(t.path, 'utf8')).toBe(text);
  const after = await storage.readJson<any>(t.metadata, {});
  expect(after.judgment.questions.A7).toMatchObject({ hash: expect.any(String), rev: 1 });
  const { A7, ...previousQuestions } = after.judgment.questions;
  expect({ ...after, judgment: { ...after.judgment, questions: previousQuestions } }).toEqual(before);
  await writeFile(t.path, text.replace('수동 질문 (rev 1)', '수정된 질문 (rev 1)'));
  const changed = (await readJudgment(t.root, { answered: true })).items.find(item => item.id === 'A7');
  expect(changed).toMatchObject({ rev: 2, answerRev: 1, classification: { kind: 'revision-mismatch', applicable: false } });
});
it('N5: 하네스 메타데이터가 없는 수동 문서도 기준선만 생성한다', async () => {
  const t = await setup(); await rm(t.metadata);
  const text = await readFile(t.path, 'utf8'); await readJudgment(t.root);
  const file = await storage.readJson<any>(t.metadata, {});
  expect(Object.keys(file.judgment)).toEqual(['questions']); expect(file.judgment.questions[t.item.id].rev).toBe(1);
  expect(await readFile(t.path, 'utf8')).toBe(text);
  await writeFile(t.path, text.replace('방식 (rev 1)', '변경된 방식 (rev 1)'));
  expect((await readJudgment(t.root)).items[0].rev).toBe(2);
});
it('N6: 실제 워처의 편집 충돌은 deferred, 실패 계수·warning 없이 다음 세션에서 적용', async () => {
  // Isolate editor contention from the OS file-watch quota; keep the real decision/persistence path.
  vi.spyOn(fs, 'watch').mockReturnValue({ close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher);
  const t = await setup(); await answerJudgment(t.root, t.item.id, '1');
  const r = await addInbox(t.root, { kind: 'judgment-changed' });
  const actual = judgments.applyJudgments;
  const apply = vi.spyOn(judgments, 'applyJudgments').mockRejectedValue(new JudgmentConflict());
  watcherExtension(t.pi);
  try {
    await t.handlers.get('session_start')({}, t.ctx);
    for (let i = 0; i < 4; i++) expect(await t.decide([r])).toEqual({ deferred: [r.id] });
    expect(t.ctx.ui.notify).not.toHaveBeenCalled(); expect((await readLedger(t.root)).filter(entry => entry.status === 'fail')).toEqual([]);
    const file = await storage.readJson<any>(t.metadata, {});
    expect(file.watch?.decisionFailures?.[r.id]).toBeUndefined(); expect(file.watch?.decided ?? []).not.toContain(r.id);
    expect((await listInbox(t.root)).find(record => record.id === r.id)!.status).not.toBe('applied');
    await t.handlers.get('session_shutdown')({}, t.ctx);
    apply.mockImplementation(actual); await t.handlers.get('session_start')({}, t.ctx);
    expect((await readJudgment(t.root)).completed).toHaveLength(1);
    expect((await listInbox(t.root)).find(record => record.id === r.id)!.status).toBe('applied');
  } finally { await t.handlers.get('session_shutdown')({}, t.ctx); }
});
