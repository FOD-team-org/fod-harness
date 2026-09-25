import { expect, it } from 'vitest';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { invoke } from './hook-helpers.ts';
import { shellParts, expansionEnd } from '../hooks/shell-parts.mjs';
import { shellCommands } from '../hooks/shell-commands.mjs';
import { auditPathReport } from '../src/core/audit.ts';

// These strings are JSON input to the hook, never commands executed by a shell.
const hook = (command: string, brain = true) => invoke('Bash', { command }, 'DOCS', { env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp' } });
const commit = (message: string, delimiter = "'EOF'") => `git commit -m "$(cat <<${delimiter}\n${message}\nEOF\n)"`;
it.each([
  [commit("fix: don't crash") + ' && git push origin main', '[승인]'],
  [commit("fix: don't crash") + ' && echo x > .pi/harness.json', '가드 설정'],
  [commit("fix: user's bug") + '; npx prisma migrate deploy', '[승인]'],
  [commit('fix (see below') + ' && git push origin main', '[승인]'],
  ["x=$(cat <<'EOF'\ndon't\nEOF\n); echo x > .pi/harness.json", '가드 설정'],
])('V1 사용자 heredoc 뒤 명령 검사: %s', async (command, message) => {
  expect(await hook(command, false)).toMatchObject({ code: 2, stderr: expect.stringContaining(message) });
});
it.each([
  commit("docs: fix today's log"), commit('docs: "quote (', '\\EOF'), commit('docs: "quote (', '"EOF"'),
  "git commit -m \"$(cat <<-'EOF'\n\tdocs: today's log\n\tEOF\n)\"",
  "git commit -m \"$(cat <<A <<'B'\ndon't\nA\n(\nB\n)\"",
  'echo $(( 1 << 2 ))', 'x=$(cat <<< "hello")',
  'npm test # don\'t care', "# don't worry\nnpm test", 'echo "a # b"', 'echo x#y', 'echo $# ${#x} issue#12',
  "x=$(# don't care\necho ok)", "x=`# don't care\necho ok`",
  '(npm test 2>&1) | tail -5', '(cd docs && npm test 2>&1) | tail -20',
  '(npm test >/dev/null 2>&1) && echo ok', '(npm test > .pi/scratch/o 2>&1)',
  'if (npm test 2>&1); then echo ok; fi',
  'echo x > docs/$(date +%F)-note.md', 'T=$(mktemp -d); rm -rf "$T"', 'rm -rf /private/tmp/tmp.AbCd1234',
])('V1~V6 정상 두뇌 명령 허용: %s', async command => expect(await hook(command)).toMatchObject({ code: 0 }));
it.each([
  "# Let's apply the migration\nnpx prisma migrate deploy\n# Check it's applied\nnpx prisma migrate status",
  "# don't forget\necho x > .pi/harness.json\n# that's it",
  "npm test # it's fine\necho x > .pi/harness.json # that's it",
  "# Check what's pending\nnpx prisma migrate deploy", "npm test # don't skip\ngit push origin main",
  '(echo x > .pi/harness.json)2>&1', '(cp x .pi/harness.json)2>/dev/null',
  '(echo x >& .pi/harness.json)',
  'echo x > .pi/harness.json$(true)', 'echo x > .pi/$X', 'echo x > $D/settings.json',
  'echo x > .pi/${X}', 'echo x > .pi/`printf harness.json`', 'echo x > ".pi/$X"',
])('V2/V4/V6 사용자·두뇌 거부: %s', async command => {
  for (const brain of [false, true]) expect(await hook(command, brain)).toMatchObject({ code: 2 });
});
it.each([
  commit("docs: fix today's log") + ' && rm -rf src',
  "# Let's clean the old build\nrm -rf src/gen\n# Now it's clean\nls",
  '(npm test > src/x 2>&1)', 'echo x > docs/판단대기.md$(true)', 'echo x > ~/.zshenv$(true)',
  "x=$(# don't hide\nrm -rf src)",
])('V1/V2/V3/V6 두뇌 거부 유지: %s', async command => expect(await hook(command)).toMatchObject({ code: 2 }));
it.each([
  'T=$(mktemp -d); cp README.md "$T"/; ls "$T"; rm -rf "$T"',
  'T=$(mktemp -d); read T; rm -rf "$T"',
])('V5 임시 변수 예외 불가 안내: %s', async command => {
  expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]: 임시 변수 예외를 줄 수 없는 조합입니다. mktemp 가 출력한 리터럴 경로로 지우세요(셸 변수는 호출 사이에 남지 않습니다)') });
});
it.each(['echo x > "$LOG"', 'echo x > $X', 'npm test | tee test-$(date +%s).log', "echo x > '.pi/$X'", 'echo x > .pi/\\$X'])('V6 사용자 허용 유지: %s', async command => expect(await hook(command, false)).toMatchObject({ code: 0 }));
it.each([
  'x=$(echo ok; echo x > .pi/harness.json', 'x=`echo ok; echo x > .pi/harness.json',
])('V1 닫히지 않은 치환도 뒤 명령은 계속 토큰화: %s', async command => {
  expect(expansionEnd(command, 2)).toBeUndefined();
  expect(shellParts(command).groups.at(-1)).toContain('.pi/harness.json');
  expect(shellCommands(command).unresolved).toBe(true);
  for (const brain of [false, true]) expect(await hook(command, brain)).toMatchObject({ code: 2 });
});
it('V1 치환 내부 heredoc 뒤 쓰기를 감사한다', () => {
  const command = commit("fix: don't crash") + ' && echo x > src/x.ts';
  expect(auditPathReport('Bash', { command }, { root: '/project', docsRoot: 'docs', worktrees: [] }).boundary).toContain('/project/src/x.ts');
});
it('V2 주석 사이 쓰기를 감사하고 주석 본문은 후보에서 뺀다', () => {
  const command = "# don't forget > src/comment.ts\necho x > src/x.ts\n# that's it";
  expect(auditPathReport('Bash', { command }, { root: '/project', docsRoot: 'docs', worktrees: [] }).boundary).toEqual(['/project/src/x.ts']);
});

it('V6 시작 파일에 맞는 외부 동적 경로는 보호 문구를 우선한다', async () => {
  expect(await hook(`echo x > ${dirname(homedir())}/$USER/.zshenv`)).toMatchObject({ code: 2, stderr: expect.stringContaining('셸 시작 파일은 두뇌가 바꿀 수 없습니다') });
});
it.each([
  "x=`cat <<'EOF'\ndon't (\nEOF\n`; echo x > .pi/harness.json",
  "x=$(cat <<-'EOF'\n\tdon't (\n\tEOF\n); echo x > .pi/harness.json",
  "echo ok;# don't hide\necho x > .pi/harness.json",
  "(# don't hide\necho x > .pi/harness.json)",
])('V1/V2 heredoc·연산자 뒤 주석에서도 후속 보호 검사: %s', async command => {
  for (const brain of [false, true]) expect(await hook(command, brain)).toMatchObject({ code: 2 });
});
