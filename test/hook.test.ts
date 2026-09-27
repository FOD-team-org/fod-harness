import { it, expect } from 'vitest';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { invoke, roots, type HookOptions } from './hook-helpers.ts';

it.each([
  ['grep -q foo <<< "$v"\nrm -rf .git', '[경계]'],
  ['cat <<< x\nprisma migrate deploy', '[승인]'],
  ['echo $((1<<2))\ncodex exec fixture', '[경계]'],
  ['((a = (1 << 2)))\ncodex exec fixture', '[경계]'],
])('N1 here-string·산술식 다음 줄도 검사한다: %s', async (command, label) => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining(label) });
});
it.each(['cat <<< x', 'echo $((1<<2))', '((a = (8 >> 1) > 0 && 1 < 2))', "cat <<'EOF'\nhello\nEOF"])(
  'N1 단독 here-string·산술식·완료 heredoc은 허용: %s', async command => {
    expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(0);
  },
);
it.each(["cat <<'EOF'\n본문", 'cat <<EOF', 'cat <<EOF\n'])('N1 미종료 heredoc은 두뇌 보호 거부·사용자 허용: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } }))
    .toMatchObject({ code: 2, stderr: '하네스 가드[보호]: heredoc 종료 표지를 찾을 수 없습니다\n' });
  expect((await invoke('Bash', { command })).code).toBe(0);
});
it.each(["cat <<'EOF' > src/x.ts\nhello\nEOF", "cat <<'EOF'>src/x.ts\nhello\nEOF"])(
  'N1 heredoc 표지 뒤 리다이렉트도 경계 검사: %s', async command => {
    expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } }))
      .toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
  },
);
it.each([true, false])('N3 순환 symlink는 두뇌 경계 거부·사용자 lexical 비교: brain=%s', async isBrain => {
  const result = await invoke('Write', { file_path: 'loop/file.ts', content: 'fixture' }, 'IMPLEMENT', {
    env: { FODH_BRAIN: isBrain ? '1' : '0' },
    setup: async root => { await symlink('loop', join(root, 'loop')); },
  });
  if (isBrain) expect(result).toMatchObject({
    code: 2, stderr: expect.stringMatching(/^하네스 가드\[경계\]: 경로를 확인할 수 없습니다: .*\/loop\/file\.ts\n$/),
  });
  else expect(result).toMatchObject({ code: 0, stderr: '' });
});

it.each([
  'codex exec task', '/usr/local/bin/codex exec task', 'env FOO=x codex exec task',
  'c\\odex exec task', '"codex" exec task', 'co"dex" exec task', 'npm test && codex exec task',
])('codex 직접 실행 차단: %s', async command => {
  expect(await invoke('Bash', { command }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('fodh codex'), stdout: '' });
});
it.each([
  '.claude/settings.json', '.claude/settings.local.json', '@pkg@/hooks/pretooluse.sh',
  '.pi/harness-state.json', '.pi/harness-ledger.jsonl',
])('가드 편집 차단: %s', async file_path => {
  expect((await invoke('Edit', { file_path, old_string: '', new_string: '변경' })).code).toBe(2);
});
it.each([
  'echo changed > .claude/settings.json', 'tee .pi/harness-state.json',
  'cp other @pkg@/hooks/pretooluse.sh', 'sed -i x .claude/settings.json',
  'echo changed>.claude/settings.json',
])('Bash 자기 수정 차단: %s', async command => {
  expect((await invoke('Bash', { command })).code).toBe(2);
});
it.each(['sk-ant-', 'AKIA' + 'A'.repeat(16), '-----BEGIN RSA PRIVATE KEY-----'])(
  '실제 자격증명 없는 비밀값 접두 패턴 차단', async content => {
    const result = await invoke('Write', { file_path: 'docs/test.md', content });
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain(content);
  },
);
it.each(['commit -m test', 'push origin feature', 'merge feature', '-C worktree commit -m test'])(
  'IMPLEMENT git %s 거부, MERGE 허용', async command => {
    expect((await invoke('Bash', { command: `git ${command}` })).code).toBe(2);
    expect((await invoke('Bash', { command: `git ${command}` }, 'MERGE')).code).toBe(0);
  },
);
it.each([
  'git push origin main', 'git push -f', 'git push --force origin branch',
  'vercel --prod', 'prisma migrate deploy', 'vercel env rm X production', 'gh secret delete X',
  'launchctl load service.plist', 'echo FODH_DOCTOR_MARKER', 'fastlane pilot upload',
  'psql local -c "DELETE FROM items"', 'neonctl projects create', 'DATABASE_URL=prod-placeholder node migrate.js',
  'stripe customers create', 'curl https://api.stripe.com/v1/customers', 'gh api users/example --method DELETE',
  'slack send example', 'mcporter call send example', 'aws iam create-user', 'gcloud iam roles create example',
  'rm .env.example', 'vercel env add X', 'gh secret set X', 'security delete-generic-password -s example',
])('MERGE에서도 승인 필수 차단: %s', async command => {
  expect(await invoke('Bash', { command }, 'MERGE'))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('판단대기') });
});
it.each([
  'ls', 'fodh codex task T01', 'cat .claude/settings.json',
  'fodh judgment add --background "production 데이터 delete 여부"',
  '  npx fodh judgment add --background "production 데이터 delete 여부"',
  '/opt/fod-harness/bin/fodh judgment add --background "production 데이터 delete 여부"',
  'npx /opt/fod-harness/bin/fodh judgment add --background "git push origin main; codex exec x"',
  'grep -r codex docs/', 'grep codex docs/file.md', 'git merge-base main HEAD',
  'cat src/hooks/useAuth.ts', 'echo "privacy policy"', 'npm test', 'git log --oneline',
  'echo "production 데이터 delete 여부"', 'echo "subscription create"', 'unset TOKEN',
  'echo stripe customers create', 'echo git push origin main', 'echo "slack send"',
  'git log --grep=commit', 'git status && echo merge', 'git status; echo push',
])('일반·fodh·읽기 명령 허용: %s', async command => {
  expect((await invoke('Bash', { command })).code).toBe(0);
});
it.each([';', '&&', '||', '|', '\n'])('fodh 뒤 다른 명령은 면제하지 않는다: %s', async separator => {
  expect((await invoke('Bash', { command: `fodh state ${separator} codex exec task` })).code).toBe(2);
});
it.each(['Write', 'Edit', 'NotebookEdit'])('문서 내용의 승인 키워드는 %s에 적용하지 않는다', async tool => {
  expect((await invoke(tool, {
    file_path: 'docs/설계/결제-설계.md', content: 'subscription create; stripe customers create; privacy policy',
  }, 'IMPLEMENT', { approval: ['payment', 'legal', 'account-admin'] })).code).toBe(0);
});
it('일반 src/hooks 파일과 패키지 밖 hooks 파일은 보호하지 않는다', async () => {
  expect((await invoke('Write', { file_path: 'src/hooks/useAuth.ts', content: 'export {};' })).code).toBe(0);
  expect((await invoke('Write', { file_path: 'hooks/custom.ts', content: 'export {};' })).code).toBe(0);
});
it.each(['FODH_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR'] as const)('워크트리에서 %s 기준 상태와 설정을 읽는다', async projectEnv => {
  const options = { projectEnv, approval: ['dns'] };
  expect((await invoke('Bash', { command: 'git commit -m example' }, 'MERGE', options)).code).toBe(0);
  expect((await invoke('Bash', { command: 'vercel domains add example.test' }, 'MERGE', options)).code).toBe(2);
  expect((await invoke('Edit', { file_path: '@root@/.claude/settings.json' }, 'MERGE', options)).code).toBe(2);
  expect((await invoke('Edit', { file_path: '.claude/settings.json' }, 'MERGE', options)).code).toBe(0);
});
it('FODH_PROJECT_ROOT가 CLAUDE_PROJECT_DIR보다 우선한다', async () => {
  const options: HookOptions = { projectEnv: 'FODH_PROJECT_ROOT', env: { CLAUDE_PROJECT_DIR: '/not-the-project' } };
  expect((await invoke('Bash', { command: 'git commit -m example' }, 'MERGE', options)).code).toBe(0);
});
it('테스트 마커는 명시적으로 활성화한 경우에만 차단한다', async () => {
  expect((await invoke('Bash', { command: 'echo FORBIDDEN_MARKER' })).code).toBe(0);
  expect((await invoke('Bash', { command: 'echo FORBIDDEN_MARKER' }, 'IMPLEMENT', {
    env: { FODH_TEST_MARKERS: '1' },
  })).code).toBe(2);
});
it('node 탐색 실패 시 설명과 exit 2를 반환한다', async () => {
  expect(await invoke('Bash', { command: 'npm test' }, 'IMPLEMENT', {
    env: { PATH: '/nonexistent', FODH_NODE: '' },
  })).toMatchObject({ code: 2, stderr: expect.stringContaining('FODH_NODE') });
});
it('FODH_NODE가 있으면 PATH와 무관하게 그 실행 파일을 사용한다', async () => {
  expect((await invoke('Bash', { command: 'npm test' }, 'IMPLEMENT', {
    env: { PATH: '/nonexistent', FODH_NODE: process.execPath },
  })).code).toBe(0);
});
it.each(['PLANNING','INTERVIEW','RESEARCH','PRD_DRAFT','ARCH','REVIEW'])('L9 %s 문서 commit 허용, push·merge는 거부',async state=>{
  expect((await invoke('Bash',{command:'git commit -m docs'},state)).code).toBe(0);
  expect((await invoke('Bash',{command:'git push origin feature'},state)).code).toBe(2);
  expect((await invoke('Bash',{command:'git merge feature'},state)).code).toBe(2);
});

it.each(['.pi/interview-bank.md','.pi/templates/docs/PRD.md'])('M2 은행·템플릿 Write/Bash 보호: %s',async file_path=>{
  expect((await invoke('Write',{file_path,content:'변경'})).code).toBe(2);
  expect((await invoke('Bash',{command:`echo changed > ${file_path}`})).code).toBe(2);
});
it('M2 설정된 은행·override 경로는 FODH_PROTECTED_EXTRA로 보호',async()=>{
  const env={FODH_PROTECTED_EXTRA:'custom/questions.md:custom/templates'};
  for(const file_path of ['custom/questions.md','custom/templates/docs/PRD.md'])expect((await invoke('Write',{file_path,content:'변경'},'INTERVIEW',{env})).code).toBe(2);
  expect((await invoke('Write',{file_path:'custom/templates-other/PRD.md',content:'변경'},'INTERVIEW',{env})).code).toBe(0);
});

it.each([
  ['대입', ['FODH_BRAIN= fodh config set interview.enforce false', 'env FODH_BRAIN=0 fodh config set interview.enforce false', 'fodh config set custom FODH_BRAIN=0']],
  ['unset', ['unset FODH_BRAIN; fodh config set interview.enforce false', 'unset -v FODH_PROJECT_ROOT']],
  ['env 제거', ['env -u FODH_BRAIN fodh config set interview.enforce false', 'env FOO=x -i fodh config get', 'env -uFODH_BRAIN fodh config get', 'env --unset=FODH_BRAIN fodh config get']],
])('N3 환경변수 %s 우회 차단', async (_, commands) => {
  for (const command of commands) expect(await invoke('Bash', { command })).toMatchObject({ code: 2, stderr: expect.stringContaining('하네스 환경변수는 바꿀 수 없습니다.') });
});
it('N3 doctor echo 표식은 환경변수 변경 거부가 아닌 기존 시험 차단', async () => {
  const result = await invoke('Bash', { command: 'echo FODH_DOCTOR_MARKER' });
  expect(result).toMatchObject({ code: 2, stderr: expect.stringContaining('승인 필수 시험 동작') });
  expect(result.stderr).not.toContain('하네스 환경변수');
  expect((await invoke('Bash', { command: 'env FOO=x node --version' })).code).toBe(0);
});
it('N8 훅과 공용 redact의 정규식 문자열은 동일하다', async () => {
  const pattern = (source: string) => source.match(/^const secretPattern = (.+);$/m)?.[1];
  const core = pattern(await readFile('src/provider/privacy.ts', 'utf8'));
  expect(core).toBeTruthy(); expect(pattern(await readFile('hooks/pretooluse.mjs', 'utf8'))).toBe(core);
});
it('N8 확장 비밀 패턴은 모두 redact·Write·Bash에서 차단된다', async () => {
  const { redact, safeValue } = await import('../src/provider/privacy.ts');
  const samples = ['sk-'+'proj-'+'x'.repeat(8), 'sk_'+'live_'+'x'.repeat(8), 'sk_'+'test_'+'x'.repeat(8), 'AIza'+'x'.repeat(20), ...['a','b','p'].map(kind=>'xox'+kind+'-'+'x'.repeat(8)), 'ghp_'+'x'.repeat(36), 'github_pat_', 'AKIA'+'A'.repeat(16), 'sk-'+'ant-', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----', 'Bearer '+'x'.repeat(20)];
  for (const sample of samples) {
    expect(redact(sample)).toBe('[비밀값 제거]'); expect(safeValue({ answer: sample })).toEqual({ answer: '[비밀값 제거]' });
    expect((await invoke('Write', { file_path: 'docs/test.md', content: sample })).code).toBe(2);
    expect((await invoke('Bash', { command: `echo '${sample}'` })).code).toBe(2);
  }
  expect(redact('일반 답 API 키는 환경변수 참조')).toBe('일반 답 API 키는 환경변수 참조');
});
it('보정2 짧은 접두·최소 길이 미만·AKIA와 ghp 단어 경계 밖은 보존한다', async () => {
  const { redact, safeValue } = await import('../src/provider/privacy.ts');
  const samples = [
    'AKIA', 'AKIA_short', 'AKIA'+'A'.repeat(15), 'xAKIA'+'A'.repeat(16), 'AKIA'+'A'.repeat(17),
    'ghp_', 'ghp_'+'x'.repeat(35), 'xghp_'+'x'.repeat(36), 'ghp_'+'x'.repeat(37),
    ...['sk-proj-', 'sk_live_', 'sk_test_', 'xoxa-', 'xoxb-', 'xoxp-'].flatMap(prefix => [prefix, prefix+'x'.repeat(7)]),
    'AIza', 'AIza'+'x'.repeat(19), 'Bearer ', 'Bearer '+'x'.repeat(19),
  ];
  for (const sample of samples) {
    expect(redact(sample)).toBe(sample); expect(safeValue({ text: sample })).toEqual({ text: sample });
    expect((await invoke('Write', { file_path: 'docs/test.md', content: sample })).code).toBe(0);
    expect((await invoke('Bash', { command: `echo '${sample}'` })).code).toBe(0);
  }
});

const brain = { env: { FODH_BRAIN: '1' }, worktrees: true };
it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('P6 %s 경로 경계·워크트리·외부·문서 예외', async tool => {
  for (const path of ['docs/a.md', '.pi/scratch/a.ts', 'CLAUDE.md', 'AGENTS.md', 'README.md', 'wt/src/x.ts', '@root@-wt/src/x.ts'])
    expect((await invoke(tool, { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: path }, 'IMPLEMENT', brain)).code, path).toBe(0);
  for (const path of ['src/x.ts', 'docs-other/x.md', '/tmp/x.ts', '.claude/skills/a/SKILL.md'])
    expect((await invoke(tool, { file_path: path }, 'IMPLEMENT', brain)).code, path).toBe(2);
});
it('P6 사용자는 경로 가드 면제, 미초기화 두뇌는 적용, 손상 상태·설정은 fail closed', async () => {
  expect((await invoke('Write', { file_path: 'src/x.ts' })).code).toBe(0);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    expect((await invoke(tool, { [key]: 'src/x.ts' }, 'IDLE', { ...brain, stateFile: 'missing' })).code).toBe(2);
    expect((await invoke(tool, { [key]: 'docs/a.md' }, 'IDLE', { ...brain, stateFile: 'missing' })).code).toBe(0);
  }
  expect((await invoke('Bash', { command: 'echo x > src/x.ts' }, 'IDLE', { ...brain, stateFile: 'missing' })).code).toBe(2);
  expect((await invoke('Bash', { command: 'echo x > docs/a.md' }, 'IDLE', { ...brain, stateFile: 'missing' })).code).toBe(0);
  expect((await invoke('Write', { file_path: 'wt/src/x.ts' }, 'IDLE', { ...brain, stateFile: 'missing' })).code).toBe(2);
  for (const bad of [{ stateFile: 'invalid' }, { configFile: 'invalid' }, { configFile: 'missing' }] as const)
    expect((await invoke('Write', { file_path: 'docs/x.md' }, 'IDLE', { ...brain, ...bad })).code).toBe(2);
});
it('P6 docs.root 환경 경로만 문서로 허용한다', async () => {
  const options = { env: { FODH_BRAIN: '1', FODH_DOCS_ROOT: 'notes' } };
  expect((await invoke('Write', { file_path: 'notes/x.md' }, 'IDLE', options)).code).toBe(0);
  expect((await invoke('Write', { file_path: 'docs/x.md' }, 'IDLE', options)).code).toBe(2);
});
it.each(['sed -i x src/x.ts', 'echo hi>src/x.ts', 'echo hi >> src/x.ts', 'tee src/x.ts', 'cp a src/b', 'mv docs/a src/b',
  'touch src/x', 'install a src/b', 'truncate -s 0 src/x', 'dd if=docs/a of=src/b', 'rsync docs/a src/b', 'patch src/x.ts', 'git apply src/a.patch',
  'git checkout -- src/x.ts', 'git restore src/x.ts', 'git stash'])('P6 Bash 소스 쓰기 거부: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each(['echo ok > docs/a.md', 'echo ok >>docs/a.md', 'sed -i x docs/a.md', "sed -i '' 's/a/b/' docs/a.md", 'cp docs/a wt/src/b', 'rm docs/a.md',
  'rm -rf @root@/wt/build', 'rm -rf @root@-wt/build', 'git -C wt clean -fdx'])('P6 문서·워크트리 쓰기 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
});
it.each(['rm -rf /outside/x', 'rm -rf .', 'rm -rf .git', 'rm -rf .pi', 'find docs -delete', 'git clean -fdx'])('P6 삭제 경계: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it('P6 직접 worktree 변경은 두뇌만 거부하고 fodh 경로를 안내한다', async () => {
  for (const action of ['add', 'remove', 'prune']) {
    expect(await invoke('Bash', { command: `git worktree ${action} example` }, 'MERGE', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('fodh worktree') });
    expect((await invoke('Bash', { command: `git worktree ${action} example` }, 'MERGE')).code).toBe(0);
  }
});
it('P6 파괴적 git은 승인 목록을 비워도 두뇌 거부', async () => {
  for (const command of ['git branch -D example', 'git reset --hard', 'git push --force-with-lease origin feature', 'git push -f'])
    expect((await invoke('Bash', { command }, 'MERGE', { ...brain, approval: [] })).code).toBe(2);
});
it('P6 Codex 자식 fodh 훅 거부는 조기 허용보다 먼저 적용한다', async () => {
  for (const command of ['fodh config get', 'npx fodh state get', '/opt/bin/fodh state get', 'env FOO=x fodh config get'])
    expect((await invoke('Bash', { command }, 'IDLE', { env: { FODH_CODEX_CHILD: '1' } })).code).toBe(2);
});
it.each([
  ['shell', ["sh -c 'unset FODH_BRAIN; fodh config set verify.commands true'", "bash -c 'unset FODH_BRAIN'", "zsh -c 'echo FODH_BRAIN'"]],
  ['node', ['node -e "delete process.env.FODH_BRAIN"', 'node --eval="delete process.env.FODH_BRAIN"']],
  ['python/perl', ["python3 -c 'FODH_BRAIN'", "perl -e 'FODH_BRAIN'"]],
])('P6 N10 %s 인라인 환경 우회 거부', async (_, commands) => {
  for (const command of commands) expect(await invoke('Bash', { command })).toMatchObject({ code: 2, stderr: expect.stringContaining('하네스 환경변수는 바꿀 수 없습니다') });
});

it('P6 사용자 대화형 세션의 삭제는 규칙 2·4 범위 밖이며 기존 승인 가드는 유지한다', async () => {
  expect((await invoke('Bash', { command: 'rm -rf /tmp/fixture' })).code).toBe(0);
  expect((await invoke('Bash', { command: 'rm -rf .git' })).code).toBe(0);
  expect((await invoke('Bash', { command: 'echo FODH_DOCTOR_MARKER' })).code).toBe(2);
});
it('P6 doctor Write 표식은 특별 규칙 없이 일반 소스 경계로 차단한다', async () => {
  expect(await invoke('Write', { file_path: 'src/FODH_DOCTOR_MARKER.ts', content: 'export {}' }, 'IDLE', brain))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('소스 파일은 두뇌가 쓰지 않습니다') });
  expect((await invoke('Write', { file_path: 'src/FODH_DOCTOR_MARKER.ts' })).code).toBe(0);
});

it.each([
  ['Bash', { command: 'echo FODH_DOCTOR_MARKER' }, '승인'],
  ['Write', { file_path: 'src/x.ts' }, '경계'],
  ['Write', { file_path: '.pi/harness.json' }, '보호'],
])('H1 훅 stderr 분류 접두 %s %j', async (tool, input, label) => {
  expect(await invoke(tool, input, 'IMPLEMENT', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining(`하네스 가드[${label}]:`) });
});

it.each(['ls docs 2>/dev/null', 'fodh state get 2>/dev/null', 'cmd &>/dev/null', 'tee /dev/stdout', 'tee /dev/fd/1', 'tee docs/a.md 2>/dev/null',
  'python3 -m json.tool < .pi/harness-state.json', 'node scripts/check.mjs', 'perl src/a.pl', 'ruby src/a.rb',
  'sh scripts/check.sh arg', 'git stash list', 'git stash show', 'echo ok > /tmp/fixture'])('M1 Bash 읽기·디바이스·외부 리다이렉트 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
});
it.each(["EOF", "'EOF'", '"EOF"', '-EOF'])('M1 heredoc %s 본문은 명령이 아니며 헤더 쓰기는 검사한다', async marker => {
  const command = `cat > docs/a.md <<${marker}\n> 인용\ncodex x\n${marker === '-EOF' ? '\t' : ''}EOF`;
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
  expect((await invoke('Bash', { command: command.replace('docs/a.md', 'src/x.ts') }, 'IMPLEMENT', brain)).code).toBe(2);
  expect((await invoke('Bash', { command: command + '\ncodex x' }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each([
  ['git apply .pi/scratch/fix.patch', 2], ['patch -p1 < docs/x.diff', 2],
  ['git -C @root@/wt apply x.patch', 0], ['git apply --directory=@root@/wt docs/x.patch', 0],
  ['patch -d @root@/wt -p1 < docs/x.diff', 0], ['patch --directory=@root@/wt -p1 < docs/x.diff', 0],
  ['git apply --check x.patch', 0], ['git apply --stat x.patch', 0], ['git apply --numstat x.patch', 0],
  ['git apply --summary x.patch', 0], ['patch --dry-run', 0],
])('M2 패치 대상 트리 판정: %s', async (command, code) => {
  const result = await invoke('Bash', { command }, 'IMPLEMENT', brain);
  expect(result.code).toBe(code); if (code === 2) expect(result.stderr).toContain('하네스 가드[경계]: 패치 적용은 워크트리에서만');
});

it.each(['fodh memory reset', 'npx fodh memory reset', '/opt/bin/fodh memory reset'])('M4 두뇌 memory reset 보호: %s', async command => {
  expect(await invoke('Bash', { command }, 'IDLE', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('하네스 가드[보호]') });
  expect((await invoke('Bash', { command }, 'IDLE')).code).toBe(0);
});

it.skipIf(process.platform !== 'darwin')('L5 darwin .pi/HARNESS.json은 대소문자 무관 보호', async () => {
  expect(await invoke('Write', { file_path: '.pi/HARNESS.json' }, 'IDLE', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});
it.each(['existing', 'dangling', 'parent'] as const)('L5 문서 symlink %s를 통한 소스 쓰기는 경계 거부', async kind => {
  const options: HookOptions = { ...brain, setup: async root => {
    await mkdir(join(root, 'docs')); await mkdir(join(root, 'src'));
    if (kind === 'existing') await writeFile(join(root, 'src/a.ts'), 'existing');
    await symlink(kind === 'parent' ? '../src' : '../src/a.ts', join(root, 'docs/link'));
  } };
  const file_path = kind === 'parent' ? 'docs/link/new.ts' : 'docs/link';
  expect(await invoke('Write', { file_path }, 'IDLE', options)).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
});
it.each(["bash -lc 'unset FODH_BRAIN'", "sh -ec 'unset FODH_BRAIN'", "zsh -xc 'unset FODH_BRAIN'",
  'eval "unset FODH_BRAIN"', 'source "FODH_ENV.sh"', '. "FODH_ENV.sh"'])('L6 결합 셸 플래그·eval 환경 우회 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IDLE', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});
it.each(['Read', 'Grep'])('L7 상태 손상이어도 사용자 %s는 허용, 두뇌는 거부', async tool => {
  expect((await invoke(tool, { file_path: 'docs/a.md' }, 'IDLE', { stateFile: 'invalid' })).code).toBe(0);
  expect((await invoke(tool, { file_path: 'docs/a.md' }, 'IDLE', { ...brain, stateFile: 'invalid' })).code).toBe(2);
  for (const name of ['Write', 'Bash']) expect((await invoke(name, { file_path: 'docs/a.md', command: 'ls' }, 'IDLE', { stateFile: 'invalid' })).code).toBe(2);
});
it.each([
  ['rm -rf .pi/scratch/task', 0], ['rm -rf .pi', 2], ['rm -rf docs', 2], ['rm -rf notes', 2],
  ['git clean -nd', 0], ['git clean --dry-run -fdx', 0],
])('L9 scratch 정리·문서 트리·clean dry-run: %s', async (command, code) => {
  const env = { FODH_BRAIN: '1', ...(command === 'rm -rf notes' ? { FODH_DOCS_ROOT: 'notes' } : {}) };
  expect((await invoke('Bash', { command }, 'IDLE', { env })).code).toBe(code);
});
it.each(['rm -rf .pi', 'rm -rf /outside/example', 'find docs -delete', 'git clean -fdx'])('L11 미초기화에도 삭제 규칙 적용: %s', async command => {
  expect(await invoke('Bash', { command }, 'IDLE', { ...brain, stateFile: 'missing' })).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
});

it.each(['branch -f main abc123', 'branch -D topic', 'checkout -B main abc123', 'update-ref refs/heads/main abc123',
  'reset --soft HEAD~1', 'reset --hard HEAD~1', 'reset --mixed HEAD~1', 'reset HEAD~1', 'rebase topic',
  'filter-branch --all', 'reflog expire --expire=now --all', '-C wt branch -f main abc123'])('P3 모든 상태에서 두뇌 git %s 보호', async command => {
  for (const stage of ['IMPLEMENT', 'MERGE', 'IDLE']) {
    expect(await invoke('Bash', { command: `git ${command}` }, stage, brain))
      .toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
  }
});

it.each([
  ['switch -C main abc123', 'switch --force-create main abc123'],
  ['branch -M topic main', 'branch -C topic main', 'branch --move --force topic main', 'branch --copy --force topic main'],
  ['fetch . +abc123:refs/heads/main'],
  ['push . +abc123:refs/heads/main'],
  ['merge -s ours topic', 'merge -X ours topic', 'merge --strategy=ours topic', 'merge --strategy-option=ours topic', 'merge --strategy ours topic', 'merge --strategy-option ours topic'],
].map(commands => ({ commands })))('Q3 참조·내용 덮어쓰기 보호: %j', async ({ commands }) => {
  for (const command of commands) expect(await invoke('Bash', { command: `git ${command}` }, 'MERGE', brain))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});

it.each([true, false])('F23 --wait background=%s', async run_in_background => {
  const result = await invoke('Bash', { command: 'fodh codex task T01 --spec docs/task.md --wait', run_in_background }, 'IMPLEMENT', brain);
  expect(result.code).toBe(run_in_background ? 2 : 0);
  if (run_in_background) expect(result.stderr).toContain('하네스 가드[경계]: --wait 를 백그라운드로 돌리지 마라');
  expect((await invoke('Bash', { command: 'fodh codex task T01 --spec docs/task.md', run_in_background }, 'IMPLEMENT', brain)).code).toBe(0);
});
it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])('F24 두뇌 %s 판단 파일 쓰기만 거부', async tool => {
  const input = (path: string) => tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
  expect(await invoke(tool, input('docs/판단대기.md'), 'IMPLEMENT', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('판단대기 문서는 사용자만 고칩니다') });
  expect((await invoke(tool, input('docs/작업일지/2026-09-24.md'), 'IMPLEMENT', brain)).code).toBe(0);
  expect((await invoke(tool, input('docs/판단대기.md'), 'IMPLEMENT')).code).toBe(0);
});
it.each(['echo answer >> docs/판단대기.md', 'echo answer > docs/판단대기.md', 'tee docs/판단대기.md', "sed -i '' 's/a/b/' docs/판단대기.md", 'cp docs/source.md docs/판단대기.md', 'mv docs/source.md docs/판단대기.md'])('F24 Bash 판단 쓰기 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('판단대기 문서는 사용자만 고칩니다') });
});
it.each(['cat docs/판단대기.md', 'grep 답 docs/판단대기.md', 'fodh judgment add --title 질문', 'fodh judgment read', 'fodh judgment write-status 대기', 'fodh inbox ack item'])('F24 읽기·하네스 판단 등록 경로 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
});
it('F24 설정 판단 경로·기본 fallback·판단 저널을 보호한다', async () => {
  const configured: HookOptions = { ...brain, setup: root => writeFile(join(root, '.pi/harness.json'), JSON.stringify({ judgment: { file: 'docs/결정.md' } })) };
  expect((await invoke('Edit', { file_path: 'docs/결정.md' }, 'IMPLEMENT', configured)).code).toBe(2);
  expect((await invoke('Bash', { command: 'tee docs/결정.md' }, 'IMPLEMENT', configured)).code).toBe(2);
  for (const path of ['docs/판단대기.md', '.pi/harness-judgment-apply.json']) {
    expect(await invoke('Write', { file_path: path }, 'IDLE', { ...brain, stateFile: 'missing' }))
      .toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
    // H9: missing configuration now fails closed before path classification.
    expect(await invoke('Write', { file_path: path }, 'IDLE', { ...brain, stateFile: 'missing', configFile: 'missing' }))
      .toMatchObject({ code: 2, stderr: '하네스 가드[보호]: 하네스 설정을 읽을 수 없습니다.\n' });
  }
});

it.each([
  'cp /tmp/판단대기.md docs/', 'mv /tmp/판단대기.md docs', 'rsync -a /tmp/stage/ docs/',
  'tar -xf archive.tar -C docs', 'ln docs/판단대기.md docs/alias.md',
  'ln /tmp/file docs/판단대기.md', 'cp -r @root@/docs/stage/. docs',
  `python3 -c "open('docs/판단대기.md','a').write('1')"`,
  `node -e "require('fs').appendFileSync('docs/판단대기.md','1')"`,
  `perl -pi -e 's/x/y/' docs/판단대기.md`, `ruby -i -e 'puts 1' docs/판단대기.md`,
  `sed -i '' 's/x/y/' docs/판단대기.md`,
  `bash -c 'cp /tmp/판단대기.md docs/'`, `sh -c 'tee docs/판단대기.md'`,
  `zsh -lc 'tar -xf archive.tar -C docs'`,
])('R1 판단 파일 쓰기 우회 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { ...brain,
    setup: root => mkdir(join(root, 'docs/stage'), { recursive: true }).then(() => {}) }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('판단대기 문서는 사용자만') });
});
it.each(['cat docs/판단대기.md', 'grep 답 docs/판단대기.md', `bash -c 'cat docs/판단대기.md'`,
  `python3 -c "print('unrelated')"`, 'cp docs/source.md .pi/scratch/copy.md'])('R1 관련 없는 쓰기·읽기 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
});
it.each([`bash -c 'fodh codex task --wait --spec docs/task.md'`,
  `sh -c 'node /opt/pkg/bin/fodh codex task --wait'`, 'node bin/fodh.ts codex task --wait',
  `zsh -lc 'node /opt/pkg/bin/fodh codex task --wait'`])('R4 셸·node 경유 --wait background 차단: %s', async command => {
  expect(await invoke('Bash', { command, run_in_background: true }, 'IMPLEMENT', brain))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('--wait 를 백그라운드로 돌리지 마라') });
  expect((await invoke('Bash', { command, run_in_background: false }, 'IMPLEMENT', brain)).code).toBe(0);
});

it.each(['cp README.md docs/', 'mv docs/x docs/', 'rsync README.md docs/', 'tar -cf docs/archive.tar -C docs README.md',
  'tar -xf archive.tar -C .pi/scratch', 'unzip archive.zip -d .pi/scratch'])('S5 일반 복사·이동·아카이브 오탐 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(0);
});
it.each(['nohup cp docs/판단대기.md docs/', 'timeout -k 5 10 cp /tmp/판단대기.md docs/',
  'nice -n 10 sh -c "cp /tmp/판단대기.md docs/"', 'time -o docs/timing cp /tmp/판단대기.md docs/',
  'xargs -n 1 cp /tmp/판단대기.md docs/', 'stdbuf -o L cp /tmp/판단대기.md docs/',
  'env LANG=C cp /tmp/판단대기.md docs/', 'cp -t docs /tmp/판단대기.md', 'mv --target-directory=docs /tmp/판단대기.md', 'cp -r /tmp/files/ docs/', 'rsync -a /tmp/files/ docs/',
  'tar -xf archive.tar -C docs', 'unzip archive.zip -d docs', 'tar -xf archive.tar 판단대기.md', 'unzip archive.zip 판단대기.md'])('S5 래퍼·재귀·추출 판단 쓰기 차단: %s', async command => {
  const result = await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } });
  expect(result.code).toBe(2); expect(result.stderr).toContain('판단');
});
it.each(['tar -xf archive.tar', 'unzip archive.zip'])('S5 cwd가 판단 디렉터리인 추출 차단: %s', async command => {
  const result = await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' },
    setup: root => writeFile(join(root, '.pi/harness.json'), JSON.stringify({ judgment: { file: '판단대기.md' } })) });
  expect(result.code).toBe(2); expect(result.stderr).toContain('판단');
});
it('S5 nohup의 --wait 백그라운드 거부', async () => {
  const result = await invoke('Bash', { command: 'nohup fodh codex task --spec docs/spec.md --wait', run_in_background: true }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } });
  expect(result.code).toBe(2); expect(result.stderr).toContain('--wait 를 백그라운드로');
});
it.each(['codex exec hi', 'claude -p hi', 'cswap switch', 'nohup codex exec hi', 'env -S "codex exec hi"', 'env --split-string="claude -p hi"', 'timeout --signal TERM 30 claude -p hi',
  'node "/Users/example/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs" task --write hi',
  'node /tmp/codex-companion.mjs task hi', 'sh -c "env LANG=C node /tmp/codex-companion.mjs task hi"',
  'node /tmp/plugins/cache/openai-codex/anything/script.mjs task hi'])('F27 두뇌 직접 실행·companion 우회 차단: %s', async command => {
  const result = await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } });
  expect(result.code).toBe(2); expect(result.stderr).toContain('위임은 fodh codex task / Claude Agent 로만 한다');
});
it.each(['mcp__codex__task', 'mcp__plugin_codex__rescue', 'Agent', 'Task'])('F27 플러그인 도구 %s 차단', async name => {
  const result = await invoke(name, { subagent_type: 'codex:codex-rescue' }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } });
  expect(result.code).toBe(2); expect(result.stderr).toContain('위임은 fodh codex task / Claude Agent 로만 한다');
});
it.each([['Bash', { command: 'fodh codex task --spec docs/spec.md' }], ['Agent', { subagent_type: 'general-purpose' }]] as const)('F27 정식 위임 %s 허용', async (name, input) => {
  expect((await invoke(name, input, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(0);
});

it.each(['exec codex exec hi', 'builtin command codex exec hi', 'eval "codex exec hi"',
  'bunx codex', 'bunx @openai/codex@latest', 'pnpm dlx @openai/codex', 'yarn dlx @openai/codex@latest', 'npx --yes @openai/codex',
  'script -q /dev/null codex exec hi', 'script -a /dev/null codex exec hi', 'script -q -e -F -k -t /dev/null codex exec hi',
  'caffeinate -i codex exec hi', 'caffeinate -t 10 -w 12 codex exec hi', 'arch -arm64 codex exec hi', 'arch -x86_64 claude -p hi',
  'node ~/.claude/plugins/cache/*/codex/*/scripts/codex-comp*.mjs task',
  'find ~/.claude/plugins/cache -name "codex-comp*.mjs" -exec node {} task \\;',
  'find . -execdir codex exec hi \\;', 'find . -ok cswap switch \\;'])('N1 위임 래퍼·패키지·glob·find 차단: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('위임은 fodh codex task / Claude Agent 로만 한다') });
});
it.each(['exec fodh codex task --spec docs/spec.md', 'npx vitest run', 'bunx vitest run', 'pnpm dlx vitest run',
  'yarn dlx vitest run', 'eval "fodh codex task --spec docs/spec.md"'])('N1 정상 명령 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(0);
});
it.each([{ skill: 'codex:rescue' }, { name: 'codex:rescue' }])('N1 Codex Skill 별칭 거부 %#', async input => {
  expect(await invoke('Skill', input, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('위임은 fodh codex task / Claude Agent 로만 한다') });
});
it('N1 하네스 Skill 허용', async () => {
  expect((await invoke('Skill', { skill: 'fodh-workflow' }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(0);
});
it.each(['cp -a README.md docs/', 'rsync -av README.md docs/', 'cp --recursive README.md docs/'])('N5 단일 파일 재귀 옵션 오탐 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup: root => writeFile(join(root, 'README.md'), 'fixture') })).code).toBe(0);
});
it.each(['cp --recursive @root@/docs/x docs/', 'rsync --archive @root@/docs/x docs/', 'rsync -a @root@/docs/x/ docs/',
  'cp -R @root@/docs/x docs/', 'tar xf a.tar -C docs', 'bsdtar xvf a.tar --directory docs', 'gtar xzf a.tar -Cdocs'])('N5 디렉터리 재귀·tar 묶음 추출 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup: root => mkdir(join(root, 'docs/x'), { recursive: true }).then(() => {}) }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('판단') });
});
// P5 now permits scratch extraction while continuing to deny the protected .pi root.
it.each(['tar xf a.tar -C .pi', 'gtar xzf a.tar -C.pi'])('N5 .pi 목적지 추출 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('.pi 아래에는 아카이브를 풀 수 없습니다') });
});
it.each(['bsdtar -xf a.tar --directory .pi/scratch', 'unzip a.zip -d .pi/scratch'])('P5 명시적 scratch 추출 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
});
it.each(['tar xf a.tar', 'bsdtar -xf a.tar', 'unzip a.zip'])('P5 scratch cwd 추출 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, cwdRelative: '.pi/scratch' })).code).toBe(0);
});

it.each(['tar xf a.tar', 'bsdtar -xf a.tar', 'unzip a.zip'])('N5 .pi cwd 추출 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, cwdRelative: '.pi' }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('.pi 아래에는 아카이브를 풀 수 없습니다') });
});

it.each([
  'fodh codex task --title "codex 위임 확인?"',
  'fodh judgment add --title "codex 슬롯이 부족한가?"',
  'grep "codex.*task" README.md',
  'find . -name "*codex*"',
  'find scripts -name "*.mjs" -exec node {} task \\;',
])('M1 정상 인자 glob 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(0);
});
it.each([
  'node ~/.claude/plugins/cache/*/codex/*/scripts/codex-comp*.mjs task',
  'find ~/.claude/plugins -name "*companion.mjs" -exec node {} task \\;',
  'bun --no-warnings ~/.claude/plugins/cache/*/worker.mjs task',
])('M1 실행 위치 companion glob 거부: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' } })).code).toBe(2);
});
it.each(['cp --recursive /var/tmp/없는경로 docs/', 'cd /var/tmp && cp -a README.md docs/'])('L1 확인 불가 소스는 재귀: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup: root => writeFile(join(root, 'README.md'), 'existing') })).code).toBe(2);
});
it('L1 존재하는 비디렉터리 cp -a는 허용', async () => {
  expect((await invoke('Bash', { command: 'cp -a README.md docs/' }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup: root => writeFile(join(root, 'README.md'), 'existing') })).code).toBe(0);
});

const a14TempCommands = [
  'node bin/expense.js --help && T=$(mktemp -d) && EXPENSE_DATA_DIR=$T node bin/expense.js add --help; rm -rf "$T"',
  'node bin/expense.js --help >/tmp/t11rev-run.txt 2>&1; rm -f /tmp/t11rev-run.txt',
  'D=$(mktemp -d "${TMPDIR:-/tmp}/t03rev.XXXX"); export EXPENSE_DATA_DIR=$D; ls -A $D; rm -rf $D',
  'r(){ out=$(node bin/expense.js "$@" 2>/tmp/_e_$$); echo "$out"; }; r add --help; rm -f /tmp/_e_$$',
  'T=$(mktemp -d); echo x > $T/out',
  'bash -c \'T=$(mktemp -d); rm -rf "$T"\'',
  'export T=$(mktemp -d); rm -rf ${T}',
  'local T=`mktemp -d`; rm -rf "$T"',
  'readonly T=$(mktemp -t a14b); rm -f "$T"',
  'declare T=/tmp/a14b-literal; rm -rf "$T"',
];
it.each([false, true].flatMap(nonTempRoot => ['', '/private/tmp'].map(TMPDIR => [nonTempRoot, TMPDIR] as const)))('H2 임시 root 여부=%s TMPDIR=%s: A14 네 명령·변수 쓰기·중첩 허용', async (nonTempRoot, TMPDIR) => {
  for (const command of a14TempCommands) expect(await invoke('Bash', { command }, 'IMPLEMENT', {
    env: { FODH_BRAIN: '1', TMPDIR }, nonTempRoot,
  }), command).toMatchObject({ code: 0 });
});
it.each([
  'rm -rf /tmp', 'rm -rf "$TMPDIR"', 'rm -rf @root@/..', 'rm -rf @root@/wt',
  'T=$(mktemp -d); T+=/../../src; rm -rf $T',
  "cat <<EOF\nT=$(mktemp -d)\nEOF\nrm -rf $T",
  "f(){\nT=$(mktemp -d);\n}; rm -rf $T",
  'T=$(mktemp -d); printf -v T src; rm -rf $T',
  'T=src; rm -rf $T', 'T=$(mktemp -d); T=src; rm -rf $T',
  'T=$(mktemp -d tmp.XXXX); rm -rf $T', 'T=$(mktemp -d -p .); rm -rf $T',
  'T=$(mktemp --tmpdir=.); rm -rf $T', 'rm -rf $UNKNOWN',
  'T=$(mktemp -d); rm -rf $T/../src', 'T=$(mktemp -d); rm -rf $T/$UNKNOWN',
  'T=@root@; rm -rf $T', 'T=@root@/..; rm -rf $T',
  'echo \'T=$(mktemp -d)\'; rm -rf $T', 'rm -rf $T; T=$(mktemp -d)',
  'T=$(mktemp -d); read T; rm -rf $T',
  'T=$(mktemp -d) node -e "0"; rm -rf $T',
  'TMPDIR=@root@; T=$(mktemp -d); rm -rf $T',
  "T=$(mktemp -d); echo x > '$T/out'",
  'T=$(mktemp -d); echo x > \\$T/out',
])('H2 확정 못 하는 변수·보호 트리 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, worktrees: true }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
});
it('H2 임시 경로의 프로젝트 symlink는 따라가서 보호한다', async () => {
  const result = await invoke('Bash', { command: 'T=@root@-alias; rm -rf $T' }, 'IMPLEMENT', {
    env: { FODH_BRAIN: '1' }, setup: async root => { await symlink(root, root + '-alias'); roots.push(root + '-alias'); },
  });
  expect(result.code).toBe(2);
});
it.each(['IMPLEMENT', 'MERGE', 'DOCS'])('H5 %s main revert/cherry-pick/am 거부·등록 워크트리 허용', async state => {
  for (const action of ['revert --no-commit abc', 'cherry-pick abc', 'am change.patch']) {
    expect(await invoke('Bash', { command: `git ${action}` }, state, { env: { FODH_BRAIN: '1' }, worktrees: true }))
      .toMatchObject({ code: 2, stderr: expect.stringContaining('main 변경은 task 워크트리 위임으로만 한다') });
    expect((await invoke('Bash', { command: `git -C @root@/wt ${action}` }, state, { env: { FODH_BRAIN: '1' }, worktrees: true })).code).toBe(0);
  }
});
const projectApproval = { id: 'db-migrate', pattern: '^npm run db:(?:migrate|push)\\b|^drizzle-kit (?:migrate|push)\\b' };
it.each(['npm run db:migrate', 'DATABASE_URL=x npm run db:migrate', 'npx drizzle-kit migrate', 'bash -c "npm run db:migrate"'])('H9 프로젝트 승인: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup: async root => {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ requiresApproval: [], approvalRules: [projectApproval] }));
  } })).toMatchObject({ code: 2, stderr: expect.stringContaining('[승인]: 승인 필수 동작(db-migrate)') });
});
it('H9 다른 명령 허용·잘못된 규칙은 두뇌 fail closed, 사용자 규칙 생략', async () => {
  const setup = async (root: string) => { await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [projectApproval] })); };
  expect((await invoke('Bash', { command: 'npm run db:generate' }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup })).code).toBe(0);
  const invalid = async (root: string) => { await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [{ ...projectApproval, pattern: '[' }] })); };
  expect(await invoke('Bash', { command: 'npm run db:migrate' }, 'IMPLEMENT', { env: { FODH_BRAIN: '1' }, setup: invalid }))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('하네스 설정을 읽을 수 없습니다.') });
  expect((await invoke('Bash', { command: 'npm run db:migrate' }, 'IMPLEMENT', { setup: invalid })).code).toBe(0);
});

// Review inputs are passed to the hook as JSON only. Never execute these shell strings.
it.each([
  'rm -rf /tmp/*', 'rm -rf /tmp/.[!.]* /tmp/*', 'rm -rf /tmp/{a,..}/Users',
  'X=..@root@; rm -rf /tmp/$X/src', 'rm -rf /tmp/$(printf ..@root@)/.git',
  'rm -rf /tmp/claude-501(:h:h)', 'rm -rf /tmp/a{b,c}', 'rm -rf /tmp/x?y',
  'T=$(mktemp -d); rm -rf ${T}/{a,..}', 'T=$(mktemp -d); rm -rf $T/x(:h:h)',
])('R1 검수1 확장 대상에는 임시 삭제 예외 없음: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each([
  'TMPDIR=$PWD bash -c \'rm -rf "$TMPDIR/src"\'',
  'export TMPDIR=$PWD; bash -c \'rm -rf $TMPDIR/src\'',
  'TMPDIR=$PWD; eval \'rm -rf $TMPDIR/src\'',
  'TMPDIR=. sh -c \'echo x > $TMPDIR/src/a.ts\'',
  'T=$PWD; bash -c "T=\\$(mktemp -d); rm -rf $T/src"',
  'env TMPDIR=$PWD bash -c \'rm -rf $TMPDIR/src\'',
  'unset TMPDIR; bash -c \'T=$(mktemp -d "${TMPDIR:-/tmp}/x.XXXX"); rm -rf $T\'',
  'declare TMPDIR; bash -c \'rm -rf $TMPDIR/src\'',
  'local TMPDIR; bash -c \'rm -rf $TMPDIR/src\'',
  'readonly TMPDIR; bash -c \'rm -rf $TMPDIR/src\'',
  'export TMPDIR; bash -c \'rm -rf $TMPDIR/src\'',
  'T=src; bash -c \'T=$(mktemp -d); rm -rf $T\'',
  'T=$(mktemp -d); bash -c "rm -rf $T"',
  'T=$(mktemp -d); read T; bash -c \'rm -rf $T\'',
  'T=$(mktemp -d); printf -v T src; rm -rf $T',
  'T=$(mktemp -d); for T in src; do :; done; rm -rf $T',
  'T=$(mktemp -d); declare -n T=src; rm -rf $T',
  'T=$(mktemp -d); mapfile T; rm -rf $T',
  'T=$(mktemp -d); getopts x T; rm -rf $T',
  'T=$(mktemp -d); unset T; rm -rf $T',
  'T=$(mktemp -d); eval \'T+=src\'; rm -rf $T',
])('R2 검수2 최상위 대입·재바인딩·중첩 인용 검사: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each([
  'false && T=$(mktemp -d); rm -rf $T/@relative-root@/src',
  'T=$(mktemp -d) | cat; rm -rf $T/@relative-root@/.git',
  'T=$(mktemp -d) & rm -rf $T/@relative-root@/src',
  'T=$(mktemp -d /tmp/no-such-dir/x.XXXX); rm -rf "$T/@relative-root@/src"',
  '( T=$(mktemp -d) ); rm -rf $T/@relative-root@/src',
  'local T=$(mktemp -d); rm -rf $T/@relative-root@/src',
  'T=$(mktemp -d); rm -f "$T/out"',
  'export T=$(mktemp -d); rm -rf ${T}/out',
])('R3 검수3 빈 변수 해석도 기존 가드를 통과해야 한다: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each([
  'ln -s "$PWD" /tmp/fodh-l && rm -rf /tmp/fodh-l/src',
  'T=$(mktemp -d) && ln -s "$PWD" "$T/l" && rm -rf "$T/l/src"',
  ...['ln', 'mv', 'cp', 'rsync', 'tar', 'unzip', 'ditto', 'bsdtar', 'git'].map(cmd => `${cmd} --help; rm -rf /tmp/literal`),
  'bash -c \'ln -s "$PWD" /tmp/fodh-l\'; rm -rf /tmp/fodh-l/src',
])('R4 검수4 링크를 만들 수 있는 명령과 임시 삭제를 함께 허용하지 않는다: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each([
  'fodh judgment add --title 질문 --background "echo PATH >> ~/.zshrc 필요"',
  'fodh backlog set T01 --notes "sed 로 .bashrc 수정"',
  'fodh judgment add --title 질문 --background "npm run db:migrate 필요"',
  'npx fodh judgment add --background "npm run db:migrate 필요"; echo ok',
])('R5 검수5 fodh 설명 인자는 승인 정규식에서 제외: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', { ...brain, setup: async root => {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [{ id: 'db-migrate', pattern: 'db:migrate' }] }));
  } })).code).toBe(0);
});
it('R5/Q7 실제 셸 설정 쓰기는 보호 거부', async () => {
  expect(await invoke('Bash', { command: 'echo PATH >> ~/.zshrc' }, 'IMPLEMENT', brain))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});
const wrappedMigrations = [
  '(npm run db:migrate)', '{ npm run db:migrate; }', 'echo "$(npm run db:migrate)"',
  'x=`npm run db:migrate`', 'if [ -f .env ]; then npm run db:migrate; fi',
  'for i in 1; do npm run db:migrate; done', '! npm run db:migrate',
  'FOO=1 npm run db:migrate', 'cd /tmp && npm run db:migrate', 'sh -c "npm run db:migrate"',
  'bash -lc "npm run db:migrate"', 'env npm run db:migrate', 'env -S "npm run db:migrate"',
  'timeout 10 npm run db:migrate', 'nohup npm run db:migrate', 'eval "npm run db:migrate"',
  'npx --yes npm run db:migrate', 'time npm run db:migrate', 'command npm run db:migrate',
  'xargs npm run db:migrate', '"npm" run db:migrate', 'n\\pm run db:migrate',
  'echo "$(npm run db:migrate', 'echo "$(echo "$(echo "$(echo "$(npm run db:migrate)")")")")"',
];
it.each(wrappedMigrations)('R6 검수6 묶음·제어문·치환·래퍼를 승인 검사: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { ...brain, setup: async root => {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [projectApproval] }));
  } })).toMatchObject({ code: 2, stderr: expect.stringContaining(wrappedMigrations.slice(-2).includes(command) ? '검사할 수 없는 셸 구문' : '[승인]') });
});
it.each(['(prisma migrate deploy)', 'echo "$(prisma migrate deploy)"', 'if true; then prisma migrate deploy; fi'])('R6 내장 승인도 검사: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('[승인]') });
});
it.each(['echo "$(git status)"', 'if [ -f x ]; then cat x; fi'])('R6 읽기는 허용: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(0);
});
it.each(['(codex exec task)', 'echo "$(codex exec task)"', 'if true; then echo x > src/a.ts; fi', '(echo x > .pi/harness.json)'])('R6 경계·보호·위임도 공통 분해: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it.each([
  'node -e "require(\'fs\').writeFileSync(\'.pi/harness.json\',\'{}\')"',
  'python3 -c "open(\'.pi/harness.json\',\'w\').write(\'{}\')"',
  'perl -pi -e \'s/approvalRules/disabled/\' .pi/harness.json',
  'ln -sf /tmp/replacement .pi/harness.json',
  'sed -i s/x/y/ .claude/settings.json',
  'node -e "require(\'fs\').writeFileSync(\'@pkg@/hooks/pretooluse.mjs\',\'x\')"',
])('R10 검수10 가드 인라인 편집·링크 우회는 보호 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', brain))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]: 가드 설정은 fodh로만 변경할 수 있습니다.') });
});
it('R10 가드 읽기는 허용', async () => {
  expect((await invoke('Bash', { command: 'cat .pi/harness.json' }, 'IMPLEMENT', brain)).code).toBe(0);
});

it.each(['rm -f done', 'echo x > fi', 'rm -rf /tmp/opaque)'])('R6 정규화가 원래 경로 가드를 약화하지 않는다: %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', brain)).code).toBe(2);
});
it('R9 위험 정규식은 실행 전에 두뇌 설정 거부', async () => {
  expect(await invoke('Bash', { command: 'x'.repeat(26) }, 'IMPLEMENT', { ...brain, setup: async root => {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [{ id: 'slow-rule', pattern: '(x+x+)+y' }] }));
  } })).toMatchObject({ code: 2, stderr: expect.stringContaining('하네스 설정을 읽을 수 없습니다.') });
});

it('R5 앵커 없는 사용자 규칙은 fodh 외 읽기 인자도 대조한다', async () => {
  expect(await invoke('Bash', { command: 'git log --grep=db:migrate' }, 'IMPLEMENT', { ...brain, setup: async root => {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [{ id: 'db-migrate', pattern: 'db:migrate' }] }));
  } })).toMatchObject({ code: 2, stderr: expect.stringContaining('[승인]') });
});
it('R2 printf 붙인 -v 변수 지정도 재바인딩이다', async () => {
  expect((await invoke('Bash', { command: 'T=$(mktemp -d); printf -vT src; rm -rf $T' }, 'IMPLEMENT', brain)).code).toBe(2);
});

it('R6 heredoc과 같은 문자열의 실제 명령 치환도 검사한다', async () => {
  const command = 'echo "$(npm run db:migrate)"\ncat <<EOF\nnpm run db:migrate\nEOF';
  expect(await invoke('Bash', { command }, 'IMPLEMENT', { ...brain, setup: async root => {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [projectApproval] }));
  } })).toMatchObject({ code: 2, stderr: expect.stringContaining('[승인]') });
});

it.each(['replace A B', 'replace -f A B', 'replace --edit A', 'replace --graft A B', 'replace -d A'])('J1 brain git %s writes are protected; user terminal remains allowed', async command => {
  for (const state of ['IMPLEMENT', 'MERGE', 'IDLE']) {
    expect(await invoke('Bash', { command: `git ${command}` }, state, brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
  }
  expect((await invoke('Bash', { command: `git ${command}` }, 'IDLE')).code).toBe(0);
});
it.each(['replace', 'replace -l', 'replace --list', 'replace --format=long', 'replace -l --format=short'])('J1 brain git %s is read-only', async command => {
  expect((await invoke('Bash', { command: `git ${command}` }, 'IMPLEMENT', brain)).code).toBe(0);
});

it.each(['fetch . A:refs/replace/X', 'push . A:refs/replace/X', 'symbolic-ref refs/replace/X refs/heads/main'])('K3 brain git %s cannot write replacement refs', async command => {
  expect(await invoke('Bash', { command: `git ${command}` }, 'IMPLEMENT', brain)).toMatchObject({ code: 2, stderr: expect.stringContaining('[보호]') });
});
it.each(['replace -l A*', 'replace --list A*', 'replace -l refs/replace/*', 'for-each-ref refs/replace', 'show-ref refs/replace/X', 'log refs/replace/X'])('K3/K4 brain git %s remains read-only', async command => {
  expect((await invoke('Bash', { command: `git ${command}` }, 'IMPLEMENT', brain)).code).toBe(0);
});
