import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addTask, listBacklog, readBacklog, setTask, syncBacklog } from '../src/core/backlog.ts';
import * as storage from '../src/core/storage.ts';

const roots: string[] = [];
const input = { title: '작업', category: 'docs' };
async function project() {
  const root = await mkdtemp('/private/tmp/fodh-backlog-revision-'); roots.push(root);
  const first = await addTask(root, input), second = await addTask(root, { ...input, title: '두 번째' });
  return { root, first, second, md: join(root, 'docs/backlog.md'), json: join(root, '.pi/harness-backlog.json') };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('H3: md 삭제 후 read는 JSON bytes를 보존하고 task와 경고 및 표를 복원한다', async () => {
  const { root, md, json, first } = await project();
  await setTask(root, first.id, { status: 'doing', spec: { rev: 1 } });
  const before = await readFile(json, 'utf8'); await rm(md);
  const read = await readBacklog(root);
  expect(read.tasks).toHaveLength(2); expect(read.tasks[0]).toMatchObject({ id: first.id, status: 'doing', spec: { rev: 1 } });
  expect(read.warnings).toEqual(['backlog.md 재생성']); expect(await readFile(json, 'utf8')).toBe(before);
  expect(await readFile(md, 'utf8')).toContain(`| ${first.id} |`);
});
it.each(['', '# 표를 지웠습니다\n', '| ID | 제목 |\n| --- | --- |\n',
  '| ID | 제목 | 분류 | 의존 | 상태 | repair | 판단 | 워크트리 | 검수(커밋) | 비고 |\n| broken |\n'])
('H3: 머리글 또는 구조가 손상되면 JSON을 그대로 둔다 (%#)', async text => {
  const { root, md, json } = await project(); const before = await readFile(json, 'utf8');
  await writeFile(md, text); await expect(listBacklog(root)).rejects.toThrow('백로그 표를 읽을 수 없습니다(JSON 보존)');
  expect(await readFile(json, 'utf8')).toBe(before);
});
it.each([{ status: 'doing' }, { verify: { ok: false } }, { review: { high: 0 } }, { merge: { commit: 'abc' } },
  { docs: { ok: true } }, { cleanup: { ok: false } }, { spec: { rev: 1 } }])
('H3: 진행 또는 증거 있는 행 삭제를 거부하고 sync는 JSON 원본을 복원한다 (%#)', async patch => {
  const { root, md, json, second } = await project(); await setTask(root, second.id, patch);
  const before = await readFile(json, 'utf8'), text = await readFile(md, 'utf8');
  await writeFile(md, text.split('\n').filter(line => !line.startsWith(`| ${second.id} |`)).join('\n'));
  await expect(listBacklog(root)).rejects.toThrow(`백로그 표에서 진행 중 task 가 사라졌습니다: ${second.id}`);
  expect(await readFile(json, 'utf8')).toBe(before);
  expect((await syncBacklog(root)).tasks).toHaveLength(2);
  expect(await readFile(md, 'utf8')).toContain(`| ${second.id} |`);
  expect((await readBacklog(root)).warnings).toEqual([]);
});
it('H3: 증거 없는 ready만 삭제를 수용하고 usedIds는 재사용하지 않는다', async () => {
  const { root, md, first } = await project();
  await writeFile(md, (await readFile(md, 'utf8')).split('\n').filter(line => !line.startsWith(`| ${first.id} |`)).join('\n'));
  expect((await listBacklog(root)).map(task => task.id)).toEqual(['T02']);
  expect((await addTask(root, input)).id).toBe('T03');
});
it('L6: 오류 행은 원래 JSON task를 유지하고 정상 행의 사람 편집을 받아들인다', async () => {
  const { root, md, first, second } = await project();
  await writeFile(md, (await readFile(md, 'utf8')).replace('| ready |', '| nonsense |').replace('두 번째', '정상 편집'));
  const result = await readBacklog(root);
  expect(result.tasks.find(task => task.id === first.id)).toEqual(first);
  expect(result.tasks.find(task => task.id === second.id)?.title).toBe('정상 편집');
  expect(result.warnings).toHaveLength(1); expect(result.warnings[0]).toContain(`${first.id}: 백로그 상태`);
  expect((await readBacklog(root)).warnings).toEqual(result.warnings);
  const synced = await syncBacklog(root); expect(synced.warnings).toEqual(result.warnings);
  expect((await readBacklog(root)).warnings).toEqual([]); expect(await readFile(md, 'utf8')).not.toContain('nonsense');
});
it('L6: 증거 없는 done 입력을 격리하고 JSON bytes를 보존한다', async () => {
  const { root, md, json, first } = await project(); const before = await readFile(json, 'utf8');
  await writeFile(md, (await readFile(md, 'utf8')).replace('| ready |', '| done |'));
  const result = await readBacklog(root);
  expect(result.tasks[0]).toEqual(first); expect(result.warnings[0]).toContain('DoD 미충족');
  expect(await readFile(json, 'utf8')).toBe(before);
});
it('L6: 중복 ID 두 행 모두 격리하며 새 오류 행은 등록하지 않는다', async () => {
  const { root, md, first } = await project();
  const text = await readFile(md, 'utf8'), firstRow = text.split('\n').find(line => line.startsWith(`| ${first.id} |`))!;
  await writeFile(md, text + firstRow.replace('작업', '덮어쓰기') + '\n| T99 | 잘못된 새 행 |\n');
  const result = await readBacklog(root);
  expect(result.tasks).toHaveLength(2); expect(result.tasks[0]).toEqual(first);
  expect(result.tasks.some(task => task.id === 'T99')).toBe(false); expect(result.warnings).toHaveLength(3);
});
it('H3: sync는 손상된 머리글도 JSON 기준으로 복원하고 경고를 반환한다', async () => {
  const { root, md } = await project(); await writeFile(md, '# 사람이 남긴 메모\n');
  const result = await syncBacklog(root);
  expect(result.tasks).toHaveLength(2); expect(result.warnings).toEqual(['백로그 표를 읽을 수 없습니다(JSON 보존)']);
  expect(await readFile(md, 'utf8')).toContain('# 사람이 남긴 메모'); expect(await listBacklog(root)).toEqual(result.tasks);
});
it('L8: md 쓰기 직전 편집 경합이면 한 번 재로드하여 사람 편집과 API 변경을 함께 보존한다', async () => {
  const { root, md, first, second } = await project(); const original = storage.atomicWrite;
  let collisions = 0;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, text) => {
    await original(path, text);
    if (path.endsWith('harness-backlog.json') && text.includes('"pending"') && collisions++ === 0) {
      await writeFile(md, (await readFile(md, 'utf8')).replace('두 번째', '동시 사람 편집'));
    }
  });
  await setTask(root, first.id, { notes: 'API 메모' });
  const result = await listBacklog(root);
  expect(result.find(task => task.id === first.id)?.notes).toBe('API 메모');
  expect(result.find(task => task.id === second.id)?.title).toBe('동시 사람 편집'); expect(collisions).toBe(2);
});
it('L8: 두 번째 경합에서는 오류를 내고 JSON bytes와 최신 사람 md를 보존한다', async () => {
  const { root, md, json, first } = await project(); const original = storage.atomicWrite;
  const before = await readFile(json, 'utf8'); let collisions = 0;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (path, text) => {
    await original(path, text);
    if (path.endsWith('harness-backlog.json') && text.includes('"pending"')) {
      collisions++; await writeFile(md, (await readFile(md, 'utf8')).replace(/두 번째(?: 편집\d+)?/u, `두 번째 편집${collisions}`));
    }
  });
  await expect(setTask(root, first.id, { notes: '반영되면 안 됨' })).rejects.toThrow('백로그 편집 경합');
  expect(collisions).toBe(2); expect(await readFile(json, 'utf8')).toBe(before);
  expect(await readFile(md, 'utf8')).toContain('두 번째 편집2'); expect(await readFile(md, 'utf8')).not.toContain('반영되면 안 됨');
});
it('L6: 오류 행의 ID가 손상되어 연결할 수 없으면 기존 task를 삭제로 오인하지 않는다', async () => {
  const { root, md, first } = await project();
  await writeFile(md, (await readFile(md, 'utf8')).replace(`| ${first.id} |`, '| 손상ID |'));
  const result = await readBacklog(root);
  expect(result.tasks).toHaveLength(2); expect(result.tasks.find(task => task.id === first.id)).toEqual(first);
  expect(result.warnings).toHaveLength(1); expect(result.warnings[0]).toContain('손상ID');
});
