import { expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './p5-helpers.ts';
import { gitProject, git } from './p7-git-helpers.ts';
import { addTask, setTask } from '../src/core/backlog.ts';
import { updateState, readState, transitionState } from '../src/core/state.ts';
import { runPick } from '../src/core/pick.ts';
import { resetMemory } from '../src/core/memory.ts';
import * as storage from '../src/core/storage.ts';
import { addInbox, listInbox } from '../src/core/inbox.ts';
import { readLedger } from '../src/core/ledger.ts';
import { decideInbox, instruction } from '../extensions/orchestrator/index.ts';
import { addJudgment, answerJudgment, applyJudgments, readJudgment, migrateJudgment, readArchive } from '../src/core/judgment.ts';
import { invoke } from './hook-helpers.ts';
import { todayKst } from '../src/core/template-values.ts';
const complete = { verify: { ok: true }, review: { commit: 'none', high: 0 }, merge: { commit: 'none' }, docs: { ok: true }, cleanup: { ok: true } };
it.each(['CLEANUP', 'DOCS'])('P1 %s critical→정리 계속→PICK→WAIT_RESOURCE→recovered 자동 재개', async stage => {
  const root = await project(stage), task = await addTask(root, { title: '마무리', category: 'docs' });
  await updateState(root, { taskId: task.id });
  const sendMessage = vi.fn(), notify = vi.fn(), pi = { sendMessage } as never;
  const ctx = { cwd: root, hasUI: true, isIdle: () => true, ui: { notify } } as never;
  await decideInbox(pi, ctx, root, [await addInbox(root, { kind: 'memory-critical' })]);
  expect(await readState(root)).toMatchObject({ state: stage, lastPaused: 'memory' });
  expect(await readLedger(root)).toContainEqual(expect.objectContaining({ action: 'notify:memory-critical', evidence: expect.objectContaining({ body: '정리·문서 단계는 계속합니다. 다음 task 는 메모리 회복 뒤 시작합니다' }) }));
  if (stage === 'DOCS') {
    await mkdir(join(root, 'docs/작업일지')); await writeFile(join(root, `docs/작업일지/${todayKst()}.md`), task.id);
    await transitionState(root, 'CLEANUP', task.id);
  }
  await setTask(root, task.id, { ...complete, status: 'done' });
  await transitionState(root, 'PICK');
  expect((await runPick(root)).outcome).toBe('WAIT_RESOURCE');
  expect(await readState(root)).toMatchObject({ state: 'WAIT_RESOURCE', lastPaused: 'memory' });
  await decideInbox(pi, ctx, root, [await addInbox(root, { kind: 'memory-recovered' })]);
  expect((await readState(root)).state).toBe('PICK'); expect((await readState(root)).lastPaused).toBeUndefined();
  expect(sendMessage).toHaveBeenCalledOnce();
});
it('P1 IMPLEMENT critical은 기존 paused(memory)', async () => {
  const root = await project('IMPLEMENT');
  await decideInbox({ sendMessage: vi.fn() } as never, { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } } as never,
    root, [await addInbox(root, { kind: 'memory-critical' })]);
  expect(await readState(root)).toMatchObject({ state: 'paused(memory)', lastPaused: 'memory', resumeState: 'IMPLEMENT' });
});
it.each(['예', 'true'])('P3 새 렌더링·옛 %s 읽기/적용·보관 한글 표기', async approval => {
  const root = await project();
  const { item } = await addJudgment(root, { title: '진행 확인', background: 'fixture', options: ['진행', '보류'], recommend: '진행', blocks: '-', requiresApproval: true });
  const file = join(root, 'docs/판단대기.md'), text = await readFile(file, 'utf8');
  expect(text).toContain('- 승인 필수: 예');
  await writeFile(file, text.replace('- 승인 필수: 예', `- 승인 필수: ${approval}`));
  expect((await readJudgment(root)).items[0].requiresApproval).toBe(true);
  await answerJudgment(root, item.id, '1'); expect((await applyJudgments(root, [item.id])).applied).toHaveLength(1);
  const archive = (await readArchive(root))[0];
  const saved = await readFile(join(root, 'docs', archive.path!), 'utf8');
  expect(saved).toContain('- 승인 필수: 예'); expect(saved).not.toContain('- 승인 필수: true');
});
it('P3 migrate 열린 항목과 기존 판단기록도 true를 예로 정규화', async () => {
  const root = await project();
  const { item } = await addJudgment(root, { title: '승인', background: 'fixture', options: ['진행'], recommend: '진행', blocks: '-', requiresApproval: true });
  const path = join(root, 'docs/판단대기.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('승인 필수: 예', '승인 필수: true'));
  await mkdir(join(root, 'docs/판단기록'), { recursive: true });
  await writeFile(join(root, 'docs/판단기록/2026-01.md'), '# 판단기록\n\n### A90 — 과거 (rev 1)\n- 결정일: 2026-01-01\n- 답: 1\n- 승인 필수: true\n');
  await migrateJudgment(root);
  expect(await readFile(path, 'utf8')).toContain('승인 필수: 예');
  for (const file of await readdir(join(root, 'docs/판단기록'))) expect(await readFile(join(root, 'docs/판단기록', file), 'utf8')).not.toContain('승인 필수: true');
  expect((await readJudgment(root)).items.find(i => i.id === item.id)?.requiresApproval).toBe(true);
});
it.each([true, false])('P5 백로그 변경=%s CLEANUP→PICK 경고만 기록', async dirty => {
  const { root, task } = await gitProject();
  await updateState(root, { state: 'CLEANUP', taskId: task.id });
  await setTask(root, task.id, complete);
  await git(root, 'add', '-f', 'docs/backlog.md'); await git(root, 'commit', '-m', 'fixture backlog');
  await setTask(root, task.id, { status: 'done' });
  if (!dirty) { await git(root, 'add', '-f', 'docs/backlog.md'); await git(root, 'commit', '-m', 'fixture done'); }
  await transitionState(root, 'PICK');
  expect((await readState(root)).state).toBe('PICK');
  expect((await readLedger(root)).filter(e => e.action === 'docs:backlog-uncommitted' && e.status === 'warn')).toHaveLength(dirty ? 1 : 0);
});
it('P5 CLEANUP 렌더링의 백로그 단독 커밋만 훅 허용', async () => {
  const root = await project('CLEANUP');
  const text = await instruction(root, { state: 'CLEANUP', taskId: 'T01' });
  expect(text).toContain('git commit -m "docs(backlog): T01 완료" -- docs/backlog.md');
  expect(text.indexOf('fodh backlog set')).toBeLessThan(text.indexOf('git commit'));
  expect(text.indexOf('git commit')).toBeLessThan(text.indexOf('fodh state transition PICK'));
  for (const [command, code] of [['git commit -m "docs(backlog): T01 완료" -- docs/backlog.md', 0],
    ['git commit -m "docs(backlog): T01 완료" -- docs/backlog.md src/a.ts', 2], ['git commit -am "all"', 2],
    ['git commit --no-verify -m "docs(backlog): T01 완료" -- docs/backlog.md', 2]] as const) {
    expect((await invoke('Bash', { command }, 'CLEANUP', { env: { FODH_BRAIN: '1' }, nonTempRoot: true, homeLayout: 'inside' })).code).toBe(code);
  }
});

it.each(['CLEANUP', 'DOCS'])('R4 %s memory reset은 marker를 해제할 회복 이벤트를 만든다', async state => {
  const root = await project(state); await updateState(root, { lastPaused: 'memory' });
  await writeFile(join(root, '.pi/harness-watcher.json'), JSON.stringify({ watch: { memory: { over: true, critical: true } } }));
  expect(await resetMemory(root)).toMatchObject({ recoveryQueued: true });
  const queued = (await listInbox(root)).filter(r => r.kind === 'memory-recovered'); expect(queued).toHaveLength(1);
  await decideInbox({ sendMessage: vi.fn() } as never, { cwd: root, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() } } as never, root, queued);
  expect((await readState(root)).lastPaused).toBeUndefined(); expect((await readState(root)).state).toBe(state);
});
it('R7 updateState 재시도 시 backlog 경고는 확정 후 단 한 번', async () => {
  const { root, task } = await gitProject(); await updateState(root, { state: 'CLEANUP', taskId: task.id });
  await setTask(root, task.id, complete);
  await git(root, 'add', '-f', 'docs/backlog.md'); await git(root, 'commit', '-m', 'fixture tracked backlog');
  await setTask(root, task.id, { status: 'done' });
  const original = storage.withFileLock; let attempts = 0;
  vi.spyOn(storage, 'withFileLock').mockImplementation(async (path, action, options) => {
    if (path === join(root, '.pi/harness-state.json') && ++attempts < 3) {
      const current = JSON.parse(await readFile(path, 'utf8')); current.race = attempts;
      await writeFile(path, JSON.stringify(current));
    }
    return original(path, action, options);
  });
  await transitionState(root, 'PICK'); expect(attempts).toBe(3);
  expect((await readLedger(root)).filter(e => e.action === 'docs:backlog-uncommitted')).toHaveLength(1);
});
