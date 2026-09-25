import { expect, it } from 'vitest';
import { invoke } from './hook-helpers.ts';
import { shellParts } from '../hooks/shell-parts.mjs';
import { shellCommands } from '../hooks/shell-commands.mjs';
import { auditPathReport } from '../src/core/audit.ts';

// All shell examples remain JSON input; the hook inspects them without execution.
const hook = (command: string, brain = true) => invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp' } });
it.each([
  'OUT=$(npm test 2>&1)', 'x=$(git status --short 2>&1)', 'x=$(npm test >/dev/null 2>&1)',
  'OUT=`npm test 2>&1`', 'if ! out=$(npm test 2>&1); then echo failed; fi',
  'npm test 2>&1 | tee .pi/scratch/t-$(date +%F).log',
  'OUT=$(echo "$(npm test 2>&1)")', 'x=$((1 + 2))', 'diff <(cat a) <(cat b)',
  '{ npm test; npm run lint; } 2>&1 | tail -30', '{ echo a; echo b; } > .pi/scratch/out',
  '(cd docs && ls) > .pi/scratch/x', '(echo a; echo b) > .pi/scratch/x 2>&1',
  'echo x > docs/$(date +%F)-note.md', 'echo x > docs/C#.md',
  'unzip -l a.zip', 'unzip -l app.ipa | grep Info.plist', 'unzip -t a.zip', 'unzip -p a.zip x.json | jq .',
  'tar -xOf a.tar x.json', 'bsdtar -xOf a.tar x.json', 'tar -xf a.tar --to-stdout',
  'unzip -v a.zip', 'unzip -c a.zip', 'unzip -z a.zip', 'unzip -Z a.zip', 'tar -tf a.tar', 'zipinfo a.zip', '7z l a.zip',
  'case $x in a) echo a; echo b;; esac', 'case $x in a|b) echo ab;; esac',
  'case $x in\na)\necho a\necho b\n;;\nb|c) echo bc;;&\n*) echo default;&\nesac',
  'function f() { echo hi; }; f', 'rm -rf .pi/scratch/x 2>/dev/null', 'T=$(mktemp -d); rm -rf "$T" 2>/dev/null',
])('U1~U7 정상 두뇌 작업 허용: %s', async command => expect(await hook(command)).toMatchObject({ code: 0 }));
it.each([
  'echo x > $(date +%F).log', 'npm test | tee test-$(date +%s).log', 'curl -o $(basename $URL) $URL',
  'echo x > issue#12.txt', 'echo x > a^b.txt', 'echo x > docs/$(date +%F)-note.md', 'echo x > docs/*.md',
])('U3 사용자 정상 목적지 허용: %s', async command => expect(await hook(command, false)).toMatchObject({ code: 0 }));
it.each([
  '(echo x > .pi/harness.json) 2>&1', '(cp x .pi/harness.json) 2>/dev/null', '{ echo x; } > .pi/harness.json',
  '{ echo a; echo b; } > .claude/settings.json 2>&1', '(echo a; echo b) > .pi/harness.json',
  'cp -l .pi/harness.json .pi/scratch/h', 'cp -s .claude/settings.json x',
  'cp -al .pi/harness.json .pi/scratch/h', 'cp --link .pi/harness.json x', 'cp --symbolic-link .claude/settings.json x',
  'rsync --remove-sent-files .pi/harness.json /tmp/x', 'echo x > .pi/harnes?.json',
])('U2/U5 보호 대상 사용자·두뇌 거부: %s', async command => {
  for (const brain of [true, false]) expect(await hook(command, brain)).toMatchObject({ code: 2 });
});
it.each([
  'echo "$(rm -rf src)"', 'x=$(prisma migrate deploy)', 'diff <(rm -rf src) x',
  '(cp .pi/scratch/j.md docs/판단대기.md) 2>&1', 'unzip a.zip', 'tar -xf a.tar',
  'case $x in a) echo a; rm -rf src;; esac', 'case $x in a|b) prisma migrate deploy;; esac',
  'case $x in\na)\necho a\nrm -rf src\n;;\nesac', 'function f() { rm -rf src; }; f',
  'rm -rf src 2>/dev/null', 'echo x > docs/판단대?.md', 'echo x > ~/.zshen?',
  'touch .pi/scratch/*.log(N)', 'cp -l docs/판단대기.md .pi/scratch/j',
])('U1~U7 위험 명령 거부 유지: %s', async command => expect(await hook(command)).toMatchObject({ code: 2 }));
it.each(['echo x > $VAR/x', 'echo x > ${VAR}/x', 'echo x > `dirname x`/out'])('U8 빈 접두는 기존 경계 문구: %s', async command => {
  expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining('소스 파일은 두뇌가 쓰지 않습니다') });
});
it('U8 외부 정적 접두는 동적 경로 문구 유지(V6 보호 매칭 제외)', async () => {
  expect(await hook('echo x > /Users/$USER/out.txt')).toMatchObject({ code: 2, stderr: expect.stringContaining('동적 쓰기 경로') });
});
it.each(['OUT=$(npm test 2>&1)', 'OUT=`npm test 2>&1`', 'T=$(echo "a (b)")', 'x=$((1 + 2))'])('U1 치환 단어 보존: %s', command => {
  expect(shellParts(command).groups).toEqual([[command]]);
  expect(auditPathReport('Bash', { command }, { root: '/project', docsRoot: 'docs', worktrees: [] })).toEqual({ boundary: [], unresolved: [] });
});
it('U1 프로세스 치환은 단어 하나이며 본문은 별도 검사', () => {
  expect(shellParts('diff <(cat a) <(cat b)').groups).toEqual([['diff', '<(cat a)', '<(cat b)']]);
  expect(shellCommands('diff <(cat a) <(cat b)').entries.map(entry => entry.words)).toContainEqual(['cat', 'a']);
});
it.each([true, false])('U2 모든 그룹 내부 명령에 출력 목적지 전달 extended=%s', extended => {
  const entries = shellCommands('{ echo a; echo b; } > .pi/scratch/out', { extended }).entries;
  for (const value of ['a', 'b']) expect(entries.some(entry => entry.words[0] === 'echo' && entry.words[1] === value && entry.words.includes('.pi/scratch/out'))).toBe(true);
});
