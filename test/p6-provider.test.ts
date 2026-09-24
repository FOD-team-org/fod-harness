import * as reclaim from '../src/core/reclaim.ts';
import { readJudgment } from '../src/core/judgment.ts';
import { addTask } from '../src/core/backlog.ts';
import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { project } from './p5-helpers.ts';
import * as runner from '../src/provider/runner.ts';
import { runTurn } from '../src/provider/turn.ts';
import { doctor } from '../src/cli/doctor.ts';
import { readState, updateState, transitionState } from '../src/core/state.ts';
import { readLedger } from '../src/core/ledger.ts';
import { listInbox } from '../src/core/inbox.ts';
import { auditPaths } from '../src/core/audit.ts';
import { setConfig } from '../src/core/config.ts';

async function setup() {
  const root = await project('IDLE');
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude/settings.json'), '{}');
  return root;
}
const env = () => ({ HOME: '/nonexistent-fodh-fixture', PATH: process.env.PATH });
function simulate(blocks: { name: string; input: Record<string, unknown> }[], denials: { tool_name: string; tool_input: Record<string, unknown> }[] = []) {
  return vi.spyOn(runner, 'runProcess').mockImplementation(async options => {
    const args = options.args ?? [];
    const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
    await options.onEvent?.({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', permissionMode: 'bypassPermissions', model: args[args.indexOf('--model') + 1] === 'fable' ? 'claude-fable-5-1' : args[args.indexOf('--model') + 1] });
    await options.onEvent?.({ type: 'assistant', message: { content: blocks.map((b, i) => ({ type: 'tool_use', id: String(i), ...b })) } });
    await options.onEvent?.({ type: 'result', permission_denials: denials, is_error: false });
    return { code: 0, cleaned: true, stderr: '', stdout: '' } as never;
  });
}
it('P6 사후 감사는 인라인 스크립트·heredoc·Write를 경고하고 판단은 만들지 않는다', async () => {
  const root = await setup();
  const mock = simulate([
    { name: 'Bash', input: { command: `node -e "require('fs').writeFileSync('src/missed.ts', 'x')"` } },
    { name: 'Bash', input: { command: "python3 <<'PY'\nopen('lib/missed.py', 'w').write('x')\nPY" } },
    { name: 'Write', input: { file_path: 'src/direct.ts', content: 'x' } },
    { name: 'Write', input: { file_path: 'docs/allowed.md' } },
    { name: 'Write', input: { file_path: 'wt/src/allowed.ts' } },
  ]);
  await updateState(root, { worktrees: [{ path: join(root, 'wt'), taskId: 'T01', branch: 'fixture', createdAt: new Date().toISOString() }] });
  const notify = vi.fn();
  expect((await runTurn('fixture', { root, env: env(), notify })).reason).toBe('stop');
  const warnings = (await readLedger(root)).filter(e => e.action === 'audit:path-boundary');
  expect(warnings.map(e => e.evidence)).toEqual(['src/missed.ts', 'lib/missed.py', 'src/direct.ts'].map(p => ({ path: join(root, p) })));
  expect(warnings.every(e => e.status === 'warn')).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(`훅이 놓친 소스 쓰기 의심 3건: ${['src/missed.ts', 'lib/missed.py', 'src/direct.ts'].map(p => join(root, p)).join(', ')} (fodh ledger list)`);
  await runTurn('같은 경로 재관측', { root, env: env(), notify });
  expect(notify).toHaveBeenCalledTimes(1);
  expect((await readLedger(root)).filter(e => e.action === 'audit:path-boundary')).toHaveLength(6);
  expect(await listInbox(root)).toEqual([]);
  expect((await readLedger(root)).some(e => e.action.includes('judgment:add'))).toBe(false);
  expect(mock.mock.calls[0][0].env).toMatchObject({ FODH_BRAIN: '1', FODH_DOCS_ROOT: 'docs' });
});
it('P6 사후 경계는 설정 문서·워크트리를 제외하고 외부 Write와 Bash를 포착한다', () => {
  const context = { root: '/fixture', docsRoot: 'notes', worktrees: [{ path: '/worktree' }] };
  for (const path of ['notes/a.md', '.pi/scratch/x', 'README.md', '/worktree/src/a']) expect(auditPaths('Write', { file_path: path }, context)).toEqual([]);
  expect(auditPaths('Write', { file_path: '/tmp/a' }, context)).toEqual(['/tmp/a']);
  expect(auditPaths('Bash', { command: 'cat src/read.ts' }, context)).toEqual([]);
  expect(auditPaths('Bash', { command: 'echo hi > src/write.ts' }, context)).toContain('/fixture/src/write.ts');
});
it.each(['both', 'bash-only', 'write-only'] as const)('P6 doctor는 서로 다른 두 실제 차단 증거 필요: %s', async mode => {
  const root = await setup();
  const bash = { tool_name: 'Bash', tool_input: { command: 'echo FODH_DOCTOR_MARKER' } };
  const write = { tool_name: 'Write', tool_input: { file_path: 'src/FODH_DOCTOR_MARKER.ts', content: 'export {}' } };
  const mock = simulate([], mode === 'both' ? [bash, write] : mode === 'bash-only' ? [bash, bash] : [write]);
  if (mode === 'both') expect(await doctor(root, { env: env() })).toMatchObject({ ok: true, hookDenials: 2 });
  else {
    await expect(doctor(root, { env: env() })).rejects.toThrow('configError');
    expect((await readState(root)).doctor).toMatchObject({ ok: false });
    for (const state of ['IMPLEMENT', 'MERGE']) await expect(transitionState(root, state)).rejects.toThrow();
  }
  expect(mock.mock.calls[0][0].input).toContain('Write 도구로 src/FODH_DOCTOR_MARKER.ts');
});
it('P6 provider docs.root env는 호출자 값을 덮어쓰고 설정을 따른다', async () => {
  const root = await setup(); await setConfig(root, 'docs.root', 'notes');
  const mock = simulate([]);
  await runTurn('fixture', { root, env: { ...env(), FODH_DOCS_ROOT: 'ignored' } });
  expect(mock.mock.calls[0][0].env?.FODH_DOCS_ROOT).toBe('notes');
});

it('P6 훅이 이미 거부한 소스 쓰기는 사후 누락 경고에서 제외한다', async () => {
  const root = await setup(), input = { file_path: 'src/denied.ts', content: 'x' };
  simulate([{ name: 'Write', input }], [{ tool_name: 'Write', tool_input: input }]);
  const notify = vi.fn();
  expect((await runTurn('fixture', { root, env: env(), notify })).reason).toBe('stop');
  expect((await readLedger(root)).filter(e => e.action === 'audit:path-boundary')).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});

it.each(['boundary', 'approval', 'guard', 'unknown'] as const)('H1 fake 훅 %s 분류는 승인만 판단·회수한다', async kind => {
  const root = await setup();
  await setConfig(root, 'brain.command', JSON.stringify(resolve('test/fake-claude/claude')));
  await writeFile(join(root, '.claude/settings.json'), await readFile('templates/claude-settings.json'));
  const task = await addTask(root, { title: 'H1 위임 유지', category: 'non-design' });
  const delegation = { runId: 'fixture-delegation', taskId: task.id, kind: 'task' as const, startedAt: new Date().toISOString() };
  await updateState(root, { state: 'IMPLEMENT', taskId: task.id, delegation });
  const cancel = vi.spyOn(reclaim, 'reclaimTask').mockResolvedValue({ reclaimed: true, judgment: 'fixture', next: 'PICK' });
  let text = '';
  expect((await runTurn('fixture', { root, env: { ...env(), FAKE_CLAUDE_SCENARIO: `p6-${kind}`, FODH_TEST_MARKERS: '1' }, onText: value => { text += value; } })).reason).toBe('stop');
  expect((await readJudgment(root)).items).toHaveLength(kind === 'approval' ? 1 : 0);
  expect(cancel).toHaveBeenCalledTimes(kind === 'approval' ? 1 : 0);
  if (kind !== 'approval') expect((await readState(root)).delegation).toEqual(delegation);
  const entries = await readLedger(root);
  if (kind !== 'approval') expect(entries.filter(e => e.action === `hook:${kind}:0:p6-denied`)).toHaveLength(1);
  expect(entries.filter(e => e.action === 'hook:unclassified')).toHaveLength(kind === 'unknown' ? 1 : 0);
  expect(text).toContain(kind === 'approval' ? '[훅 차단] 승인 필요' : kind === 'boundary' ? '같은 동작을 다시 시도하지 말고 위임' : kind === 'guard' ? '[훅 차단] 보호: 이 동작은 포기하세요.' : '[훅 차단] 분류 없음');
});

it('L1 훅 없는 fake doctor가 쓴 표식은 제거하고 실패한다', async () => {
  const root = await setup();
  await setConfig(root, 'brain.command', JSON.stringify(resolve('test/fake-claude/claude')));
  await expect(doctor(root, { env: { ...env(), FAKE_CLAUDE_SCENARIO: 'first' } })).rejects.toThrow('configError: 훅 미적용으로 파일이 생성됐습니다');
  await expect(readFile(join(root, 'src/FODH_DOCTOR_MARKER.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readState(root)).doctor).toMatchObject({ ok: false });
});

it('H1 tool_result 없는 permission_denials는 unknown 원장·경고 1건, 판단 없음', async () => {
  const root = await setup();
  simulate([], [{ tool_name: 'Write', tool_input: { file_path: 'src/one.ts' } }, { tool_name: 'Write', tool_input: { file_path: 'src/two.ts' } }]);
  let text = '';
  await runTurn('fixture', { root, env: env(), onText: value => { text += value; } });
  const entries = await readLedger(root);
  expect(entries.filter(e => e.action.startsWith('hook:unknown:'))).toHaveLength(2);
  expect(entries.filter(e => e.action === 'hook:unclassified')).toEqual([expect.objectContaining({ status: 'warn' })]);
  expect((await readJudgment(root)).items).toEqual([]);
  expect(text).toContain('[훅 차단] 분류 없음: 원장을 확인하세요.');
});
