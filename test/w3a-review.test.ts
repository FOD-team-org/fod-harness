import { expect, it } from 'vitest';
import { join } from 'node:path';
import { possibleCwds } from '../hooks/effective-cwd.mjs';
import { shellCommands } from '../hooks/shell-commands.mjs';
import { fixtureWorkspace, invokeWorkspace, M } from './w3a-helpers.ts';
const denied = (message: string) => ({ code: 2, stderr: `하네스 가드[경계]: ${message}\n` });

it('git redirect destinations use shell cwd while git write operands use git cwd', async () => {
  const f = await fixtureWorkspace();
  for (const command of ['git -C ../chemical log --oneline > .pi/scratch/log.txt', 'git -C ../chemical diff HEAD > .pi/scratch/web.diff', 'git -C ../chemical show HEAD:src/app.ts > .pi/scratch/app.ts']) {
    expect.soft(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 0, stderr: '' });
  }
  for (const [command, message] of [['git -C ../chemical log > ../chemical/x.txt', M.M1()], ['git -C ../chemical stash', M.M2], ['git -C ../chemical stash > .pi/scratch/x', M.M2], ['git -C ../chemical restore src/app.ts > .pi/scratch/x', M.M2], ['git -C ../chemical checkout -- src/app.ts > .pi/scratch/x', M.M2]]) {
    expect.soft(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual(denied(message));
  }
});
it('inline directory search settings are unknown for both workspace and single repository', async () => {
  const f = await fixtureWorkspace();
  const settings = ['CDPATH=.. cd chemical', 'export CDPATH=..; cd chemical', 'CDPATH=..; cd chemical', 'env CDPATH=.. sh -c "cd chemical"', ...['export', 'declare', 'typeset', 'local', 'readonly'].map(c => `${c} CDPATH; cd chemical`), 'setopt CDABLE_VARS; cd chemical', 'setopt AUTO_CD; cd chemical', 'set -o cdablevars; cd chemical', 'set -o autocd; cd chemical', 'bash -c "CDPATH=.. cd chemical"', 'echo "$(CDPATH=.. cd chemical)"'];
  for (const prefix of settings) {
    for (const workspace of [true, false]) {
      const set = possibleCwds(shellCommands(prefix).entries, f.root, { workspace, home: f.home, cdpath: '' });
      expect.soft(set.unknown, prefix).toBe(true);
      expect.soft(set.cwds, prefix).toContain(f.root);
    }
    expect.soft(await invokeWorkspace('Bash', { command: `${prefix} && npm i` }, { fixture: f }), prefix).toEqual(denied(M.M5));
    for (const brain of [true, false]) expect.soft(await invokeWorkspace('Bash', { command: `${prefix} && git commit -m x` }, { fixture: f, brain, state: 'MERGE' }), prefix).toEqual(denied(M.M4));
  }
  expect(await invokeWorkspace('Bash', { command: 'CDPATH=.. cd chemical && git add -A' }, { fixture: f })).toEqual(denied(M.M5));
  for (const brain of [true, false]) expect(await invokeWorkspace('Bash', { command: 'CDPATH=.. cd x && git commit -m x' }, { fixture: f, brain, state: 'MERGE', config: {} })).toEqual(denied(M.M4));
}, 30000);
it('brace and xargs replacement arguments fail closed; bundled options keep write classification', async () => {
  const f = await fixtureWorkspace();
  for (const command of ['npm i --prefix=../{chemical,chemical}', 'node ../{chemical,chemical}/scripts/x.js', 'npx tsc -p ../{chemical,}', 'xargs -I{} npm --prefix {} i <<< ../chemical', 'xargs -IITEM npm --prefix ITEM i <<< ../chemical', 'xargs -I ITEM npm --prefix ITEM i <<< ../chemical']) expect.soft(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual(denied(M.M5));
  for (const command of ['tree -ao x ../chemical', 'sort -ro .pi/scratch/x ../chemical/package.json', 'sort -rT .pi/scratch ../chemical/package.json', 'file -bC -m x ../chemical/package.json', 'X=../chemical npm i']) expect.soft(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual(denied(M.M1()));
  expect(await invokeWorkspace('Bash', { command: "git -C ../chemical grep -nO'touch PWNED' FAKE" }, { fixture: f })).toEqual(denied(M.M2));
  for (const command of ['X=../chemical', "node 'literal{brace}'", 'node "literal{brace}"']) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 0, stderr: '' });
});
it('cwd expansion has a total budget and pathological hook input finishes within one second', async () => {
  const f = await fixtureWorkspace();
  const command = [...Array(600).fill('a'), ...Array(6).fill('cd .'), 'npm i'].join('; ');
  const started = performance.now();
  const set = possibleCwds(shellCommands(command).entries, f.root, { workspace: true, cdpath: '' });
  expect(set).toEqual({ cwds: [f.root], unknown: true });
  expect(performance.now() - started).toBeLessThan(1000);
  const hookStart = performance.now();
  expect(await invokeWorkspace('Bash', { command }, { fixture: f })).toEqual(denied(M.M5));
  expect(performance.now() - hookStart).toBeLessThan(1000);
});
it('single repository outside event cwd retains target and secret checks', async () => {
  const f = await fixtureWorkspace();
  for (const brain of [true, false]) {
    const options = { fixture: f, brain, cwd: '@base@/outside', config: {}, state: 'MERGE' };
    expect(await invokeWorkspace('Bash', { command: 'git commit -m x' }, options)).toEqual(denied(M.M3));
    expect(await invokeWorkspace('Bash', { command: 'git -C @root@ commit -m x' }, options)).toEqual({ code: 0, stderr: '' });
    expect(await invokeWorkspace('Bash', { command: 'npm i' }, options)).toEqual({ code: 0, stderr: '' });
    expect(await invokeWorkspace('Bash', { command: 'cat .env' }, options)).toEqual(brain ? denied('비밀 파일은 두뇌가 읽을 수 없습니다: .env. 값이 필요하면 판단으로 사용자에게 요청하세요') : { code: 0, stderr: '' });
  }
  const set = possibleCwds(shellCommands('cd docs').entries, join(f.base, 'outside'), { cdpath: '' });
  expect(set).toEqual({ cwds: [join(f.base, 'outside'), join(f.base, 'outside/docs')], unknown: false });
});
