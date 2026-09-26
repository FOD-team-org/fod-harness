import { expect, it } from 'vitest';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { invoke, type HookOptions } from './hook-helpers.ts';
import { secretPolicy, scanSecretFiles } from '../hooks/secret-paths.mjs';

const options = (secrets?: unknown): HookOptions => ({ nonTempRoot: true, homeLayout: 'inside', env: { FODH_BRAIN: '1' }, setup: async root => {
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '../sibling')); await mkdir(join(root, '../chemical'));
  for (const file of ['.env', '.env.slack', '.env.local', '.env.example', '../sibling/.env', '../chemical/.env']) await writeFile(join(root, file), 'FAKE_VALUE');
  await writeFile(join(root, 'src/a.ts'), 'export {};');
  if (secrets) await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ secrets }));
} });
const denyBash = ['cat .env', 'head -3 ./.env.local', 'grep DATABASE_URL .env', 'sed -n 1p ../chemical/.env',
  'node --env-file=.env x.js', 'source .env', '. .env', 'dotenv -e .env', 'cp .env /tmp/x', 'rsync .env /tmp/x', 'ditto .env /tmp/x', 'install .env /tmp/x', 'ln -s .env /tmp/x',
  `node -e "require('fs').readFileSync('.env')"`, `node -p "require('fs').readFileSync('.env.local')"`,
  `python3 -c "open('.env').read()"`, `perl -e "open F, '.env'"`, `ruby -e "File.read('.env')"`, `deno eval "Deno.readTextFile('.env')"`, `bun -e "Bun.file('.env')"`,
  'cat .env*', 'cat $ROOT/.env', 'cat "${W}/.env.slack"', 'cat < .env', 'cat <> .env', `sh -c 'cat .env'`,
  'grep -rn X .', 'egrep --recursive X .', 'fgrep -d recurse X .', 'rg --hidden X .', 'rg -uu X .', 'rg --no-ignore --hidden X .', 'ag -u X .',
  `find . -name '*.ts' -exec grep -l X {} +`];
it.each(denyBash)('H11 HOME 내부 Bash 차단: %s', async command => {
  const result = await invoke('Bash', { command }, 'IMPLEMENT', options());
  expect(result.code).toBe(2); expect(result.stderr).toContain('하네스 가드[경계]: 비밀 파일');
  expect(result.stderr).not.toContain('FAKE_VALUE'); expect(result.stderr).not.toContain('/Users/');
});
it.each(['ls -la .env', 'test -f .env', 'stat .env', 'file .env', 'du .env', '[ -f .env ]', '[[ -f .env ]]', 'git check-ignore .env', 'git ls-files .env', 'git status -- .env',
  'cat .env.example', 'cat *', 'grep -rn X src', "grep -rn --exclude='.env*' X .", "grep -rn --exclude '.env*' X .", "grep -rn --include='*.ts' X .", 'rg X .', "rg --hidden -g '!.env*' X .", "rg --hidden --glob '!.env*' X .", "rg --hidden --iglob '!.ENV*' X ."])
('H11 HOME 내부 Bash 허용: %s', async command => expect((await invoke('Bash', { command }, 'IMPLEMENT', options())).code).toBe(0));
it.each(['.env', '../sibling/.env', '.env.slack', '.env.local'])('H11 Read %s', async file_path => {
  expect((await invoke('Read', { file_path }, 'IMPLEMENT', options())).code).toBe(2);
});
it.each([['Read', { file_path: '.env.example' }, 0], ['NotebookRead', { notebook_path: '.env' }, 2],
  ['Grep', { path: '.env', pattern: 'X' }, 2], ['Grep', { glob: '.env*', pattern: 'X' }, 2],
  ['Grep', { glob: '*.pem', pattern: 'X' }, 2], ['Grep', { glob: '.env.example', pattern: 'X' }, 0], ['Grep', { path: '.', pattern: 'X' }, 0],
  ['Glob', { pattern: '.env*' }, 0]] as const)('H11 파일 도구 %s %j', async (name, input, code) => {
  expect((await invoke(name, input, 'IMPLEMENT', options())).code).toBe(code);
});
it.each(['cat *', 'cat neon_api.json', 'cat "${W}/neon_api.json"', `node -e "require('fs').readFileSync('neon_api.json')"`, 'grep -r X .'])
('H11 설정 readDeny neon_api.json: %s', async command => {
  const opt = options({ readDeny: ['neon_api.json'] }), setup = opt.setup!;
  opt.setup = async root => { await setup(root); await writeFile(join(root, 'neon_api.json'), 'FAKE_VALUE'); };
  expect((await invoke('Bash', { command }, 'IMPLEMENT', opt)).code).toBe(2);
});
it('H11 사용자 세션은 읽기 가드가 없다', async () => {
  for (const command of ['cat .env', 'grep -r X .', 'cat $ROOT/.env']) expect((await invoke('Bash', { command }, 'IMPLEMENT', { ...options(), env: {} })).code).toBe(0);
  expect((await invoke('Read', { file_path: '.env' }, 'IMPLEMENT', { ...options(), env: {} })).code).toBe(0);
});
it('H11 readAllow·defaults:false·상대 경로·HOME 인증 경로와 symlink 정규화', async () => {
  expect((await invoke('Read', { file_path: '.env.local' }, 'IMPLEMENT', options({ readAllow: ['.env.local'] }))).code).toBe(0);
  expect((await invoke('Read', { file_path: '.env' }, 'IMPLEMENT', options({ defaults: false, readDeny: ['private.json'] }))).code).toBe(0);
  for (const file_path of ['~/.ssh/id_rsa', '$HOME/.aws/credentials', '~/.codex/auth.json']) expect((await invoke('Read', { file_path }, 'IMPLEMENT', options())).code).toBe(2);
  for (const file_path of ['~/.ssh/id_rsa.pub', '~/.ssh/known_hosts']) expect((await invoke('Read', { file_path }, 'IMPLEMENT', options())).code).toBe(0);
  const opt = options({ readDeny: ['src/private.json'] }), setup = opt.setup!;
  opt.setup = async root => { await setup(root); await symlink(join(root, '.env'), join(root, 'alias')); };
  expect((await invoke('Read', { file_path: 'alias' }, 'IMPLEMENT', opt)).code).toBe(2);
  expect((await invoke('Read', { file_path: 'src/private.json' }, 'IMPLEMENT', opt)).code).toBe(2);
});
it('H11 재귀 탐색 상한·링크 디렉터리 제외·exclude-dir', async () => {
  const opt = options(), setup = opt.setup!;
  opt.setup = async root => {
    await setup(root); await mkdir(join(root, 'isolated')); await symlink(join(root, '../sibling'), join(root, 'isolated/link'));
    const policy = secretPolicy(root);
    expect(scanSecretFiles(root, policy, { limit: 1 }).exceeded).toBe(true);
    expect(scanSecretFiles(join(root, 'isolated'), policy).files).toEqual([]);
    await mkdir(join(root, 'src/private')); await writeFile(join(root, 'src/private/.env'), 'FAKE_VALUE');
  };
  expect((await invoke('Bash', { command: 'grep -r --exclude-dir=private X src' }, 'IMPLEMENT', opt)).code).toBe(0);
});

it('H11 상대 readAllow는 인라인 읽기에도 적용하고 단일 ln 원본을 검사한다', async () => {
  expect((await invoke('Bash', { command: `node -e "require('fs').readFileSync('src/private.pem')"` }, 'IMPLEMENT', options({ readAllow: ['src/private.pem'] }))).code).toBe(0);
  expect((await invoke('Bash', { command: 'ln -s @root@/.env' }, 'IMPLEMENT', options())).code).toBe(2);
});

it.each(['rg -f .env X', 'grep --file=.env src/a.ts', 'echo X < .env', 'rg --files < .env', 'rg -e X .env'])('R5 패턴 파일·입력 리다이렉트·실제 파일 경로 보호 유지 %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', options())).code).toBe(2);
});
