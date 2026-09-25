import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { addTask, getTask, setTask } from '../src/core/backlog.ts';
import { addJudgment, readJudgment, similarJudgmentTitle } from '../src/core/judgment.ts';
import { readLedger } from '../src/core/ledger.ts';
import { updateState, readState } from '../src/core/state.ts';
import { tick } from '../src/core/watcher.ts';
const input = { title: 'git 커밋 권한 문제', background: '오류 원문', options: ['재개', '보류'], recommend: '재개', blocks: '-' };
const add = (task: string, title = input.title, extra: string[] = []) => ['judgment', 'add', '--title', title,
  '--background', input.background, '--options', input.options.join('|'), '--recommend', input.recommend, '--blocks', task, ...extra];
async function taskProject() {
  const root = await project('IDLE');
  const a = await addTask(root, { title: '첫 작업', category: 'docs' });
  const b = await addTask(root, { title: '다음 작업', category: 'docs' });
  return { root, a, b };
}
it('P8 CLI 동일 task는 제목·distinct와 무관하게 기존 판단 1개와 dedupe 원장', async () => {
  const { root, a } = await taskProject();
  const first = await cli(root, add(a.id));
  expect(first.code).toBe(0);
  const next = await cli(root, add(a.id, '전혀 다른 문구', ['--distinct']));
  expect(next).toMatchObject({ code: 0, value: { item: { id: first.value.item.id }, deduped: 'same-task' } });
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await getTask(root, a.id)).status).toBe(`blocked(${first.value.item.id})`);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'judgment:dedupe',
    evidence: { taskId: a.id, existing: first.value.item.id, title: '전혀 다른 문구' } }));
});
it('P8 CLI 유사 제목은 exit 1 안내, distinct는 유사도만 건너뛴다', async () => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id));
  const next = await cli(root, add(b.id, `${b.id} git 커밋 권한 제한`));
  expect(next).toEqual({ code: 1, value: { error: `비슷한 열린 판단 ${first.value.item.id}(${input.title})이 있습니다. 같은 원인이면 --same-as ${first.value.item.id} 로 이 task 를 붙이고, 다른 원인이면 --distinct 를 붙여 다시 등록하라` } });
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await getTask(root, b.id)).status).toBe('ready');
  expect((await cli(root, add(b.id, `${b.id} git 커밋 권한 제한`, ['--distinct']))).code).toBe(0);
  expect((await readJudgment(root)).items).toHaveLength(2);
});
it('P8 CLI same-as는 task·해시를 갱신하고 rev/워처 사용자 변경 없이 답 적용 때 함께 푼다', async () => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id)), id = first.value.item.id;
  const now = Date.now(); await tick(root, { judgmentOnly: true, now });
  const path = join(root, '.pi/harness-watcher.json');
  const before = JSON.parse(await readFile(path, 'utf8')).judgment.questions[id];
  for (let i = 0; i < 2; i++) expect(await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', b.id]))
    .toMatchObject({ code: 0, value: { item: { id, blocks: `${a.id}, ${b.id}`, rev: 1 } } });
  const after = JSON.parse(await readFile(path, 'utf8')).judgment.questions[id];
  expect(after.rev).toBe(before.rev); expect(after.hash).not.toBe(before.hash);
  expect((await readJudgment(root)).items[0].rev).toBe(1);
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toContain(`- 막힌 작업: ${a.id}, ${b.id}\n`);
  for (const at of [now + 1, now + 11000]) expect((await tick(root, { judgmentOnly: true, now: at })).emitted)
    .not.toContainEqual(expect.objectContaining({ kind: 'judgment-changed' }));
  expect((await getTask(root, b.id)).status).toBe(`blocked(${id})`);
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'judgment:attach', evidence: { taskId: b.id, judgment: id } }));
  expect((await cli(root, ['judgment', 'answer', id, '1'])).code).toBe(0);
  expect((await cli(root, ['judgment', 'apply', id])).value.applied).toHaveLength(1);
  expect((await getTask(root, a.id)).status).toBe('ready'); expect((await getTask(root, b.id)).status).toBe('ready');
});
it('P8 CLI same-as는 없는 대상·답 있는 대상·완료 task·복수 task를 거부한다', async () => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id)), id = first.value.item.id;
  expect((await cli(root, ['judgment', 'add', '--same-as', 'A999', '--blocks', b.id])).code).toBe(1);
  expect((await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', `${a.id},${b.id}`])).code).toBe(1);
  await cli(root, ['judgment', 'answer', id, '1']);
  expect((await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', b.id])).value.error).toContain('답이 있는 판단');
  await cli(root, ['judgment', 'answer', id, '']);
  await setTask(root, b.id, { status: 'done', verify: { ok: true }, review: { high: 0, commit: 'none' }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } });
  expect((await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', b.id])).value.error).toContain('완료 task');
  expect((await readJudgment(root)).items[0].blocks).toBe(a.id);
});
it.each(['same-task', 'same-as'])('P8 CLI %s reclaim은 기존 id로 회수한다', async mode => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id)), id = first.value.item.id;
  const task = mode === 'same-task' ? a : b;
  await setTask(root, task.id, { status: 'doing' });
  await updateState(root, { state: 'IMPLEMENT', phase: 'task', taskId: task.id });
  const result = await cli(root, mode === 'same-task' ? add(task.id, '새 설명', ['--reclaim'])
    : ['judgment', 'add', '--same-as', id, '--blocks', task.id, '--reclaim']);
  expect(result).toMatchObject({ code: 0, value: { judgment: id, reclaimed: true, next: 'PICK', item: { id } } });
  if (mode === 'same-task') expect(result.value.deduped).toBe('same-task');
  expect((await readState(root)).state).toBe('PICK');
  expect((await getTask(root, task.id)).status).toBe(`blocked(${id})`);
  expect((await readJudgment(root)).items).toHaveLength(1);
});
it('P8 내부 addJudgment 직접 호출은 task/제목 중복 정책의 영향을 받지 않는다', async () => {
  const root = await project();
  await addJudgment(root, input); await addJudgment(root, input);
  expect((await readJudgment(root)).items).toHaveLength(2);
});
it.each([
  ['T05 검증 실패', 'T03 설정 결정'], ['문서 번역 범위', '테스트 실행 시간'],
])('P8 서로 다른 제목 %s / %s는 CLI에서 모두 생성', async (aTitle, bTitle) => {
  const { root, a, b } = await taskProject();
  expect((await cli(root, add(a.id, aTitle))).code).toBe(0);
  expect((await cli(root, add(b.id, bTitle))).code).toBe(0);
});
it('P8 제목 토큰은 소문자·기호·task/판단 번호·1글자를 정규화한다', () => {
  expect(similarJudgmentTitle('T05 A20 GIT: 커밋 권한! x', 'T03 A21 git 커밋 권한')).toBe(true);
  expect(similarJudgmentTitle('T05 git x', 'T03 git y')).toBe(false);
});
it('P8 두뇌 규칙과 VERIFY/IMPLEMENT/FIX는 원문 오류와 same-as 사용을 안내한다', async () => {
  expect(await readFile('templates/brain-rules.md', 'utf8')).toContain('`fodh` 출력은 파이프(`| jq`, `| head`, `2>/dev/null` 등)로 가공하지 말고 그대로 읽는다. JSON 에 `error` 키가 있으면 그 문구가 원인이며, 원인을 추측해 판단을 만들지 않는다.');
  expect(await readFile('templates/prompts/VERIFY.md', 'utf8')).toContain('1. git 프로젝트는 먼저 `fodh worktree commit {{taskId}} -m "{{taskId}} 구현"`을 실행한다(`-m` 은 반드시 붙인다. 실패하면 출력의 `error` 를 그대로 읽는다).');
  for (const name of ['VERIFY', 'IMPLEMENT', 'FIX']) expect(await readFile(`templates/prompts/${name}.md`, 'utf8')).toContain('--same-as A<n> --blocks {{taskId}}');
});

it('P8-c CLI 답이 있고 미적용인 정확한 재등록은 기존 판단과 task 연결을 유지한다', async () => {
  const { root, a } = await taskProject();
  const first = await cli(root, add(a.id));
  await cli(root, ['judgment', 'answer', first.value.item.id, '1']);
  const next = await cli(root, add(a.id));
  expect(next).toMatchObject({ code: 0, value: { item: { id: first.value.item.id, answer: '1' }, deduped: 'same-key' } });
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await getTask(root, a.id)).status).toBe(`blocked(${first.value.item.id})`);
  expect((await cli(root, ['judgment', 'apply', first.value.item.id])).value.applied).toHaveLength(1);
  expect((await getTask(root, a.id)).status).toBe('ready');
});

it.each(['-', 'T01, T02', 'T01'])('P8-c 정확한 재등록 blocks=%s는 유사도·same-task보다 먼저 기존 key를 반환한다', async blocks => {
  const { root } = await taskProject();
  const first = await cli(root, add(blocks));
  expect(first.code).toBe(0);
  expect(await cli(root, add(blocks))).toMatchObject({ code: 0, value: { item: { id: first.value.item.id }, deduped: 'same-key' } });
  expect((await readJudgment(root)).items).toHaveLength(1);
});
it.each(['-', 'T01, T02'])('P8-c 단일 task가 아닌 blocks=%s의 유사도 안내는 same-as를 제안하지 않는다', async blocks => {
  const { root } = await taskProject();
  const first = await cli(root, add(blocks));
  expect(first.code).toBe(0);
  expect(await cli(root, add(blocks, 'git 커밋 권한 제한'))).toEqual({ code: 1, value: {
    error: `비슷한 열린 판단 ${first.value.item.id}(${input.title})이 있습니다. 같은 원인이면 새로 등록하지 말고 그 판단을 기다려라. 다른 원인이면 --distinct 를 붙여 다시 등록하라`,
  } });
  expect((await readJudgment(root)).items).toHaveLength(1);
});
it('P8-c same-as는 프로젝트 판단의 -를 taskId로 치환한다', async () => {
  const { root, a } = await taskProject();
  const first = await cli(root, add('-'));
  expect(first.code).toBe(0);
  expect(await cli(root, ['judgment', 'add', '--same-as', first.value.item.id, '--blocks', a.id]))
    .toMatchObject({ code: 0, value: { item: { blocks: a.id } } });
  expect((await readJudgment(root)).items[0].blocks).toBe(a.id);
});
it.each([false, true])('P8-c same-as는 다른 판단 연결을 보호하고 같은 판단에는 멱등이다(하위 번호=%s)', async suffix => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id));
  const second = await cli(root, add(b.id, '문서 번역 범위'));
  expect(first.code).toBe(0); expect(second.code).toBe(0);
  const id = second.value.item.id + (suffix ? '-1' : '');
  if (suffix) {
    const path = join(root, 'docs/판단대기.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace(`### ${second.value.item.id} —`, `### ${id} —`));
    await setTask(root, b.id, { status: `blocked(${id})`, judgment: id });
  }
  const before = await readFile(join(root, 'docs/판단대기.md'), 'utf8');
  expect(await cli(root, ['judgment', 'add', '--same-as', first.value.item.id, '--blocks', b.id]))
    .toEqual({ code: 1, value: { error: `task ${b.id} 는 이미 ${id} 에 묶여 있습니다` } });
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toBe(before);
  expect((await getTask(root, b.id)).status).toBe(`blocked(${id})`);
  expect(await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', b.id]))
    .toMatchObject({ code: 0, value: { item: { id, blocks: b.id } } });
  expect((await readJudgment(root)).items).toHaveLength(2);
});

// Fable이 토이 docs/판단대기.md에서 추출한 제목 원문. ID는 토이 출처이며 CLI가 새 ID를 배정한다.
const toyTitles = {
  A19: 'T04 git 커밋 권한 해결',
  A20: 'worktree git add/commit 권한 문제 일괄 해결',
  A21: '모든 worktree git add/commit 권한 일괄 해결',
  A22: 'T06 worktree git 커밋 권한',
};
it.each([
  ['A19', 'A20'], ['A20', 'A21'], ['A19', 'A22'],
] as const)('P8-b 토이 원문 %s 뒤 %s는 다른 task의 CLI 등록도 거부한다', async (existing, next) => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id, toyTitles[existing]));
  expect(first.code).toBe(0);
  const duplicate = await cli(root, add(b.id, toyTitles[next]));
  expect(duplicate).toMatchObject({ code: 1, value: { error: expect.stringContaining(`비슷한 열린 판단 ${first.value.item.id}(`) } });
  expect(duplicate.value.error).toContain(`--same-as ${first.value.item.id}`);
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await getTask(root, b.id)).status).toBe('ready');
});
it('P8-b 토이 A19·A20을 distinct로 함께 둬도 A21의 CLI 중복 등록은 거부한다', async () => {
  const { root, a, b } = await taskProject();
  const c = await addTask(root, { title: '세 번째 작업', category: 'docs' });
  const first = await cli(root, add(a.id, toyTitles.A19, ['--distinct']));
  const second = await cli(root, add(b.id, toyTitles.A20, ['--distinct']));
  expect(first.code).toBe(0); expect(second.code).toBe(0);
  expect(second.value.item.id).not.toBe(first.value.item.id);
  const duplicate = await cli(root, add(c.id, toyTitles.A21));
  expect(duplicate).toMatchObject({ code: 1, value: { error: expect.stringContaining('비슷한 열린 판단') } });
  expect((await readJudgment(root)).items).toHaveLength(2);
  expect((await getTask(root, c.id)).status).toBe('ready');
});

it('A16 R9 답 있는 판단도 이미 연결된 task의 same-as 재시도는 멱등이다', async () => {
  const { root, a, b } = await taskProject();
  const first = await cli(root, add(a.id)), id = first.value.item.id;
  expect((await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', b.id])).code).toBe(0);
  expect((await cli(root, ['judgment', 'answer', id, '1'])).code).toBe(0);
  const before = await readFile(join(root, 'docs/판단대기.md'), 'utf8');
  expect(await cli(root, ['judgment', 'add', '--same-as', id, '--blocks', b.id]))
    .toMatchObject({ code: 0, value: { item: { id, answer: '1', blocks: `${a.id}, ${b.id}` } } });
  expect(await readFile(join(root, 'docs/판단대기.md'), 'utf8')).toBe(before);
  expect((await readJudgment(root)).items).toHaveLength(1);
  expect((await getTask(root, b.id)).status).toBe(`blocked(${id})`);
});
