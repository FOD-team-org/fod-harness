import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireSlot, releaseSlot, slotsPath, slotsStatus, updateSlot, type SlotOwner } from '../src/core/slots.ts';
import { atomicWrite, harnessPath } from '../src/core/storage.ts';
import { readLedger } from '../src/core/ledger.ts';
import { readState, updateState } from '../src/core/state.ts';
import { tick } from '../src/core/watcher.ts';
import { autoResume } from '../extensions/orchestrator/resume.ts';
import { main } from '../src/cli/index.ts';
import { resolveCliRoot } from '../src/cli/root.ts';
import * as processTime from '../src/core/process-time.ts';
import * as tree from '../src/core/proc-tree.ts';
import * as worktree from '../src/core/worktree.ts';

const stamp = '2026-09-28T00:00:00Z';
let parent: string, home: string, a: string, b: string;
const owner = (root: string, runId = 'run'): SlotOwner => ({ root, runId, pid: process.pid, startedAt: stamp, acquiredAt: stamp });
const row = (command: string, pid = 701): tree.ProcessSnapshotRow => ({ pid, ppid: 1, command, startedAt: stamp });
const snapshot = (...candidates: tree.ProcessSnapshotRow[]) => ({ snapshot: async () => candidates });
async function config(root: string, value: object = {}) {
  await atomicWrite(harnessPath(root, 'harness.json'), JSON.stringify({ notify: { channels: ['ledger'] }, ...value }));
}
beforeEach(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'fodh-sl1-')));
  home = join(parent, 'home'); a = join(parent, 'a'); b = join(parent, 'b');
  for (const path of [home, a, b]) await mkdir(path);
  vi.stubEnv('HOME', home); vi.stubEnv('FODH_NOTIFY_OS', 'off');
  vi.stubEnv('FODH_PROJECT_ROOT', ''); vi.stubEnv('FODH_BRAIN', ''); vi.stubEnv('FODH_CODEX_CHILD', '');
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(stamp);
  vi.spyOn(tree, 'commandSnapshot').mockResolvedValue([]);
  vi.spyOn(tree, 'processCwd').mockResolvedValue(undefined);
  vi.spyOn(worktree, 'listWorktrees').mockResolvedValue({ worktrees: [], porcelain: '' });
  await config(a); await config(b);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  await rm(parent, { recursive: true, force: true });
});
it('T1 A와 B는 Codex를 동시에 획득하고 독립 파일에 보관한다', async () => {
  expect(await acquireSlot('codex', owner(a))).toEqual({ acquired: true });
  expect(await acquireSlot('codex', owner(b))).toEqual({ acquired: true });
  for (const root of [a, b]) expect(JSON.parse(await readFile(slotsPath(root), 'utf8')).codex).toEqual(owner(root));
  await updateSlot(b, 'codex', 'run', { childPid: 702 });
  expect((await slotsStatus(a)).codex?.childPid).toBeUndefined();
  await releaseSlot(b, 'codex', 'run');
  expect((await slotsStatus(a)).codex).toEqual(owner(a));
  expect((await slotsStatus(b)).codex).toBeNull();
});
it.each(['codex', 'heavy'] as const)('T2 같은 프로젝트 %s 배타, 다른 프로젝트 허용', async kind => {
  await acquireSlot(kind, owner(a));
  const other = kind === 'codex' ? 'heavy' : 'codex';
  expect(await acquireSlot(other, owner(b))).toEqual({ acquired: true });
  expect(await acquireSlot(other, owner(a, 'next'))).toMatchObject({ acquired: false, owner: { root: a } });
});
it('T3 영역 밖 후보는 획득과 외부 원장에 영향을 주지 않는다', async () => {
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec --cwd ${b}`)))).toEqual({ acquired: true });
  expect((await readLedger(a)).filter(e => e.action.startsWith('slot:external-'))).toEqual([]);
  expect(tree.processCwd).not.toHaveBeenCalled();
});
it.each(['-C', '--cd', '--cwd', '--root', '--project-root'])('T4 %s 공백·등호 인자와 공백 포함 경로', async flag => {
  const location = join(a, 'future directory', 'nested');
  for (const separator of [' ', '=']) {
    const result = await acquireSlot('codex', owner(a), snapshot(row(`codex exec ${flag}${separator}${JSON.stringify(location)}`)));
    expect(result).toMatchObject({ acquired: false, owner: { external: true, root: location, runId: 'external-701' } });
    expect((await slotsStatus(a)).codex?.root).toBe(location);
    await releaseSlot(a, 'codex', 'external-701');
  }
});
it('T4 루트 밖 prefix 워크트리와 그 하위만 포함한다', async () => {
  await config(a, { worktrees: { root: '../trees', prefix: 'a-wt-' } });
  const path = join(parent, 'trees/a-wt-task'); await mkdir(path, { recursive: true });
  await mkdir(join(parent, 'trees/other'));
  await writeFile(join(parent, 'trees/a-wt-file'), 'fixture');
  for (const outside of ['trees', 'trees/other', 'trees/a-wt-file']) {
    expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec --cwd=${join(parent, outside)}`)))).toEqual({ acquired: true });
    await releaseSlot(a, 'codex', 'run');
  }
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec --cwd=${path}/src`))))
    .toMatchObject({ acquired: false, owner: { root: `${path}/src`, external: true } });
});
async function workspace() {
  for (const name of ['web', 'api']) await mkdir(join(parent, name, '.git'), { recursive: true });
  await config(a, { workspace: { repos: Object.fromEntries(['web', 'api'].map(name => [name, {
    path: `../${name}`, worktrees: { root: '../trees', prefix: `${name}-wt-` }, verify: { commands: ['fixture'] },
  }])) } });
}
it.each(['web', 'api', 'trees/api-wt-task'])('T4 워크스페이스 외부 멤버·멤버 워크트리 %s는 루트 슬롯을 막는다', async name => {
  await workspace(); const path = join(parent, name); await mkdir(path, { recursive: true });
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${path}/src`))))
    .toMatchObject({ acquired: false, owner: { root: `${path}/src`, external: true } });
  await expect(readFile(slotsPath(join(parent, 'web')), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
it('T4 인자 없는 후보는 주입 cwd를 사용하고 구형 snapshot.root를 사용하지 않는다', async () => {
  const cwdOf = vi.fn(async () => a);
  expect(await acquireSlot('codex', owner(a), { ...snapshot({ ...row('codex exec'), root: b }), cwdOf }))
    .toMatchObject({ acquired: false, owner: { root: a, external: true } });
  expect(cwdOf).toHaveBeenCalledWith(701);
});
it('T5 영역 밖 첫 후보 뒤 영역 안 companion 후보를 찾는다', async () => {
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec --cwd ${b}`), row(`node /plugin/codex-companion.mjs task --cwd ${a}`, 702))))
    .toMatchObject({ acquired: false, owner: { runId: 'external-702', root: a } });
});
it('영역 안 후보 중 첫 후보를 기록한다', async () => {
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${a}`), row(`codex exec -C ${a}/next`, 702))))
    .toMatchObject({ acquired: false, owner: { runId: 'external-701' } });
});
it.each([false, true])('T6 cwd 조회 실패(throw=%s)는 위치 모름 원장 한 건 후 획득', async throws => {
  const command = 'codex exec ' + 'fixture '.repeat(40);
  const cwdOf = async () => { if (throws) throw new Error('fixture cwd unavailable'); return undefined; };
  expect(await acquireSlot('codex', owner(a), { ...snapshot(row(command)), cwdOf })).toEqual({ acquired: true });
  expect((await readLedger(a)).filter(e => e.action.startsWith('slot:external-')))
    .toEqual([expect.objectContaining({ action: 'slot:external-unlocated', status: 'ok', evidence: { pid: 701, command: command.slice(0, 200) } })]);
});
it.each([true, false])('T7 상대 인자는 프로세스 cwd가 있을 때만 판정: %s', async located => {
  const result = await acquireSlot('codex', owner(a), { ...snapshot(row('codex exec --cd=../a/future')), cwdOf: async () => located ? b : undefined });
  if (located) expect(result).toMatchObject({ acquired: false, owner: { root: join(a, 'future') } });
  else {
    expect(result).toEqual({ acquired: true });
    expect(await readLedger(a)).toContainEqual(expect.objectContaining({ action: 'slot:external-unlocated' }));
  }
});
it('T8 심링크 하네스 루트와 존재하지 않는 자손은 realpath로 비교한다', async () => {
  const alias = join(parent, 'alias'); await symlink(a, alias);
  expect(await acquireSlot('codex', owner(alias), snapshot(row(`codex exec -C ${a}/future`))))
    .toMatchObject({ acquired: false, owner: { root: join(a, 'future') } });
  await releaseSlot(alias, 'codex', 'external-701');
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${alias}/future`))))
    .toMatchObject({ acquired: false, owner: { root: join(a, 'future') } });
});
it('T8 루트 안의 심링크가 영역 밖으로 향하면 무시한다', async () => {
  await symlink(b, join(a, 'outside'));
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${a}/outside/future`)))).toEqual({ acquired: true });
});
it('T9 구형 HOME 전역 파일과 FODH_SLOTS_DIR는 읽거나 수정하지 않는다', async () => {
  const legacy = join(home, '.pi/agent/fod-harness/slots.json'), override = join(parent, 'override');
  const bytes = JSON.stringify({ codex: owner(b), heavy: owner(b, 'heavy'), claude: null }) + '\n';
  await atomicWrite(legacy, bytes); await atomicWrite(join(override, 'slots.json'), bytes); vi.stubEnv('FODH_SLOTS_DIR', override);
  expect(await acquireSlot('codex', owner(a))).toEqual({ acquired: true });
  await updateSlot(a, 'codex', 'run', { pid: process.pid }); await slotsStatus(a); await releaseSlot(a, 'codex', 'run');
  expect(await readFile(legacy, 'utf8')).toBe(bytes);
  expect(await readFile(join(override, 'slots.json'), 'utf8')).toBe(bytes);
});
it.each(['paused(slot)', 'WAIT_RESOURCE'])('T10 살아 있는 다른 프로젝트 표지는 60초 내 해제: %s', async state => {
  const waiting = { kind: 'codex' as const, since: stamp, owner: { ...owner(b, 'external-old'), external: true } };
  await acquireSlot('codex', owner(b));
  const now = Date.now();
  await tick(a, { now });
  await updateState(a, { state, lastPaused: 'slot', phase: 'project', awaitingSlot: waiting });
  const watcherPath = harnessPath(a, 'harness-watcher.json');
  const file = JSON.parse(await readFile(watcherPath, 'utf8'));
  file.watch.slotCheck = { since: stamp, ownerRunId: 'external-old', at: new Date(now).toISOString() };
  await atomicWrite(watcherPath, JSON.stringify(file));
  const emitted = (await tick(a, { now: now + 60000 })).emitted;
  expect(emitted).toContainEqual(expect.objectContaining({ kind: 'slot-free', ownerRunId: 'external-old' }));
  const sendMessage = vi.fn();
  expect(await autoResume({ sendMessage } as never, a, { cwd: a, hasUI: true, isIdle: () => true, notify: vi.fn() }, 'slot-free')).toEqual({ resumed: true });
  expect(await readState(a)).toMatchObject({ state: 'PICK' });
  expect((await readState(a)).awaitingSlot).toBeUndefined(); expect(sendMessage).toHaveBeenCalledOnce();
});
it.each(['codex', 'heavy'] as const)('현재 프로젝트의 살아 있는 %s 소유자는 낡은 표지 대신 대기한다', async kind => {
  await acquireSlot(kind, owner(a));
  await updateState(a, { state: 'paused(slot)', lastPaused: 'slot', awaitingSlot: { kind: 'codex', since: stamp, owner: { ...owner(b), pid: 99999999 } } });
  expect(await autoResume({ sendMessage: vi.fn() } as never, a, { cwd: a, hasUI: true, isIdle: () => true, notify: vi.fn() }, 'slot-free')).toEqual({ skipped: 'slot' });
});
it('T11 status와 CLI는 현재 프로젝트 path와 필드만 출력한다', async () => {
  await acquireSlot('codex', owner(b));
  const expected = { path: slotsPath(a), codex: null, heavy: null, claude: null, alive: { codex: false, heavy: false, claude: false } };
  expect(await slotsStatus(a)).toEqual(expected);
  await updateState(a, { state: 'PICK' }); await mkdir(join(a, 'nested'));
  let output = ''; const write = vi.spyOn(process.stdout, 'write').mockImplementation(value => { output += value; return true; });
  try { await main(['slots', 'status'], await resolveCliRoot(join(a, 'nested'))); } finally { write.mockRestore(); }
  expect(process.exitCode ?? 0).toBe(0); expect(JSON.parse(output)).toEqual(expected);
});
it('등록 워크트리는 prefix 밖·아직 없는 경로도 포함한다', async () => {
  const path = join(parent, 'registered/future');
  vi.mocked(worktree.listWorktrees).mockResolvedValue({ worktrees: [{ taskId: 'T01', path, branch: 'fixture', createdAt: stamp, exists: false, registeredInGit: false, setupOk: false }], porcelain: '' });
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec --root=${path}/src`))))
    .toMatchObject({ acquired: false, owner: { root: `${path}/src` } });
});
it('하네스 미등록 Git 경로는 listWorktrees porcelain에 있어도 제외한다', async () => {
  vi.mocked(worktree.listWorktrees).mockResolvedValue({ worktrees: [], porcelain: { web: `worktree ${b}\nHEAD fixture\n` } });
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${b}`)))).toEqual({ acquired: true });
});
it.each([(a: string, _b: string) => a, (_a: string, b: string) => b])('영역 계산 오류는 실패 원장을 남기고 루트만 사용한다', async location => {
  vi.mocked(worktree.listWorktrees).mockRejectedValue(new Error('fixture list unavailable'));
  const path = location(a, b);
  expect((await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${path}`)))).acquired).toBe(path !== a);
  expect(await readLedger(a)).toContainEqual(expect.objectContaining({ action: 'slot:external-scan', status: 'fail' }));
});
it('설정 읽기 오류도 루트 내 외부 후보를 보수적으로 검사한다', async () => {
  await writeFile(harnessPath(a, 'harness.json'), '{broken');
  expect(await acquireSlot('codex', owner(a), snapshot(row(`codex exec -C ${a}`)))).toMatchObject({ acquired: false });
  expect(await readLedger(a)).toContainEqual(expect.objectContaining({ action: 'slot:external-scan', status: 'fail' }));
});
it('ps 실패는 scan fail만 남기고 획득한다', async () => {
  expect(await acquireSlot('codex', owner(a), { snapshot: async () => { throw new Error('fixture ps unavailable'); } })).toEqual({ acquired: true });
  expect(await readLedger(a)).toEqual([expect.objectContaining({ action: 'slot:external-scan', status: 'fail' })]);
});
it('externalGuard false이면 스냅샷·cwd·영역 계산을 하지 않는다', async () => {
  await config(a, { delegate: { codex: { externalGuard: false } } });
  expect(await acquireSlot('codex', owner(a))).toEqual({ acquired: true });
  expect(tree.commandSnapshot).not.toHaveBeenCalled(); expect(tree.processCwd).not.toHaveBeenCalled(); expect(worktree.listWorktrees).not.toHaveBeenCalled();
});
it('상대 경로는 하이픈으로 시작해도 cwd 기준으로 해석한다', async () => {
  expect(await acquireSlot('codex', owner(a), { ...snapshot(row('codex exec --cwd=-folder')), cwdOf: async () => a }))
    .toMatchObject({ acquired: false, owner: { root: join(a, '-folder') } });
});
it('여러 후보의 cwd를 각각 조회하고 영역 밖·위치 모름 뒤에도 검사한다', async () => {
  const cwdOf = vi.fn(async (pid: number) => pid === 701 ? b : pid === 702 ? undefined : a);
  expect(await acquireSlot('codex', owner(a), { ...snapshot(row('codex exec', 701), row('codex exec', 702), row('codex exec', 703)), cwdOf }))
    .toMatchObject({ acquired: false, owner: { runId: 'external-703', root: a } });
  expect(cwdOf.mock.calls.map(([pid]) => pid)).toEqual([701, 702, 703]);
  expect((await readLedger(a)).filter(e => e.action.startsWith('slot:external-')))
    .toEqual([expect.objectContaining({ action: 'slot:external-unlocated', evidence: { pid: 702, command: 'codex exec' } })]);
});
it('cwd 조회 실행 함수에 1초·C locale를 전달하고 조회 실패는 위치 모름이다', async () => {
  const run = vi.fn(async () => ({ stdout: `p701\nn${a}\n` }));
  // beforeEach's production seam is restored only for this injected executor test.
  vi.mocked(tree.processCwd).mockRestore();
  expect(await tree.processCwd(701, run)).toBe(a);
  expect(run).toHaveBeenCalledWith('/usr/sbin/lsof', ['-a', '-p', '701', '-d', 'cwd', '-Fn'],
    expect.objectContaining({ timeout: 1000, env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C' }) }));
  expect(await tree.processCwd(701, async () => { throw new Error('fixture lsof unavailable'); })).toBeUndefined();
});
