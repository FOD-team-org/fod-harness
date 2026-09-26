import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { project } from './p5-helpers.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState } from '../src/core/state.ts';
import { setupWorktree } from '../src/core/worktree-setup.ts';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function pidAt(path: string) {
  for (let i = 0; i < 150; i++) { const pid = Number(await readFile(path, 'utf8').catch(() => '')); if (pid) return pid; await sleep(10); }
  throw new Error('fixture PID timeout');
}
async function fixture(command: string) {
  const root = await project(); await setConfig(root, 'worktrees.setup', JSON.stringify([command]));
  await updateState(root, { worktrees: [{ taskId: 'T01', path: root, branch: 'fixture', createdAt: new Date().toISOString() }] });
  return root;
}
it.each(['exit', 'SIGTERM', 'SIGINT', 'SIGHUP'] as const)('R8 준비 부모 %s 시 분리 그룹 회수', async event => {
  const code = "require('fs').writeFileSync('setup.pid', String(process.pid)); setInterval(() => {}, 1000)";
  const root = await fixture(`exec ${quote(process.execPath)} -e ${quote(code)}`), runner = join(root, 'runner.mjs');
  await writeFile(runner, `import { setupWorktree } from ${JSON.stringify(resolve('src/core/worktree-setup.ts'))};\n${event === 'exit' ? 'setTimeout(() => process.exit(0), 500);' : ''}\nawait setupWorktree(${JSON.stringify(root)}, 'T01');\n`);
  const parent = spawn(process.execPath, [runner], { stdio: 'ignore' }); let pid = 0;
  const closed = new Promise(r => parent.once('exit', r));
  try {
    pid = await pidAt(join(root, 'setup.pid')); if (event !== 'exit') parent.kill(event);
    await closed; let alive = true;
    for (let i = 0; i < 60; i++) { try { process.kill(pid, 0); } catch { alive = false; break; } await sleep(10); }
    expect(alive).toBe(false);
  } finally { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} parent.kill('SIGKILL'); }
});
it('R8 그룹을 떠난 자손의 열린 pipe가 exit 이후 resolve를 붙잡지 않는다·핸들러 복원', async () => {
  const detached = "require('fs').writeFileSync('escaped.pid', String(process.pid)); setTimeout(() => {}, 3000)";
  const code = `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(detached)}], { detached: true, stdio: ['ignore', 1, 2] }); c.unref();`;
  const root = await fixture(`exec ${quote(process.execPath)} -e ${quote(code)}`);
  const events = ['exit', 'SIGTERM', 'SIGINT', 'SIGHUP'] as const, before = events.map(e => process.listenerCount(e));
  const started = performance.now();
  try { await setupWorktree(root, 'T01', { timeoutMs: 2000 }); expect(performance.now() - started).toBeLessThan(800); }
  finally { const pid = await pidAt(join(root, 'escaped.pid')); try { process.kill(-pid, 'SIGKILL'); } catch {} }
  expect(events.map(e => process.listenerCount(e))).toEqual(before);
});
