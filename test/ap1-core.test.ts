import * as locks from '../src/core/lock.ts';
import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { liveHarness } from './p7-brain-helpers.ts';
import { invoke } from './hook-helpers.ts';
import { loadConfig, setConfig, approvalConfigKeys } from '../src/core/config.ts';
import { addJudgment, addCliJudgment, readJudgment, questionHash, migrateJudgment, answerJudgment, AnswerConflict, applyJudgments, parseArchive } from '../src/core/judgment.ts';
import { recommendedOption, autopilotBlocked, autopilotEligible, normalizeTitle, autopilotOn, autopilotOff, autopilotStatus, readAutopilot, parseAutopilotDuration } from '../src/core/autopilot.ts';
import { startInterview, deferInterview } from '../src/core/interview.ts';
import { isBrainProcess } from '../src/core/brain-guard.ts';
const now = new Date('2026-09-27T00:00:00Z');
const input = { title: '색상 선택', background: '화면 비교', options: ['파랑', '초록'], recommend: '① 파랑', blocks: '-' };
async function fixture() { const root = await project('ARCH'); await addJudgment(root, { ...input, origin: { kind: 'brain' } }); return { root, item: (await readJudgment(root)).items[0], config: await loadConfig(root), auto: await autopilotOn(root, { now }) }; }
it.each(['① 추천', '1번 추천', '1)', '1.', '1 추천', '① 먼저, ② 나중'])('추천 시작 번호 %s', async recommend => {
  const { item } = await fixture(); expect(recommendedOption({ ...item, recommend })).toBe(1);
});
it.each(['0', '3', '추천 1', '추천 없음 — 결정 불가', '', '1추천'])('유효 추천 없음 %s', async recommend => {
  const { item } = await fixture(); expect(recommendedOption({ ...item, recommend })).toBeUndefined();
});
it.each(['배포', 'MIGRATION', 'deploy', '운영', 'PROD', 'release', '출시', '삭제', 'delete', 'DROP', 'revert', 'reset', 'force', 'TAG', 'TOKEN', 'secret', '키', '과금', 'billing', '계정', '권한', 'permission', 'publish', '게시', '공개', '발송', '이메일', 'SMS'])('추천 칸 차단 %s', async word => {
  const { item, config } = await fixture(); expect(autopilotBlocked({ ...item, recommend: `① ${word}` }, config)).toBe(true);
});
it.each(['stage', 'product', 'preset', 'reinforcement', 'tokenizer'])('짧은 영문은 단어 경계 %s', async word => {
  const { item, config } = await fixture(); expect(autopilotBlocked({ ...item, recommend: `① ${word}` }, config)).toBe(false);
});
it('승인 플래그, 상세 링크, 설정 규칙 이름·정규식·잘못된 정규식', async () => {
  const { item, config } = await fixture();
  expect(autopilotBlocked({ ...item, requiresApproval: true }, config)).toBe(true);
  expect(autopilotBlocked({ ...item, detail: '[문서](deploy.md)' }, config)).toBe(true);
  const custom = { ...config, requiresApproval: ['custom-rule'], approvalRules: [{ id: 'custom-rule', pattern: '특별.*실행', description: '원격 반영' }] };
  expect(autopilotBlocked({ ...item, recommend: '① 특별 항목 실행' }, custom)).toBe(true);
  expect(autopilotBlocked({ ...item, detail: '원격 반영' }, custom)).toBe(true);
  expect(autopilotBlocked(item, { ...custom, approvalRules: [{ id: 'custom-rule', pattern: '[' }] })).toBe(false);
});
it('순수 대상 판정의 모든 제외 조건과 제목·범위·task 한도', async () => {
  const { item, config, auto } = await fixture();
  for (const patch of [{ origin: undefined }, { origin: { kind: 'cli' as const } }, { origin: { kind: 'interview' as const } }, { answer: '1' }, { held: { at: '', reason: 'brain-turn' as const, runId: 'x' } }, { followup: 'A2' }, { reaskOf: 'A0' }, { resolution: 'cleanup' as const }, { options: ['하나'] }]) expect(autopilotEligible({ ...item, ...patch }, config, auto, now).ok).toBe(false);
  for (const patch of [{ enabled: false }, { until: now.toISOString() }, { answered: 30 }, { scope: 'ARCH:project', perScope: { 'ARCH:project': 3 } }, { recentTitles: [normalizeTitle(item.title)] }]) expect(autopilotEligible(item, config, { ...auto, ...patch }, now).ok).toBe(false);
  expect(autopilotEligible({ ...item, blocks: 'T01, T02' }, config, { ...auto, perTask: { T02: 3 } }, now).ok).toBe(false);
  expect(autopilotEligible({ ...item, origin: { kind: 'interview' } }, config, { ...auto, interview: true }, now)).toEqual({ ok: true, option: 1 });
  expect(normalizeTitle('A31 색상  선택 (rev 2)')).toBe(normalizeTitle('A9 색상 선택 (rev 3)'));
});
it('출처는 곁 파일에만 존재, add 반환·판단 raw·hash 불변, dedupe·migrate 보존', async () => {
  const root = await project(), plain = await project();
  const before = await addJudgment(plain, { ...input, dedupeKey: 'same' });
  const added = await addCliJudgment(root, { ...input, dedupeKey: 'same' });
  expect(JSON.stringify(added)).toBe(JSON.stringify(before));
  const file = join(root, 'docs/판단대기.md'), raw = await readFile(file, 'utf8');
  expect(raw).toBe(await readFile(join(plain, 'docs/판단대기.md'), 'utf8'));
  expect(raw).not.toContain('fodh-origin');
  expect((await readJudgment(root)).items[0].origin).toEqual({ kind: 'cli' });
  const originPath = join(root, '.pi/harness-judgment-origin.json'), origins = await readFile(originPath, 'utf8');
  vi.stubEnv('FODH_BRAIN', '1'); expect(await isBrainProcess(root)).toBe(true);
  await addCliJudgment(root, { ...input, dedupeKey: 'same' });
  expect(await readFile(originPath, 'utf8')).toBe(origins);
  vi.unstubAllEnvs();
  const hash = questionHash((await readJudgment(root)).items[0]);
  await migrateJudgment(root);
  expect((await readJudgment(root)).items[0]).toMatchObject({ origin: { kind: 'cli' }, rev: 1 });
  expect(questionHash((await readJudgment(root)).items[0])).toBe(hash);
  vi.stubEnv('FODH_BRAIN', '1');
  await addCliJudgment(root, { ...input, title: '글꼴', dedupeKey: 'other' }, true);
  expect((await readJudgment(root)).items[1].origin).toEqual({ kind: 'brain' });
});
it.each(['{', 'null', '[]', '{"A1":{"kind":"bogus","createdAt":"today"}}'])('깨진 출처 파일은 fail closed %s', async content => {
  const { root } = await fixture(); await writeFile(join(root, '.pi/harness-judgment-origin.json'), content);
  expect((await readJudgment(root)).items[0].origin).toBeUndefined();
});
it('내부 판단과 재질문에는 출처를 부여하지 않는다', async () => {
  const root = await project(); const { item } = await addJudgment(root, input);
  expect((await readJudgment(root)).items[0].origin).toBeUndefined();
  await answerJudgment(root, item.id, '1 또는 2'); await applyJudgments(root);
  expect((await readJudgment(root)).items.every(item => !item.origin)).toBe(true);
});
it('인터뷰 추천 글 보존, 기본 선택·정규화 일치만 자동 선택', async () => {
  const root = await project(); await startInterview(root); await deferInterview(root, 'Q03-02');
  const item = (await readJudgment(root)).items[0];
  expect(item).toMatchObject({ recommend: '2~4주', origin: { kind: 'interview' } });
  expect(recommendedOption(item)).toBe(1);
  expect(recommendedOption({ ...item, recommend: '  두   번째 ', options: ['두 번째', '첫 번째'] })).toBe(1);
  expect(recommendedOption({ ...item, recommend: '별도', options: ['추천안 채택', '직접 답하기'] })).toBe(1);
  expect(recommendedOption({ ...item, recommend: '별도' })).toBeUndefined();
});
it('잠금 안 CAS는 사용자 답과 raw 변경을 거부', async () => {
  const { root, item } = await fixture();
  await answerJudgment(root, item.id, '2');
  const text = await readFile(join(root, 'docs/판단대기.md'), 'utf8');
  await expect(answerJudgment(root, item.id, '1', { expectEmpty: true, source: 'autopilot' })).rejects.toBeInstanceOf(AnswerConflict);
  await expect(answerJudgment(root, item.id, '1', { expectedRaw: item.raw })).rejects.toBeInstanceOf(AnswerConflict);
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toBe(text);
});
it.each(['file', 'cli'])('답 변경 %s는 자동 출처를 무효화하며 기록으로 전파하지 않는다', async mode => {
  const { root, item } = await fixture();
  await answerJudgment(root, item.id, '1', { source: 'autopilot' });
  expect((await readJudgment(root)).items[0].answerSource).toBe('autopilot');
  if (mode === 'file') { const p = join(root, 'docs/판단대기.md'); await writeFile(p, (await readFile(p, 'utf8')).replace('- 답: 1', '- 답: 2')); }
  else await answerJudgment(root, item.id, '2');
  expect((await readJudgment(root)).items[0].answerSource).toBeUndefined();
  await applyJudgments(root);
  expect((await readJudgment(root)).completed[0].answerSource).toBeUndefined();
});
it('답 출처·답 해시 migrate 보존 및 판단기록·최근 결정 반영', async () => {
  const { root, item } = await fixture(); await answerJudgment(root, item.id, '1', { source: 'autopilot' });
  await migrateJudgment(root); expect((await readJudgment(root)).items[0].answerSource).toBe('autopilot');
  await applyJudgments(root); const doc = await readJudgment(root);
  expect(doc.completed[0].answerSource).toBe('오토파일럿');
  const archive = await readFile(join(root, 'docs', doc.completed[0].path!), 'utf8');
  expect(parseArchive(archive)[0].answerSource).toBe('오토파일럿');
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toContain('→ 답 "1"(오토)');
});
it('기본 상태·켜기 초기화·끄기 취소·기간 상태', async () => {
  const root = await project(); expect(await readAutopilot(root)).toEqual({ enabled: false });
  await autopilotOn(root, { now, forMs: parseAutopilotDuration('8h'), max: 10, interview: true });
  expect(await autopilotStatus(root, new Date(now.getTime() + 3600000))).toMatchObject({ enabled: true, remainingMs: 7 * 3600000 });
  expect(await autopilotOff(root)).toMatchObject({ enabled: false, pending: {} });
  expect(await autopilotOn(root, { now })).toMatchObject({ answered: 0, perTask: {}, perScope: {}, stallResumed: {}, recentTitles: [], chat: { count: 0 } });
});
it.each(['0h', '8d', '1.5h', '-1m', '8', '30s'])('기간 검증 %s', value => expect(() => parseAutopilotDuration(value)).toThrow());
it.each([['delaySeconds', -1], ['delaySeconds', 601], ['maxAnswers', 0], ['maxAnswers', 201], ['perTaskMax', 11], ['perScopeMax', 0], ['maxChatReplies', 6], ['extra', 1]])('설정 거부 %s=%s', async (key, value) => {
  const root = await project(); await expect(setConfig(root, `autopilot.${key}`, JSON.stringify(value))).rejects.toThrow();
});
it('설정 기본값·일반 사용자 설정, CLI 옵션·경고·권한', async () => {
  const root = await project();
  expect((await loadConfig(root)).autopilot).toEqual({ delaySeconds: 30, maxAnswers: 30, perTaskMax: 3, perScopeMax: 3, maxChatReplies: 2 });
  expect(approvalConfigKeys).not.toContain('autopilot');
  expect((await cli(root, ['config', 'set', 'autopilot.delaySeconds', '0'])).code).toBe(0);
  const args = ['judgment', 'add', '--title', '색상', '--background', '화면', '--options', '파랑|초록', '--recommend', '파랑', '--blocks', '-'];
  expect((await cli(root, args)).value.warning).toBeUndefined();
  expect((await cli(root, ['autopilot', 'on', '--for', '8h', '--max', '30'])).code).toBe(0);
  expect((await cli(root, args)).value.warning).toContain('번호로 시작하지 않음');
  expect((await cli(root, ['autopilot', 'on', '--max', '201'])).code).toBe(1);
  await liveHarness(root); vi.stubEnv('FODH_BRAIN', '1');
  for (const action of ['on', 'off']) expect((await cli(root, ['autopilot', action])).value.error).toContain('두뇌 세션');
  expect((await cli(root, ['autopilot', 'status'])).code).toBe(0);
});
it.each(['harness-autopilot.json', 'harness-judgment-origin.json'])('기존 훅이 곁 파일 쓰기를 거부 %s', async name => {
  const result = await invoke('Write', { file_path: `@root@/.pi/${name}`, content: '{}' }, 'ARCH', { env: { FODH_BRAIN: '1' } });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(name === 'harness-judgment-origin.json' ? '판단대기 문서는 사용자만' : '가드 설정은 fodh로만');
});
it('11번째 이후 자동 선택도 원래 선택지로 적용, 수동 분류는 유지', async () => {
  const root = await project();
  const options = Array.from({ length: 21 }, (_, index) => `항목 ${index + 1}`);
  const { item } = await addJudgment(root, { ...input, options, recommend: '21번', origin: { kind: 'brain' } });
  expect(recommendedOption((await readJudgment(root)).items[0])).toBe(21);
  await answerJudgment(root, item.id, '21', { source: 'autopilot' });
  expect((await readJudgment(root, { answered: true })).items[0].classification).toMatchObject({ kind: 'choice', selection: 21 });
  expect((await applyJudgments(root)).applied[0].interpretation).toBe('항목 21');
});

it('빈 기간·다른 명령에 붙인 autopilot 옵션 거부', async () => {
  const root = await project();
  expect((await cli(root, ['autopilot', 'on', '--for', ''])).code).toBe(1);
  expect((await cli(root, ['state', 'get', '--max', '1'])).value.error).toContain("Unknown option '--max'");
});

it('답 검사 전 잠금을 기다리는 사이의 사용자 편집도 덮어쓰지 않는다', async () => {
  const { root, item } = await fixture();
  const file = join(root, 'docs/판단대기.md'), before = await readFile(file, 'utf8');
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquire = locks.acquireLock;
  vi.spyOn(locks, 'acquireLock').mockImplementation(async (path, options) => {
    if (path === file + '.lock') { entered(); await gate; }
    return acquire(path, options);
  });
  const pending = answerJudgment(root, item.id, '1', { expectEmpty: true, expectedRaw: item.raw, source: 'autopilot' });
  const rejected = expect(pending).rejects.toBeInstanceOf(AnswerConflict);
  await waiting;
  const edited = before.replace(/^- 답:/mu, '- 답: 2');
  try { await writeFile(file, edited); } finally { release(); }
  await rejected;
  expect(await readFile(file, 'utf8')).toBe(edited);
});

it.each(['직접 답하기', '  직접   답하기  ', '', '추천 없음 — 비교 불가'])('검수 M2: 인터뷰 기본 쌍 추천 제외 %s', async recommend => {
  const { item, config, auto } = await fixture();
  const interview = { ...item, origin: { kind: 'interview' as const }, options: ['추천안 채택', '직접 답하기'], recommend };
  expect(recommendedOption(interview)).toBeUndefined();
  expect(autopilotEligible(interview, config, { ...auto, interview: true }, now)).toEqual({ ok: false, reason: '추천 번호 없음' });
});
it('검수 L1: 잠금 소유자 자손이어도 명시적 두뇌 env가 없으면 cli 출처', async () => {
  const root = await project(); vi.stubEnv('FODH_BRAIN', undefined);
  vi.spyOn(locks, 'ownerAt').mockResolvedValue({ pid: process.ppid, token: 'parent', startedAt: now.toISOString() });
  vi.spyOn(locks, 'lockOwnerAlive').mockResolvedValue(true);
  expect(await isBrainProcess(root)).toBe(true);
  await addCliJudgment(root, input);
  expect((await readJudgment(root)).items[0].origin).toEqual({ kind: 'cli' });
  await expect(autopilotOn(root, { now })).rejects.toThrow('두뇌 세션');
});
it.each(['production', 'tokens', 'tags', 'resets', 'deployed', 'migrations', 'droplet'])('검수 L3: 확장 영문 차단 %s', async word => {
  const { item, config } = await fixture();
  expect(autopilotBlocked({ ...item, recommend: `① ${word}` }, config)).toBe(true);
});
it.each([['3개월 뒤', undefined], ['3.', 3], ['3)', 3], ['3번', 3], ['3 ', 3], ['3', 3], ['③개월 뒤', 3]])('검수 L5: 추천 숫자의 끝 경계 %s', async (recommend, expected) => {
  const { item } = await fixture();
  expect(recommendedOption({ ...item, options: ['하나', '둘', '셋'], recommend: String(recommend) })).toBe(expected);
});
it('검수 L2: off·status CLI JSON은 현재 미적용 자동 답만 표시', async () => {
  const { root } = await fixture();
  await answerJudgment(root, 'A1', '1', { source: 'autopilot' });
  const before = await readFile(join(root, 'docs/판단대기.md'), 'utf8');
  expect((await cli(root, ['autopilot', 'off'])).value).toMatchObject({ enabled: false, unappliedAutoAnswers: ['A1'] });
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toBe(before);
  expect((await cli(root, ['autopilot', 'status'])).value.unappliedAutoAnswers).toEqual(['A1']);
  await answerJudgment(root, 'A1', '2');
  expect((await cli(root, ['autopilot', 'status'])).value.unappliedAutoAnswers).toEqual([]);
});
