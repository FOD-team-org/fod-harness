import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { addTask } from '../src/core/backlog.ts';
import { loadConfig } from '../src/core/config.ts';
import { ackInbox, addInbox, deliverInbox, listInbox, queueInbox } from '../src/core/inbox.ts';
import { addJudgment, answerJudgment, classifyAnswer, completeJudgment, parseJudgment, readJudgment, writeJudgmentStatus } from '../src/core/judgment.ts';
import { appendLedger, readLedger, unknownEntries } from '../src/core/ledger.ts';
import { acquireLock } from '../src/core/lock.ts';
import { listProcs, registerProc, removeProc } from '../src/core/procs.ts';
import { readState, transitionState, updateState } from '../src/core/state.ts';

const execute = promisify(execFile);
const roots: string[] = [];
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'fodh-core-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('원자 상태와 잠금', () => {
  test('동시 쓰기 10회가 모두 보존되고 마지막 쓰기가 남는다', async () => {
    const path = await root();
    await Promise.all(Array.from({ length: 10 }, () => updateState(path, current => ({ count: Number(current.count ?? 0) + 1 }))));
    expect((await readState(path)).count).toBe(10);
    await updateState(path, { marker: '마지막' });
    expect(JSON.parse(await readFile(join(path, '.pi/harness-state.json'), 'utf8'))).toMatchObject({ count: 10, marker: '마지막' });
  });

  test('별도 프로세스 10개의 동시 읽기-변경-저장이 유실되지 않는다', async () => {
    const path = await root();
    const module = pathToFileURL(resolve('src/core/state.ts')).href;
    const source = `import { updateState } from ${JSON.stringify(module)}; await updateState(process.argv[1], s => ({ count: Number(s.count ?? 0) + 1 }));`;
    await Promise.all(Array.from({ length: 10 }, () => execute(process.execPath, ['--input-type=module', '-e', source, path], { timeout: 15_000 })));
    expect((await readState(path)).count).toBe(10);
  });

  test('죽은 pid 잠금을 회수하고 살아 있는 소유자를 덮지 않는다', async () => {
    const path = join(await root(), 'harness.lock');
    await writeFile(path, JSON.stringify({ pid: 2_147_483_647, startedAt: '2020-01-01', token: 'stale' }));
    const release = await acquireLock(path);
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid);
    await expect(acquireLock(path, { waitMs: 20 })).rejects.toThrow('잠금');
    await release();
    await release();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('상태 전이와 task를 저장하고 잘못된 상태는 거부한다', async () => {
    const path = await root();
    const task = await addTask(path, { title: '상태 검증', category: 'docs' });
    await updateState(path, { state: 'SPEC', taskId: task.id, doctor: { ok: true, checkedAt: new Date().toISOString() } });
    expect(await transitionState(path, 'IMPLEMENT', task.id)).toMatchObject({ state: 'IMPLEMENT', taskId: task.id });
    await expect(transitionState(path, 'MERGE', task.id)).rejects.toThrow('허용되지 않는 전이');
    await expect(transitionState(path, 'INVALID')).rejects.toThrow('상태');
  });
});

describe('설정과 실행 원장', () => {
  test('기본값과 배열 명령을 읽고 잘못된 제한 시간을 거부한다', async () => {
    const path = await root();
    expect((await loadConfig(path)).brain).toMatchObject({ command: 'claude', maxTurnMinutes: 45, skipPermissions: true });
    await mkdir(join(path, '.pi'));
    await writeFile(join(path, '.pi/harness.json'), JSON.stringify({ brain: { command: ['node', 'fake'], maxTurnMinutes: 0.001 } }));
    expect((await loadConfig(path)).brain.command).toEqual(['node', 'fake']);
    await writeFile(join(path, '.pi/harness.json'), JSON.stringify({ brain: { maxTurnMinutes: -1 } }));
    await expect(loadConfig(path)).rejects.toThrow('양수');
  });

  test('동시 원장 기록을 보존하고 runId/action별 미완료만 unknown으로 읽는다', async () => {
    const path = await root();
    await Promise.all(Array.from({ length: 10 }, (_, index) => appendLedger(path, { runId: `r${index}`, action: 'turn', status: 'pre' })));
    await appendLedger(path, { runId: 'r0', action: 'turn', status: 'ok' });
    await appendLedger(path, { runId: 'r1', action: 'turn', status: 'fail' });
    await appendLedger(path, { runId: 'r2', action: 'other', status: 'running' });
    expect(await readLedger(path)).toHaveLength(13);
    const pending = await unknownEntries(path);
    expect(pending).toHaveLength(9);
    expect(pending.every(value => value.status === 'unknown')).toBe(true);
    expect(pending.some(value => value.runId === 'r0')).toBe(false);
  });
});

describe('판단대기 문서', () => {
  test('실제 규격 픽스처의 열린 항목, rev, 답과 결정 완료를 읽는다', async () => {
    const parsed = parseJudgment(await readFile('test/fixtures/judgment/open-and-completed.md', 'utf8'));
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ id: 'A2', rev: 2, answer: '2, 단 검수 후 진행', options: ['검증 환경', '운영 환경'] });
    expect(parsed.completed[0]).toMatchObject({ id: 'A1', answer: '①', interpretation: '테스트부터 진행' });
  });

  test.each([
    ['②', 1, 1, 'choice', true],
    ['2, 단 검수 후 진행', 1, 1, 'conditional', true],
    ['테스트부터 진행하자', 1, 1, 'freeform', true],
    ['1은 하지 마', 1, 1, 'ambiguous', false],
    ['나중에', 1, 1, 'ambiguous', false],
    ['1 또는 2', 1, 1, 'ambiguous', false],
    ['1또는2', 1, 1, 'ambiguous', false],
    ['2 말고1', 1, 1, 'ambiguous', false],
    ['1번과2번', 1, 1, 'ambiguous', false],
    ['선택지는 1 혹은 2', 1, 1, 'ambiguous', false],
    ['①②', 1, 1, 'ambiguous', false],
    ['2는 제외', 1, 1, 'ambiguous', false],
    ['1, 2', 1, 1, 'ambiguous', false],
    ['2, 단 1회만 실행', 1, 1, 'conditional', true],
    ['2, 단 5분 이내 완료', 1, 1, 'conditional', true],
    ['1', 2, 1, 'revision-mismatch', false],
    ['', 1, 1, 'empty', false],
  ])('답 문법 %s → %s', (answer, rev, answerRev, kind, applicable) => {
    expect(classifyAnswer(String(answer), ['첫째', '둘째'], Number(rev), Number(answerRev))).toMatchObject({ kind, applicable });
  });

  test('보류와 다른 섹션의 판단 형식 항목을 열린 판단에 포함하지 않는다', async () => {
    const fixture = await readFile('test/fixtures/judgment/open-and-completed.md', 'utf8');
    const held = '### A8 — 보류 중인 결정 (rev 1)\n- 선택지: ① 유지 ② 변경\n- 답: ②\n\n';
    const text = fixture.replace('## 열린 판단', `## 참고\n\n${held}## 열린 판단`).replace('## 결정 완료', `## 보류\n\n${held}## 결정 완료`);
    expect(parseJudgment(text).items.map(item => item.id)).toEqual(['A2', 'A3']);
    expect(parseJudgment(`# 판단대기\n\n## 보류\n\n${held}`).items).toEqual([]);
  });

  test('열린 항목 수정은 보류 항목의 원문을 보존하고 보류 답 수정은 거부한다', async () => {
    const path = await root();
    await mkdir(join(path, 'docs'));
    const fixture = await readFile('test/fixtures/judgment/open-and-completed.md', 'utf8');
    const held = '## 보류\n\n### A8 — 보류 중인 결정 (rev 1)\n- 선택지: ① 유지 ② 변경\n- 답: ②\n\n';
    await writeFile(join(path, 'docs/판단대기.md'), fixture.replace('## 결정 완료', `${held}## 결정 완료`));
    await answerJudgment(path, 'A3', '1');
    await expect(answerJudgment(path, 'A8', '1')).rejects.toThrow('열린 판단');
    expect(await readFile(join(path, 'docs/판단대기.md'), 'utf8')).toContain(held);
  });

  test('승인 필수 자유서술에 명시 승인 토큰을 요구한다', () => {
    expect(classifyAnswer('검수 후 처리해', ['유지', '진행'], 1, 1, true).applicable).toBe(false);
    expect(classifyAnswer('승인 검수 후 처리해', ['유지', '진행'], 1, 1, true).applicable).toBe(true);
    expect(classifyAnswer('승인 안 해', ['유지', '진행'], 1, 1, true).applicable).toBe(false);
  });

  test('쓰기 기대 해시를 저장하고 중복 병합, 원문/해석 완료 이동, 번호 재사용 금지를 지킨다', async () => {
    const path = await root();
    const input = { title: 'Bash 명령 승인', background: '차단됨', options: ['승인', '보류'], recommend: '보류', blocks: ['T1'], dedupeKey: 'Bash:marker' };
    const added = await addJudgment(path, input);
    const duplicate = await addJudgment(path, input);
    expect(duplicate.item.id).toBe(added.item.id);
    expect((await readJudgment(path)).items).toHaveLength(1);
    await answerJudgment(path, added.item.id, '1, 단 검수 후');
    expect((await readJudgment(path, { answered: true })).items).toHaveLength(1);
    const moved = await completeJudgment(path, added.item.id, { interpretation: '검수 후 | 승인', commit: 'abc123' });
    expect((await readJudgment(path)).items).toHaveLength(0);
    expect((await readJudgment(path)).completed[0]).toMatchObject({ answer: '1, 단 검수 후', interpretation: '검수 후 | 승인', commit: 'abc123' });
    const text = await readFile(join(path, 'docs/판단대기.md'), 'utf8');
    expect(moved.expectedHash).toBe(createHash('sha256').update(text).digest('hex'));
    expect(JSON.parse(await readFile(join(path, '.pi/harness-watcher.json'), 'utf8')).judgment.expectedHash).toBe(moved.expectedHash);
    expect((await addJudgment(path, { ...input, dedupeKey: 'other' })).item.id).toBe('A2');
  });

  test('구형 완료 표와 보류 영역을 보존하고 rev 불일치 답을 완료하지 않는다', async () => {
    const path = await root();
    await mkdir(join(path, 'docs'));
    await writeFile(join(path, 'docs/판단대기.md'), await readFile('test/fixtures/judgment/legacy-and-revised.md'));
    await expect(completeJudgment(path, 'A9', { interpretation: '유지', commit: 'abc123' })).rejects.toThrow('적용');
    await writeJudgmentStatus(path, '상태 갱신');
    await answerJudgment(path, 'A9', '①');
    await completeJudgment(path, 'A9', { interpretation: '유지', commit: 'abc123' });
    const text = await readFile(join(path, 'docs/판단대기.md'), 'utf8');
    expect(text).toContain('보류한 프로젝트는 유지한다.');
    expect(parseJudgment(text).completed).toHaveLength(2);
    expect(text).toContain('상태 갱신');
  });
});

describe('인박스와 프로세스 레지스트리', () => {
  test('세 항목 순서를 보존하고 전달/ack 뒤 재시작에도 미적용 항목만 남는다', async () => {
    const path = await root();
    const records = [];
    for (const content of ['첫째', '둘째', '셋째']) records.push(await addInbox(path, { kind: 'judgment-changed', content }));
    for (const record of records) await queueInbox(path, record.id);
    expect((await listInbox(path)).map(record => record.content)).toEqual(['첫째', '둘째', '셋째']);
    await deliverInbox(path, records.map(record => record.id), 'r1');
    await ackInbox(path, [records[0]!.id, records[1]!.id], 'r1');
    expect((await listInbox(path)).filter(record => record.status !== 'applied').map(record => record.content)).toEqual(['셋째']);
    await deliverInbox(path, [records[2]!.id], 'r2');
    await expect(ackInbox(path, [records[2]!.id], 'r1')).rejects.toThrow('실행 번호');
    await ackInbox(path, [records[2]!.id], 'r2');
    expect((await listInbox(path)).every(record => record.status === 'applied')).toBe(true);
  });

  test('미전달 ack와 없는 항목을 거부한다', async () => {
    const path = await root();
    const record = await addInbox(path, { kind: 'recover' });
    await expect(ackInbox(path, [record.id])).rejects.toThrow('전달');
    await expect(queueInbox(path, '없는-id')).rejects.toThrow('찾을');
  });

  test('프로세스 식별 정보를 보존하고 다른 runId 제거를 거부한다', async () => {
    const path = await root();
    const record = { pid: 1234, pgid: 1234, startedAt: '시작 시각', runId: 'r1', kind: 'brain', cmd: 'fake' };
    await registerProc(path, record);
    await removeProc(path, 1234, 'other');
    expect(await listProcs(path)).toEqual([record]);
    await expect(registerProc(path, { ...record, runId: 'other' })).rejects.toThrow('소유');
    await removeProc(path, 1234, 'r1');
    expect(await listProcs(path)).toEqual([]);
  });
});
