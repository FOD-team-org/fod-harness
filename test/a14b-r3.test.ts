import { it, expect } from 'vitest';
import { invoke } from './hook-helpers.ts';
import { shellParts } from '../hooks/shell-parts.mjs';

// Dangerous examples are JSON data for the hook, never executed as shell commands.
const hook = (command: string, brain = true, home = false) => invoke('Bash', { command }, 'IMPLEMENT', {
  env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp', ...(home ? { HOME: '@root@/home', ZDOTDIR: '@root@/zdot' } : {}) }, worktrees: true,
});
const denied = async (command: string, brain = true, home = false) => expect(await hook(command, brain, home), command).toMatchObject({ code: 2 });
it.each([
  'T=$(mktemp -d); : ${T::=src}; rm -rf "$T"', 'T=$(mktemp -d); : ${T::=src}; echo x > "$T/a.ts"',
  'T=$(mktemp -d /tmp/fodh-nx/x.XXXX); : ${T:=src}; rm -rf "$T"',
  'echo "${T::=.pi/harness.json}"; echo "{}" > "$T"',
  String.raw`T=$(mktemp -d); X=$(printf '\x54'); declare -n R=$X; R=src; rm -rf "$T"`,
  'T=$(mktemp -d); : ${(P)X::=src}; echo x > "$T"', 'T=$(mktemp -d); : ${T=src}; rm -rf "$T"',
  "alias mktemp='echo src'; T=$(mktemp -d); rm -rf \"$T\"",
  'PATH=$PWD/.pi/scratch:$PATH; T=$(mktemp -d); rm -rf "$T"',
  ...['declare -rn R=$X', 'typeset -gn R=$X', 'local -n R=$X', 'echo ${(e)X}',
    'unalias mktemp', 'hash mktemp', 'enable mktemp', 'functions mktemp', 'autoload mktemp',
    'export FPATH', 'declare IFS', 'path=src', 'BASH_ENV=script.sh', 'ENV=script.sh', 'ZDOTDIR=src']
    .map(form => `T=$(mktemp -d); ${form}; echo x > "$T"`),
])('P1 확장 대입·명령 해석 변경 시 임시 예외 거부: %s', async command => denied(command));
it.each([
  'f () { CMD; }; f', 'function g () { CMD; }', 'f()(CMD); f', 'my-fn() { CMD; }; my-fn',
  '() { CMD; }', 'if(CMD); then :; fi', 'until(CMD); do :; done', 'repeat 1 CMD', 'foreach x (a) CMD; end',
  'function { CMD; }', 'select x in a; do CMD; done', 'coproc job (CMD)',
])('P2 모르는 구조 fail-closed: %s', async form => {
  for (const cmd of ['rm -rf src', 'prisma migrate deploy']) {
    expect(await hook(form.replace('CMD', cmd))).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
  }
});
it.each([
  'time { CMD; }', 'nocorrect CMD', 'noglob CMD', 'command CMD', 'builtin CMD', 'exec -a custom -c -l CMD',
  'case $x in a ) CMD;; esac', 'case $x in a) echo hi;; b ) CMD;; esac', 'case $x in ( a ) CMD;; esac',
  'coproc job ( CMD )', 'coproc job { CMD; }',
])('P2 인식한 본문은 기존 검사: %s', async form => {
  for (const cmd of ['rm -rf src', 'prisma migrate deploy']) await denied(form.replace('CMD', cmd));
});
it('P2 unresolved 지정 문구', async () => {
  expect(await hook('repeat 1 echo hi')).toMatchObject({ code: 2, stderr: '하네스 가드[경계]: 검사할 수 없는 셸 구문입니다. 단순한 명령으로 나눠 쓰세요\n' });
  expect((await hook('repeat 1 echo hi', false)).code).toBe(0);
});
it.each([
  'f() { echo hi; }; f', 'function g { echo hi; }; g', 'case $x in a) echo a;; b ) echo b;; esac',
  '(( i++ ))', 'time npm test', 'command -v node', 'diff <(cat a) <(cat b)',
  'if [ -f x ]; then cat x; fi', 'for f in a b; do cat "$f"; done', 'while false; do echo hi; done',
  'bash scripts/check.sh', "sh -c 'npm test'", `node -e "console.log(require('./package.json').profile)"`,
  'cp src/a.ts .pi/scratch/', 'T=$(mktemp -d) && cp README.md $T/',
  'tar -xf a.tar -C .pi/scratch/x', 'T=$(mktemp -d); tar -xf a.tar -C "$T"',
  'cp -R docs/x .pi/scratch/', 'tar -xf a.tar -C @root@/wt/out',
  'touch .pi/scratch/*.log', 'cmd 2>&1', 'cmd >&2', 'cmd 2>/dev/null', 'cmd &> .pi/scratch/log',
])('P2/P5/P6/P7/P9 정상 명령 허용: %s', async command => expect((await hook(command)).code, command).toBe(0));
it.each([
  'bash -s x', 'bash -o errexit', 'bash -O extglob', 'bash +o errexit', 'bash +O extglob',
  'bash --rcfile config', 'bash --init-file config', 'bash /dev/fd/0', 'bash /proc/self/fd/0',
  "bash <(echo 'rm -rf src')", 'tcsh', 'csh', 'fish', 'mksh', 'yash', 'ash', 'pdksh', 'busybox sh', 'toybox sh',
])('P3 stdin 셸 옵션·목록: %s', async shell => {
  expect(await hook(`echo 'rm -rf src' | ${shell}`)).toMatchObject({ code: 2, stderr: expect.stringContaining('표준입력으로 셸') });
});
it.each(['ditto .pi/scratch/fake .pi', 'ditto .pi/scratch/fake .pi/'])('P4 ditto 사용자·두뇌 재귀 병합: %s', async command => {
  await denied(command); await denied(command, false);
});
it('P4 ditto HOME 병합', async () => denied('ditto x @root@/home', true, true));
it.each([
  'tar -xf .pi/scratch/a.tar', 'unzip -o .pi/scratch/a.zip', 'cd .claude && tar -xf ../.pi/scratch/a.tar',
  'pushd docs; cp -R x .pi/scratch/', 'popd; tar -xf a.tar -C /tmp/safe',
  'tar -xf a.tar -C @root@/home/..', 'cp -R .pi/scratch/hooks @pkg@/', 'tar -xf a.tar -C @pkg@',
  'cp -R .pi/scratch/x .', 'rsync x .', 'ditto x .', 'cpio -i < a.cpio', '7z x a.zip',
  'tar -xf a.tar -C @root@/wt/.claude', 'tar -xf a.tar -C @root@/wt/.pi',
])('P5 상위 경로·모르는 cwd 거부: %s', async command => denied(command, true, true));
it('P5 사용자 루트 추출 판정 유지', async () => expect((await hook('tar -xf a.tar', false)).code).toBe(0));
const operators = ['>>|', '>|', '>>!', '>!', '&>|', '&>>', '&>', '>&', '<>', '>>&', '2>|', '1>&', '2>>'];
it.each(operators)('P6 연산자 %s 토큰화·공통 보호', async operator => {
  expect(shellParts(`echo x ${operator} .pi/harness.json`).groups).toEqual([['echo', 'x', operator.replace(/^\d+/, ''), '.pi/harness.json']]);
  for (const brain of [true, false]) await denied(`echo x ${operator} .pi/harness.json`, brain);
  await denied(`echo x ${operator} src/a.ts`);
  await denied(`echo x ${operator} docs/판단대기.md`);
  await denied(`echo x ${operator} @root@/home/.zshenv`, true, true);
});
it.each(['cmd 2>&1', 'cmd >&2', 'cmd 2>&-', 'cmd 3<&0', 'cmd 2>/dev/null', 'cmd &> .pi/scratch/log'])('P6 fd 복제·정상 리다이렉트: %s', async command => {
  for (const brain of [true, false]) expect((await hook(command, brain)).code).toBe(0);
});
it.each([
  'echo x > .pi/harnes?.json', 'echo x > .pi/harnes[s].json', 'tee .pi/harnes?.json',
  'cp x .claude/setting?.json', 'touch .pi/harnes*.json',
  'echo x > .pi/harness(#q).json', 'echo x > .pi/harness<1-2>.json',
])('P7 glob 사용자·두뇌 보호: %s', async command => { await denied(command); await denied(command, false); });
it('P7 시작 파일 glob·사용자 무관 패턴·인용', async () => {
  await denied('echo x >> @root@/home/.zshen?', true, true);
  await denied('echo x > docs/판단대?.md');
  expect((await hook('echo x > docs/판단대?.md', false)).code).toBe(0);
  expect((await hook('echo x > docs/notes-?.md', false)).code).toBe(0);
  expect((await hook('echo x > "docs/판단대?.md"', false)).code).toBe(0);
});
it.each([
  'sort -o .pi/harness.json input', 'sort --output=.pi/harness.json input',
  'curl -o .pi/harness.json file://input', 'curl -so .pi/harness.json file://input', 'curl --output .pi/harness.json file://input',
  'wget -O .pi/harness.json input', 'split input .pi/harness.json', 'patch -o .pi/harness.json',
  'tee -a .pi/harness.json', 'install x .pi/harness.json', 'dd of=.pi/harness.json',
])('P8 쓰기 명령 보호: %s', async command => { await denied(command); await denied(command, false); });
it.each(['curl -O url', 'wget url', 'wget -P src url', 'echo x >> /Users/$USER/.zshenv', 'echo x > ~$USER/.zshenv', 'mv src/a.ts .pi/scratch/', 'rsync --remove-source-files src/a.ts .pi/scratch/'])('P8/P9 동적 쓰기·원본 삭제 유지: %s', async command => denied(command));
it.each(['fish', 'csh', 'tcsh', 'mksh', 'yash', 'ash', 'pdksh', 'busybox sh', 'toybox sh'])('P3 인식한 셸의 -c 본문도 검사: %s', async shell => {
  await denied(`${shell} -c 'rm -rf src'`);
  expect((await hook(`${shell} -c 'npm test'`)).code).toBe(0);
});
it('P7 디렉터리 glob 목적지도 보호', async () => {
  for (const brain of [true, false]) await denied('cp .pi/scratch/harness.json .p?', brain);
});
it('P9 여러 복사·추출의 경로 효과가 섞이면 임시 목적지를 입증하지 않는다', async () => {
  await denied('T=$(mktemp -d); cp -a .pi/scratch/tree/. "$T"; cp README.md "$T/x"');
});
