import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addTask, setTask, readBacklog, syncBacklog, backlogInSync, renderBacklog, parseBacklog, type Task } from '../src/core/backlog.ts';
import { fixture, writeConfig } from './w1-helpers.ts';
import { cli } from './p5-helpers.ts';
const input = { title: 'title | title', category: 'docs' };
it('workspace 표 왕복과 JSON·md 동기화, single 표 고정 바이트', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  const task = await addTask(f.root, { ...input, repo: 'web' }); const text = await readFile(join(f.root, 'docs/backlog.md'), 'utf8');
  expect(text).toContain('| ID | 제목 | 분류 | 레포 | 의존 | 상태 | repair | 판단 | 워크트리 | 검수(커밋) | 비고 |');
  expect(parseBacklog(text, [], f.candidate)).toEqual([task]); expect(renderBacklog(text, [task], f.candidate)).toBe(text);
  expect(await backlogInSync(f.root)).toBe(true);
  const single: Task = { id: 'T01', title: '제목', category: 'docs', depends: [], status: 'ready', repair: 0, judgment: '', worktree: '', notes: '' };
  expect(renderBacklog('', [single])).toBe('# 백로그\n\n표 순서대로 의존 관계를 확인해 작업합니다.\n\n\n| ID | 제목 | 분류 | 의존 | 상태 | repair | 판단 | 워크트리 | 검수(커밋) | 비고 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| T01 | 제목 | docs |  | ready | 0 |  |  |  |  |\n');
});
it('CLI --repo 필수·unknown·점 거부, single repo 옵션 거부', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  const args = ['backlog', 'add', '--title', 'title', '--category', 'docs'];
  for (const value of [undefined, '.', 'missing']) {
    expect((await cli(f.root, value ? [...args, '--repo', value] : args)).code).toBe(1);
  }
  expect((await cli(f.root, [...args, '--repo', 'web'])).value.repo).toBe('web');
  expect((await cli(f.root, [...args, '--repo', 'web', '--repo', 'app'])).code).toBe(1);
  await writeConfig(f.member(), {});
  expect((await cli(f.member(), [...args, '--repo', 'web'])).value.error).toBe('한 레포 모드에서는 --repo 를 쓰지 않습니다');
});
it.each(['doing', 'worktree'])('set·Markdown 진행 보호 %s, JSON 보존', async kind => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  const task = await addTask(f.root, { ...input, repo: 'web' });
  await setTask(f.root, task.id, kind === 'doing' ? { status: 'doing' } : { worktree: '../wt-web-T01' });
  expect((await cli(f.root, ['backlog', 'set', task.id, '--repo', 'app'])).value.error).toBe('진행 중 task T01의 레포는 바꿀 수 없습니다');
  const json = join(f.root, '.pi/harness-backlog.json'), before = await readFile(json, 'utf8'), md = join(f.root, 'docs/backlog.md');
  const original = await readFile(md, 'utf8');
  const edited = original.replace(' | web | ', ' | app | '); await writeFile(md, edited);
  await expect(readBacklog(f.root)).rejects.toThrow('진행 중 task T01의 레포는 바꿀 수 없습니다 — fodh backlog sync 로 JSON 기준 복원');
  expect(await readFile(json, 'utf8')).toBe(before);
  const result = await syncBacklog(f.root); expect(result.warnings.join(' ')).toContain('진행 중 task T01의 레포');
  expect(await readFile(md, 'utf8')).toBe(original);
  expect(await readFile(json, 'utf8')).toBe(before);
  expect((await readBacklog(f.root)).tasks[0].repo).toBe('web');
});
it('ready repo 변경 허용, 잘못된 md repo는 sync 복원, 잘못된 JSON은 거부', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  const task = await addTask(f.root, { ...input, repo: 'web' });
  expect((await cli(f.root, ['backlog', 'set', task.id, '--repo', 'backend'])).code).toBe(0);
  const md = join(f.root, 'docs/backlog.md'); let text = (await readFile(md, 'utf8')).replace(' | backend | ', ' | app | ');
  await writeFile(md, text); expect((await readBacklog(f.root)).tasks[0].repo).toBe('app'); await syncBacklog(f.root);
  for (const value of ['', 'unknown']) {
    await writeFile(md, text.replace(' | app | ', ` | ${value} | `)); await expect(readBacklog(f.root)).rejects.toThrow('--repo');
    expect((await syncBacklog(f.root)).warnings.join(' ')).toContain('--repo');
    expect(await readFile(md, 'utf8')).toBe(text);
  }
  await writeFile(md, text);
  const json = join(f.root, '.pi/harness-backlog.json'), store = JSON.parse(await readFile(json, 'utf8')); delete store.tasks[0].repo;
  await writeFile(json, JSON.stringify(store)); await expect(syncBacklog(f.root)).rejects.toThrow('--repo');
  await expect(backlogInSync(f.root)).rejects.toThrow('--repo');
});
it.each(['ready', 'doing'])('미등록 멤버를 참조하는 %s md task는 읽기 거부 후 sync로 JSON 복원', async status => {
  const f = await fixture(); await writeConfig(f.root, f.candidate);
  const task = await addTask(f.root, { ...input, repo: 'web' });
  const invalid = { ...task, status, repo: 'removed' };
  expect(() => renderBacklog('', [invalid], f.candidate)).toThrow('--repo');
  const md = join(f.root, 'docs/backlog.md'), text = renderBacklog('', [{ ...task, status }], f.candidate);
  const edited = text.replace(' | web | ', ' | removed | ');
  expect(() => parseBacklog(edited, [], f.candidate)).toThrow('--repo');
  await writeFile(md, edited);
  await expect(readBacklog(f.root)).rejects.toThrow('— fodh backlog sync 로 JSON 기준 복원');
  expect((await syncBacklog(f.root)).warnings.join(' ')).toContain('--repo');
  expect((await readBacklog(f.root)).tasks).toEqual([task]);
});

it('깨진 한 레포 harness.json에서도 기존 backlog 명령과 표 바이트를 보존한다', async () => {
  const f = await fixture(['web']); await writeConfig(f.root, {});
  const first = await addTask(f.root, input);
  const path = join(f.root, '.pi/harness.json');
  for (const broken of ['{broken', 'null', '[]', '123']) {
    await writeFile(path, broken);
    expect((await cli(f.root, ['backlog', 'list'])).code).toBe(0);
    expect((await cli(f.root, ['backlog', 'set', first.id, '--title', 'updated'])).code).toBe(0);
    const before = await readFile(join(f.root, 'docs/backlog.md'), 'utf8');
    expect((await cli(f.root, ['backlog', 'sync'])).code).toBe(0);
    expect(await readFile(join(f.root, 'docs/backlog.md'), 'utf8')).toBe(before);
    expect((await cli(f.root, ['backlog', 'add', '--title', 'new', '--category', 'docs'])).code).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(broken);
  }
});
it('한 레포 backlog set --repo는 거부하고 백로그 파일을 보존한다', async () => {
  const f = await fixture(['web']); await writeConfig(f.root, {});
  const task = await addTask(f.root, input), path = join(f.root, '.pi/harness-backlog.json'), before = await readFile(path);
  expect((await cli(f.root, ['backlog', 'set', task.id, '--repo', 'web'])).value.error).toBe('한 레포 모드에서는 --repo 를 쓰지 않습니다');
  expect(await readFile(path)).toEqual(before);
});
