import { expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { hookWorkspace } from '../hooks/workspace-members.mjs';
import { possibleCwds, commandCwds } from '../hooks/effective-cwd.mjs';
import { shellCommands } from '../hooks/shell-commands.mjs';
import { loadConfig } from '../src/core/config.ts';
import { workspaceMembers } from '../src/core/workspace.ts';
import { fixtureWorkspace, invokeWorkspace, M } from './w3a-helpers.ts';

it('hook workspace is a subset of application validation and preserves member order', async () => {
  for (const alias of [false, true]) {
    const f = await fixtureWorkspace({ alias });
    for (const variant of ['base', 'no-secrets', 'no-rules', 'base-branch']) {
      const config = structuredClone(f.config);
      if (variant === 'no-secrets') delete config.workspace.repos.web.secrets;
      if (variant === 'no-rules') delete config.workspace.repos.web.approvalRules;
      if (variant === 'base-branch') config.workspace.repos.web.baseBranch = 'develop';
      const app = await workspaceMembers(f.root, await loadConfig(f.root, config, { dryRun: true }));
      const hook = hookWorkspace(f.root, config);
      const view = (m: { name: string; path: string; secrets?: unknown; approvalRules?: { id: string }[] }) => ({ name: m.name, path: m.path, ids: m.approvalRules?.map(r => r.id) ?? [], secrets: m.secrets !== undefined });
      expect(hook.enabled).toBe(true); expect(hook.members.map(view)).toEqual(app.map(view));
    }
  }
  expect(hookWorkspace('/unused', {})).toEqual({ enabled: false, members: [] });
});
it('cwd breadth first traversal uses each occurrence once and preserves known paths', async () => {
  const f = await fixtureWorkspace({ deep: true });
  const cwd = (command: string, workspace = false, cdpath = '') => possibleCwds(shellCommands(command).entries, f.root, { home: f.home, workspace, cdpath });
  expect(cwd('cd docs')).toEqual({ cwds: [f.root, join(f.root, 'docs')], unknown: false });
  expect(cwd('cd docs && cd docs')).toEqual({ cwds: [f.root, join(f.root, 'docs'), join(f.root, 'docs/docs')], unknown: false });
  expect(cwd('cd ..')).toEqual({ cwds: [f.root, dirname(f.root)], unknown: false });
  expect(cwd('cd docs 2>/dev/null').unknown).toBe(false);
  expect(cwd('cd docs 2>/dev/null').cwds).toHaveLength(2);
  for (const command of [Array(7).fill('cd docs').join(';'), 'cd -', 'cd $X', 'pushd', 'pushd +1', 'cd old new', 'cd ~other', 'env -S "echo x"']) {
    expect(cwd(command).unknown, command).toBe(true); expect(cwd(command).cwds).toContain(f.root);
  }
  expect(cwd('cd chemical', true, f.base).unknown).toBe(true);
  for (const command of ['cd ..', 'cd .']) expect(cwd(command, true, f.base).unknown).toBe(false);
  expect(cwd('cd chemical', false, f.base).unknown).toBe(false);
  const relative = commandCwds(['env', '-C', 'docs', 'npx', 'tsc'], { cwds: [f.root], unknown: false });
  expect(relative).toEqual({ cwds: [join(f.root, 'docs')], unknown: false });
});
it('malformed workspace denies all brain tools and falls back for other audiences', async () => {
  const f = await fixtureWorkspace();
  const invalid = [{ repos: [] }, { repos: { web: { path: f.root } } }, { repos: { web: { path: '../missing' } } }, { repos: { web: { path: '../chemical', approvalRules: [{ id: 'bad-rule', pattern: '[' }] } } }];
  for (const workspace of invalid) {
    const config = { workspace };
    for (const tool of ['Bash', 'Read', 'Edit']) expect(await invokeWorkspace(tool, { command: 'ls', file_path: 'docs/a' }, { fixture: f, config })).toMatchObject({ code: 2, stderr: expect.stringContaining('하네스 설정을 읽을 수 없습니다.') });
    expect((await invokeWorkspace('Bash', { command: 'ls' }, { fixture: f, config, brain: false })).code).toBe(0);
    expect(await invokeWorkspace('Bash', { command: 'git -C ../chemical commit -m x' }, { fixture: f, config, brain: false, state: 'MERGE' })).toMatchObject({ code: 2, stderr: `하네스 가드[경계]: ${M.M3}\n` });
  }
});
it('cwd caps, redirects, physical symlinks and filesystem failures are bounded', async () => {
  const { symlink } = await import('node:fs/promises');
  const { pathCandidates } = await import('../hooks/effective-cwd.mjs');
  const { memberMainOf } = await import('../hooks/member-main.mjs');
  const f = await fixtureWorkspace();
  const set = (command: string) => possibleCwds(shellCommands(command).entries, f.root, { home: f.home, workspace: true, cdpath: '' });
  expect(set('cd a; cd b; cd c; cd d; cd e; cd f').unknown).toBe(true);
  expect(set('cd a; cd b; cd c; cd d; cd e; cd f').cwds).toContain(f.root);
  expect(set('popd')).toEqual({ cwds: [f.root], unknown: false });
  for (const command of ['cd -P docs', 'cd -L -- docs', '(cd docs)', '{ cd docs; } 2>&1', 'if true; then cd docs; fi', 'docs']) expect(set(command), command).toEqual({ cwds: [f.root, join(f.root, 'docs')], unknown: false });
  expect(set('lnk/../wisepharm-backend').cwds).toContain(join(f.base, 'wisepharm-backend'));
  const paths = pathCandidates('lnk/../wisepharm-backend', f.root);
  expect(paths.cwds).toContain(join(f.base, 'wisepharm-backend')); expect(paths.unknown).toBe(false);
  await symlink('../chemical/new-file', join(f.root, 'dangling'));
  expect(memberMainOf(join(f.root, 'dangling'), [{ name: 'web', path: join(f.base, 'chemical') }])).toBe('web');
  expect((await invokeWorkspace('Bash', { command: 'echo x > dangling' }, { fixture: f })).stderr).toContain(M.M1());
  await symlink('cycle', join(f.root, 'cycle'));
  expect(pathCandidates('cycle/child', f.root).unknown).toBe(true);
  for (const brain of [false, true]) expect((await invokeWorkspace('Bash', { command: 'git -C cycle commit -m x' }, { fixture: f, brain, state: 'MERGE' })).stderr).toContain(M.M4);
});
