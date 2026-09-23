import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';

export interface Task {
  id: string; title: string; category: string; depends: string[]; status: string; repair: number;
  judgment: string; worktree: string; notes: string;
  verify?: { ok?: boolean }; review?: { commit?: string; high?: number }; merge?: { commit?: string };
  docs?: { ok?: boolean }; cleanup?: { ok?: boolean }; spec?: { rev?: number };
}
interface BacklogStore { tasks: Task[]; usedIds: string[]; hash: string; pending?: { before: string; text: string } }
const columns = ['ID', '제목', '분류', '의존', '상태', 'repair', '판단', '워크트리', '검수(커밋)', '비고'];
const initial = '# 백로그\n\n표 순서대로 의존 관계를 확인해 작업합니다.\n\n';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const cells = (line: string) => line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u)
  .map(cell => cell.trim().replace(/\\\|/gu, '|').replace(/<br\s*\/?\s*>/giu, '\n'));
const cell = (text: string) => text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
export function missingDoD(task: Task): string[] {
  return [!task.verify?.ok && 'verify.ok', task.review?.high !== 0 && 'review.high',
    !task.review?.commit && 'review.commit', !task.merge?.commit && 'merge.commit',
    !task.docs?.ok && 'docs.ok', !task.cleanup?.ok && 'cleanup.ok'].filter(Boolean) as string[];
}
export class BacklogError extends Error {
  missing?: string[];
  constructor(message: string, missing?: string[]) { super(message); this.missing = missing; }
}
function validate(task: Task): void {
  if (!/^T\d+$/u.test(task.id) || !task.title.trim()) throw new Error('task ID와 제목이 필요합니다');
  if (!['design', 'non-design', 'docs', 'research'].includes(task.category)) throw new Error('백로그 분류가 올바르지 않습니다');
  if (!/^(ready|doing|verify|review|fix|merge|done|blocked\(A\d+(?:-\d+)?\))$/u.test(task.status)) {
    throw new Error('백로그 상태가 올바르지 않습니다');
  }
  if (!Number.isSafeInteger(task.repair) || task.repair < 0) throw new Error('repair는 0 이상의 정수여야 합니다');
  if (task.depends.some(id => !/^T\d+$/u.test(id))) throw new Error('의존 ID가 올바르지 않습니다');
  if (task.judgment && !/^A\d+(?:-\d+)?$/u.test(task.judgment)) throw new Error('판단 번호가 올바르지 않습니다');
  if (task.review?.high !== undefined && (!Number.isSafeInteger(task.review.high) || task.review.high < 0)) {
    throw new Error('review.high는 0 이상의 정수여야 합니다');
  }
  if (task.spec?.rev !== undefined && (!Number.isSafeInteger(task.spec.rev) || task.spec.rev < 1)) {
    throw new Error('spec.rev는 양의 정수여야 합니다');
  }
  if (task.status === 'done' && missingDoD(task).length) throw new BacklogError('DoD 미충족', missingDoD(task));
}
function tableRange(text: string): { lines: string[]; start: number; end: number } {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim().startsWith('|') && cells(line)[0] === 'ID');
  if (start < 0) return { lines, start: lines.length, end: lines.length };
  let end = start + 1;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  return { lines, start, end };
}
export function parseBacklog(text: string, previous: Task[] = []): Task[] {
  const { lines, start, end } = tableRange(text);
  if (start === lines.length) {
    if (/^\s*\|/mu.test(text)) throw new Error('백로그 ID 표 머리글이 필요합니다');
    return [];
  }
  const headers = cells(lines[start]);
  if (columns.some(name => !headers.includes(name))) throw new Error('백로그 표 열이 누락되었습니다');
  const result: Task[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const values = cells(line);
    if (values.every(value => /^:?-+:?$/u.test(value))) continue;
    if (values.length !== headers.length) throw new Error('백로그 표 열 수가 맞지 않습니다');
    const value = (name: string) => values[headers.indexOf(name)] ?? '';
    const old = previous.find(task => task.id === value('ID'));
    const reviewCommit = value('검수(커밋)');
    const task: Task = {
      ...old, id: value('ID'), title: value('제목'), category: value('분류'), depends: value('의존').split(',').map(s => s.trim()).filter(Boolean),
      status: value('상태'), repair: Number(value('repair')), judgment: value('판단'), worktree: value('워크트리'), notes: value('비고'),
      review: { ...old?.review, commit: reviewCommit || undefined,
        high: old?.review?.commit === (reviewCommit || undefined) ? old?.review?.high : undefined },
    };
    if (result.some(item => item.id === task.id)) throw new Error('중복 task ID입니다');
    validate(task); result.push(task);
  }
  return result;
}
export function renderBacklog(text: string, tasks: Task[]): string {
  const { lines, start, end } = tableRange(text || initial);
  const table = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...tasks.map(task =>
    `| ${[task.id, task.title, task.category, task.depends.join(','), task.status, String(task.repair), task.judgment,
      task.worktree, task.review?.commit ?? '', task.notes].map(cell).join(' | ')} |`)];
  return [...lines.slice(0, start), ...table, ...lines.slice(end)].join('\n').trimEnd() + '\n';
}
async function load(root: string): Promise<{ store: BacklogStore; text: string }> {
  const path = join(root, 'docs/backlog.md');
  let text = await readText(path);
  const store = await readJson<BacklogStore>(harnessPath(root, 'harness-backlog.json'), { tasks: [], usedIds: [], hash: '' });
  if (store.pending) {
    if (digest(text) === store.pending.before) { text = store.pending.text; await atomicWrite(path, text); }
    delete store.pending;
  }
  if (digest(text) !== store.hash) {
    const tasks = parseBacklog(text, store.tasks);
    for (const task of tasks) {
      if (store.usedIds.includes(task.id) && !store.tasks.some(old => old.id === task.id)) throw new Error('삭제한 task ID는 재사용할 수 없습니다');
    }
    store.tasks = tasks;
    store.usedIds = [...new Set([...store.usedIds, ...tasks.map(task => task.id)])];
    store.hash = digest(text);
  }
  await atomicWrite(harnessPath(root, 'harness-backlog.json'), JSON.stringify(store, null, 2) + '\n');
  return { store, text };
}
async function mutate<T>(root: string, action: (tasks: Task[], store: BacklogStore) => T): Promise<T> {
  const path = harnessPath(root, 'harness-backlog.json');
  return withFileLock(path, async () => {
    const { store, text } = await load(root);
    const result = action(store.tasks, store);
    for (const task of store.tasks) validate(task);
    const rendered = renderBacklog(text, store.tasks);
    store.pending = { before: digest(text), text: rendered }; store.hash = digest(rendered);
    await atomicWrite(path, JSON.stringify(store, null, 2) + '\n');
    await atomicWrite(join(root, 'docs/backlog.md'), rendered);
    delete store.pending;
    await atomicWrite(path, JSON.stringify(store, null, 2) + '\n');
    return result;
  });
}
export async function listBacklog(root: string): Promise<Task[]> {
  return withFileLock(harnessPath(root, 'harness-backlog.json'), async () => (await load(root)).store.tasks);
}
export async function getTask(root: string, id: string): Promise<Task> {
  const task = (await listBacklog(root)).find(task => task.id === id);
  if (!task) throw new Error(`백로그 task를 찾을 수 없습니다: ${id}`);
  return task;
}
export async function addTask(root: string, input: { title: string; category: string; depends?: string[] }): Promise<Task> {
  return mutate(root, (tasks, store) => {
    const number = Math.max(0, ...store.usedIds.map(id => Number(id.slice(1)))) + 1;
    if (!Number.isSafeInteger(number)) throw new Error('task ID 한도 초과');
    const task: Task = { ...input, id: `T${String(number).padStart(2, '0')}`, depends: input.depends ?? [],
      status: 'ready', repair: 0, judgment: '', worktree: '', notes: '' };
    tasks.push(task); store.usedIds.push(task.id); return task;
  });
}
export async function setTask(root: string, id: string, patch: Partial<Omit<Task, 'id'>>): Promise<Task> {
  return mutate(root, tasks => {
    const index = tasks.findIndex(task => task.id === id);
    if (index < 0) throw new Error(`백로그 task를 찾을 수 없습니다: ${id}`);
    const old = tasks[index];
    const task = { ...old, ...patch };
    for (const key of ['verify', 'review', 'merge', 'docs', 'cleanup', 'spec'] as const) {
      if (patch[key]) task[key] = { ...old[key], ...patch[key] };
    }
    if (patch.review?.commit !== undefined && patch.review.commit !== old.review?.commit) {
      task.review = { ...task.review, high: patch.review.high };
    }
    if (patch.spec?.rev !== undefined && patch.spec.rev !== old.spec?.rev) {
      if (patch.spec.rev <= (old.spec?.rev ?? 0)) throw new Error('spec.rev는 증가해야 합니다');
      task.repair = 0; task.verify = {}; task.review = {}; task.merge = {}; task.docs = {}; task.cleanup = {};
    }
    tasks[index] = task; return task;
  });
}
