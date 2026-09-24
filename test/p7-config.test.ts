import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { loadConfig, setConfig } from '../src/core/config.ts';
import * as storage from '../src/core/storage.ts';
import { readLedger } from '../src/core/ledger.ts';
import { notify } from '../src/core/notify.ts';

it('F3 미지 키는 모아서 root+키 집합당 1회 경고하고 로드는 성공한다', async () => {
  const raw = { unknown: true, maxAutoTurns: 3, brain: { typo: true }, delegate: { codex: { effort: 'high' } },
    verify: { typo: true }, docs: { typo: true }, skills: { typo: true }, notify: { channels: ['ledger'], typo: true } };
  const keys = ['brain.typo', 'delegate.codex.effort', 'docs.typo', 'notify.typo', 'skills.typo', 'unknown', 'verify.typo'];
  for (const root of [await project(), await project()]) {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify(raw));
    // notify→loadConfig→notify must complete without a recursive lock wait.
    await notify(root, { key: 'fixture', title: 'fixture', body: 'fixture', level: 'info' });
    expect((await loadConfig(root)).delegate.codex.brainEffort).toBe('xhigh');
    await Promise.all([loadConfig(root), loadConfig(root, Object.fromEntries(Object.entries(raw).reverse()))]);
    const warnings = (await readLedger(root)).filter(e => e.action === 'notify:config:unknown-key');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ status: 'ok', evidence: { level: 'warning', body: `알 수 없는 설정 키: ${keys.join(', ')}` } });
  }
});

it('N6/F9 별도 Node 프로세스마다 읽어도 같은 키 집합은 알림 1회·skip 0줄', async () => {
  const root = await project();
  await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ notify: { channels: ['ledger'] }, delegate: { codex: { effort: 'high' } } }));
  const script = "import { loadConfig } from './src/core/config.ts'; await loadConfig(process.argv[1]);";
  for (let i = 0; i < 2; i++) await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root]);
  await loadConfig(root);
  const warnings = (await readLedger(root)).filter(e => e.action === 'notify:config:unknown-key');
  expect(warnings).toHaveLength(1); expect(warnings[0].status).toBe('ok');
  expect(warnings.filter(e => e.status === 'skip')).toHaveLength(0);
  expect(JSON.parse(await readFile(join(root, '.pi/harness-config-warned.json'), 'utf8'))).toEqual({ keysHash: expect.stringMatching(/^[a-f0-9]{64}$/u), at: expect.any(String) });
});

it('N6 키 집합 변경은 즉시 경고하고 미지 키가 없어지면 파일을 삭제한다', async () => {
  const root = await project(), path = join(root, '.pi/harness.json'), warned = join(root, '.pi/harness-config-warned.json');
  const write = async (extra: Record<string, unknown>) => {
    await writeFile(path, JSON.stringify({ notify: { channels: ['ledger'] }, ...extra })); await loadConfig(root);
  };
  await write({ typo: true }); const first = JSON.parse(await readFile(warned, 'utf8')).keysHash;
  await write({ secondTypo: true }); expect(JSON.parse(await readFile(warned, 'utf8')).keysHash).not.toBe(first);
  await write({}); await expect(readFile(warned)).rejects.toMatchObject({ code: 'ENOENT' });
  await write({ typo: true });
  expect((await readLedger(root)).filter(e => e.action === 'notify:config:unknown-key').map(e => e.status)).toEqual(['ok', 'ok', 'ok']);
});

it('L6 같은 프로세스의 같은 키 집합은 경고 파일을 다시 읽거나 잠그지 않는다', async () => {
  const root = await project(), path = join(root, '.pi/harness.json'), warned = join(root, '.pi/harness-config-warned.json');
  await writeFile(path, JSON.stringify({ notify: { channels: ['ledger'] }, typo: true }));
  const reads = vi.spyOn(storage, 'readJson'), locks = vi.spyOn(storage, 'withFileLock');
  await Promise.all([loadConfig(root), loadConfig(root)]);
  expect(reads.mock.calls.filter(([file]) => file === warned)).toHaveLength(1);
  reads.mockClear(); locks.mockClear();
  await Promise.all([loadConfig(root), loadConfig(root)]);
  expect(reads.mock.calls.filter(([file]) => file === warned)).toHaveLength(0);
  expect(locks.mock.calls.filter(([file]) => file === warned)).toHaveLength(0);
  expect((await readLedger(root)).filter(e => e.action === 'notify:config:unknown-key')).toHaveLength(1);
});

it.each(['validation', 'write'])('L6 setConfig %s 실패는 경고 파일·설정·경고 이력을 만들지 않는다', async failure => {
  const root = await project(), path = join(root, '.pi/harness.json'), warned = join(root, '.pi/harness-config-warned.json');
  const before = await readFile(path, 'utf8');
  if (failure === 'validation') {
    await expect(setConfig(root, 'brain', '{"model":"invalid","typo":true}')).rejects.toThrow('brain.model');
  } else {
    const original = storage.atomicWrite;
    const write = vi.spyOn(storage, 'atomicWrite').mockImplementation(async (file, text) => {
      if (file === path) throw new Error('fixture: save failed');
      return original(file, text);
    });
    await expect(setConfig(root, 'pendingTypo', 'true')).rejects.toThrow('fixture: save failed');
    write.mockRestore();
  }
  expect(await readFile(path, 'utf8')).toBe(before);
  await expect(readFile(warned)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readLedger(root)).filter(e => e.action === 'notify:config:unknown-key')).toHaveLength(0);
  // A later successful save is warned only on a real load; dryRun must not poison the cache.
  await setConfig(root, 'pendingTypo', 'true');
  await expect(readFile(warned)).rejects.toMatchObject({ code: 'ENOENT' });
  await loadConfig(root);
  expect((await readLedger(root)).filter(e => e.action === 'notify:config:unknown-key')).toHaveLength(1);
});
