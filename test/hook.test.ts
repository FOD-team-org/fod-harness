import { it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const roots: string[] = [];
interface HookOptions {
  env?: NodeJS.ProcessEnv;
  projectEnv?: 'FODH_PROJECT_ROOT' | 'CLAUDE_PROJECT_DIR';
  approval?: string[];
}
async function invoke(tool_name: string, tool_input: unknown, state = 'IMPLEMENT', options: HookOptions = {}) {
  const root = await mkdtemp('/private/tmp/fodh-hook-');
  roots.push(root);
  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state }));
  if (options.approval) {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ requiresApproval: options.approval }));
  }
  const cwd = options.projectEnv ? join(root, 'worktree') : root;
  if (options.projectEnv) await mkdir(cwd);
  const env = { ...process.env };
  delete env.FODH_PROJECT_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.FODH_TEST_MARKERS;
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
it.each(['sk-ant-', 'AKIA', '-----BEGIN RSA PRIVATE KEY-----'])(
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
