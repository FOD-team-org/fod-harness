import { loadConfig, type HarnessConfig } from './config.ts';
import { redact } from '../provider/privacy.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';

export interface Task {
  repo?: string;
  id: string; title: string; category: string; depends: string[]; status: string; repair: number;
  resume?: { status: string; state: string; at: string };
  delegate?: 'codex' | 'claude'; codexThread?: string;
  judgment: string; worktree: string; notes: string;
  verify?: { ok?: boolean; runId?: string; at?: string }; review?: { commit?: string; high?: number }; merge?: { commit?: string; base?: string; baseJudgment?: string };
  docs?: { ok?: boolean }; cleanup?: { ok?: boolean }; spec?: { rev?: number };
}
interface BacklogStore { tasks: Task[]; usedIds: string[]; hash: string; pending?: { before: string; text: string } }
const columns = ['ID', '제목', '분류', '의존', '상태', 'repair', '판단', '워크트리', '검수(커밋)', '비고'];
export type BacklogMode = Pick<HarnessConfig, 'workspace'>;
const tableColumns = (mode: BacklogMode) => mode.workspace ? [...columns.slice(0, 3), '레포', ...columns.slice(3)] : columns;
class WorkspaceBacklogError extends Error {}
function validateRepo(task: Pick<Task, 'repo'> & Partial<Pick<Task, 'status'>>, mode: BacklogMode) {
  if (mode.workspace) {
    if (!task.repo || !/^[a-z][a-z0-9-]{0,15}$/u.test(task.repo)
      || task.status !== 'done' && !Object.hasOwn(mode.workspace.repos, task.repo)) {
      throw new WorkspaceBacklogError('워크스페이스 task에는 알려진 --repo <이름>이 필요합니다');
    }
  } else if (task.repo !== undefined) throw new WorkspaceBacklogError('한 레포 모드에서는 --repo 를 쓰지 않습니다');
}
function protectRepo(old: Task | undefined, repo: string | undefined) {
  if (old && old.repo !== repo && (old.status !== 'ready' || old.worktree)) throw new WorkspaceBacklogError(`진행 중 task ${old.id}의 레포는 바꿀 수 없습니다`);
}
async function backlogMode(root: string): Promise<BacklogMode> {
  // Legacy backlog commands did not depend on a readable or valid config file.
  let raw: BacklogMode | null;
  try { raw = await readJson<BacklogMode | null>(harnessPath(root, 'harness.json'), {}); }
  catch { return {}; }
  return !raw || raw.workspace === undefined ? {} : loadConfig(root, raw, { dryRun: true });
}
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
  if (task.delegate !== undefined && !['codex', 'claude'].includes(task.delegate)) throw new Error('delegate는 codex, claude 중 하나여야 합니다');
  if (task.codexThread !== undefined && (typeof task.codexThread !== 'string' || !task.codexThread.trim())) throw new Error('codexThread가 올바르지 않습니다');
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
interface BacklogRead { tasks: Task[]; warnings: string[] }
const unreadable = () => new Error('백로그 표를 읽을 수 없습니다(JSON 보존)');
function parseRows(text: string, previous: Task[] = [], mode: BacklogMode = {}): BacklogRead {
  const { lines, start, end } = tableRange(text);
  if (start === lines.length) throw unreadable();
  const headers = cells(lines[start]);
  const separator = cells(lines[start + 1] ?? '');
  if (tableColumns(mode).some(name => !headers.includes(name)) || new Set(headers).size !== headers.length
    || separator.length !== headers.length || !separator.every(value => /^:?-+:?$/u.test(value))) throw unreadable();
  const result: Task[] = [], warnings: string[] = [];
  let unidentifiedError = false;
  const rows = lines.slice(start + 2, end).map((line, index) => ({ values: cells(line), line: start + index + 3 }));
  const counts = new Map<string, number>();
  for (const { values } of rows) {
    const id = values[headers.indexOf('ID')] ?? '';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const row of rows) {
    const values = row.values;
    const value = (name: string) => values[headers.indexOf(name)] ?? '';
    const old = previous.find(task => task.id === value('ID'));
    try {
      if (values.length !== headers.length) throw new Error('백로그 표 열 수가 맞지 않습니다');
      if ((counts.get(value('ID')) ?? 0) > 1) throw new Error('중복 task ID입니다');
      if (!/^\d+$/u.test(value('repair'))) throw new Error('repair는 0 이상의 정수여야 합니다');
      const reviewCommit = value('검수(커밋)');
      const task: Task = {
        ...old, id: value('ID'), title: value('제목'), category: value('분류'), depends: value('의존').split(',').map(s => s.trim()).filter(Boolean),
        status: value('상태'), repair: Number(value('repair')), judgment: value('판단'), worktree: value('워크트리'), notes: value('비고'),
      };
      if (mode.workspace) { task.repo = value('레포'); validateRepo(task, mode); protectRepo(old, task.repo); }
      if (old?.review || reviewCommit) task.review = { ...old?.review, commit: reviewCommit || undefined,
        high: old?.review?.commit === (reviewCommit || undefined) ? old?.review?.high : undefined };
      validate(task); result.push(task);
    } catch (error) {
      if (error instanceof WorkspaceBacklogError) throw new WorkspaceBacklogError(`${error.message} — fodh backlog sync 로 JSON 기준 복원`);
      warnings.push(`백로그 ${row.line}행 ${value('ID') || '(ID 없음)'}: ${(error as Error).message} (JSON 값 유지)`);
      if (old && !result.some(task => task.id === old.id)) result.push(old);
      if (!old) unidentifiedError = true;
    }
  }
  // An invalid or unknown ID cannot safely establish that an old task was deleted.
  if (unidentifiedError) for (const old of previous) if (!result.some(task => task.id === old.id)) result.push(old);
  return { tasks: result, warnings };
}
export function parseBacklog(text: string, previous: Task[] = [], mode: BacklogMode = {}): Task[] {
  return parseRows(text, previous, mode).tasks;
}
export function renderBacklog(text: string, tasks: Task[], mode: BacklogMode = {}): string {
  if (mode.workspace) for (const task of tasks) validateRepo(task, mode);
  const columns = tableColumns(mode);
  const { lines, start, end } = tableRange(text || initial);
  const table = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...tasks.map(task =>
    `| ${[task.id, task.title, task.category, ...(mode.workspace ? [task.repo!] : []), task.depends.join(','), task.status, String(task.repair), task.judgment,
      task.worktree, task.review?.commit ?? '', task.notes].map(cell).join(' | ')} |`)];
  return [...lines.slice(0, start), ...table, ...lines.slice(end)].join('\n').trimEnd() + '\n';
}
async function markdown(root: string): Promise<string | undefined> {
  try { return await readFile(join(root, 'docs/backlog.md'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
const stamp = (text: string | undefined): string => text === undefined ? 'missing' : digest(text);
const contention = () => new Error('백로그 편집 경합: 다시 시도하세요(JSON 보존)');
function protectsRemoval(task: Task): boolean {
  return task.status !== 'ready' || ['verify', 'review', 'merge', 'docs', 'cleanup', 'spec'].some(key => {
    const evidence = task[key as 'verify'];
    return evidence && Object.values(evidence).some(value => value !== undefined);
  });
}
async function load(root: string, retry = false, modeOverride?: BacklogMode): Promise<{ store: BacklogStore; text: string; warnings: string[] }> {
  const mode = modeOverride ?? await backlogMode(root);
  const path = join(root, 'docs/backlog.md');
  let text = await markdown(root);
  const store = await readJson<BacklogStore>(harnessPath(root, 'harness-backlog.json'), { tasks: [], usedIds: [], hash: '' });
  if (mode.workspace) for (const task of store.tasks) validateRepo(task, mode);
  if (text === undefined) {
    const rendered = renderBacklog('', store.tasks, mode);
    if (await markdown(root) !== undefined) { if (retry) throw contention(); return load(root, true, mode); }
    await atomicWrite(path, rendered);
    return { store, text: rendered, warnings: ['backlog.md 재생성'] };
  }
  if (store.pending) {
    if (digest(text) === store.pending.before) {
      if (stamp(await markdown(root)) !== digest(text)) throw contention();
      text = store.pending.text; await atomicWrite(path, text);
    }
    delete store.pending;
  }
  let warnings: string[] = [];
  if (digest(text) !== store.hash) {
    const parsed = parseRows(text, store.tasks, mode), tasks = parsed.tasks;
    warnings = parsed.warnings;
    for (const task of tasks) {
      if (store.usedIds.includes(task.id) && !store.tasks.some(old => old.id === task.id)) throw new Error('삭제한 task ID는 재사용할 수 없습니다');
    }
    const missing = store.tasks.filter(task => !tasks.some(next => next.id === task.id) && protectsRemoval(task));
    if (missing.length) throw new Error(`백로그 표에서 진행 중 task 가 사라졌습니다: ${missing.map(task => task.id).join(', ')} — \`fodh backlog sync\` 로 JSON 기준 복원`);
    store.tasks = tasks;
    store.usedIds = [...new Set([...store.usedIds, ...tasks.map(task => task.id)])];
    // Keep reparsing isolated rows so warnings are visible until the document is repaired.
    if (!warnings.length) store.hash = digest(text);
  }
  return { store, text, warnings };
}
async function saveStore(root: string, store: BacklogStore): Promise<void> {
  const path = harnessPath(root, 'harness-backlog.json'), next = JSON.stringify(store, null, 2) + '\n';
  if (await readText(path) !== next) await atomicWrite(path, next);
}
async function commitMarkdown(root: string, store: BacklogStore, before: string | undefined, rendered: string): Promise<boolean> {
  if (stamp(await markdown(root)) !== stamp(before)) return false;
  const path = harnessPath(root, 'harness-backlog.json'), original = await readText(path);
  store.pending = { before: stamp(before), text: rendered }; store.hash = digest(rendered);
  await saveStore(root, store);
  // Check again after the journal write, immediately before replacing the human document.
  if (stamp(await markdown(root)) !== stamp(before)) {
    if (original) await atomicWrite(path, original); else await unlink(path);
    return false;
  }
  await atomicWrite(join(root, 'docs/backlog.md'), rendered);
  delete store.pending;
  await saveStore(root, store);
  return true;
}
async function mutate<T>(root: string, action: (tasks: Task[], store: BacklogStore) => T): Promise<T> {
  return withFileLock(harnessPath(root, 'harness-backlog.json'), async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { store, text } = await load(root);
      const result = action(store.tasks, store);
      const mode = await backlogMode(root);
      for (const task of store.tasks) { validate(task); if (mode.workspace) validateRepo(task, mode); }
      if (await commitMarkdown(root, store, text, renderBacklog(text, store.tasks, mode))) return result;
    }
    throw contention();
  });
}
export async function readBacklog(root: string, mode?: BacklogMode): Promise<BacklogRead> {
  return withFileLock(harnessPath(root, 'harness-backlog.json'), async () => {
    const loaded = await load(root, false, mode);
    // Recreating a missing markdown file must not rewrite the authoritative JSON.
    if (!loaded.warnings.includes('backlog.md 재생성')) await saveStore(root, loaded.store);
    return { tasks: loaded.store.tasks, warnings: loaded.warnings };
  });
}
export async function listBacklog(root: string): Promise<Task[]> {
  return (await readBacklog(root)).tasks;
}
// Check without load(): reading the backlog normally imports Markdown edits into JSON.
export async function backlogInSync(root: string, mode?: BacklogMode): Promise<boolean> {
  mode ??= await backlogMode(root);
  return withFileLock(harnessPath(root, 'harness-backlog.json'), async () => {
    const text = await markdown(root);
    const store = await readJson<BacklogStore>(harnessPath(root, 'harness-backlog.json'), { tasks: [], usedIds: [], hash: '' });
    if (mode.workspace) for (const task of store.tasks) validateRepo(task, mode);
    return text !== undefined && !store.pending && store.hash === digest(text)
      && renderBacklog(text, store.tasks, mode) === text;
  });
}
export async function syncBacklog(root: string): Promise<BacklogRead> {
  const mode = await backlogMode(root);
  return withFileLock(harnessPath(root, 'harness-backlog.json'), async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await markdown(root);
      const store = await readJson<BacklogStore>(harnessPath(root, 'harness-backlog.json'), { tasks: [], usedIds: [], hash: '' });
      let warnings: string[] = [];
      if (text === undefined) warnings = ['backlog.md 재생성'];
      else { try { warnings = parseRows(text, store.tasks, mode).warnings; } catch (error) { warnings = [(error as Error).message]; } }
      if (await commitMarkdown(root, store, text, renderBacklog(text ?? '', store.tasks, mode))) return { tasks: store.tasks, warnings };
    }
    throw contention();
  });
}
export async function getTask(root: string, id: string): Promise<Task> {
  const task = (await listBacklog(root)).find(task => task.id === id);
  if (!task) throw new Error(`백로그 task를 찾을 수 없습니다: ${id}`);
  return task;
}
export async function addTask(root: string, input: { title: string; category: string; depends?: string[]; repo?: string }): Promise<Task> {
  validateRepo(input, await backlogMode(root));
  return mutate(root, (tasks, store) => {
    const number = Math.max(0, ...store.usedIds.map(id => Number(id.slice(1)))) + 1;
    if (!Number.isSafeInteger(number)) throw new Error('task ID 한도 초과');
    const task: Task = { ...input, id: `T${String(number).padStart(2, '0')}`, depends: input.depends ?? [],
      status: 'ready', repair: 0, judgment: '', worktree: '', notes: '' };
    tasks.push(task); store.usedIds.push(task.id); return task;
  });
}
// CLI input policy; core callers retain Markdown cell newline round-tripping.
export function normalizeNotes(value: string): string {
  const notes = value.replace(/[\r\n]+/gu, ' ');
  if (notes.length > 300) throw new Error('notes는 300자 이하여야 합니다');
  if (redact(notes) !== notes) throw new Error('notes에 비밀값 패턴을 기록할 수 없습니다');
  return notes;
}
export async function setTask(root: string, id: string, patch: Partial<Omit<Task, 'id'>>): Promise<Task> {
  const mode = Object.hasOwn(patch, 'repo') ? await backlogMode(root) : undefined;
  return mutate(root, tasks => {
    const index = tasks.findIndex(task => task.id === id);
    if (index < 0) throw new Error(`백로그 task를 찾을 수 없습니다: ${id}`);
    const old = tasks[index];
    if (Object.hasOwn(patch, 'repo')) protectRepo(old, patch.repo);
    const task = { ...old, ...patch };
    if (mode) validateRepo(task, mode);
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
