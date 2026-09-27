import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { instruction } from '../extensions/orchestrator/resume.ts';
import { invokeWorkspace } from './w3a-helpers.ts';
import { invoke } from './hook-helpers.ts';
import { single } from './w3b-helpers.ts';
const golden = JSON.parse(await readFile(new URL('./fixtures/w3b-single-golden.json', import.meta.url), 'utf8')) as { before: Record<string, string> };
const retry = "단 거부 문구에 `리터럴 경로로 쓰세요`·`git 전역 옵션은`·`단순한 명령으로 나눠 쓰세요` 가 있으면 같은 명령을 되풀이하지 말고, 명령을 나누거나 리터럴 경로·허용된 git 전역 옵션만 쓰는 꼴로 고쳐 한 번만 다시 친다.";
const mergeRule = "MERGE 의 병합은 `fodh worktree merge <T>` 로만 한다(`git merge` 를 직접 치지 않는다). 실패하면 재시도하거나 git 으로 정리하지 않고 `fodh judgment add … --blocks <T> --reclaim` 으로 올린다. 비-git 프로젝트는 `fodh backlog set <T> --merge-commit none` 이다.";
const workflow = "| MERGE | `fodh worktree merge <T>`(비-git 은 `fodh backlog set <T> --merge-commit none`) 뒤 `fodh state transition DOCS`, 실패 → `fodh judgment add … --blocks <T> --reclaim` |\n| DOCS | 실제 증거를 `fodh backlog set <T>`에 기록 |";
const specWriting = "워크스페이스 모드면 스펙 머리에 대상 레포(`fodh backlog get <T>` 의 `repo`)와 그 레포의 검증 명령을 적는다. task 하나 = 레포 하나다. 다른 레포도 고쳐야 하면 이 스펙은 한 레포로 줄이고, 나머지는 `fodh backlog add --title <제목> --category <분류> --repo <이름> --depends <T>` 로 쪼갠다.";
const merge = "# MERGE\n## 지금 할 일\n1. `fodh backlog get {{taskId}}`으로 `review.commit`과 `review.high = 0`을 확인한다.\n2. `fodh worktree merge {{taskId}}`로 병합한다. 하네스가 task 레포의 기준 브랜치에 병합 커밋을 만들고 `merge.commit`을 기록한다. `git merge` 를 직접 치지 않는다. 비-git 프로젝트는 병합 없이 `fodh backlog set {{taskId}} --merge-commit none` 이다.\n3. 출력에 `warnings`(추적 안 된 파일 등)가 있으면 DOCS 작업일지에 옮겨 적는다. 출력에 `error` 가 있으면 그 문구가 원인이다.\n4. `fodh state transition DOCS --task {{taskId}} --commit <review.commit>`으로 전이한다.\n병합 실패(충돌·기준 브랜치·미커밋 변경·커밋 훅 거부)는 재시도하거나 git 으로 정리하지 않고 아래 판단 등록·회수 명령으로 회수한다.\n## 산출물\n하네스가 만든 병합 커밋과 `merge.commit` 기록.\n## 끝내는 조건\n`fodh backlog get {{taskId}}` 에 `merge.commit` 이 있고, 검수 대상과 실제 작업 SHA 가 일치한다.\n## 다음 fodh 명령\n- 완료 → `fodh state transition DOCS --task {{taskId}} --commit <검수한작업sha>`\n- 병합 실패·승인 필요 → `fodh judgment add --title \"<제목>\" --background \"<배경>\" --options \"선택1|선택2\" --recommend \"<추천>\" [--detail <문서>] --blocks {{taskId}} --reclaim` 판단 등록 시 배경은 두 문장 안으로 쓴다. 긴 근거는 문서에 쓰고 `--detail <문서>`로 연결한다.\n## 금지\n두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.\n승인 미결 동작을 실행하지 않는다.\nreview.commit 을 바꾸는 판단을 만들지 않는다.\n`git merge`·`git merge --abort`·`git reset` 으로 병합하거나 실패한 병합을 정리하지 않는다.\n`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim`\n";
it('T1 brain rules change only the two exact specified places', async () => {
  const path = 'templates/brain-rules.md', lines = golden.before[path].split('\n');
  lines[2] = lines[2].replace('위임(fodh codex task / Claude Agent)으로 바꾼다. `[보호]`', '위임(fodh codex task / Claude Agent)으로 바꾼다. ' + retry + ' `[보호]`');
  lines.splice(8, 0, mergeRule);
  expect(await readFile(path, 'utf8')).toBe(lines.join('\n'));
});
it('T2 workflow has exactly the two new flow rows', async () => {
  const path = 'skills/fodh-workflow/SKILL.md', lines = golden.before[path].split('\n');
  lines.splice(14, 1, workflow);
  expect(await readFile(path, 'utf8')).toBe(lines.join('\n'));
});
it('T3 spec skill adds only the single workspace line', async () => {
  const path = 'skills/fodh-spec-writing/SKILL.md', lines = golden.before[path].split('\n');
  lines.splice(9, 0, specWriting);
  expect(await readFile(path, 'utf8')).toBe(lines.join('\n'));
});
it('T4 MERGE exact full text and instruction substitution', async () => {
  expect(await readFile('templates/prompts/MERGE.md', 'utf8')).toBe(merge);
  const { root } = await single(); const rendered = await instruction(root, { state: 'MERGE', taskId: 'T01' });
  expect(rendered).toBe(merge.replaceAll('{{taskId}}', 'T01'));
  expect(rendered).toContain('fodh worktree merge T01'); expect(rendered).not.toContain('{{');
});
it('T5 brain MERGE command passes both unchanged hook paths', async () => {
  expect(await invokeWorkspace('Bash', { command: 'fodh worktree merge T01' }, { state: 'MERGE' })).toEqual({ code: 0, stderr: '' });
  expect(await invoke('Bash', { command: 'fodh worktree merge T01' }, 'MERGE', { env: { FODH_BRAIN: '1' } })).toMatchObject({ code: 0, stderr: '' });
});
