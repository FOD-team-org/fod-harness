import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fixtureWorkspace, invokeWorkspace } from './w3a-helpers.ts';
import { invoke } from './hook-helpers.ts';
const secret = (name: string) => `하네스 가드[경계]: 비밀 파일은 두뇌가 읽을 수 없습니다: ${name}. 값이 필요하면 판단으로 사용자에게 요청하세요\n`;
const recursive = (name: string) => `하네스 가드[경계]: 비밀 파일(${name})이 있는 디렉터리를 재귀로 읽습니다. rg(기본으로 .gitignore·숨김 제외) 또는 --exclude='.env*' 를 쓰세요\n`;
it('member secret union, repository-relative blobs and cwd candidates', async () => {
  const f = await fixtureWorkspace();
  const denied = ['git -C ../chemical show HEAD:config/prod.json', 'git -C ../chemical show HEAD:./config/prod.json', 'git -C ../chemical/src show HEAD:config/prod.json', 'git -C ../chemical/config show HEAD:./prod.json', 'git -C ../chemical show :config/prod.json', 'git -C ../chemical show :0:config/prod.json', 'git -C ../chemical cat-file -p HEAD:neon_api.json', 'git -C ../wp-web-T01 show HEAD:config/prod.json', 'cd ../chemical && git show HEAD:config/prod.json', 'cat ../chemical/neon_api.json', 'cd ../chemical/config && cat prod.json', 'cd $D && cat config/prod.json'];
  for (const command of denied) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 2, stderr: secret(command.includes('neon_api.json') ? 'neon_api.json' : 'prod.json') });
  for (const file_path of ['@base@/chemical/config/prod.json', '@base@/wisepharm-backend/neon_api.json']) expect((await invokeWorkspace('Read', { file_path }, { fixture: f })).stderr).toBe(secret(basename(file_path)));
  for (const command of ['git -C ../chemical show HEAD:src/app.ts', 'git -C ../chemical/config show HEAD:prod.json']) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 0, stderr: '' });
  for (const file_path of ['@root@/config/prod.json', '@base@/wp-web-T01/config/prod.json']) expect((await invokeWorkspace('Read', { file_path }, { fixture: f })).code).toBe(0);
  expect((await invokeWorkspace('Bash', { command: 'cat neon_api.json' }, { fixture: f, setup: f => writeFile(join(f.root, 'neon_api.json'), 'FAKE_VALUE') })).stderr).toBe(secret('neon_api.json'));
  const config = structuredClone(f.config);
  Object.assign(config.workspace.repos.app, { secrets: { defaults: false } });
  expect((await invokeWorkspace('Bash', { command: 'cat ../wisepharm-app/.env' }, { fixture: f, config })).stderr).toBe(secret('.env'));
  config.workspace.repos.web.secrets = { readAllow: ['*.secret.json'] };
  expect((await invokeWorkspace('Read', { file_path: '@base@/chemical/a.secret.json' }, { fixture: f, config: { ...config, secrets: { readDeny: ['*.secret.json'] } } })).stderr).toBe(secret('a.secret.json'));
});
it('recursive searches use member owners and preserve ignore pruning', async () => {
  const f = await fixtureWorkspace();
  for (const command of ['rg --hidden foo ../chemical', 'rg -uu foo ../chemical/config', 'cd ../chemical && rg --hidden foo', 'cd $D && rg --hidden foo']) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 2, stderr: recursive(command.includes('../chemical/config') ? 'prod.json' : '.env') });
  expect((await invokeWorkspace('Bash', { command: 'rg --hidden foo ../chemical/src' }, { fixture: f })).code).toBe(0);
  const pruned = await fixtureWorkspace({ prune: true });
  expect((await invokeWorkspace('Bash', { command: 'rg --hidden foo ../chemical' }, { fixture: pruned })).code).toBe(0);
  expect((await invokeWorkspace('Bash', { command: 'rg --hidden --no-ignore foo ../chemical' }, { fixture: pruned })).stderr).toBe(recursive('.env'));
});
it('single repository checks never discard the event cwd on unknown cwd', async () => {
  const options = { homeLayout: 'outside' as const, env: { FODH_BRAIN: '1' }, setup: (root: string) => writeFile(join(root, '.pi/harness.json'), JSON.stringify({ secrets: { readDeny: ['config/prod.json'] } })) };
  for (const command of ['git show :config/prod.json', 'cd docs && cat ../config/prod.json', 'cat config/prod.json', 'cd "$(git rev-parse --show-toplevel)" && cat config/prod.json', 'cd - >/dev/null; cat config/prod.json', 'cd docs 2>/dev/null; cat config/prod.json']) expect((await invoke('Bash', { command }, 'IMPLEMENT', options)).stderr, command).toBe(secret('prod.json'));
  expect((await invoke('Bash', { command: 'git show HEAD:config/prod.json' }, 'IMPLEMENT', { ...options, cwdRelative: 'docs' })).stderr).toBe(secret('prod.json'));
  expect((await invoke('Bash', { command: 'git show HEAD:.env.example' }, 'IMPLEMENT', options)).code).toBe(0);
});
it('external git top, worktree owners and Grep policy union', async () => {
  const { mkdir } = await import('node:fs/promises');
  const f = await fixtureWorkspace({ prune: true });
  await mkdir(join(f.base, 'outside/src'), { recursive: true });
  await mkdir(join(f.base, 'wp-web-T01/dist'), { recursive: true });
  await writeFile(join(f.base, 'wp-web-T01/dist/.env'), 'FAKE_VALUE');
  const config = { ...f.config, secrets: { readDeny: ['../outside/private.json'] } };
  expect((await invokeWorkspace('Bash', { command: 'git -C ../outside/src show HEAD:private.json' }, { fixture: f, config })).stderr).toBe(secret('private.json'));
  expect((await invokeWorkspace('Bash', { command: 'rg --hidden foo ../wp-web-T01' }, { fixture: f })).code).toBe(0);
  expect((await invokeWorkspace('Bash', { command: 'rg --hidden --no-ignore foo ../wp-web-T01' }, { fixture: f })).stderr).toBe(recursive('.env'));
  expect((await invokeWorkspace('Bash', { command: 'rg --hidden foo ../wp-web-T01' }, { fixture: f, config: {} })).stderr).toBe(recursive('.env'));
  for (const glob of ['neon_api.json', 'neon_*.json']) expect((await invokeWorkspace('Grep', { path: '.', pattern: 'x', glob }, { fixture: f })).stderr).toBe(secret(glob));
});
it('member policy path errors deny locally instead of reaching the input parser catch', async () => {
  const { symlink } = await import('node:fs/promises');
  const f = await fixtureWorkspace();
  await symlink('cycle', join(f.base, 'chemical/cycle'));
  const config = structuredClone(f.config);
  config.workspace.repos.web.secrets = { readDeny: ['cycle/private.json'] };
  for (const tool of ['Read', 'Bash', 'Glob', 'NotebookEdit', 'MultiEdit', 'Agent']) {
    const result = await invokeWorkspace(tool, { file_path: 'docs/a', command: 'ls' }, { fixture: f, config });
    expect.soft(result).toEqual({ code: 2, stderr: '하네스 가드[보호]: 하네스 설정을 읽을 수 없습니다.\n' });
  }
  expect(await invokeWorkspace('Bash', { command: 'git -C ../chemical commit -m x' }, { fixture: f, config, brain: false, state: 'MERGE' })).toEqual({ code: 2, stderr: '하네스 가드[경계]: commit·merge·push 는 루트 저장소나 등록 워크트리를 대상으로만 합니다\n' });
});
