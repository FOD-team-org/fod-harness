import { expect, it, vi } from 'vitest';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gitProject, git } from './p7-git-helpers.ts';
import { addTask, getTask } from '../src/core/backlog.ts';
import { createWorktree, prepareWorktree, listWorktrees } from '../src/core/worktree.ts';
import { loadConfig, setConfig } from '../src/core/config.ts';
import { readState, updateState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { startCodex } from '../src/core/codex.ts';
import * as privacy from '../src/provider/privacy.ts';
import * as processTime from '../src/core/process-time.ts';
import * as tree from '../src/core/proc-tree.ts';
const shQuote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
it('H12 setup 없음은 기존 동작, 새 워크트리 링크 뒤 순차 준비와 기록', async () => {
  const { root, task, path } = await gitProject();
  expect((await readState(root)).worktrees?.[0].setupOk).toBeUndefined();
  const next = await addTask(root, { title: '준비', category: 'docs' });
  await mkdir(join(root, 'node_modules'));
  await setConfig(root, 'worktrees.links', '["node_modules"]');
  await setConfig(root, 'worktrees.setup', JSON.stringify(['test -d node_modules && printf "%s\\n%s\\n" "$FODH_WORKTREE" "$FODH_TASK" > prepared', 'cat prepared; printf FAKE_VALUE >&2']));
  const redact = vi.spyOn(privacy, 'redact').mockImplementation(v => v.replaceAll('FAKE_VALUE', '[fixture redacted]'));
  const made = await createWorktree(root, next.id);
  expect(made).toMatchObject({ created: true, setupOk: true, setupAt: expect.any(String) });
  expect(await readFile(join(made.path, 'prepared'), 'utf8')).toBe(`${made.path}\n${next.id}\n`);
  const log = (await readdir(join(root, '.pi/worktree-setup')))[0];
  expect(await readFile(join(root, '.pi/worktree-setup', log), 'utf8')).toContain('[fixture redacted]');
  expect(redact).toHaveBeenCalled();
  const entries = (await readLedger(root)).filter(e => e.action === 'worktree:setup');
  expect(entries.map(e => e.status)).toEqual(['pre', 'ok', 'pre', 'ok']);
  expect(entries[3].evidence).toMatchObject({ order: 2, exitCode: 0, durationMs: expect.any(Number), log: expect.stringContaining(next.id) });
  const before = entries.length; await createWorktree(root, next.id);
  expect((await readLedger(root)).filter(e => e.action === 'worktree:setup')).toHaveLength(before);
  expect((await listWorktrees(root)).worktrees.find(w => w.taskId === next.id)?.setupOk).toBe(true);
  expect((await getTask(root, task.id)).worktree).toBe(path);
});
it('H12 새 준비 실패 후 등록 유지, 재호출은 준비만 다시 실행', async () => {
  const { root } = await gitProject(), next = await addTask(root, { title: '재시도', category: 'docs' });
  await setConfig(root, 'worktrees.setup', JSON.stringify(['echo attempt >> attempts; test -f ready || exit 7', 'echo complete']));
  await expect(createWorktree(root, next.id)).rejects.toThrow('worktree 준비 실패: 1 exit 7 (로그 .pi/worktree-setup/');
  const record = (await readState(root)).worktrees!.find(w => w.taskId === next.id)!;
  expect(record.setupOk).not.toBe(true); expect((await getTask(root, next.id)).worktree).toBe(record.path);
  await writeFile(join(record.path, 'ready'), 'FAKE_VALUE');
  const retry = await createWorktree(root, next.id);
  expect(retry).toMatchObject({ created: false, setupOk: true, createdAt: record.createdAt });
  expect((await readFile(join(record.path, 'attempts'), 'utf8')).trim().split('\n')).toHaveLength(2);
  expect((await readLedger(root)).filter(e => e.action === 'worktree:create' && e.taskId === next.id && e.status === 'pre')).toHaveLength(1);
});
it('H12 타임아웃은 셸과 자손 그룹을 종료한다', async () => {
  const { root, task, path } = await gitProject();
  const script = "const fs = require('fs'); fs.writeFileSync('child.pid', String(process.pid)); setTimeout(() => fs.writeFileSync('escaped', 'FAKE_VALUE'), 700); setInterval(() => {}, 1000)";
  await setConfig(root, 'worktrees.setup', JSON.stringify([`${shQuote(process.execPath)} -e ${shQuote(script)} & wait`]));
  await expect(prepareWorktree(root, task.id, { timeoutMs: 250 })).rejects.toThrow('exit 124');
  const pid = Number(await readFile(join(path, 'child.pid'), 'utf8'));
  const deadline = Date.now() + 1500;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(alive).toBe(false);
  expect(await readFile(join(path, 'escaped'), 'utf8').catch(() => undefined)).toBeUndefined();
  expect((await readLedger(root)).filter(e => e.action === 'worktree:setup').at(-1)).toMatchObject({ status: 'fail', evidence: { exitCode: 124 } });
});
it.each(['paused(memory)', 'CLEANUP'])('H12 메모리 중단(%s)에는 준비 미실행', async state => {
  const { root, task, path } = await gitProject();
  await setConfig(root, 'worktrees.setup', '["touch should-not-exist"]');
  await updateState(root, { state, lastPaused: 'memory' });
  await expect(createWorktree(root, task.id)).rejects.toThrow('메모리 회복 전');
  expect(await readFile(join(path, 'should-not-exist')).catch(() => undefined)).toBeUndefined();
  expect((await readLedger(root)).filter(e => e.action === 'worktree:setup')).toEqual([]);
});
it('R9 슬롯 거부는 준비 미실행·메모리 거부 (실제 수행자 실행 없음)', async () => {
  const { root, task, path } = await gitProject();
  await setConfig(root, 'worktrees.setup', '["echo prepared > prepared"]');
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id });
  await writeFile(join(root, 'spec.md'), 'fixture spec');
  vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('fixture');
  const snapshot = vi.spyOn(tree, 'commandSnapshot').mockResolvedValue([{ pid: 8001, ppid: 1, startedAt: 'fixture', command: 'codex exec' }]);
  await expect(startCodex(root, 'task', { taskId: task.id, spec: 'spec.md' })).rejects.toThrow('슬롯 사용 중');
  expect(await readFile(join(path, 'prepared'), 'utf8').catch(() => undefined)).toBeUndefined();
  expect(snapshot).toHaveBeenCalledOnce();
  await updateState(root, { lastPaused: 'memory' });
  await expect(startCodex(root, 'task', { taskId: task.id, spec: 'spec.md' })).rejects.toThrow('메모리 회복 전');
});
it('H12·H11·P4 설정 기본값·승인 키·두뇌 변경 거부·링크 비밀 경로', async () => {
  const { root } = await gitProject();
  expect(await loadConfig(root)).toMatchObject({ worktrees: { setup: [], setupTimeoutMinutes: 10 }, delegate: { codex: { externalGuard: true } } });
  for (const [key, value] of [['worktrees.setup', '[]'], ['secrets.readDeny', '["neon_api.json"]'], ['secrets.readAllow', '[]'], ['secrets.defaults', 'false'], ['delegate.codex.externalGuard', 'false']]) {
    await expect(setConfig(root, key, value, { fromCli: true })).rejects.toThrow('승인 전용');
    await setConfig(root, key, value, { fromCli: true, approve: true });
  }
  for (const value of ['0', '61', '1.5']) await expect(setConfig(root, 'worktrees.setupTimeoutMinutes', value)).rejects.toThrow('1~60');
  await setConfig(root, 'secrets.readDeny', '["private.json"]');
  await expect(setConfig(root, 'worktrees.links', '["private.json"]')).rejects.toThrow('보호 경로');
  vi.stubEnv('FODH_BRAIN', '1');
  await expect(setConfig(root, 'secrets.defaults', 'true', { approve: true })).rejects.toThrow('두뇌 세션');
  await expect(setConfig(root, 'worktrees.setup', '[]', { approve: true })).rejects.toThrow('두뇌 세션');
});

it('R9 슬롯 획득 후 준비 실패는 슬롯 해제·감독 실행 없음', async () => {
  const { root, task } = await gitProject();
  vi.stubEnv('FODH_SLOTS_DIR', join(root, 'slots'));
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue('fixture');
  const snapshot = vi.spyOn(tree, 'commandSnapshot').mockResolvedValue([]);
  const check = "const fs = require('fs'); const slot = JSON.parse(fs.readFileSync(process.env.FODH_SLOTS_DIR + '/slots.json')); process.exit(slot.codex?.runId ? 7 : 8)";
  await setConfig(root, 'worktrees.setup', JSON.stringify([`${shQuote(process.execPath)} -e ${shQuote(check)}`]));
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id }); await writeFile(join(root, 'spec.md'), 'fixture spec');
  await expect(startCodex(root, 'task', { taskId: task.id, spec: 'spec.md' })).rejects.toThrow('exit 7');
  expect(snapshot).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(root, 'slots/slots.json'), 'utf8')).codex).toBeNull();
  expect(await readdir(join(root, '.pi/codex')).catch(() => [])).toEqual([]);
});
