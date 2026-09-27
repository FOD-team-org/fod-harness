import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
import { join } from 'node:path';
import { acquireSlot, type SlotOwner } from '../src/core/slots.ts';
import { atomicWrite, harnessPath } from '../src/core/storage.ts';
import { readLedger } from '../src/core/ledger.ts';
import { updateState } from '../src/core/state.ts';
import * as processTime from '../src/core/process-time.ts';
import * as worktrees from '../src/core/worktree.ts';
import * as configs from '../src/core/config.ts';
import { externalCodexCandidates, type ProcessSnapshotRow } from '../src/core/proc-tree.ts';

const stamp = '2026-09-28T00:00:00Z';
let parent: string, root: string, outside: string;
const row = (command: string, pid = 701, ppid = 1): ProcessSnapshotRow => ({ command, pid, ppid, startedAt: stamp });
const owner = (): SlotOwner => ({ root, pid: process.pid, startedAt: stamp, acquiredAt: stamp, runId: 'correction' });
const acquire = (rows: ProcessSnapshotRow[], cwdOf: (pid: number) => Promise<string | undefined> = async () => root) =>
  acquireSlot('codex', owner(), { snapshot: async () => rows, cwdOf, alive: async () => false });
async function config(value: object = {}) {
  await atomicWrite(harnessPath(root, 'harness.json'), JSON.stringify({ notify: { channels: ['ledger'] }, ...value }));
}
beforeEach(async () => {
  parent = await fs.realpath(await fs.mkdtemp('/private/tmp/fodh-sl1-fix-'));
  root = join(parent, '일반앱  아이디어'); outside = join(parent, 'outside');
  const home = join(parent, 'home');
  for (const path of [root, outside, home]) await fs.mkdir(path);
  vi.stubEnv('HOME', home); vi.stubEnv('FODH_NOTIFY_OS', 'off');
  vi.spyOn(processTime, 'processStartedAt').mockResolvedValue(stamp);
  await config();
  // Deliberately no global listWorktrees mock: F3 exercises the real non-git path.
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(parent, { recursive: true, force: true });
});
it.each(['-C ', '--cwd ', '--cwd='])('F1 ps 원문 %s 공백 경로·연속 공백을 그대로 판정한다', async flag => {
  expect(await acquire([row(`codex exec -s read-only ${flag}${root} --skip-git-repo-check -`)]))
    .toMatchObject({ acquired: false, owner: { root, external: true } });
});
it.each(['-C ', '--cwd ', '--cwd='])('F1 %s 뒤 위치 인자가 있어도 존재하는 가장 긴 경로를 고른다', async flag => {
  // Both the short prefix and the complete path exist; the complete path must win.
  await fs.mkdir(join(parent, '일반앱'));
  expect(await acquire([row(`codex exec ${flag}${root} review this task --json`)]))
    .toMatchObject({ acquired: false, owner: { root } });
});
it.each(['-C ', '--cwd ', '--cwd='])('F1 %s 상대 공백 경로도 프로세스 cwd로 푼다', async flag => {
  expect(await acquire([row(`codex exec ${flag}일반앱  아이디어 positional prompt -m fixture`)], async () => parent))
    .toMatchObject({ acquired: false, owner: { root } });
});
it('F1 없는 여러 단어 경로는 임의로 짧게 잘라 영역 밖으로 보내지 않는다', async () => {
  const command = `codex exec --cwd=${parent}/없는  경로 --json`;
  expect(await acquire([row(command)])).toEqual({ acquired: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'slot:external-unlocated', evidence: { pid: 701, command } }));
});
it('F1 없는 단일 단어 경로는 기존 prospective realpath를 유지한다', async () => {
  // Use a no-space alias so the input is one unquoted word.
  const alias = join(parent, 'alias'); await fs.symlink(root, alias);
  expect(await acquire([row(`codex exec -C ${alias}/future --json`)]))
    .toMatchObject({ acquired: false, owner: { root: join(root, 'future') } });
});
it('F1 상대 공백 경로의 cwd가 없으면 위치 모름이다', async () => {
  expect(await acquire([row('codex exec --cwd=일반앱  아이디어')], async () => undefined)).toEqual({ acquired: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'slot:external-unlocated' }));
});
const wrapper = (path: string) => `/bin/zsh -c source /tmp/fixture-snapshot && export CODEX_COMPANION_SESSION_ID=fixture && node /plugin/codex-companion.mjs task --cwd ${path} --prompt-file /tmp/fixture-prompt`;
it.each([false, true])('F2 zsh 래퍼의 cwd는 A 안, companion 목적지가 A 안=%s', async inside => {
  const path = inside ? root : outside;
  const cwdOf = vi.fn(async () => root);
  const result = await acquire([row(wrapper(path), 701), row(`node /plugin/codex-companion.mjs task --cwd ${path} --prompt-file /tmp/fixture-prompt`, 702, 701)], cwdOf);
  if (inside) expect(result).toMatchObject({ acquired: false, owner: { pid: 702, root } });
  else expect(result).toEqual({ acquired: true });
  expect(cwdOf).not.toHaveBeenCalled();
});
it.each([false, true])('F2 node → vendor는 가장 안쪽 후보만 센다: 중간 프로세스=%s', async intermediate => {
  const rows = [row(`node /bin/codex exec -C ${root}`, 701), ...(intermediate ? [row('intermediate fixture', 702, 701)] : []), row(`/vendor/codex exec -C ${root}`, 703, intermediate ? 702 : 701)];
  expect(externalCodexCandidates(rows).map(item => item.pid)).toEqual([703]);
  expect(await acquire(rows)).toMatchObject({ acquired: false, owner: { pid: 703, root } });
});
it('F2 별도 형제 후보는 보존하고 자손 순서와 무관하게 래퍼만 제외한다', () => {
  const rows = [row('/vendor/codex exec', 703, 702), row('codex exec', 704), row('node /bin/codex exec', 701), row('middle', 702, 701)];
  expect(externalCodexCandidates(rows).map(item => item.pid)).toEqual([703, 704]);
});
it.each([false, true])('F2 자식 없는 래퍼도 Codex 뒤 목적지 사용: A 안=%s', async inside => {
  const result = await acquire([row(wrapper(inside ? root : outside))]);
  if (inside) expect(result).toMatchObject({ acquired: false, owner: { pid: 701, root } });
  else expect(result).toEqual({ acquired: true });
});
it('F2 Codex 명령 전 node -C 조건은 위치 플래그가 아니다', async () => {
  expect(await acquire([row(`node -C development /plugin/codex-companion.mjs task --cwd ${root} --write`)]))
    .toMatchObject({ acquired: false, owner: { root } });
});
it('F2 codex exec resume 뒤 위치와 따옴표 안 프롬프트 플래그를 구분한다', async () => {
  expect(await acquire([row(`codex exec resume thread "please check -C ${outside}" --cwd ${root} --json`)]))
    .toMatchObject({ acquired: false, owner: { root } });
});
it('F2 위치 없는 래퍼는 Codex 전 -C를 무시하고 cwd를 사용한다', async () => {
  const cwdOf = vi.fn(async () => root);
  expect(await acquire([row('node -C development /plugin/codex-companion.mjs task --write')], cwdOf))
    .toMatchObject({ acquired: false, owner: { root } });
  expect(cwdOf).toHaveBeenCalledWith(701);
});
it('F3 비-git 루트의 상태 등록 워크트리를 실제 listWorktrees로 탐지한다', async () => {
  const path = join(parent, 'registered-custom'); await fs.mkdir(path);
  await updateState(root, { worktrees: [{ taskId: 'T01', path, branch: 'fixture', createdAt: stamp }] });
  expect(vi.isMockFunction(worktrees.listWorktrees)).toBe(false);
  const listed = await worktrees.listWorktrees(root);
  expect(listed.worktrees).toContainEqual(expect.objectContaining({ path, exists: true, registeredInGit: false }));
  expect(await acquire([row(`codex exec -C ${path}`)])).toMatchObject({ acquired: false, owner: { root: path } });
});
async function workspace() {
  for (const name of ['web', 'api']) await fs.mkdir(join(parent, name, '.git'), { recursive: true });
  await fs.mkdir(join(parent, 'trees'));
  await config({ workspace: { repos: Object.fromEntries(['web', 'api'].map(name => [name, {
    path: `../${name}`, worktrees: { root: '../trees', prefix: `${name}-wt-` }, verify: { commands: ['fixture'] },
  }])) } });
}
it.each(['web', 'api', 'trees/api-wt-good'])('F4 깨진 prefix 심링크가 있어도 %s 영역을 보존한다', async name => {
  await workspace(); await fs.mkdir(join(parent, 'trees/api-wt-good'));
  await fs.symlink(join(parent, 'missing'), join(parent, 'trees/web-wt-broken'));
  const path = join(parent, name);
  expect(await acquire([row(`codex exec -C ${path}`)])).toMatchObject({ acquired: false, owner: { root: path } });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'slot:external-scan', status: 'fail', evidence: { stage: 'areas', error: expect.any(String) } }));
});
it('F4 한 멤버 readdir EACCES는 다른 멤버 prefix 영역을 지우지 않는다', async () => {
  await workspace(); const path = join(parent, 'trees/api-wt-good'); await fs.mkdir(path);
  vi.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('fixture readdir denied'), { code: 'EACCES' }));
  expect(await acquire([row(`codex exec -C ${path}`)])).toMatchObject({ acquired: false, owner: { root: path } });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: { stage: 'areas', error: 'fixture readdir denied' } }));
});
it('F4 등록 항목 하나의 정규화 실패는 다른 등록 경로를 지우지 않는다', async () => {
  const broken = join(parent, 'broken'); await fs.symlink(join(parent, 'missing'), broken);
  vi.spyOn(worktrees, 'listWorktrees').mockResolvedValue({ worktrees: [broken, outside].map(path => ({ taskId: path, path, branch: 'fixture', createdAt: stamp, exists: true, registeredInGit: false, setupOk: false })), porcelain: '' });
  expect(await acquire([row(`codex exec -C ${outside}`)])).toMatchObject({ acquired: false, owner: { root: outside } });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: { stage: 'areas', error: expect.any(String) } }));
});
it('F4 listWorktrees 실패도 앞서 수집한 prefix 영역은 유지한다', async () => {
  await config({ worktrees: { root: '../trees', prefix: 'own-' } });
  const path = join(parent, 'trees/own-task'); await fs.mkdir(path, { recursive: true });
  vi.spyOn(worktrees, 'listWorktrees').mockRejectedValue(new Error('fixture list unavailable'));
  expect(await acquire([row(`codex exec -C ${path}`)])).toMatchObject({ acquired: false, owner: { root: path } });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ evidence: { stage: 'areas', error: 'fixture list unavailable' } }));
});
it.each(['config', 'ps', 'areas'] as const)('F4 %s 실패 원장은 stage와 redact 후 200자 error를 남긴다', async stage => {
  // Public synthetic pattern only; never an actual credential.
  const error = new Error('Bearer ' + 'fixture'.repeat(6) + ' ' + 'x'.repeat(240));
  let snapshot = async () => [row(`codex exec -C ${outside}`)];
  if (stage === 'config') vi.spyOn(configs, 'loadConfig').mockRejectedValueOnce(error);
  if (stage === 'ps') snapshot = async () => { throw error; };
  if (stage === 'areas') vi.spyOn(worktrees, 'listWorktrees').mockRejectedValue(error);
  expect(await acquireSlot('codex', owner(), { snapshot })).toEqual({ acquired: true });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'slot:external-scan', status: 'fail',
    evidence: { stage, error: ('[비밀값 제거] ' + 'x'.repeat(240)).slice(0, 200) } }));
});
it('F1 긴 위치 인자가 파일명 길이 한도를 넘어도 앞의 실제 경로를 선택한다', async () => {
  expect(await acquire([row(`codex exec -C ${root} ${'fixture'.repeat(50)} --json`)]))
    .toMatchObject({ acquired: false, owner: { root } });
});
