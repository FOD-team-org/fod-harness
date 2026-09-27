import { expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, git, writeConfig } from './w2-helpers.ts';
import { project, cli } from './p5-helpers.ts';
import { addTask } from '../src/core/backlog.ts';
import { createWorktree } from '../src/core/worktree.ts';
import { runVerify } from '../src/core/verify.ts';
import { updateState, readState } from '../src/core/state.ts';
import { workspaceBranchWarnings, taskMember } from '../src/core/workspace-task.ts';
import { repoOf } from '../src/core/workspace.ts';
import { loadConfig } from '../src/core/config.ts';
import { buildHeader, startCodex } from '../src/core/codex.ts';
import { appendLedger, readLedger } from '../src/core/ledger.ts';
import { runPick } from '../src/core/pick.ts';
import { auditPaths } from '../src/core/audit.ts';
import { buildPrompt } from '../src/provider/turn.ts';
import * as slots from '../src/core/slots.ts';

it('verify 멤버 명령과 cwd 경계·없는 워크트리·브랜치 경고', async () => {
  const f = await workspace();
  f.repos.web.verify.commands = [`${process.execPath} -e "process.exit(require('fs').existsSync('code.txt') ? 0 : 8)"`];
  await writeConfig(f.root, f.candidate);
  const task = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  await updateState(f.root, { state: 'VERIFY', taskId: task.id });
  await expect(runVerify(f.root)).rejects.toThrow('워크스페이스 모드 task T01에 워크트리가 없습니다 — fodh worktree create T01 먼저');
  const wt = await createWorktree(f.root, task.id);
  const other = await addTask(f.root, { repo: 'backend', title: 'backend', category: 'docs' }); const otherWt = await createWorktree(f.root, other.id);
  for (const cwd of [f.root, f.member(), otherWt.path]) await expect(runVerify(f.root, { cwd })).rejects.toThrow('워크스페이스 모드 검증은 현재 task 워크트리 안에서만 합니다');
  await git(f.member('backend'), 'checkout', '-b', 'other');
  expect(await runVerify(f.root)).toMatchObject({ ok: true, cwd: wt.path, warnings: [expect.stringContaining('멤버 backend 체크아웃이 main가 아닙니다')] });
  expect((await readState(f.root)).verify).not.toHaveProperty('repo');
  expect((await readLedger(f.root)).findLast(e => e.action === 'verify:run')?.evidence).toHaveProperty('repo', 'web');
});
it('verify 멤버별 시간 제한은 실행 실패로 기록', async () => {
  const f = await workspace(); f.repos.web.verify.timeoutMinutes = 0.001;
  f.repos.web.verify.commands = [`${process.execPath} -e "setTimeout(()=>{},10000)"`]; await writeConfig(f.root, f.candidate);
  const task = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' }); await createWorktree(f.root, task.id);
  await updateState(f.root, { state: 'VERIFY', taskId: task.id });
  expect(await runVerify(f.root)).toMatchObject({ ok: false, commands: [{ timedOut: true }] });
});
it('PICK은 모든 멤버 경고·detached를 기록하며 checker Git 실패는 경고다', async () => {
  const f = await workspace(); await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' });
  await git(f.member('app'), 'checkout', '--detach');
  expect(await runPick(f.root)).toMatchObject({ outcome: 'SPEC', warnings: [expect.stringContaining('현재 detached')] });
  const config = await loadConfig(f.root); await rm(f.member('backend'), { recursive: true });
  expect(await workspaceBranchWarnings(f.root, config)).toContain('멤버 backend 브랜치를 읽을 수 없습니다');
  expect(await readLedger(f.root)).toContainEqual(expect.objectContaining({ action: 'workspace:base-branch', status: 'warn', evidence: { repo: 'backend', branch: null } }));
});
it('멤버 머리말 정확한 한 줄·한 레포 고정 바이트·repoOf 오류 유지', async () => {
  const f = await workspace(), config = await loadConfig(f.root);
  const meta = { kind: 'task' as const, taskId: 'T01', runId: 'fixed-run', cwd: '/project/wt-T01', sandbox: 'workspace-write' as const, workerModel: 'worker', workerEffort: 'high' };
  const single = await buildHeader(meta, 1, '고정 스펙');
  expect(single).toBe(await readFile(new URL('./w2-single-header.fixture.md', import.meta.url), 'utf8'));
  const header = await buildHeader(meta, 1, '고정 스펙', await repoOf(f.root, config, { repo: 'web' }));
  const line = `- 대상 레포: web (${f.member()}) — 다른 멤버 레포는 읽기만 한다. 그 레포의 AGENTS.md 규칙을 따른다.\n`;
  expect(header.replace(line, '')).toBe(single); expect(header.split('\n')[3] + '\n').toBe(line);
  await expect(taskMember(f.root, config, { id: 'T01' })).rejects.toThrow('task T01에 레포가 없습니다: fodh backlog set T01 --repo <이름>');
});
it('task gitTask는 멤버 .git을 보고 워크트리 없으면 launch 전에 거부', async () => {
  const f = await workspace(); await writeFile(join(f.root, 'spec.md'), 'spec');
  const t = await addTask(f.root, { repo: 'web', title: 'web', category: 'docs' }); await updateState(f.root, { state: 'IMPLEMENT', taskId: t.id });
  await expect(startCodex(f.root, 'task', { spec: 'spec.md', taskId: t.id })).rejects.toThrow('워크스페이스 모드 task T01에 워크트리가 없습니다');
});
it('research repo 입력 오류·task/review CLI --repo 거부', async () => {
  const f = await workspace(); await updateState(f.root, { state: 'RESEARCH' }); await writeFile(join(f.root, 'spec.md'), 'spec');
  const root = await project('RESEARCH');
  await expect(startCodex(root, 'research', { repo: 'web', spec: 'spec.md' })).rejects.toThrow('--repo 는 워크스페이스 모드에서만 씁니다');
  await expect(startCodex(f.root, 'research', { repo: 'missing', spec: 'spec.md' })).rejects.toThrow('task에 알려진 워크스페이스 repo가 필요합니다');
  await expect(startCodex(f.root, 'research', { repo: 'web', spec: 'spec.md', cwd: f.root })).rejects.toThrow('--repo 와 --cwd 는 함께 쓸 수 없습니다');
  for (const kind of ['task', 'review']) expect((await cli(f.root, ['codex', kind, '--repo', 'web', '--spec', 'spec.md'])).value.error).toContain("Unknown option '--repo'");
});
it('Bash 멤버 쓰기만 추가 경고·워크트리와 한 레포 판정 유지', () => {
  const context = { root: '/parent/workspace', docsRoot: 'docs', worktrees: [{ path: '/parent/wt' }] };
  expect(auditPaths('Bash', { command: 'cp a ../web/src/x.ts' }, context)).toEqual([]);
  expect(auditPaths('Bash', { command: 'cp a ../web/src/x.ts' }, { ...context, members: ['/parent/web'] })).toEqual(['/parent/web/src/x.ts']);
  expect(auditPaths('Bash', { command: 'cp a ../wt/src/x.ts' }, { ...context, members: ['/parent'] })).toEqual([]);
});
it('복구 unknown repo만 조건부로 추가하고 기존 JSON 줄은 불변', async () => {
  const f = await workspace();
  for (const [runId, evidence] of [['single', {}], ['multi', { repo: 'web' }]] as const) await appendLedger(f.root, { runId, action: 'worktree:merge', status: 'pre', at: 'fixed', evidence });
  const prompt = await buildPrompt(f.root, 'next', 'prompt');
  expect(prompt).toContain('{"runId":"single","action":"worktree:merge","at":"fixed"}\n');
  expect(prompt).toContain('{"runId":"multi","action":"worktree:merge","at":"fixed","repo":"web"}\n');
});
it.each([undefined, 'web'])('research repo=%s는 지정 cwd와 read-only로 fake Codex 실행', async repo => {
  const { setConfig } = await import('../src/core/config.ts');
  const { readMeta } = await import('../src/core/codex.ts');
  const { resolve } = await import('node:path');
  const f = await workspace(); await updateState(f.root, { state: 'RESEARCH' }); await writeFile(join(f.root, 'spec.md'), 'spec');
  await setConfig(f.root, 'delegate.codex.command', JSON.stringify([process.execPath, resolve('test/fake-codex/codex')]));
  const run = await startCodex(f.root, 'research', { spec: 'spec.md', repo });
  try {
    expect(run).toMatchObject({ cwd: repo ? f.member() : f.root, sandbox: 'read-only' });
    await vi.waitFor(async () => expect((await readMeta(f.root, run.runId))?.status).toBe('ok'), { timeout: 10000 });
    expect((await readMeta(f.root, run.runId))?.command).toContain('read-only');
  } finally { if ('pid' in run && typeof run.pid === 'number') { try { process.kill(-run.pid, 'SIGKILL'); } catch {} } }
});
