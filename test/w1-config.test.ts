import { expect, it } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { approvalConfigKeys, loadConfig, setConfig } from '../src/core/config.ts';
import { repoOf, workspaceMembers } from '../src/core/workspace.ts';
import { fixture, writeConfig } from './w1-helpers.ts';
import { cli } from './p5-helpers.ts';
it('WisePharm 모양 멤버 설정·두 모드 repoOf 기본값', async () => {
  const f = await fixture();
  f.repos.web.secrets = { readDeny: ['neon_api.json'] };
  f.repos.web.worktrees.links = ['node_modules'];
  f.repos.app.worktrees.setup = ['flutter pub get --enforce-lockfile --offline'];
  f.repos.web.approvalRules = [{ id: 'web-db', pattern: '^npm run db:migrate', description: 'DB' }];
  const config = await loadConfig(f.root, f.candidate, { dryRun: true });
  expect(config.workspace?.repos.web.worktrees.root).toBe('..');
  expect((await workspaceMembers(f.root, config)).map(m => m.name)).toEqual(['web', 'backend', 'app']);
  expect(await repoOf(f.root, config, { repo: 'app' })).toMatchObject({ path: f.member('app'), baseBranch: 'main' });
  for (const repo of [undefined, '.', 'unknown']) await expect(repoOf(f.root, config, { repo })).rejects.toThrow('task에 알려진 워크스페이스 repo가 필요합니다');
  const single = await loadConfig(f.root, {}, { dryRun: true });
  expect(await workspaceMembers(f.root, single)).toEqual([expect.objectContaining({ name: '.', path: f.root, baseBranch: undefined })]);
  expect((await repoOf(f.root, single, {})).name).toBe('.');
});
it.each(['.', 'Web', 'bad_name', 'abcdefghijklmnopq', '__proto__'])('이름 %s 거부', async name => {
  const f = await fixture(['web']);
  await expect(loadConfig(f.root, { workspace: { repos: { [name]: f.repos.web } } }, { dryRun: true })).rejects.toThrow('이름');
});
it.each(['zero', 'nine', 'file', 'home', 'slash', 'self', 'ancestor', 'inside', 'duplicate', 'nested', 'prefix', 'empty', 'missing-prefix', 'absolute', 'top-verify', 'top-prefix', 'top-links', 'top-setup', 'ids', 'bad-rule', 'secret-link', 'traversal-link'])('설정 위반 %s', async kind => {
  const f = await fixture(['web', 'backend']); const raw: any = f.candidate;
  switch (kind) {
    case 'zero': raw.workspace.repos = {}; break;
    case 'nine': raw.workspace.repos = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i}`, f.repos.web])); break;
    case 'file': await rm(join(f.member(), '.git'), { recursive: true }); await writeFile(join(f.member(), '.git'), 'gitdir: somewhere'); break;
    case 'home': await mkdir(join(process.env.HOME!, '.git')); f.repos.web.path = '../home'; break;
    case 'slash': f.repos.web.path = relative(f.root, '/'); break;
    case 'self': await mkdir(join(f.root, '.git')); f.repos.web.path = '.'; break;
    case 'ancestor': await mkdir(join(f.parent, '.git')); f.repos.web.path = '..'; break;
    case 'inside': await mkdir(join(f.root, 'nested/.git'), { recursive: true }); f.repos.web.path = 'nested'; break;
    case 'duplicate': f.repos.backend.path = f.repos.web.path; break;
    case 'nested': await mkdir(join(f.member(), 'nested/.git'), { recursive: true }); f.repos.backend.path = '../web/nested'; break;
    case 'prefix': f.repos.backend.worktrees.prefix = f.repos.web.worktrees.prefix; break;
    case 'empty': f.repos.web.verify.commands = []; break;
    case 'missing-prefix': delete raw.workspace.repos.web.worktrees.prefix; break;
    case 'absolute': f.repos.web.path = f.member(); break;
    case 'top-verify': raw.verify = {}; break;
    case 'top-prefix': raw.worktrees = { prefix: 'x-' }; break;
    case 'top-links': raw.worktrees = { links: [] }; break;
    case 'top-setup': raw.worktrees = { setup: [] }; break;
    case 'ids': raw.approvalRules = f.repos.web.approvalRules = [{ id: 'same-id', pattern: 'x' }]; break;
    case 'bad-rule': f.repos.web.approvalRules = [{ id: 'bad-id', pattern: '(' }]; break;
    case 'secret-link': f.repos.web.worktrees.links = ['neon_api.json']; break;
    case 'traversal-link': f.repos.web.worktrees.links = ['../other']; break;
  }
  const messages: Record<string, string> = {
    zero: '멤버 수는 1~8개', nine: '멤버 수는 1~8개', file: '경로와 .git 디렉터리',
    home: 'HOME·루트·루트의 조상·안쪽', slash: 'HOME·루트·루트의 조상·안쪽', self: 'HOME·루트·루트의 조상·안쪽',
    ancestor: 'HOME·루트·루트의 조상·안쪽', inside: 'HOME·루트·루트의 조상·안쪽', duplicate: '같거나 포함 관계', nested: '같거나 포함 관계',
    prefix: 'root와 prefix 쌍이 겹칩니다', empty: 'verify.commands는 비어 있으면 안 됩니다', 'missing-prefix': 'worktrees.prefix는 필수',
    absolute: 'path는 상대경로', 'top-verify': 'workspace.repos.<이름> 아래', 'top-prefix': 'workspace.repos.<이름> 아래',
    'top-links': 'workspace.repos.<이름> 아래', 'top-setup': 'workspace.repos.<이름> 아래', ids: 'id는 전체에서 중복',
    'bad-rule': 'pattern 정규식', 'secret-link': '보호 경로', 'traversal-link': '보호 경로',
  };
  await expect(loadConfig(f.root, raw, { dryRun: true })).rejects.toThrow(messages[kind]);
});
it('읽을 때마다 realpath·별칭과 멤버 사이 승인 id 검사', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate); await loadConfig(f.root);
  await rm(join(f.member(), '.git'), { recursive: true }); await expect(loadConfig(f.root)).rejects.toThrow('.git');
  await mkdir(join(f.member(), '.git'));
  await symlink(f.member(), join(f.parent, 'alias')); f.repos.backend.path = '../alias';
  await expect(loadConfig(f.root, f.candidate)).rejects.toThrow('포함');
  f.repos.backend.path = '../backend';
  f.repos.web.approvalRules = f.repos.app.approvalRules = [{ id: 'same-id', pattern: 'x' }];
  await expect(loadConfig(f.root, f.candidate)).rejects.toThrow('중복');
});
it('승인 키는 자식과 기존 부모 키 모두 보호하고 원본 top 키와 기본값을 구별한다', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  for (const key of ['worktrees.setup.0', 'secrets']) {
    await expect(setConfig(f.root, key, 'x', { fromCli: true })).rejects.toThrow('승인 전용');
  }
  expect((await loadConfig(f.root)).workspace).toBeDefined();
});
it.each(['workspace', 'workspace.repos.web.path', 'workspace.repos.web.verify.commands'])('config set %s는 승인 여부와 무관하게 거부·바이트 보존', async key => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  const path = join(f.root, '.pi/harness.json'), before = await readFile(path);
  const message = '워크스페이스 설정은 fodh workspace add/remove 또는 사용자의 harness.json 직접 편집으로 바꿉니다';
  expect(approvalConfigKeys).not.toContain('workspace');
  for (const approve of [false, true]) {
    expect(await cli(f.root, ['config', 'set', key, '{}', ...(approve ? ['--approve'] : [])]))
      .toEqual({ code: 1, value: { error: message } });
    expect(await readFile(path)).toEqual(before);
    await expect(setConfig(f.root, key, '{}', { approve })).rejects.toThrow(message);
    expect(await readFile(path)).toEqual(before);
  }
});

it('아직 없는 worktrees.root 허용·가까운 조상의 realpath 기준 prefix 충돌 검사', async () => {
  const f = await fixture();
  await symlink(f.parent, join(f.parent, 'alias-parent'));
  f.repos.web.worktrees.root = '../not-yet/nested';
  f.repos.backend.worktrees.root = '../alias-parent/not-yet/nested';
  await expect(loadConfig(f.root, f.candidate, { dryRun: true })).resolves.toMatchObject({ workspace: { repos: {
    web: { worktrees: { root: '../not-yet/nested' } },
  } } });
  f.repos.backend.worktrees.prefix = f.repos.web.worktrees.prefix;
  await expect(loadConfig(f.root, f.candidate, { dryRun: true })).rejects.toThrow('root와 prefix 쌍이 겹칩니다');
});
it('없는 멤버 경로 오류에는 이동·제거 복구 안내가 있다', async () => {
  const f = await fixture(); await rm(f.member(), { recursive: true });
  await expect(loadConfig(f.root, f.candidate, { dryRun: true })).rejects.toThrow('— 멤버를 옮겼다면 경로를 고치고, 없앴다면 fodh workspace remove web');
});
