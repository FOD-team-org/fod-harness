import { expect, it } from 'vitest';
import { fixtureWorkspace, invokeWorkspace, M } from './w3a-helpers.ts';
import { invoke } from './hook-helpers.ts';

it('member git subcommands and global options', async () => {
  const f = await fixtureWorkspace();
  const allowed = [
    'status', '--no-pager log --oneline -5', 'diff --output-indicator-new=+', 'grep -n foo', 'blame package.json', 'cat-file -p HEAD:package.json',
    'branch', 'branch -a', 'branch -vv', "branch --list 'wp-*'", 'branch --contains HEAD', 'branch --show-current',
    'remote', 'remote -v', 'remote get-url origin', 'config --get user.name', 'config --list --show-origin', 'config -l --local',
    'symbolic-ref --short HEAD', 'worktree list --porcelain', 'stash list', 'stash show', 'rev-parse --show-toplevel', 'ls-files', 'for-each-ref', 'merge-base main HEAD',
  ].map(s => 'git -C ../chemical ' + s).concat(['git --no-pager -C ../chemical diff HEAD --stat', 'git -P -C ../chemical show HEAD --stat', 'git --no-optional-locks -C ../chemical status', 'cd ../chemical && git log', 'git -C .. -C chemical log', 'git -C $D log', 'cd $D && git status', 'git --version', 'git --help']);
  for (const command of allowed) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 0, stderr: '' });
  const denied = ['checkout main', 'branch newname', 'branch -m a b', 'fetch', 'add .', 'stash', 'stash pop', 'remote show origin', 'remote add x y', 'config user.name x', 'config --global --get x', 'symbolic-ref HEAD refs/heads/x', 'worktree lock x',
    'log --output=x', 'log --output x', 'diff --ext-diff', 'show --textconv', 'grep -O foo', 'grep -Oless foo', 'grep --open-files-in-pager=vi foo', 'cat-file --textconv HEAD:a', 'cat-file --filters HEAD:a', 'grep --open-files=touch foo', 'grep --open=vi foo', 'cat-file --filt HEAD:a', 'diff --ext'];
  for (const action of denied) expect(await invokeWorkspace('Bash', { command: 'git -C ../chemical ' + action }, { fixture: f }), action).toEqual({ code: 2, stderr: `하네스 가드[경계]: ${M.M2}\n` });
  for (const command of ['git -c core.pager=less -C ../chemical log', 'git -c x=y status', 'git --git-dir=../chemical/.git log', 'git --work-tree=. status', 'git --exec-path=/x status', 'git -p log', 'git --paginate log', 'git --config-env=a=B status']) expect((await invokeWorkspace('Bash', { command }, { fixture: f })).stderr, command).toBe(`하네스 가드[경계]: ${M.M7}\n`);
  for (const command of ['GIT_DIR=../chemical/.git git log', 'export GIT_DIR=../chemical/.git; git log', 'env GIT_PAGER=cat git log', 'GIT_EXTERNAL_DIFF=x git diff', 'export GIT_WORK_TREE', 'bash -c "GIT_DIR=x git log"', 'eval "GIT_DIR=x git log"']) expect((await invokeWorkspace('Bash', { command }, { fixture: f })).stderr, command).toBe(`하네스 가드[경계]: ${M.M6}\n`);
  for (const [action, message] of [['reset --hard', '두뇌의 git 이력·참조 재작성은 금지합니다.'], ['branch -D x', '두뇌의 git 이력·참조 재작성은 금지합니다.'], ['worktree add ../x', 'git worktree 직접 실행 대신 fodh worktree를 사용하세요.'], ['worktree prune', 'git worktree 직접 실행 대신 fodh worktree를 사용하세요.'], ['revert HEAD', 'main 변경은 task 워크트리 위임으로만 한다']]) expect((await invokeWorkspace('Bash', { command: 'git -C ../chemical ' + action }, { fixture: f })).stderr, action).toContain(message);
  expect((await invokeWorkspace('Bash', { command: 'git -C .. -C chemical checkout x' }, { fixture: f })).stderr).toContain(M.M2);
  expect((await invokeWorkspace('Bash', { command: 'git -C $D checkout x' }, { fixture: f })).stderr).toBe(`하네스 가드[경계]: ${M.M5}\n`);
}, 30000);
it('git mutation targets precede the state gate, across audiences', async () => {
  const f = await fixtureWorkspace();
  for (const brain of [true, false]) {
    for (const command of ['git commit -m x', 'cd docs && git commit -m x', 'git -C ../wp-web-T01 commit -m x', 'git -C ../chemical -C ../workspace commit -m x']) expect((await invokeWorkspace('Bash', { command }, { fixture: f, state: 'MERGE', brain })).code, command).toBe(0);
    for (const command of ['git -C ../chemical commit -m x', 'git -C ../chemical merge wp-web-T01', 'git -C ../chemical push origin main', 'cd ../chemical && git commit -m x']) expect((await invokeWorkspace('Bash', { command }, { fixture: f, state: 'MERGE', brain })).stderr, command).toBe(`하네스 가드[경계]: ${M.M2}\n`);
    for (const [command, message] of [['git -C ../outside commit -m x', M.M3], ['git -C .. commit -m x', M.M3], ['git -C $D commit -m x', M.M4], ['cd $D && git commit -m x', M.M4]]) expect((await invokeWorkspace('Bash', { command }, { fixture: f, state: 'MERGE', brain })).stderr, command).toContain(message);
  }
  expect((await invokeWorkspace('Bash', { command: 'GIT_DIR=x git commit -m x' }, { fixture: f, brain: false, state: 'MERGE' })).stderr).toContain(M.M4);
  expect((await invokeWorkspace('Bash', { command: 'git -C ../wp-web-T01 commit -m x' }, { fixture: f })).stderr).toContain('현재 상태에서는 해당 git 변경을 허용하지 않습니다.');
  expect((await invokeWorkspace('Bash', { command: 'git push origin main' }, { fixture: f, state: 'MERGE' })).stderr).toContain('승인 필수 동작(push-main)');
});
it('single repository target checks for both audiences and deep roots', async () => {
  for (const brain of [true, false]) {
    const options = { worktrees: true, homeLayout: 'outside' as const, env: { FODH_NOTIFY_OS: 'off', ...(brain ? { FODH_BRAIN: '1' } : {}) } };
    for (const command of ['git commit -m x', 'git -C worktree commit -m x', 'git -C @root@-wt commit -m x', 'cd docs && git commit -m x', 'cd docs 2>/dev/null && git commit -m x', 'pushd docs >/dev/null && git commit -m x', 'cd a/b && cd c && git commit -m x']) expect((await invoke('Bash', { command }, 'MERGE', options)).code, command).toBe(0);
    for (const command of ['git -C .. commit -m x', 'cd docs && git commit -m x && cd ..', 'cd docs && npm test && cd .. && git commit -m x']) expect((await invoke('Bash', { command }, 'MERGE', options)).stderr, command).toContain(M.M3);
    for (const command of ['cd $D && git commit -m x', 'GIT_DIR=x git commit -m x', 'git --git-dir=.git commit -m x', 'git --work-tree=. commit -m x', 'git commit -m x && cd -']) expect((await invoke('Bash', { command }, 'MERGE', options)).stderr, command).toContain(M.M4);
    expect((await invoke('Bash', { command: 'git -C .. commit -m x' }, 'IMPLEMENT', options)).stderr).toContain(M.M3);
    const f = await fixtureWorkspace({ deep: true });
    expect((await invokeWorkspace('Bash', { command: 'cd docs && git commit -m x' }, { fixture: f, config: {}, state: 'MERGE', brain })).code).toBe(0);
  }
}, 30000);
