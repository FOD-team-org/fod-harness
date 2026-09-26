import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addCliJudgment, addJudgment, answerJudgment, applyJudgments, beginJudgmentSnapshot, classifyAnswer, completeJudgment, migrateJudgment, parseJudgment, questionHash, readArchive, readJudgment, renderDerived, warnLegacyJudgment, writeJudgmentStatus } from '../src/core/judgment.ts';
import { loadConfig, setConfig } from '../src/core/config.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { tick } from '../src/core/watcher.ts';
import * as storage from '../src/core/storage.ts';
const input = { title: '선택할 내용', background: '짧은 배경', options: ['첫째', '둘째'], recommend: '① — 이유', blocks: '-' };
const doc = (root: string) => join(root, 'docs/판단대기.md');
const text = (root: string) => readFile(doc(root), 'utf8');
async function complete(root: string, answer = '1') {
  const { item } = await addJudgment(root, input);
  await answerJudgment(root, item.id, answer);
  await completeJudgment(root, item.id, { interpretation: '첫째 해석\n다음', commit: '판단 적용; 코드 커밋 없음' });
  return item.id;
}
afterEach(() => vi.useRealTimers());
it('J1 새 구조, 반환 raw/offset, 선택지 형식과 hash/분류 호환', async () => {
  const root = await project(); await readJudgment(root);
  expect((await text(root)).match(/^## .*/gmu)).toEqual(['## 지금 상태', '## 한눈에', '## 열린 판단', '## 최근 결정']);
  expect(await text(root)).toContain('열린 판단 없음');
  const initial = await text(root);
  expect(initial.match(/^> .*/gmu)).toHaveLength(2);
  expect(initial).toMatch(/^# 판단대기\n\n> 답은[^\n]+\n> `한눈에`[^\n]+\n\n## 지금 상태/u);
  const { item } = await addJudgment(root, input), written = await text(root);
  expect(written).toContain('| A1 | 선택할 내용 | - | ① |');
  expect(written).toContain('- 선택지:\n  ① 첫째\n  ② 둘째\n');
  expect(written).not.toContain('- 회신:'); expect(written.slice(item.start, item.end)).toBe(item.raw);
  const old = parseJudgment(written.replace('- 선택지:\n  ① 첫째\n  ② 둘째', '- 선택지: ① 첫째 ② 둘째')).items[0];
  expect(old.options).toEqual(item.options); expect(questionHash(old)).toBe(questionHash(item));
  expect(classifyAnswer('2', old.options)).toEqual(classifyAnswer('2', item.options));
  const bullets = parseJudgment(written.replace('  ① 첫째\n  ② 둘째', '  - 첫째\n  2) 둘째\n\n  * 포함 안 됨')).items[0];
  expect(bullets.options).toEqual(input.options);
});
it('J1 개요 길이와 이스케이프, detail은 질문 hash 제외', async () => {
  const root = await project();
  const { item } = await addJudgment(root, { ...input, title: '가'.repeat(41) + '|', blocks: 'T'.repeat(25), recommend: '나'.repeat(25) + ': 이유' });
  expect(await text(root)).toContain(`| ${'가'.repeat(40)}… | ${'T'.repeat(24)}… | ${'나'.repeat(24)}… |`);
  expect(questionHash({ ...item, detail: 'new' })).toBe(questionHash(item));
  const overview = renderDerived('## 열린 판단\n\n### A1 — a|b (rev 1)\n- 추천: x|y\n- 답:\n', { recent: 0, completed: [] });
  expect(overview).toContain('a\\|b'); expect(overview).toContain('x\\|y'); expect(overview).not.toContain('## 최근 결정');
});
it('J1 KST 월 경계, raw 보존, 최근 결정 제한 및 CLI 조회', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T15:30:00Z'));
  const root = await project(); await setConfig(root, 'judgment.recent', '2');
  for (let i = 0; i < 3; i++) await complete(root, '1, 검수 후');
  const archived = await readFile(join(root, 'docs/판단기록/2026-10.md'), 'utf8');
  for (const line of ['- 결정일: 2026-10-01', '- 답: 1, 검수 후', '- 해석: 첫째 해석 다음', '- 반영: 판단 적용; 코드 커밋 없음', '- 배경: 짧은 배경', '- 선택지:\n  ① 첫째']) expect(archived).toContain(line);
  expect(archived).not.toContain('- 답 기준 rev:');
  const content = await text(root); expect(content).not.toContain('### A'); expect(content).toContain('열린 판단 없음');
  expect(content.match(/^- A\d+ ·/gmu)).toHaveLength(2); expect(content.indexOf('- A3 ·')).toBeLessThan(content.indexOf('- A2 ·'));
  expect((await cli(root, ['judgment', 'read'])).value).toMatchObject({ completedTotal: 3, completed: [expect.objectContaining({ id: 'A3' }), expect.objectContaining({ id: 'A2' })] });
  expect((await cli(root, ['judgment', 'read', '--all'])).value.completed).toHaveLength(3);
  await setConfig(root, 'judgment.recent', '0'); await writeJudgmentStatus(root, '대기');
  expect((await text(root)).split('## 최근 결정')[1].trim()).toBe('');
  expect((await cli(root, ['judgment', 'read'])).value.completed).toEqual([]);
});
it('J1 재질문 사슬 각 멤버 기록 및 삭제 후 번호 재사용 방지', async () => {
  const root = await project(); const first = await addJudgment(root, input);
  await answerJudgment(root, first.item.id, '둘 다'); await applyJudgments(root);
  const next = (await readJudgment(root)).items.find(item => item.reaskOf)!;
  await answerJudgment(root, next.id, '2'); await applyJudgments(root);
  expect(await readArchive(root)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.item.id, answer: `모호: 둘 다 → ${next.id}: 2` }), expect.objectContaining({ id: next.id, answer: '2' }),
  ]));
  expect((await readJudgment(root)).items).toEqual([]);
  await complete(root); await rm(join(root, 'docs/판단기록'), { recursive: true });
  await setConfig(root, 'judgment.recent', '0'); await writeJudgmentStatus(root, '대기');
  expect(await text(root)).not.toMatch(/A[123]/u);
  expect(await readArchive(root)).toEqual([]);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-judgment-seq.json'), 'utf8'))).toEqual({ last: 3 });
  expect((await addJudgment(root, input)).item.id).toBe('A4');
});
it('J1 판단기록의 모든 md와 영속 카운터로 번호를 정한다', async () => {
  const root = await project(); await mkdir(join(root, 'docs/판단기록/nested'), { recursive: true });
  await writeFile(join(root, 'docs/판단기록/nested/이전.md'), '이전 A51 및 A52-1');
  expect((await addJudgment(root, input)).item.id).toBe('A53');
});
it('J1 아카이브 저장 후 판단 CAS 전 장애에서 적용 복구는 블록/notes를 중복하지 않는다', async () => {
  const root = await project(), task = await addTask(root, { title: '진행 작업', category: 'docs' });
  const { item } = await addJudgment(root, { ...input, blocks: task.id });
  await setTask(root, task.id, { status: `blocked(${item.id})`, judgment: item.id });
  await updateState(root, { state: 'WAIT_JUDGMENT', resumeState: 'PICK', pickJudgment: item.id });
  await answerJudgment(root, item.id, '1');
  const actual = storage.atomicWrite;
  const failure = vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, value, cas) => {
    if (path === doc(root)) throw new Error('injected after archive');
    return actual(path, value, cas);
  });
  await expect(applyJudgments(root)).rejects.toThrow('injected'); failure.mockRestore();
  expect(await readArchive(root)).toHaveLength(1); expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await getTask(root, task.id)).status).toBe(`blocked(${item.id})`);
  expect((await applyJudgments(root)).applied).toHaveLength(1); await applyJudgments(root);
  expect(await readArchive(root)).toHaveLength(1); expect((await readJudgment(root)).items).toHaveLength(0);
  const released = await getTask(root, task.id); expect(released.status).toBe('ready');
  expect(released.notes?.match(/A1: 첫째/gu)).toHaveLength(1);
  expect((await readState(root)).state).toBe('PICK');
  expect((await readLedger(root)).filter(entry => entry.action === 'state:WAIT_JUDGMENT→PICK')).toHaveLength(1);
});
it('J1 읽기는 답 수정의 mtime/hash를 보존하고 다음 쓰기는 한눈에를 복구한다', async () => {
  const root = await project(); await addJudgment(root, input);
  await writeFile(doc(root), (await text(root)).replace(/^- 답:/mu, '- 답: 1').replace('| A1 | 선택할 내용', '| A1 | 손으로 변경'));
  const before = await stat(doc(root)), body = await text(root); await readJudgment(root);
  expect((await stat(doc(root))).mtimeMs).toBe(before.mtimeMs); expect(await text(root)).toBe(body);
  const result = await writeJudgmentStatus(root, '다시\n진행');
  expect(await text(root)).not.toContain('손으로 변경'); expect(await text(root)).toContain('다시 진행');
  expect(result.expectedHash).toBe(createHash('sha256').update(await text(root)).digest('hex'));
});
it('J1 상태 절이 없으면 머리말 뒤에 넣고 사용자 문단/절은 보존한다', async () => {
  const root = await project(); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(doc(root), '# 제목\n\n> 인용\n\n사용자 문단\n\n## 보류\n\n사용자 보류\n');
  await writeJudgmentStatus(root, '진행');
  expect(await text(root)).toContain('# 제목\n\n> 인용\n\n## 지금 상태\n\n진행\n\n사용자 문단');
  expect(await text(root)).toContain('## 보류\n\n사용자 보류\n');
});
it('J1 complete/migrate는 자체 변경 이벤트를 내지 않고 사용자 답은 안정화 후 낸다', async () => {
  const root = await project(), now = Date.now(); await complete(root);
  await migrateJudgment(root);
  for (const at of [now, now + 11000]) expect((await tick(root, { judgmentOnly: true, now: at })).emitted).toEqual([]);
  await addJudgment(root, input);
  await writeFile(doc(root), (await text(root)).replace(/^- 답:/mu, '- 답: 2'));
  expect((await tick(root, { judgmentOnly: true, now: now + 12000 })).emitted).toEqual([]);
  expect((await tick(root, { judgmentOnly: true, now: now + 23000 })).emitted).toContainEqual(expect.objectContaining({ kind: 'judgment-changed' }));
});
it.each([['title', 60], ['background', 400], ['recommend', 200], ['options', 160]] as const)('J1 CLI %s 유니코드 길이 제한, 내부 등록 무제한', async (field, limit) => {
  const root = await project(); const value = '🙂'.repeat(limit);
  const make = (v: string) => ({ ...input, [field]: field === 'options' ? [v] : v });
  await expect(addCliJudgment(root, make(value + '🙂'))).rejects.toThrow(`${limit}자를 넘습니다(${limit + 1}자)`);
  expect((await addCliJudgment(root, make(value), true)).item.id).toBe('A1');
  expect((await addJudgment(root, make(value + '🙂'))).item.id).toBe('A2');
});
it('J1 detail 경로 검증과 상대 링크, 사용자 설정 판단 파일', async () => {
  const root = await project(); await readJudgment(root);
  await mkdir(join(root, 'docs/조사'), { recursive: true }); await writeFile(join(root, 'docs/조사/비교.md'), '근거');
  for (const detail of ['missing.md', '/tmp/x', '../x', 'docs/판단대기.md', 'docs/판단기록/a.md', 'docs/조사']) await expect(addCliJudgment(root, { ...input, detail })).rejects.toThrow('--detail');
  await symlink(doc(root), join(root, 'docs/alias.md'));
  await expect(addCliJudgment(root, { ...input, detail: 'docs/alias.md' })).rejects.toThrow('--detail');
  const result = await cli(root, ['judgment', 'add', '--title', '제목', '--background', '배경', '--options', 'a|b', '--recommend', '1', '--blocks', '-', '--detail', 'docs/조사/비교.md']);
  expect(result.code).toBe(0); expect(result.value.item.detail).toBe('[비교.md](조사/비교.md)');
  await setConfig(root, 'judgment.file', 'decisions/open.md'); await setConfig(root, 'judgment.archive', 'records/decisions');
  await readJudgment(root); expect(await readFile(join(root, 'decisions/open.md'), 'utf8')).toContain('[판단기록](../records/decisions/)');
});
async function snapshot(root: string) {
  const paths = (await readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)).sort();
  return Promise.all(paths.map(async path => [path, await readFile(path, 'utf8'), (await stat(path)).mtimeMs]));
}
it('J1 실제 legacy 픽스처: 원문 손실 없음, hash/답/rev 보존, dry-run과 재실행 무쓰기', async () => {
  const root = await project(), legacy = await readFile('test/fixtures/judgment/fod-harness-legacy.md', 'utf8');
  await mkdir(join(root, 'docs'), { recursive: true }); await writeFile(doc(root), legacy);
  expect((await readJudgment(root)).items).toEqual([]);
  const before = parseJudgment(legacy, { migrate: true }); expect(before.items.map(i => i.id)).toEqual(['A19', 'A20', 'A21', 'A22']);
  const files = await snapshot(root), dry = await cli(root, ['judgment', 'migrate', '--dry-run']);
  expect(dry.code).toBe(0); expect(dry.value.changed).toBe(true); expect(dry.value.files).toContain('docs/판단기록/이전.md');
  expect(await snapshot(root)).toEqual(files);
  expect(dry.value.warnings).toEqual(['선택지 수동 확인 필요: A22']);
  const migratedResult = await cli(root, ['judgment', 'migrate']);
  expect(migratedResult.code).toBe(0); expect(migratedResult.value.warnings).toEqual(dry.value.warnings);
  const migrated = await text(root), archived = await readFile(join(root, 'docs/판단기록/이전.md'), 'utf8');
  const after = await readJudgment(root);
  expect(after.items.find(i => i.id === 'A22')!.raw.match(/^- 선택지:.*$/mu)?.[0]).toBe(before.items.find(i => i.id === 'A22')!.raw.match(/^- 선택지:.*$/mu)?.[0]);
  for (const item of after.items.filter(i => i.id !== 'A22')) expect(item.raw).toContain('- 선택지:\n  ①');
  expect(after.items.map(questionHash)).toEqual(before.items.map(questionHash)); expect(after.items.map(i => i.rev)).toEqual([1, 1, 1, 1]);
  expect(after.items.map(i => i.raw.match(/^- 답:.*$/mu)?.[0])).toEqual(before.items.map(i => i.raw.match(/^- 답:.*$/mu)?.[0]));
  expect(migrated).not.toContain('- 회신:'); expect(migrated).not.toContain('## 결정 완료');
  expect(migrated).toContain(legacy.split('## 보류\n')[1].split('## 결정 완료')[0]);
  const status = legacy.split('## 지금 상태\n')[1].split('## 열린 판단')[0].trim().split('\n\n');
  expect(migrated.split('## 지금 상태\n')[1].split('## 한눈에')[0].trim()).toBe(status[0]);
  const relocated = (value: string) => value.replace(/\]\((검수|위임스펙|현황|설계|이관)\//gu, '](../$1/');
  for (const paragraph of status.slice(1)) expect(archived).toContain(relocated(paragraph));
  for (const block of legacy.split('## 결정 완료\n')[1].trim().split('\n\n').filter(Boolean)) expect(archived).toContain(relocated(block));
  const saved = await snapshot(root); expect(await migrateJudgment(root)).toMatchObject({ changed: false }); expect(await snapshot(root)).toEqual(saved);
});
it('J1 규격 표 이전, 비규격/잘못된 날짜 보존, 모르는 열린 줄 보존', async () => {
  const root = await project(); await addJudgment(root, input);
  await writeFile(doc(root), (await text(root)).replace(/^- 답:/mu, '- 낯선 필드: 원문\n사용자 줄\n- 답:') + '\n## 결정 완료\n\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n| A7 | 2 | 1 | a\\|b | none | 2026-08-31 |\n| A8 | 1 | 2 | 두 번째 | none | 미상 |\n\n끝 문단\n');
  await migrateJudgment(root);
  expect(await readFile(join(root, 'docs/판단기록/2026-08.md'), 'utf8')).toContain('### A7 — A7 (rev 2)\n- 결정일: 2026-08-31\n- 답: 1\n- 해석: a|b');
  expect(await readFile(join(root, 'docs/판단기록/이전.md'), 'utf8')).toContain('끝 문단');
  expect(await readArchive(root)).toHaveLength(2); expect(await text(root)).toContain('- 낯선 필드: 원문\n사용자 줄');
  expect(await migrateJudgment(root)).toMatchObject({ changed: false });
});
it('J1 migrate는 저널/활성 스냅샷/두뇌 실행을 이유와 함께 거부한다', async () => {
  const root = await project(); await readJudgment(root);
  vi.stubEnv('FODH_BRAIN', '1'); await expect(migrateJudgment(root)).rejects.toThrow(); vi.unstubAllEnvs();
  await writeFile(join(root, '.pi/harness-judgment-apply.json'), '[{"id":"A1"}]');
  await expect(migrateJudgment(root)).rejects.toThrow('저널'); await writeFile(join(root, '.pi/harness-judgment-apply.json'), '[]');
  await beginJudgmentSnapshot(root, { runId: 'active', startedAt: new Date().toISOString() });
  await expect(migrateJudgment(root)).rejects.toThrow('활성 판단 스냅샷');
});
it('J1 미이전 규격 표는 새 완료 시 보존하고 둘 다 조회하며 doctor는 경고만 기록한다', async () => {
  const root = await project(); await addJudgment(root, input);
  const old = '## 결정 완료\n\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n| A7 | 1 | 2 | 이전 | none | 2026-08-01 |\n';
  await writeFile(doc(root), (await text(root)) + old);
  await warnLegacyJudgment(root);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:judgment:legacy-format', evidence: expect.objectContaining({ body: '사용자 터미널에서 fodh judgment migrate' }) }));
  await answerJudgment(root, 'A1', '1'); await applyJudgments(root);
  expect(await text(root)).toContain(old); expect((await readJudgment(root)).completed).toHaveLength(2);
});
it.each(['/tmp/records', '../records', 'docs/../records', 'docs/판단대기.md', 'docs', '.'])('J1 archive 검증 %s', async archive => {
  await expect(loadConfig(await project(), { judgment: { archive } })).rejects.toThrow('judgment.archive');
});
it.each([-1, 21, 1.5, '5'])('J1 recent 검증 %s', async recent => {
  await expect(loadConfig(await project(), { judgment: { recent } })).rejects.toThrow('judgment.recent');
});
it('J1 archive 기본값 및 worktrees.links 제외', async () => {
  const root = await project(); expect((await loadConfig(root, { judgment: { file: 'custom/open.md' } })).judgment).toEqual({ file: 'custom/open.md', archive: 'custom/판단기록', recent: 5 });
  for (const link of ['records', 'records/decisions', 'records/decisions/x']) await expect(loadConfig(root, { judgment: { archive: 'records/decisions' }, worktrees: { links: [link] } })).rejects.toThrow('worktrees.links');
});
it('J1 월을 넘긴 장애 복구도 최초 월 블록을 재사용한다', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T14:59:00Z'));
  const root = await project(); const { item } = await addJudgment(root, input); await answerJudgment(root, item.id, '1');
  const actual = storage.atomicWrite;
  const spy = vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, value, cas) => {
    if (path === doc(root)) throw new Error('crash'); return actual(path, value, cas);
  });
  await expect(applyJudgments(root)).rejects.toThrow('crash'); spy.mockRestore();
  vi.setSystemTime(new Date('2026-09-30T15:30:00Z')); await applyJudgments(root);
  expect(await readArchive(root)).toEqual([expect.objectContaining({ date: '2026-09-30', path: '판단기록/2026-09.md' })]);
});
it('J1 legacy 첫 migrate의 자체 저장은 워처 이벤트를 만들지 않는다', async () => {
  const root = await project(), now = Date.now();
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(doc(root), '# 판단대기\n\n## 열린 판단\n\n### A1 — 질문 (rev 1)\n- 선택지: ① 하나 ② 둘\n- 답:\n');
  await tick(root, { judgmentOnly: true, now });
  expect((await tick(root, { judgmentOnly: true, now: now + 11000 })).emitted).toHaveLength(1);
  await migrateJudgment(root);
  for (const at of [now + 12000, now + 23000]) expect((await tick(root, { judgmentOnly: true, now: at })).emitted).toEqual([]);
});
it('J1 dry-run은 알 수 없는 설정 경고도 저장하지 않고 메타데이터 변경까지 예고한다', async () => {
  const root = await project();
  await writeFile(join(root, '.pi/harness.json'), '{"unknownJ1":true}');
  const before = await snapshot(root), result = await migrateJudgment(root, { dryRun: true });
  expect(result.files).toEqual(expect.arrayContaining(['docs/판단대기.md', '.pi/harness-watcher.json', '.pi/harness-judgment-seq.json']));
  expect(await snapshot(root)).toEqual(before);
});
it('J1 21개 선택지 표기와 새 렌더링에서도 질문 hash 보존', async () => {
  const root = await project(), options = Array.from({ length: 21 }, (_, i) => `선택 ${i + 1}개`);
  const { item } = await addJudgment(root, { ...input, options });
  expect(item.raw).toContain('  ⑳ 선택 20개\n  21. 선택 21개'); expect(item.options).toEqual(options);
  const before = questionHash(item); await migrateJudgment(root);
  expect(questionHash((await readJudgment(root)).items[0])).toBe(before);
});
it('J1 문서 위치에는 판단대기/판단기록을 구분하고 migrate는 두뇌 명령에서 제외한다', async () => {
  const { generateClaudeMd } = await import('../src/core/claude-md.ts');
  const root = await project(); await generateClaudeMd(root);
  const block = await readFile(join(root, 'CLAUDE.md'), 'utf8');
  expect(block).toContain('| docs/판단대기.md | 판단대기: 열린 판단, 사용자만 답 |');
  expect(block).toContain('| docs/판단기록/ | 판단기록: 지난 판단, 하네스만 씀 |');
  expect(block).not.toContain('- fodh judgment migrate\n');
});
it('J1 R2 미방출 사용자 답은 migrate 뒤 안정화 이벤트 1회와 적용으로 이어진다', async () => {
  const root = await project(), now = Date.now(); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(doc(root), '# 판단대기\n\n## 열린 판단\n\n### A19 — 날짜 질문 (2026-09-25)\n- 배경: 결정\n- 선택지: ① 하나 ② 둘\n- 답: 1\n');
  await migrateJudgment(root);
  expect((await tick(root, { judgmentOnly: true, now })).emitted).toEqual([]);
  expect((await tick(root, { judgmentOnly: true, now: now + 11000 })).emitted).toEqual([expect.objectContaining({ kind: 'judgment-changed' })]);
  expect((await tick(root, { judgmentOnly: true, now: now + 22000 })).emitted).toEqual([]);
  expect((await applyJudgments(root)).applied).toEqual([{ id: 'A19', interpretation: '하나' }]);
  expect((await readJudgment(root)).items).toEqual([]);
  expect(await readArchive(root)).toEqual([expect.objectContaining({ id: 'A19', answer: '1' })]);
});
it('J1 R2 날짜 제목은 migrate에서만 읽으며 답과 질문 변경도 이전 전 적용하지 않는다', async () => {
  const root = await project(); await mkdir(join(root, 'docs'), { recursive: true });
  const original = '# 판단대기\n\n## 열린 판단\n\n### A19 — 날짜 질문 (2026-09-25)\n- 배경: 원래 배경\n- 선택지: ① 하나 ② 둘\n- 답: 1\n';
  await writeFile(doc(root), original);
  expect(parseJudgment(original).items).toEqual([]); expect((await readJudgment(root)).items).toEqual([]);
  expect((await applyJudgments(root)).applied).toEqual([]); expect(await text(root)).toBe(original); expect(await readArchive(root)).toEqual([]);
  await writeFile(doc(root), original.replace('- 배경: 원래 배경', '- 배경: 바뀐 배경'));
  expect((await readJudgment(root)).items).toEqual([]); expect((await applyJudgments(root)).applied).toEqual([]);
  await warnLegacyJudgment(root);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:judgment:legacy-format' }));
  await migrateJudgment(root);
  expect(await text(root)).toContain('### A19 — 날짜 질문 (rev 1)');
  expect((await readJudgment(root)).items).toEqual([expect.objectContaining({ id: 'A19', rev: 1, answer: '1', background: '바뀐 배경' })]);
});
it.each(['① 하나 ① 반복 ② 둘', '① 하나② 붙음', '② 둘 ③ 셋', '1. 하나 3) 셋', '설명 ① 하나 ② 둘'])('J1 R2 불확실한 선택지 원문 보존과 dry-run 경고: %s', async options => {
  const root = await project(); await mkdir(join(root, 'docs'), { recursive: true });
  const original = `# 판단대기\n\n## 열린 판단\n\n### A1 — 질문 (rev 1)\n- 선택지: ${options}\n- 답:\n`;
  await writeFile(doc(root), original); const hash = questionHash(parseJudgment(original).items[0]);
  expect((await migrateJudgment(root, { dryRun: true })).warnings).toEqual(['선택지 수동 확인 필요: A1']);
  expect(await text(root)).toBe(original);
  expect((await migrateJudgment(root)).warnings).toEqual(['선택지 수동 확인 필요: A1']);
  expect(await text(root)).toContain(`- 선택지: ${options}\n`); expect(questionHash((await readJudgment(root)).items[0])).toBe(hash);
});
it('J1 R2 순서대로인 숫자 선택지는 hash를 유지하며 여러 줄로 이전한다', async () => {
  const root = await project(); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(doc(root), '# 판단대기\n\n## 열린 판단\n\n### A1 — 질문 (rev 1)\n- 선택지: 1. 하나 2) 둘\n- 답:\n');
  const before = (await readJudgment(root)).items[0]; expect((await migrateJudgment(root)).warnings).toEqual([]);
  const after = (await readJudgment(root)).items[0]; expect(after.raw).toContain('- 선택지:\n  ① 하나\n  ② 둘'); expect(questionHash(after)).toBe(questionHash(before));
});
it.each(['answer', 'question'] as const)('J1 R2 아카이브 뒤 장애에서 %s 변경은 낡은 블록/저널을 제거하고 한 번만 적용한다', async changed => {
  const root = await project(), task = await addTask(root, { title: '진행 작업', category: 'docs' });
  const { item } = await addJudgment(root, { ...input, blocks: task.id });
  await setTask(root, task.id, { status: `blocked(${item.id})`, judgment: item.id });
  await updateState(root, { state: 'WAIT_JUDGMENT', resumeState: 'PICK', pickJudgment: item.id }); await answerJudgment(root, item.id, '1');
  const actual = storage.atomicWrite;
  const spy = vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, value, cas) => {
    if (path === doc(root)) throw new Error('crash after archive'); return actual(path, value, cas);
  });
  await expect(applyJudgments(root)).rejects.toThrow('crash after archive'); spy.mockRestore();
  expect(await readArchive(root)).toEqual([expect.objectContaining({ id: item.id, rev: 1, answer: '1' })]);
  if (changed === 'answer') await answerJudgment(root, item.id, '2');
  else {
    await writeFile(doc(root), (await text(root)).replace(/^- 배경:.*$/mu, '- 배경: 바뀐 배경'));
    await readJudgment(root); await answerJudgment(root, item.id, '2');
  }
  expect((await applyJudgments(root)).applied).toEqual([{ id: item.id, interpretation: '둘째' }]); await applyJudgments(root);
  const records = await readArchive(root); expect(records).toEqual([expect.objectContaining({ id: item.id, rev: changed === 'answer' ? 1 : 2, answer: '2' })]);
  expect(records.filter(record => record.answer === '1')).toHaveLength(0);
  expect((await getTask(root, task.id)).notes?.match(/A1: 둘째/gu)).toHaveLength(1);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-judgment-apply.json'), 'utf8'))).toEqual([]);
  expect((await readJudgment(root)).items).toEqual([]);
  expect((await readLedger(root)).filter(entry => entry.action === 'state:WAIT_JUDGMENT→PICK')).toHaveLength(1);
});
it('J1 R2 SHA256 같은 영문 토큰은 판단 번호를 올리지 않는다', async () => {
  const root = await project(); await mkdir(join(root, 'docs/판단기록'), { recursive: true });
  await writeFile(join(root, 'docs/판단기록/이전.md'), 'SHA256 abcA999 x_A888 2A777');
  expect((await addJudgment(root, input)).item.id).toBe('A1');
});
it('J1 R2 기존 한눈에/최근 결정은 사용자 절 사이의 위치를 유지한다', async () => {
  const original = '# 제목\n\n사용자 문단\n\n## 열린 판단\n\n## 한눈에\n\n수동 표\n\n## 최근 결정\n\n수동 기록\n\n## 보류\n\n보류 원문\n';
  const rendered = renderDerived(original, { recent: 5, completed: [] });
  expect(rendered.match(/^## .*/gmu)).toEqual(original.match(/^## .*/gmu));
  expect(rendered).toContain('## 한눈에\n\n열린 판단 없음');
  expect(rendered).not.toContain('수동 기록'); expect(rendered).toContain('# 제목\n\n사용자 문단'); expect(rendered).toContain('## 보류\n\n보류 원문\n');
  const missing = renderDerived('## 열린 판단\n\n## 결정 완료\n\n옛 기록\n\n## 보류\n\n보류 원문\n', { recent: 5, completed: [] });
  expect(missing.match(/^## .*/gmu)).toEqual(['## 한눈에', '## 열린 판단', '## 결정 완료', '## 보류', '## 최근 결정']);
});
const links = '[설계](설계/a.md)·[현황](../현황/b.md)·[외부](https://x)·[앵커](#y)·[메일](mailto:a@b)·[루트](/a.md)';
it.each(['docs/판단기록', 'records/decisions'])('J1 R2 완료 원문의 링크 기준을 %s로 옮긴다', async archive => {
  const root = await project(); await setConfig(root, 'judgment.archive', JSON.stringify(archive));
  const { item } = await addJudgment(root, { ...input, background: links, options: ['[선택](조사/c.md)', '둘째'], detail: '[근거](조사/d.md)' });
  await answerJudgment(root, item.id, '1'); await applyJudgments(root);
  const record = (await readArchive(root))[0], content = await readFile(join(root, 'docs', record.path!), 'utf8');
  const prefix = archive === 'docs/판단기록' ? '..' : '../../docs';
  expect(content).toContain(`[설계](${prefix}/설계/a.md)`); expect(content).toContain('[현황](../../현황/b.md)');
  for (const unchanged of ['[외부](https://x)', '[앵커](#y)', '[메일](mailto:a@b)', '[루트](/a.md)']) expect(content).toContain(unchanged);
  expect(content).toContain(`[선택](${prefix}/조사/c.md)`); expect(content).toContain(`[근거](${prefix}/조사/d.md)`);
  expect((await text(root))).toContain(`[기록](${archive === 'docs/판단기록' ? '판단기록' : '../records/decisions'}/${record.date.slice(0, 7)}.md)`);
});
it.each(['docs/판단기록', 'records/decisions'])('J1 R2 migrate의 이전/월 파일 링크도 %s 기준이고 참조 정의는 보존한다', async archive => {
  const root = await project(); await setConfig(root, 'judgment.archive', JSON.stringify(archive)); await mkdir(join(root, 'docs'), { recursive: true });
  const definition = '[참조]: 설계/a.md';
  await writeFile(doc(root), `# 판단대기\n\n## 지금 상태\n\n현재\n\n이전 상태 ${links}\n\n## 열린 판단\n\n## 결정 완료\n\n자유 원문 ${links}\n\n${definition}\n\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n| A1 | 1 | 1 | ${links} | none | 2026-09-26 |\n`);
  await migrateJudgment(root);
  const prefix = archive === 'docs/판단기록' ? '..' : '../../docs';
  for (const file of ['이전.md', '2026-09.md']) {
    const content = await readFile(join(root, archive, file), 'utf8');
    expect(content).toContain(`[설계](${prefix}/설계/a.md)`); expect(content).toContain('[현황](../../현황/b.md)');
    for (const unchanged of ['[외부](https://x)', '[앵커](#y)', '[메일](mailto:a@b)', '[루트](/a.md)']) expect(content).toContain(unchanged);
    if (file === '이전.md') { expect(content).toContain(definition); expect(content).toContain('이전 상태'); expect(content).toContain('자유 원문'); }
  }
  expect(await migrateJudgment(root)).toMatchObject({ changed: false });
});
it('J1 R2 장애 뒤 질문만 변경하면 낡은 결정을 지우고 기존 rev 불일치 재질문 규칙을 따른다', async () => {
  const root = await project(); const { item } = await addJudgment(root, input); await answerJudgment(root, item.id, '1');
  const actual = storage.atomicWrite;
  const spy = vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, value, cas) => {
    if (path === doc(root)) throw new Error('crash'); return actual(path, value, cas);
  });
  await expect(applyJudgments(root)).rejects.toThrow('crash'); spy.mockRestore();
  await writeFile(doc(root), (await text(root)).replace(/^- 배경:.*$/mu, '- 배경: 새 질문'));
  const result = await applyJudgments(root);
  expect(result.applied).toEqual([]); expect(result.unapplied).toContainEqual({ id: item.id, reason: '문항과 답의 개정 번호가 다릅니다' });
  expect(await readArchive(root)).toEqual([]); expect((await readJudgment(root)).items).toContainEqual(expect.objectContaining({ reaskOf: item.id }));
  expect(JSON.parse(await readFile(join(root, '.pi/harness-judgment-apply.json'), 'utf8'))).toEqual([]);
});
it('J1 R2 링크가 있는 답도 아카이브 멱등성/저널 복구의 같은 답으로 인식한다', async () => {
  const root = await project(); const { item } = await addJudgment(root, input); await answerJudgment(root, item.id, '[계획](./설계/a.md)');
  const actual = storage.atomicWrite;
  const spy = vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, value, cas) => {
    if (path === doc(root)) throw new Error('crash'); return actual(path, value, cas);
  });
  await expect(applyJudgments(root)).rejects.toThrow('crash'); spy.mockRestore();
  expect((await applyJudgments(root)).applied).toHaveLength(1);
  expect(await readArchive(root)).toEqual([expect.objectContaining({ id: item.id, answer: '[계획](../설계/a.md)' })]);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-judgment-apply.json'), 'utf8'))).toEqual([]);
});
