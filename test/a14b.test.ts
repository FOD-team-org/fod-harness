import { invoke } from './hook-helpers.ts';
import { expect, it, vi } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { commandTable } from '../src/cli/commands.ts';
import { addTask, getTask } from '../src/core/backlog.ts';
import { loadConfig } from '../src/core/config.ts';

it('H1 표 전체 메타데이터·전체/그룹/개별 help·두뇌 허용·부작용 없음', async () => {
  for (const item of commandTable) {
    expect(item.summary.trim()).not.toBe(''); expect(item.summary).not.toContain('\n');
    expect(item.usage).toMatch(/^fodh /); expect(item.usage).not.toContain('\n');
  }
  const root = await project();
  const before = await readdir(join(root, '.pi'));
  const state = await readFile(join(root, '.pi/harness-state.json'), 'utf8');
  vi.stubEnv('FODH_BRAIN', '1');
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const result = await cli(root, args); expect(result.code).toBe(0);
    expect(result.value.help).toHaveLength(commandTable.length);
  }
  expect((await cli(root, ['backlog', '--help'])).value.help).toHaveLength(commandTable.filter(c => c.group === 'backlog').length);
  expect(await cli(root, ['backlog', 'set', '--help'])).toMatchObject({ code: 0, value: { help: [{ usage: expect.stringContaining('--notes') }] } });
  expect((await cli(root, ['pick', '-h'])).value.help).toHaveLength(1);
  expect(await readdir(join(root, '.pi'))).toEqual(before);
  expect(await readFile(join(root, '.pi/harness-state.json'), 'utf8')).toBe(state);
  expect((await cli(root, ['backlog', 'set', '--not-known'])).value.error).toMatch(/\(사용법: fodh backlog set --help\)$/);
  vi.unstubAllEnvs();
  expect((await cli(root, ['backlog', 'get'])).value.error).toMatch(/\(사용법: fodh backlog get --help\)$/);
});
it('H6 notes 왕복·표 이스케이프·개행·길이·비밀값', async () => {
  const root = await project(), task = await addTask(root, { title: '메모', category: 'docs' });
  expect(await cli(root, ['backlog', 'set', task.id, '--notes', '검수 | 이월\n다음\r\n단계'])).toMatchObject({ code: 0, value: { notes: '검수 | 이월 다음 단계' } });
  expect((await cli(root, ['backlog', 'get', task.id])).value.notes).toBe('검수 | 이월 다음 단계');
  expect(await readFile(join(root, 'docs/backlog.md'), 'utf8')).toContain('검수 \\| 이월 다음 단계');
  for (const text of ['x'.repeat(301), 'sk-ant-fixture']) expect((await cli(root, ['backlog', 'set', task.id, '--notes', text])).code).toBe(1);
  expect((await getTask(root, task.id)).notes).toBe('검수 | 이월 다음 단계');
});
it.each([
  [{ id: 'db-migrate', pattern: '[' }], [{ id: 'prod-migration', pattern: 'x' }],
  [{ id: 'X', pattern: 'x' }], [{ id: 'db-migrate', pattern: 'x', flags: 'g' }],
  [{ id: 'db-migrate', pattern: 'x' }, { id: 'db-migrate', pattern: 'y' }],
].map(rules => [rules]))('H9 잘못된 approvalRules 거부 %j', async approvalRules => {
  await expect(loadConfig(await project(), { approvalRules })).rejects.toThrow('approvalRules');
});
it.each(['/tmp/node_modules', '../node_modules', '.git', '.pi/x', '.claude/skills', 'docs/판단대기.md', 'docs', 'node_modules/../x'])('H10 잘못된 링크 경로 %s', async path => {
  await expect(loadConfig(await project(), { worktrees: { links: [path] } })).rejects.toThrow('worktrees.links');
});
it('H9/H10 기본값·유효 설정·중복 링크 거부', async () => {
  const root = await project();
  expect(await loadConfig(root)).toMatchObject({ approvalRules: [], worktrees: { links: [] } });
  expect(await loadConfig(root, { approvalRules: [{ id: 'db-migrate', pattern: '^npm', flags: 'i', description: 'DB' }], worktrees: { links: ['node_modules', 'server/node_modules'] } }))
    .toMatchObject({ approvalRules: [{ id: 'db-migrate', flags: 'i' }], worktrees: { links: ['node_modules', 'server/node_modules'] } });
  await expect(loadConfig(root, { worktrees: { links: ['node_modules', 'node_modules'] } })).rejects.toThrow('worktrees.links');
});
it('H5/H7/H8 두뇌·README 문구', async () => {
  const text = await readFile('templates/brain-rules.md', 'utf8');
  for (const line of [
    'main(기본 브랜치)의 파일·커밋은 두뇌가 직접 바꾸지 않는다. 되돌림(git revert)·삭제·수정은 모두 task 워크트리 위임(수정 스펙)으로 한다. 판단 선택지와 추천도 이 경계 안에서 쓴다(예: "T03 수정 스펙에 되돌림을 넣어 위임").',
    '판단 답은 사용자가 판단대기 문서에 쓰고 하네스가 적용해 두뇌를 다시 부른다. 두뇌는 판단을 답하거나 적용하지 않으며 그렇게 하겠다고 보고하지도 않는다.',
    '위임 결과·워크트리·main 에 스펙에 없는 파일이나 커밋(출처 불명)이 있으면 지우지 않는다. 수행자 결과 보고로 경위를 확인하고, 수행자가 만든 것이 아니면 fodh judgment add … --blocks <task> 로 올린다.',
  ]) expect(text).toContain(line);
  expect(await readFile('README.md', 'utf8')).toContain('두뇌가 판단을 등록한 바로 그 턴 안에 답을 쓰면 안전을 위해 held 가 된다. 알림을 보고 /judged A<n> 로 확인하면 적용된다.');
});
it.each(['(x+)+', '(a*)*', '(?:x+x+)+', '(x+x+)+y', '(x)\\1', '(?<word>x)\\k<word>', 'x'.repeat(201)])('R9 비용 위험 정규식 거부: %s', async pattern => {
  await expect(loadConfig(await project(), { approvalRules: [{ id: 'db-migrate', pattern }] })).rejects.toThrow('approvalRules');
});
it.each(['approvalRules', 'worktrees.links', 'requiresApproval'])('R10 CLI 가드 설정 %s는 승인 필수', async key => {
  const root = await project();
  expect(await cli(root, ['config', 'set', key, '[]'])).toMatchObject({ code: 1, value: { error: expect.stringContaining('승인 전용 키') } });
  expect((await cli(root, ['config', 'set', key, '[]', '--approve'])).code).toBe(0);
});
it.each(['a/.git/x', 'a/.pi/x', 'a/.claude/x', '.env', '.env.local', 'server/.env.production'])('R11 보호 조각·환경 파일 링크 거부: %s', async path => {
  await expect(loadConfig(await project(), { worktrees: { links: [path] } })).rejects.toThrow('worktrees.links');
});
it('R11 .github·.gitignore는 이름 접두만으로 거부하지 않는다', async () => {
  expect((await loadConfig(await project(), { worktrees: { links: ['.github', '.gitignore'] } })).worktrees.links).toEqual(['.github', '.gitignore']);
});

// These are JSON inputs to the hook. None of the command strings is run by a shell.
const compoundForms = [
  'f() { CMD; }; f', 'f ( ) { CMD; }; f', 'f(){ CMD; }; f',
  'function g { CMD; }', 'function g() { CMD; }',
  'case "$x" in a) CMD;; b|c) echo hi;; esac',
  'case "$x" in a) echo hi;; b|c) CMD;;& esac',
  'cat <(CMD)', 'cat >(CMD)', 'coproc CMD', 'coproc job { CMD; }',
];
it.each(compoundForms)('Q1 복합 구문 승인·경계, 사용자 기존 판정: %s', async form => {
  for (const [cmd, label] of [['prisma migrate deploy', '[승인]'], ['rm -rf src', '[경계]']]) {
    const command = form.replace('CMD', cmd);
    const unknown = ['f ( ) { CMD; }; f', 'coproc CMD'].includes(form);
    expect(await hook(command), command).toMatchObject({ code: 2, stderr: expect.stringContaining(unknown ? '[경계]' : label) });
    expect((await hook(command, false)).code, command).toBe(0);
  }
});
it.each(['echo "CMD" | bash', 'bash <<< "CMD"', 'bash <<EOF\nCMD\nEOF'])('Q1 stdin 셸은 두뇌만 거부: %s', async form => {
  for (const cmd of ['prisma migrate deploy', 'rm -rf src']) {
    const command = form.replace('CMD', cmd);
    expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining("[경계]: 표준입력으로 셸에 명령을 넘기는 형태는 검사할 수 없습니다. bash -c '…' 로 쓰세요") });
    expect((await hook(command, false)).code).toBe(0);
  }
});
it.each(['sh', 'bash -s', 'zsh -', 'dash /dev/stdin', 'ksh < input', 'source /dev/stdin', '. /dev/fd/3', 'source -', 'source <(echo hi)', 'source >(echo hi)'])('Q1 stdin 셸 변형 거부: %s', async command => {
  expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining('표준입력으로 셸') });
  expect((await hook(command, false)).code).toBe(0);
});
it.each(['f() { echo hi; }; f', 'case $x in a) echo a;; esac', 'diff <(cat a) <(cat b)', 'bash script.sh'])('Q1 정상 명령 허용: %s', async command => {
  expect((await hook(command)).code).toBe(0);
});
it.each(['node', 'python', 'python3', 'perl', 'ruby', 'bun', 'deno', 'php', 'osascript'])('Q1 stdin 인터프리터 원문 보호·판단 검사: %s', async executable => {
  for (const [body, label] of [["open('.claude/settings.json','w')", '[보호]'], ["open('docs/판단대기.md','w')", '[경계]']]) {
    for (const command of [`${executable} - <<EOF\n${body}\nEOF`, `${executable} <<< "${body}"`, `echo "${body}" | ${executable} -`]) {
      expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining(label) });
      expect((await hook(command, false)).code).toBe(0);
    }
  }
  expect((await hook(`${executable} <<EOF\nprint('hi')\nEOF`)).code).toBe(0);
});
const rebindingForms = [
  'NAME[0]=src', 'readarray NAME', 'for NAME (src); do echo hi; done', 'print -v NAME src',
  'select NAME in src; do echo hi; done', '(( NAME = 1 ))', 'let "NAME = 1"', 'declare -n R=NAME',
  'export "$DYNAMIC"=src', 'declare `cat names`', 'typeset $DYNAMIC', 'local N"AME"=src',
  'readonly ${DYNAMIC}=src', 'integer $DYNAMIC', 'float $DYNAMIC', 'eval "$TEXT"', 'source config.sh', '. config.sh',
  'echo $((X=1))', '[[ -v NAME ]]', 'echo ${A[X=1]}', "export $'NAME'=src", 'read X', 'mapfile X',
  'getopts x X', 'coproc echo hi', 'trap "export TMPDIR=." EXIT', 'printf -v X src',
  'f() { echo hi; }; f', 'cat <<EOF\nhi\nEOF', 'cat <<< hi',
];
it.each(rebindingForms)('Q3 불확실한 재바인딩은 삭제·쓰기 예외 없음: %s', async form => {
  for (const end of ['rm -rf "$NAME"', 'echo x > "$NAME"']) {
    expect(await hook(`NAME=$(mktemp -d); ${form}\n${end}`)).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
  }
});
it.each(['unset CI', 'fodh judgment add --title "일반 read 설명"'])('Q3 무관한 이름·설명은 임시 예외 유지: %s', async form => {
  for (const end of ['rm -rf "$NAME"', 'echo x > "$NAME"']) expect((await hook(`NAME=$(mktemp -d); ${form}\n${end}`)).code).toBe(0);
});
it.each(['export "$DYNAMIC"=.', 'source config.sh', '. config.sh', 'eval "$TEXT"', 'echo hi'])('Q4 중첩 TMPDIR 치환 거부: %s', async prefix => {
  for (const end of ['rm -rf "$TMPDIR/x"', 'echo x > "$TMPDIR/x"']) expect(await hook(`${prefix}; bash -c '${end}'`))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
});
it.each([
  'cp .pi/scratch/harness.json .pi/', 'mv .pi/scratch/harness.json .pi/', 'ln .pi/scratch/harness.json .pi/',
  'install .pi/scratch/harness.json .pi/', 'ditto .pi/scratch/harness.json .pi/', 'rsync x .pi/',
  'cp -r x .claude/', 'cp $UNKNOWN .claude/', 'cp *.json .pi/', 'ditto x .claude/settings.json',
  'tar -xf a.tar -C .claude', 'unzip a.zip -d .claude', 'bsdtar -xf a.tar -C .claude', 'ditto -x a.zip .claude',
  'cp -r x @pkg@/hooks', 'cp --target-directory=.claude settings.json', 'tar -xf a.tar -C @pkg@/hooks', 'cp templates .pi/',
])('Q5 보호 디렉터리 덮어쓰기는 사용자도 거부: %s', async command => {
  for (const brain of [true, false]) expect(await hook(command, brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});
it.each(['cp README.md docs/', `node -e "require('./src/hooks/useX')"`, `python3 -c "open('.vscode/settings.json').read()"`])('Q5/Q6 정상 복사·읽기 허용: %s', async command => {
  expect((await hook(command)).code).toBe(0);
});
it.each([
  `node -e "fs.writeFileSync(['.claude','settings.json'].join('/'),'{}')"`,
  `node -e "open('.pi' + '/harness.json')"`, `python3 -c "open('fod-harness/hooks/x')"`,
  `node -e "open('pretooluse.mjs')"`,
])('Q6 조각 결합 보호 경로 언급 거부: %s', async command => {
  expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});
it.each([
  `echo 'export TMPDIR=.' >> ~/.zshrc`, 'cp x ~/.zshenv', `python3 -c "open('.zshrc','a')"`,
  'echo x >> $HOME/.profile', 'echo x >> ${HOME}/.bash_login', 'cp .zprofile $HOME/',
  'cp -r x $HOME/', 'cp $UNKNOWN $HOME/', 'cp x $ZDOTDIR/.zlogout', 'cp .zlogin $ZDOTDIR/',
  'echo x > $CLAUDE_ENV_FILE', 'cp x ~/.config/fish/config.fish', 'cp config.fish ~/.config/fish/', 'tar -xf a.tar -C $HOME',
])('Q7 셸 시작 파일 보호: %s', async command => {
  expect(await hook(command, true, true)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]: 셸 시작 파일은 두뇌가 바꿀 수 없습니다') });
});
it.each(['cp x ~/.zshenv', `python3 -c "open('.zshrc','a')"`, 'echo x > $CLAUDE_ENV_FILE'])('Q7 사용자 셸 파일 판정 유지: %s', async command => {
  expect((await hook(command, false, true)).code).toBe(0);
});
it.each(['.ENVRC', 'server/.dev.vars.prod', '.npmrc', '.netrc', '.pypirc', 'neon_api.json', 'key.properties', 'x.PEM', 'x.KEY', 'x.P8', 'x.P12', 'x.KEYSTORE', 'x.JKS'])('Q8 자격 증명 링크 거부: %s', async path => {
  await expect(loadConfig(await project(), { worktrees: { links: [path] } })).rejects.toThrow('worktrees.links');
});
it('Q8 node_modules 링크 허용', async () => {
  expect((await loadConfig(await project(), { worktrees: { links: ['node_modules'] } })).worktrees.links).toEqual(['node_modules']);
});

async function hook(command: string, brain = true, home = false) {
  return invoke('Bash', { command }, 'IMPLEMENT', {
    env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp', ...(home ? { HOME: '@root@', ZDOTDIR: '@root@/zdot', CLAUDE_ENV_FILE: '@root@/env.sh' } : {}) },
    setup: async root => { await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ requiresApproval: [], approvalRules: [{ id: 'db-migrate', pattern: '^prisma migrate deploy\\b' }] })); },
  });
}
