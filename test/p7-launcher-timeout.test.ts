import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { project, cli } from './p5-helpers.ts';
import { startCodex, readMeta } from '../src/core/codex.ts';
import { slotsStatus } from '../src/core/slots.ts';
import { readState } from '../src/core/state.ts';
import { addTask } from '../src/core/backlog.ts';
import { isProcessAlive } from '../src/core/lock.ts';
const spawned: number[] = [];
afterEach(() => { for (const pid of spawned.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
it.each([false, true])('R3 실제 멈춘 런처 timeout, 알려진 감독 pid=%s도 회수', async supervisor => {
  const root = await project('RESEARCH'), bin = join(root, 'launcher.mjs');
  await writeFile(join(root, 'spec.md'), 'stub');
  await writeFile(bin, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const pids = [process.pid];
    if (${supervisor}) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref(); pids.push(child.pid);
      process.stdout.write(JSON.stringify({ pid: child.pid }) + '\\n');
    }
    writeFileSync(process.argv[2] + '/pids.json', JSON.stringify(pids));
    setInterval(() => {}, 1000);
  `);
  try {
    await expect(startCodex(root, 'research', { spec: 'spec.md' }, { bin, timeoutMs: 750 })).rejects.toThrow('런처 종료 대기 시간 초과');
    spawned.push(...JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
    const [id] = await readdir(join(root, '.pi/codex'));
    expect(await readMeta(root, id)).toMatchObject({ status: 'fail', finishedAt: expect.any(String) });
    expect((await slotsStatus(root)).codex).toBeNull();
    expect((await readState(root)).delegation).toBeUndefined();
    for (let i = 0; i < 50 && spawned.some(isProcessAlive); i++) await delay(20);
    expect(spawned.some(isProcessAlive)).toBe(false);
  } finally {
    const pids: number[] = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8').catch(() => '[]'));
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});
it('F25 두뇌 pick --dry는 상태·백로그를 변경하지 않고 순수 판정만 출력한다', async () => {
  const root = await project('PICK'), task = await addTask(root, { title: '후보', category: 'docs' });
  const state = await readFile(join(root, '.pi/harness-state.json'));
  const backlog = await readFile(join(root, '.pi/harness-backlog.json'));
  vi.stubEnv('FODH_BRAIN', '1');
  expect(await cli(root, ['pick', '--dry'])).toMatchObject({ code: 0, value: { outcome: 'SPEC', task: { id: task.id } } });
  expect(await readFile(join(root, '.pi/harness-state.json'))).toEqual(state);
  expect(await readFile(join(root, '.pi/harness-backlog.json'))).toEqual(backlog);
  await expect(access(join(root, '.pi/harness-judgment-apply.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
