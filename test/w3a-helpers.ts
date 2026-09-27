import { afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { defaultWorkspaceMember } from '../src/core/workspace.ts';

const bases: string[] = [];
afterEach(async () => { for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true }); });
export const M = {
  M1: (name = 'web') => `멤버 main(${name})은 읽기만 합니다 — 바꾸거나 실행하는 일은 task 로 위임합니다`,
  M2: '멤버 main 은 fodh worktree merge 로만 바꿉니다',
  M3: 'commit·merge·push 는 루트 저장소나 등록 워크트리를 대상으로만 합니다',
  M4: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요',
  M5: '멤버 main 을 가리킬 수 있는 동적 경로입니다 — 리터럴 경로로 쓰세요',
  M6: 'GIT_* 환경변수는 워크스페이스 모드에서 쓸 수 없습니다',
  M7: 'git 전역 옵션은 -C·--no-pager·-P·--no-optional-locks 만 씁니다',
};
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FODH_|GIT_)/.test(key) && !['CLAUDE_PROJECT_DIR', 'CDPATH'].includes(key)));
}
export async function fixtureWorkspace(options: { deep?: boolean; prune?: boolean; alias?: boolean } = {}) {
  const base = await mkdtemp('/private/tmp/fodh-w3a-'); bases.push(base);
  const root = join(base, ...(options.deep ? Array(9).fill('deep') : []), 'workspace'), home = join(base, 'home');
  for (const dir of [root, home, ...['chemical', 'wisepharm-backend', 'wisepharm-app', 'outside'].map(p => join(base, p))]) await mkdir(dir, { recursive: true });
  const env = { ...cleanEnv(), HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', FODH_NOTIFY_OS: 'off' };
  const git = (dir: string, ...args: string[]) => {
    if (!dir.startsWith(base + '/')) throw new Error('temporary repositories only');
    const result = spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('fixture git failed');
    return result.stdout.trim();
  };
  for (const dir of [root, ...['chemical', 'wisepharm-backend', 'wisepharm-app', 'outside'].map(p => join(base, p))]) git(dir, 'init', '-b', 'main');
  const files = ['workspace/docs/a', 'workspace/config/prod.json', 'chemical/package.json', 'chemical/src/app.ts', 'chemical/.gitignore', 'chemical/dist/.env', 'wisepharm-backend/src/app.ts', 'wisepharm-backend/scripts/migrate.ts', 'wisepharm-app/pubspec.yaml', 'wisepharm-app/.env'];
  if (!options.prune) files.push('chemical/config/prod.json', 'chemical/neon_api.json', 'chemical/.env', 'chemical/a.secret.json');
  for (const file of files) {
    const path = file.startsWith('workspace/') ? join(root, file.slice(10)) : join(base, file);
    await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, file.endsWith('.gitignore') ? 'dist/\n' : 'FAKE_VALUE\n');
  }
  const web = join(base, 'chemical');
  git(web, 'config', '--local', 'user.name', 'W3a Fixture'); git(web, 'config', '--local', 'user.email', 'w3a@example.invalid'); git(web, 'config', '--local', 'commit.gpgsign', 'false');
  git(web, 'add', '--', 'package.json', 'src/app.ts', '.gitignore'); git(web, 'commit', '-m', 'fixture');
  git(web, 'worktree', 'add', '-b', 'wp-web-T01', join(base, 'wp-web-T01'));
  await mkdir(join(base, 'wp-web-T01/config'), { recursive: true }); await writeFile(join(base, 'wp-web-T01/config/prod.json'), 'FAKE_VALUE');
  await symlink(web, join(base, 'chem-link')); await symlink(web, join(root, 'lnk'));
  const repos = Object.fromEntries([['web', options.alias ? 'chem-link' : 'chemical'], ['backend', 'wisepharm-backend'], ['app', 'wisepharm-app']].map(([name, dir]) => [name, defaultWorkspaceMember(name, relative(root, join(base, dir)))]));
  repos.web.secrets = { readDeny: ['neon_api.json', 'config/prod.json'] };
  repos.web.approvalRules = [
    { id: 'web-db', pattern: '^npm run (?:db:(?:migrate|push|studio)|seed:|ingest:|backfill:|purge:|maintenance:|slack\\b|smoke:prod)|\\bdrizzle-kit (?:migrate|push|drop|studio)\\b' },
    { id: 'web-scripts', pattern: '(?:^|[\\s/])scripts/(?:slack-bot|purge-|seed-|backfill-|ingest-|run-c003|smoke-prod)' },
  ];
  repos.backend.approvalRules = [
    { id: 'be-db', pattern: '^npm run db:(?:migrate|push|studio)\\b|\\bdrizzle-kit (?:migrate|push|drop|studio)\\b|(?:^|[\\s/])scripts/migrate\\.ts\\b' },
    { id: 'be-maintenance', pattern: '^npm run (?:maintenance|moderation):|(?:^|[\\s/])scripts/maintenance|modules/(?:maintenance|moderation)/cli/' },
  ];
  await mkdir(join(root, '.pi/scratch'), { recursive: true });
  return { base, root, home, repos, config: { workspace: { repos } }, git };
}
export type WorkspaceFixture = Awaited<ReturnType<typeof fixtureWorkspace>>;
interface Options {
  state?: string; brain?: boolean; cwd?: string; env?: NodeJS.ProcessEnv;
  config?: unknown; setup?: (f: WorkspaceFixture) => Promise<void>; fixture?: WorkspaceFixture;
}
export async function invokeWorkspace(tool: string, input: unknown, options: Options = {}) {
  const f = options.fixture ?? await fixtureWorkspace();
  const expand = (value: string) => value.replaceAll('@root@', f.root).replaceAll('@base@', f.base);
  await writeFile(join(f.root, '.pi/harness.json'), JSON.stringify(options.config ?? f.config));
  await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: options.state ?? 'IMPLEMENT', worktrees: [{ taskId: 'T01', repo: 'web', branch: 'wp-web-T01', path: join(f.base, 'wp-web-T01') }] }));
  await options.setup?.(f);
  const cwd = expand(options.cwd ?? '@root@');
  const env = { ...cleanEnv(), HOME: f.home, FODH_PROJECT_ROOT: f.root, FODH_NOTIFY_OS: 'off', ...(options.brain === false ? {} : { FODH_BRAIN: '1' }), ...Object.fromEntries(Object.entries(options.env ?? {}).map(([k, v]) => [k, v && expand(v)])) };
  const result = spawnSync(resolve('hooks/pretooluse.sh'), [], { cwd, env, encoding: 'utf8', timeout: 5000, input: JSON.stringify({ cwd, tool_name: tool, tool_input: JSON.parse(expand(JSON.stringify(input))) }) });
  if (result.error) throw result.error;
  return { code: result.status, stderr: result.stderr };
}
