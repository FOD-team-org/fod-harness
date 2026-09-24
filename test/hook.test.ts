import { it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const roots: string[] = [];
interface HookOptions {
  env?: NodeJS.ProcessEnv;
  projectEnv?: 'FODH_PROJECT_ROOT' | 'CLAUDE_PROJECT_DIR';
  approval?: string[];
  setup?: (root: string) => Promise<void>;
  worktrees?: boolean; stateFile?: 'missing' | 'invalid'; configFile?: 'invalid' | 'missing';
}
async function invoke(tool_name: string, tool_input: unknown, state = 'IMPLEMENT', options: HookOptions = {}) {
  const root = await mkdtemp('/private/tmp/fodh-hook-');
  roots.push(root);
  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state, worktrees: options.worktrees ? [{ path: join(root, 'wt') }, { path: root + '-wt' }] : [] }));
  await writeFile(join(root, '.pi/harness.json'), '{}');
  if (options.stateFile === 'missing') await rm(join(root, '.pi/harness-state.json'));
  if (options.stateFile === 'invalid') await writeFile(join(root, '.pi/harness-state.json'), '{');
  if (options.configFile === 'invalid') await writeFile(join(root, '.pi/harness.json'), '{');
  if (options.configFile === 'missing') await rm(join(root, '.pi/harness.json'));
  if (options.approval) {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ requiresApproval: options.approval }));
  }
  await options.setup?.(root);
  const cwd = options.projectEnv ? join(root, 'worktree') : root;
  if (options.projectEnv) await mkdir(cwd);
  const env = { ...process.env };
  delete env.FODH_PROJECT_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.FODH_TEST_MARKERS;
  delete env.FODH_BRAIN; delete env.FODH_DOCS_ROOT; delete env.FODH_CODEX_CHILD;
  if (options.projectEnv) env[options.projectEnv] = root;
  Object.assign(env, options.env);
  const input = JSON.parse(JSON.stringify(tool_input)
    .replaceAll('@root@', root).replaceAll('@pkg@', resolve('.')));
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult, reject) => {
    const child = spawn(resolve('hooks/pretooluse.sh'), [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify({ cwd, tool_name, tool_input: input }));
  });
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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
it.each(['rm -rf /tmp/x', 'rm -rf .', 'rm -rf .git', 'rm -rf .pi', 'find docs -delete', 'git clean -fdx'])('P6 삭제 경계: %s', async command => {
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
it.each(['rm -rf .pi', 'rm -rf /tmp/example', 'find docs -delete', 'git clean -fdx'])('L11 미초기화에도 삭제 규칙 적용: %s', async command => {
  expect(await invoke('Bash', { command }, 'IDLE', { ...brain, stateFile: 'missing' })).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
});
