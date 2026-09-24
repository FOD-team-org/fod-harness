import { liveHarness } from './p7-brain-helpers.ts';
import * as processes from '../src/core/process-time.ts';
import { generateClaudeMd } from '../src/core/claude-md.ts';
import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, cli } from './p5-helpers.ts';
import { resetMemory, judgeMemory } from '../src/core/memory.ts';
import { readLedger } from '../src/core/ledger.ts';
import { addInbox, listInbox } from '../src/core/inbox.ts';
import { readState, updateState } from '../src/core/state.ts';
import { decideInbox } from '../extensions/orchestrator/index.ts';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

it('P6 memory reset CLI는 표본·다른 워처 필드를 보존하고 이전 critical을 닫아 5분을 다시 센다', async () => {
  const root = await project(), now = Date.now();
  const memory = { at: new Date(now).toISOString(), freeMB: 100, swapUsedGB: 12, over: true, critical: true, overSince: 'old', underSince: 'old' };
  await writeFile(join(root, '.pi/harness-watcher.json'), JSON.stringify({ watch: { memory, childTimeouts: 3 }, judgment: { expectedHash: 'keep' } }));
  const old = await addInbox(root, { kind: 'memory-critical' });
  expect(await cli(root, ['memory', 'reset'])).toMatchObject({ code: 0, value: { ok: true, recoveryQueued: false } });
  const file = JSON.parse(await readFile(join(root, '.pi/harness-watcher.json'), 'utf8'));
  expect(file).toMatchObject({ watch: { childTimeouts: 3, memory: { over: false, swapUsedGB: 12 } }, judgment: { expectedHash: 'keep' } });
  for (const key of ['critical', 'overSince', 'underSince']) expect(file.watch.memory).not.toHaveProperty(key);
  expect((await listInbox(root)).find(r => r.id === old.id)?.status).toBe('applied');
  expect((await readLedger(root)).some(e => e.action === 'memory:reset')).toBe(true);
  const sample = { freeMB: 100, swapUsedGB: 12, pressure: 'warning' as const };
  const first = judgeMemory(file.watch.memory, sample, 8, now);
  expect(first.events.map(e => e.kind)).toEqual(['memory-pressure']);
  expect(judgeMemory(first.watch, sample, 8, now + 299999).events).toEqual([]);
  expect(judgeMemory(first.watch, sample, 8, now + 300000).events.map(e => e.kind)).toEqual(['memory-critical']);
});
it.each(['paused(memory)', 'WAIT_RESOURCE'])('P6 %s reset은 기존 recovered 핸들러로 PICK 회복한다', async state => {
  const root = await project();
  await updateState(root, { state, lastPaused: 'memory', doctor: { ok: true, checkedAt: new Date().toISOString() } });
  expect(await resetMemory(root)).toMatchObject({ recoveryQueued: true });
  const inbox = (await listInbox(root)).filter(r => r.kind === 'memory-recovered');
  expect(inbox).toHaveLength(1); expect(inbox[0]).toMatchObject({ status: 'queued', manualReset: true });
  const notify = vi.fn();
  const pi = { sendUserMessage: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { isIdle: () => false, hasUI: true, ui: { notify } };
  await decideInbox(pi, ctx as never, root, inbox);
  expect((await readState(root)).state).toBe('PICK');
  expect((await readState(root)).lastPaused).toBeUndefined();
  const entries = await readLedger(root);
  expect(entries.find(e => e.action === 'notify:memory-recovered')?.evidence).toMatchObject({ body: expect.stringContaining('수동 해제') });
});
it('P6 memory-critical 알림에 수동 해제 명령을 붙인다', async () => {
  const root = await project('PICK');
  const entry = await addInbox(root, { kind: 'memory-critical', swapUsedGB: 12 });
  await decideInbox({} as ExtensionAPI, { isIdle: () => false } as never, root, [entry]);
  expect((await readLedger(root)).find(e => e.action === 'notify:memory-critical')?.evidence).toMatchObject({ body: expect.stringContaining('fodh memory reset') });
});

it.each(['env', 'ancestor'] as const)('M4 %s 두뇌 memory reset 거부는 워처 바이트 불변', async source => {
  const root = await project();
  const path = join(root, '.pi/harness-watcher.json'), before = '{"watch":{"memory":{"critical":true,"over":true}}}\n';
  await writeFile(path, before);
  if (source === 'env') { await liveHarness(root); vi.stubEnv('FODH_BRAIN', '1'); }
  else {
    await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: process.ppid, startedAt: 'fixture', token: 'fixture' }));
    vi.spyOn(processes, 'processStartedAt').mockResolvedValue('fixture');
    vi.spyOn(processes, 'descendantOf').mockResolvedValue(true);
  }
  await expect(resetMemory(root)).rejects.toThrow('두뇌 세션은 memory reset 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await listInbox(root)).toEqual([]);
});
it('M4 두뇌 CLAUDE.md 명령 목록은 memory reset을 제외한다', async () => {
  const root = await project(); await generateClaudeMd(root);
  const text = await readFile(join(root, 'CLAUDE.md'), 'utf8');
  expect(text).not.toContain('fodh memory reset'); expect(text).not.toContain('fodh config set');
  expect(text).toContain('fodh memory status');
});
