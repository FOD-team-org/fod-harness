import { rebaseJudgmentLinks } from './judgment-links.ts';
import { processStartedAt } from './process-time.ts';
import { lockOwnerAlive } from './lock.ts';
import { readdir, realpath, stat, unlink } from 'node:fs/promises';
import { notify } from './notify.ts';
import { assertNotBrain, originOfCaller } from './brain-guard.ts';
import { appendLedger } from './ledger.ts';
import type { BrainTurn } from './state.ts';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { readState, updateState, transitionState } from './state.ts';
import { listBacklog, setTask } from './backlog.ts';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';

export interface JudgmentOrigin { kind: 'brain' | 'cli' | 'stall' | 'interview'; scope?: string }
export interface JudgmentItem {
  origin?: JudgmentOrigin; answerSource?: 'autopilot';
  id: string; title: string; rev: number; background: string; options: string[]; recommend: string;
  held?: { at: string; reason: 'brain-turn'; runId: string };
  detail?: string; blocks: string; answer: string; answerRev?: number; classification?: AnswerClassification;
  resolution?: 'resume' | 'cleanup'; requiresApproval?: boolean; reaskOf?: string; followup?: string; dedupeKey?: string; raw: string; start: number; end: number;
}
export interface CompletedJudgment { answerSource?: string; title?: string; path?: string; id: string; rev?: number; answer: string; interpretation: string; commit: string; date: string }
export interface JudgmentDocument { items: JudgmentItem[]; completed: CompletedJudgment[] }
export interface JudgmentInput {
  origin?: JudgmentOrigin;
  title: string; background: string; options: string | string[]; recommend: string;
  detail?: string; blocks: string | string[]; dedupeKey?: string; resolution?: 'resume' | 'cleanup'; requiresApproval?: boolean; reaskOf?: string;
}
export interface AnswerClassification {
  kind: 'choice' | 'conditional' | 'freeform' | 'ambiguous' | 'revision-mismatch' | 'empty';
  applicable: boolean; selection?: number; selections?: number[]; interpretation?: string; condition?: string; reason?: string;
}

const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const preamble = (archive: string) => `> 답은 각 항목의 \`- 답:\` 줄에만 쓴다. 번호 하나(1 또는 ①)나 자유 서술로 쓰고, 승인이 필요한 동작이면 번호나 "승인"을 넣는다. 채팅으로 \`A<n> 1\` 이라고 답해도 된다.
> \`한눈에\` 표와 \`최근 결정\` 은 하네스가 다시 쓴다. 지난 판단: [판단기록](${archive}/). 편집기는 외부 변경 자동 새로고침을 켜 둘 것.`;
const initial = '# 판단대기\n\n## 지금 상태\n\n대기 중\n\n## 열린 판단\n\n';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const field = (text: string, key: string): string => text.match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, 'mu'))?.[1]?.trim() ?? '';

function optionsOf(text: string): string[] {
  if (!/[①-⑳]|(?:^|\s)\d+[.)]/u.test(text)) return text.split('|').map(value => value.trim()).filter(Boolean);
  const numbered = text.split(/(?:[①-⑳]|(?:^|\s)\d+[.)])\s*/u).map(value => value.trim()).filter(Boolean);
  return numbered.length ? numbered : text.split('|').map(value => value.trim()).filter(Boolean);
}

function cells(line: string): string[] {
  return line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u)
    .map(value => value.trim().replace(/\\\|/gu, '|').replace(/<br\s*\/?\s*>/giu, '\n'));
}

export function parseJudgment(text: string, options: { migrate?: boolean } = {}): JudgmentDocument {
  const items: JudgmentItem[] = [];
  const headings = [...text.matchAll(/^###\s+(A\d+(?:-\d+)?)\s*[—–-]\s*(.*?)\s*\((?:rev\s+(\d+)|\d{4}-\d{2}-\d{2})\)\s*$/gmu)];
  const open = /^## 열린 판단[ \t]*\r?$/mu.exec(text);
  const openStart = open ? open.index + open[0].length : -1;
  const nextSection = open ? text.slice(openStart).search(/^#{1,2}[ \t]/mu) : -1;
  const openEnd = nextSection < 0 ? text.length : openStart + nextSection;
  const completedStart = text.search(/^## 결정 완료\s*$/mu);
  for (const heading of headings) {
    if (!options.migrate && heading[3] === undefined) continue;
    const start = heading.index!;
    if (openStart < 0 || start < openStart || start >= openEnd) continue;
    const tail = text.slice(start + heading[0].length);
    const boundary = tail.search(/^#{1,3}\s/mu);
    const end = boundary < 0 ? text.length : start + heading[0].length + boundary;
    const raw = text.slice(start, end);
    const answerRev = field(raw, '답 기준 rev');
    items.push({
      id: heading[1]!, title: heading[2]!, rev: Number(heading[3] ?? 1), background: field(raw, '배경'),
      options: parsedOptions(raw), detail: field(raw, '자세히') || undefined, recommend: field(raw, '추천'), blocks: field(raw, '막힌 작업'),
      ...(field(raw, '답 출처') === '오토파일럿' && raw.match(/<!-- fodh-answer: ([a-f0-9]+) -->/u)?.[1] === hash(raw.match(/^- 답:[^\r\n]*$/mu)?.[0] ?? '') ? { answerSource: 'autopilot' as const } : {}),
      answer: field(raw, '답'), requiresApproval: ['true', '예'].includes(field(raw, '승인 필수')),
      resolution: ['resume', 'cleanup'].includes(field(raw, '적용 정책')) ? field(raw, '적용 정책') as 'resume' | 'cleanup' : undefined,
      reaskOf: field(raw, '재질문 원본') || undefined, followup: field(raw, '후속 질문') || undefined, ...(answerRev ? { answerRev: Number(answerRev) } : {}),
      dedupeKey: raw.match(/<!-- fodh-dedupe: ([a-f0-9]+) -->/u)?.[1], raw, start, end,
    });
  }
  const completed: CompletedJudgment[] = [];
  let headers: string[] = [];
  if (completedStart >= 0) for (const line of text.slice(completedStart).split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const values = cells(line);
    if (values[0] === '번호') { headers = values; continue; }
    if (!/^A\d+(?:-\d+)?$/u.test(values[0] ?? '')) continue;
    const value = (name: string): string => values[headers.indexOf(name)] ?? '';
    completed.push({
      id: values[0]!, ...(value('rev') ? { rev: Number(value('rev')) } : {}), answer: value('답(원문)'),
      interpretation: value('해석') || value('반영'), commit: value('반영 커밋'), date: value('날짜'),
    });
  }
  return { items, completed };
}

export function classifyAnswer(text: string, options: string[], rev = 1, answerRev = rev, requiresApproval = false, settings: { allowMulti?: boolean } = {}): AnswerClassification {
  const answer = text.trim();
  if (!answer) return { kind: 'empty', applicable: false };
  if (rev !== answerRev) return { kind: 'revision-mismatch', applicable: false, reason: '문항과 답의 개정 번호가 다릅니다' };
  const negative = new RegExp([
    /하지\s*마|말고|(?:[0-9①-⑳]+)(?:은|는)\s*제외|나중에|보류|취소|반대|거절/.source,
    /승인\s*(?:안|못|하지)|진행\s*(?:안|못|하지)|(?:^|\s)(?:안|못)\s*(?:해|하|돼)|아니|둘\s*다/.source,
  ].join('|'), 'u');
  if (negative.test(answer)) {
    return { kind: 'ambiguous', applicable: false, reason: '부정 또는 유보가 포함되어 있습니다' };
  }
  const circles = [...answer.matchAll(/[①-⑩]/gu)];
  // 번 뒤 조사가 이어지는 "2번으로"도 선택이다. 소수와 영숫자 식별자는 제외한다.
  const leading = answer.match(/^(10|[1-9])(?!\.\d)(?:번(?=$|[\s\p{P}\p{Script=Hangul}])|(?=$|[\s\p{P}]))/u);
  const numberPattern = /(?<![A-Za-z0-9_])(?<!\d\.)(10|[1-9])(?![A-Za-z0-9_]|\.\d)(?=$|[\s\p{P}]|번|과|와|또는|혹은|이나|은|는|을|를|으로|로|하고|및)/gu;
  const numbers = [...answer.matchAll(numberPattern)];
  if (circles.length + numbers.length > 1) {
    const selections = [...new Set([...circles.map(m => ({ index: m.index!, number: circled.indexOf(m[0]) + 1 })),
      ...numbers.map(m => ({ index: m.index!, number: Number(m[1]) }))].sort((a, b) => a.index - b.index).map(m => m.number))];
    if (settings.allowMulti && selections.every(n => n >= 1 && n <= options.length)) {
      return { kind: 'freeform', applicable: true, selections,
        interpretation: `복수 선택: ${selections.map(n => options[n - 1]).join(', ')}; 원문: ${answer}` };
    }
    return { kind: 'ambiguous', applicable: false, reason: '선택 번호가 여러 개입니다' };
  }
  if (/모두|제외|전부/u.test(answer) && !circles.length && !leading
    && /선택|항목|옵션|둘|다|모두|전부/u.test(answer)) {
    return { kind: 'ambiguous', applicable: false, reason: '다중 선택 문맥입니다' };
  }
  if (circles.length || leading) {
    const selection = circles.length ? circled.indexOf(circles[0][0]) + 1 : Number(leading![1]);
    if (selection > options.length) return { kind: 'ambiguous', applicable: false, reason: '선택지 범위를 벗어났습니다' };
    const condition = (circles.length ? answer.replace(circles[0][0], '') : answer.slice(leading![0].length))
      .replace(/^[\s,，:.)]+/u, '').trim();
    const interpretation = options[selection - 1]!;
    return condition
      ? { kind: 'conditional', applicable: true, selection, condition, interpretation: `${interpretation}; 조건: ${condition}` }
      : { kind: 'choice', applicable: true, selection, interpretation };
  }
  const approved = /(?:^|[\s,.:;])(승인(?:합니다|해요|해|함)?|진행(?:합니다|해요|해)?)(?=$|[\s,.:;])/u.test(answer);
  return {
    kind: 'freeform', applicable: !requiresApproval || approved,
    ...(!requiresApproval || approved ? {} : { reason: '승인 필수 동작에는 선택 번호 또는 승인/진행 토큰이 필요합니다' }),
  };
}

function classifyItemAnswer(item: JudgmentItem, answerRev = item.answerRev ?? item.rev, requiresApproval = approvalRequired(item)): AnswerClassification {
  const number = Number(item.answer);
  if (item.answerSource === 'autopilot' && /^\d+$/u.test(item.answer) && number > 10
    && number <= item.options.length && item.rev === answerRev) {
    return { kind: 'choice', applicable: true, selection: number, interpretation: item.options[number - 1] };
  }
  const classification = classifyAnswer(item.answer, item.options, item.rev, answerRev, requiresApproval,
    { allowMulti: !requiresApproval && !item.resolution });
  // Shared by apply and its locked completion check; the watcher still waits for freeform stability.
  if (classification.kind === 'ambiguous' && item.reaskOf && !requiresApproval && !item.resolution) {
    return { kind: 'freeform', applicable: true, interpretation: `사용자 지시(재질문 뒤 자유 서술): ${item.answer}` };
  }
  return classification;
}

async function location(root: string): Promise<string> { return resolve(root, (await loadConfig(root)).judgment.file); }
export function questionHash(item: JudgmentItem): string {
  return hash(JSON.stringify([item.title, item.background, item.options, item.recommend, item.blocks]));
}
async function reconcileEdits(root: string, path: string, text: string): Promise<string> {
  const watcher = await readJson<{ judgment?: { questions?: Record<string, { hash: string; rev: number }> } }>(
    harnessPath(root, 'harness-watcher.json'), {},
  );
  for (const item of parseJudgment(text).items.reverse()) {
    const previous = watcher.judgment?.questions?.[item.id];
    if (!previous || previous.hash === questionHash(item) || item.rev > previous.rev) continue;
    let raw = item.raw.replace(/\(rev \d+\)/u, () => `(rev ${previous.rev + 1})`);
    if (item.answer && item.answerRev === undefined) raw = raw.trimEnd() + `\n- 답 기준 rev: ${previous.rev}\n\n`;
    text = text.slice(0, item.start) + raw + text.slice(item.end);
  }
  return text;
}
async function rememberQuestions(root: string, items: JudgmentItem[]): Promise<void> {
  const path = harnessPath(root, 'harness-watcher.json');
  await withFileLock(path, async () => {
    const watcher = await readJson<{
      judgment?: { questions?: Record<string, { hash: string; rev: number }>; [key: string]: unknown };
      [key: string]: unknown;
    }>(path, {});
    const questions = watcher.judgment?.questions ?? {};
    const missing = items.filter(item => !Object.hasOwn(questions, item.id));
    if (!missing.length) return;
    for (const item of missing) questions[item.id] = { hash: questionHash(item), rev: item.rev };
    watcher.judgment = { ...watcher.judgment, questions };
    await atomicWrite(path, JSON.stringify(watcher, null, 2) + '\n');
  });
}
// Invalid or unreadable provenance is never evidence for automatic consent.
async function readOrigins(root: string): Promise<Record<string, JudgmentOrigin & { createdAt: string }>> {
  try {
    const data = await readJson<unknown>(harnessPath(root, 'harness-judgment-origin.json'), {});
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([id, value]) => /^A\d+(?:-\d+)?$/u.test(id)
      && value && typeof value === 'object' && ['brain', 'cli', 'stall', 'interview'].includes(value.kind)
      && (value.scope === undefined || typeof value.scope === 'string')
      && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))));
  } catch { return {}; }
}
export async function readJudgment(root: string, options: { answered?: boolean } = {}): Promise<JudgmentDocument & {
  expectedHash: string;
}> {
  const config = await loadConfig(root);
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const expectedHash = text === original ? hash(text) : await save(root, path, text, original);
    if (text !== original) text = await readText(path);
    const document = parseJudgment(text);
    const origins = await readOrigins(root);
    for (const item of document.items) {
      const origin = origins[item.id];
      if (origin) item.origin = { kind: origin.kind, ...(origin.scope === undefined ? {} : { scope: origin.scope }) };
    }
    document.completed.push(...await readArchive(root));
    const held = await readJson<HeldAnswer[]>(harnessPath(root, 'harness-judgment-held.json'), []);
    for (const item of document.items) item.held = held.find(record => record.id === item.id && record.answer === item.answer)?.held;
    if (text === original) await rememberQuestions(root, document.items);
    return { ...document, items: document.items.filter(item => !options.answered || item.answer.trim()).map(item => ({
      ...item, ...(options.answered ? { classification: classifyItemAnswer(item, item.answerRev, approvalRequired(item, config.requiresApproval)) } : {}),
    })), expectedHash };
  }));
}

export class JudgmentConflict extends Error {
  constructor() { super('판단 내용이 변경되었습니다. 다시 읽어 주세요'); this.name = 'JudgmentConflict'; }
}
async function retryJudgment<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { if (!(error instanceof JudgmentConflict)) throw error; return action(); }
}
async function save(root: string, path: string, text: string, original: string): Promise<string> {
  const config = await loadConfig(root);
  if (!original && !text.includes(preamble(relative(dirname(path), resolve(root, config.judgment.archive))))) text = text.replace(/^(#[^\n]*\n)/u, (_, title: string) => `${title}\n${preamble(relative(dirname(path), resolve(root, config.judgment.archive)))}\n`);
  text = renderDerived(text, { recent: config.judgment.recent, completed: await readArchive(root) });
  const expectedHash = hash(text);
  const watcherPath = harnessPath(root, 'harness-watcher.json');
  await withFileLock(watcherPath, async () => {
    const watcher = await readJson<{
      judgment?: { expectedHash?: string; externalPending?: { hash: string; at: string } };
      watch?: { judgment?: { lastEmitted?: string; observed?: { hash: string; since: string } } };
    }>(watcherPath, {});
    const previous = watcher.judgment;
    const observed = watcher.watch?.judgment?.observed;
    const originalHash = hash(original);
    const externalPending = previous?.externalPending ?? (original && originalHash !== previous?.expectedHash
      && originalHash !== watcher.watch?.judgment?.lastEmitted
      ? { hash: originalHash, at: observed?.hash === originalHash ? observed.since : new Date().toISOString() } : undefined);
    // The watcher lock excludes tick until both document and metadata are committed.
    await atomicWrite(path, text, async () => {
      if (hash(await readText(path)) !== originalHash) throw new JudgmentConflict();
    });
    await atomicWrite(watcherPath, JSON.stringify({ ...watcher, judgment: { path, expectedHash, externalPending,
      questions: Object.fromEntries(parseJudgment(text).items.map(item => [item.id, { hash: questionHash(item), rev: item.rev }])),
      savedAt: new Date().toISOString() } }, null, 2) + '\n');
  });
  return expectedHash;
}

function oneLine(value: string): string { return value.replace(/[\r\n]+/gu, ' ').trim(); }
function requireItem(text: string, id: string): JudgmentItem {
  const item = parseJudgment(text).items.find(value => value.id === id);
  if (!item) throw new Error('열린 판단 항목을 찾을 수 없습니다');
  return item;
}

export function similarJudgmentTitle(left: string, right: string): boolean {
  const tokens = (title: string) => new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(token => [...token].length > 1 && !/^[ta]\d+$/u.test(token)));
  const a = tokens(left), b = tokens(right);
  return a.size >= 2 && b.size >= 2 && [...a].filter(token => b.has(token)).length / Math.min(a.size, b.size) >= 0.6;
}
// CLI policy is opt-in; internal safeguards/reasks keep their existing dedupe behavior.
export async function addCliJudgment(root: string, input: JudgmentInput, distinct = false) {
  for (const [label, value, limit] of [
    ['제목', input.title, 60], ['배경', input.background, 400], ['추천', input.recommend, 200],
    ...(typeof input.options === 'string' ? optionsOf(input.options) : input.options).map(value => ['선택지', value, 160] as const),
  ] as const) {
    if (typeof value !== 'string') throw new Error(`${label}는 문자열이어야 합니다`);
    if ([...value].length > limit) throw new Error(`${label}가 ${limit}자를 넘습니다(${[...value].length}자). 자세한 내용은 문서에 쓰고 --detail <경로> 로 연결하라`);
  }
  if (input.detail !== undefined) {
    const config = await loadConfig(root), target = resolve(root, input.detail);
    const inside = (p: string, base: string) => p === base || p.startsWith(base + '/');
    if (isAbsolute(input.detail) || input.detail.split('/').includes('..') || !inside(target, resolve(root))
      || target === resolve(root, config.judgment.file) || inside(target, resolve(root, config.judgment.archive))) throw new Error('--detail은 판단 파일·판단기록 밖 프로젝트 상대 파일 경로여야 합니다');
    if (!(await stat(target).catch(() => undefined))?.isFile()) throw new Error('--detail 파일이 존재하지 않습니다');
    const actual = await realpath(target);
    const actualArchive = await realpath(resolve(root, config.judgment.archive)).catch(() => resolve(root, config.judgment.archive));
    const actualJudgment = await realpath(resolve(root, config.judgment.file)).catch(() => resolve(root, config.judgment.file));
    if (!inside(actual, await realpath(root)) || inside(actual, actualArchive) || actual === actualJudgment) throw new Error('--detail은 판단 파일·판단기록 밖 프로젝트 파일이어야 합니다');
    input = { ...input, detail: `[${basename(target)}](${relative(dirname(resolve(root, config.judgment.file)), target)})` };
  }
  return addJudgment(root, { ...input, origin: { kind: originOfCaller() } }, { distinct });
}
export async function attachJudgmentTask(root: string, id: string, taskId: string): Promise<{ item: JudgmentItem; expectedHash: string }> {
  if (!/^T\d+$/u.test(taskId)) throw new Error('--same-as는 --blocks 단일 task가 필요합니다');
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const task = (await listBacklog(root)).find(task => task.id === taskId);
    if (!task) throw new Error('task를 찾을 수 없습니다');
    if (task.status === 'done') throw new Error('완료 task는 새 작업으로 등록해야 합니다');
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const item = requireItem(text, id);
    const blocked = /^blocked\((A\d+(?:-\d+)?)\)$/u.exec(task.status);
    if (blocked && blocked[1] !== id) throw new Error(`task ${taskId} 는 이미 ${blocked[1]} 에 묶여 있습니다`);
    if (blocked?.[1] === id && item.blocks.split(/[,\s]+/u).includes(taskId)) {
      const expectedHash = await save(root, path, text, original);
      return { item: requireItem(await readText(path), id), expectedHash };
    }
    if (item.answer.trim()) throw new Error('답이 있는 판단에는 task를 붙일 수 없습니다');
    if (!item.blocks.split(/[,\s]+/u).includes(taskId)) {
      const blocks = [item.blocks === '-' ? '' : item.blocks, taskId].filter(Boolean).join(', ');
      const line = /^- 막힌 작업:[^\r\n]*$/mu;
      const raw = line.test(item.raw) ? item.raw.replace(line, () => `- 막힌 작업: ${blocks}`)
        : item.raw.trimEnd() + `\n- 막힌 작업: ${blocks}\n\n`;
      text = text.slice(0, item.start) + raw + text.slice(item.end);
    }
    const expectedHash = await save(root, path, text, original);
    return { item: requireItem(await readText(path), id), expectedHash };
  }));
}

export async function addJudgment(root: string, input: JudgmentInput, cliPolicy?: { distinct: boolean }): Promise<{ item: JudgmentItem; expectedHash: string; deduped?: 'same-key' | 'same-task' }> {
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const document = parseJudgment(text);
    const dedupeKey = input.dedupeKey ? hash(input.dedupeKey) : undefined;
    const found = dedupeKey && document.items.find(item => item.dedupeKey === dedupeKey);
    if (found) { const expectedHash = await save(root, path, text, original); return { item: requireItem(await readText(path), found.id), expectedHash, ...(cliPolicy ? { deduped: 'same-key' as const } : {}) }; }
    if (cliPolicy) {
      const unanswered = document.items.filter(item => !item.answer.trim());
      const taskId = typeof input.blocks === 'string' && /^T\d+$/u.test(input.blocks) ? input.blocks : undefined;
      const sameTask = taskId && unanswered.find(item => item.blocks.split(/[,\s]+/u).includes(taskId));
      if (sameTask) { const expectedHash = await save(root, path, text, original); return { item: requireItem(await readText(path), sameTask.id), expectedHash, deduped: 'same-task' }; }
      const similar = !cliPolicy.distinct && unanswered.find(item => similarJudgmentTitle(input.title, item.title));
      if (similar) throw new Error(`비슷한 열린 판단 ${similar.id}(${similar.title})이 있습니다. ${taskId
        ? `같은 원인이면 --same-as ${similar.id} 로 이 task 를 붙이고, 다른 원인이면 --distinct 를 붙여 다시 등록하라`
        : '같은 원인이면 새로 등록하지 말고 그 판단을 기다려라. 다른 원인이면 --distinct 를 붙여 다시 등록하라'}`);
    }
    if (!input.title.trim()) throw new Error('판단 제목이 필요합니다');
    const next = await highestNumber(root, text) + 1;
    const id = `A${next}`;
    const options = typeof input.options === 'string' ? optionsOf(input.options) : input.options;
    if (!options.length) throw new Error('판단 선택지가 필요합니다');
    const section = [
      `### ${id} — ${oneLine(input.title)} (rev 1)\n- 배경: ${oneLine(input.background)}\n`,
      `- 선택지:\n${options.map((option, index) => `  ${circled[index] ?? `${index + 1}.`} ${oneLine(option)}`).join('\n')}\n`,
      `- 추천: ${oneLine(input.recommend)}\n`,
      `- 막힌 작업: ${oneLine(Array.isArray(input.blocks) ? input.blocks.join(', ') : input.blocks)}\n`,
      `${input.detail ? `- 자세히: ${input.detail}\n` : ''}- 답:\n`,
      `${input.resolution ? `- 적용 정책: ${input.resolution}\n` : ''}`,
      `${input.requiresApproval ? '- 승인 필수: 예\n' : ''}${input.reaskOf ? `- 재질문 원본: ${oneLine(input.reaskOf)}\n` : ''}`,
      `${dedupeKey ? `<!-- fodh-dedupe: ${dedupeKey} -->\n` : ''}\n`,
    ].join('');
    if (!/^## 열린 판단\s*$/mu.test(text)) text += '\n## 열린 판단\n\n';
    const open = /^## 열린 판단\s*$/mu.exec(text)!;
    const afterOpen = open.index + open[0].length;
    const nextHeading = text.slice(afterOpen).search(/^## /mu);
    const at = nextHeading < 0 ? text.length : afterOpen + nextHeading;
    text = text.slice(0, at).trimEnd() + '\n\n' + section + text.slice(at);
    const expectedHash = await save(root, path, text, original);
    await atomicWrite(harnessPath(root, 'harness-judgment-seq.json'), JSON.stringify({ last: next }) + '\n');
    if (input.origin) {
      const origins = await readOrigins(root);
      origins[id] = { ...input.origin, createdAt: new Date().toISOString() };
      await atomicWrite(harnessPath(root, 'harness-judgment-origin.json'), JSON.stringify(origins, null, 2) + '\n');
    }
    return { item: requireItem(await readText(path), id), expectedHash };
  }));
}

export class AnswerConflict extends Error {}
export async function answerJudgment(root: string, id: string, answer: string, options: { expectEmpty?: boolean; expectedRaw?: string; source?: 'autopilot' } = {}): Promise<{ item: JudgmentItem; expectedHash: string }> {
  await assertNotBrain(root, '판단 답변');
  if (/[\r\n]/u.test(answer)) throw new Error('답은 한 줄로 입력해야 합니다');
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const item = requireItem(text, id);
    if (options.expectEmpty && item.answer.trim() || options.expectedRaw !== undefined && item.raw !== options.expectedRaw) throw new AnswerConflict('판단 답 또는 내용이 변경되었습니다');
    let replacement = item.raw.replace(/^- 답:[^\r\n]*$/mu, () => `- 답: ${answer}`);
    replacement = replacement.replace(/^- 답 기준 rev:[^\r\n]*\n?/mu, '');
    replacement = replacement.replace(/^- 답 출처:[^\r\n]*\n?|^<!-- fodh-answer:[^\r\n]*\n?/gmu, '');
    replacement = replacement.trimEnd() + `\n- 답 기준 rev: ${item.rev}\n${options.source === 'autopilot' ? `- 답 출처: 오토파일럿\n<!-- fodh-answer: ${hash(`- 답: ${answer}`)} -->\n` : ''}\n`;
    text = text.slice(0, item.start) + replacement + text.slice(item.end);
    const expectedHash = await save(root, path, text, original);
    return { item: requireItem(await readText(path), id), expectedHash };
  }));
}

export async function writeJudgmentStatus(root: string, status: string): Promise<{ expectedHash: string }> {
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    if (!/^## 지금 상태\s*$/mu.test(text)) {
      const at = text.match(/^#[^\n]*\n(?:[ \t]*\n|>[^\n]*\n)*/u)?.[0].length ?? 0;
      text = text.slice(0, at) + `## 지금 상태\n\n${oneLine(status)}\n\n` + text.slice(at);
      return { expectedHash: await save(root, path, text, original) };
    }
    const heading = /^## 지금 상태[^\r\n]*\r?\n/mu.exec(text)!;
    const start = heading.index + heading[0].length;
    const boundary = text.slice(start).search(/^## /mu);
    const end = boundary < 0 ? text.length : start + boundary;
    text = text.slice(0, start) + `\n${oneLine(status)}\n\n` + text.slice(end);
    return { expectedHash: await save(root, path, text, original) };
  }));
}

const tableValue = (value: string): string => value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
export async function completeJudgment(
  root: string, id: string,
  input: { interpretation: string; commit: string; answerRev?: number; requiresApproval?: boolean; expectedRaw?: string; resolveChain?: boolean },
): Promise<{ expectedHash: string; completed: CompletedJudgment }> {
  const path = await location(root);
  return withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const item = requireItem(text, id);
    if (input.expectedRaw !== undefined && input.expectedRaw !== item.raw) throw new JudgmentConflict();
    const classification = classifyItemAnswer(item, input.answerRev ?? item.answerRev ?? item.rev, input.requiresApproval ?? approvalRequired(item));
    if (!classification.applicable) throw new Error('적용할 수 없는 답입니다');
    if (!input.interpretation.trim() || !input.commit.trim()) throw new Error('해석과 반영 커밋이 필요합니다');
    const completed: CompletedJudgment = {
      ...(item.answerSource === 'autopilot' ? { answerSource: '오토파일럿' } : {}),
      id, rev: item.rev, answer: item.answer, interpretation: input.interpretation, commit: input.commit,
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()),
    };
    const chain = input.resolveChain ? relatedChain(parseJudgment(text).items, item) : [item];
    const archiveChanges: { path: string; original: string; text: string }[] = [];
    for (const member of chain) archiveChanges.push(await appendArchive(root, { ...completed, id: member.id, rev: member.rev, title: member.title,
      answerSource: member.id === id ? completed.answerSource : undefined,
      answer: member.id === id ? item.answer : `모호: ${member.answer} → ${id}: ${item.answer}` }, member.raw));
    for (const member of [...chain].sort((a, b) => b.start - a.start)) text = text.slice(0, member.start) + text.slice(member.end);
    try { return { expectedHash: await save(root, path, text, original), completed }; }
    catch (error) {
      // A rejected CAS is a known non-commit. Undo only our new archive writes;
      // abrupt interruption instead leaves the archive for finish(pending).
      if (error instanceof JudgmentConflict) for (const change of archiveChanges.reverse()) {
        if (change.text === change.original) continue;
        await withFileLock(change.path, async () => {
          if (await readText(change.path) !== change.text) throw new JudgmentConflict();
          if (change.original) await atomicWrite(change.path, change.original); else await unlink(change.path);
        });
      }
      throw error;
    }
  });
}

export function approvalRequired(item: JudgmentItem, configured: string[] = []): boolean {
  const text = `${item.title} ${item.background} ${item.options.join(' ')}`;
  return item.requiresApproval === true || configured.some(name => text.includes(name))
    || /승인|훅.*거부|프로덕션|운영.*배포|결제|스토어|심사|push|환경변수|비밀값|외부.*발송|약관|개인정보|DNS|키체인/iu.test(text);
}
function relatedChain(items: JudgmentItem[], last: JudgmentItem): JudgmentItem[] {
  const chain = [last], seen = new Set([last.id]);
  for (let at = 0; at < chain.length; at++) {
    for (const item of items) if (!seen.has(item.id) && (item.id === chain[at].reaskOf || item.followup === chain[at].id)) {
      seen.add(item.id); chain.push(item);
    }
  }
  return chain;
}
interface ApplyEntry { id: string; interpretation: string }
interface ApplyJournal { id: string; rev: number; answer: string; interpretation: string; releases: string[]; hold?: boolean; resolution?: string; relevant?: boolean }
async function markFollowup(root: string, item: JudgmentItem, followup: string): Promise<void> {
  const path = await location(root);
  await withFileLock(path, async () => {
    const original = await readText(path);
    const text = await reconcileEdits(root, path, original || initial);
    const current = requireItem(text, item.id);
    if (current.raw !== item.raw) throw new JudgmentConflict();
    const raw = current.raw.trimEnd() + `\n- 후속 질문: ${followup}\n\n`;
    await save(root, path, text.slice(0, current.start) + raw + text.slice(current.end), original);
  });
}
export async function applyJudgments(root: string, ids?: string[], expectedAnswers?: Record<string, string>, options: { releaseHeld?: boolean } = {}): Promise<{
  applied: ApplyEntry[]; unapplied: { id: string; reason: string }[];
}> {
  await assertNotBrain(root, '판단 적용');
  const applied: ApplyEntry[] = [];
  return retryJudgment(() => withFileLock(harnessPath(root, 'harness-judgment-apply'), async () => {
    // Recheck watcher reads under the apply lock against a turn that started meanwhile.
    const activeSnapshot = await hasActiveJudgmentSnapshot(root) ? await readJson<JudgmentSnapshot | null>(snapshotPath(root), null) : null;
    if (expectedAnswers && activeSnapshot) throw new JudgmentConflict();
    if (options.releaseHeld) await releaseHeldAnswers(root, ids);
    const unapplied: { id: string; reason: string }[] = [];
    const journalPath = harnessPath(root, 'harness-judgment-apply.json');
    let journal = await readJson<ApplyJournal[]>(journalPath, []);
    const persist = () => atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
    const finish = async (entry: ApplyJournal) => {
      let document = await readJudgment(root);
      const path = await location(root);
      const discarded = await withFileLock(path, async () => {
        const original = await readText(path), text = await reconcileEdits(root, path, original);
        const open = parseJudgment(text).items.find(item => item.id === entry.id);
        if (!open || open.rev === entry.rev && open.answer === entry.answer) return false;
        const removed = await removeArchivedJudgment(root, entry, path);
        journal = journal.filter(item => item.id !== entry.id); await persist();
        if (removed || text !== original) await save(root, path, text, original);
        return true;
      });
      if (discarded) return;
      if (!document.completed.some(item => archivedIdentity(item, entry, path))) return;
      if (document.items.some(item => entry.releases.includes(item.id))) {
        const open = document.items.find(item => item.id === entry.id);
        if (!open) throw new JudgmentConflict();
        await completeJudgment(root, entry.id, { interpretation: entry.interpretation, commit: '판단 적용; 코드 커밋 없음', expectedRaw: open.raw, resolveChain: true });
        document = await readJudgment(root);
      }
      let relevant = entry.relevant ?? false;
      for (const task of await listBacklog(root)) {
        if (!entry.releases.some(id => task.status === `blocked(${id})`)) continue;
        relevant = true;
        const other = document.items.find(item => !item.followup && !entry.releases.includes(item.id)
          && item.blocks.split(/[,\s]+/u).includes(task.id));
        const status = entry.hold ? task.status : other ? `blocked(${other.id})` : task.resume?.status ?? 'ready';
        await setTask(root, task.id, { status, judgment: entry.hold ? task.judgment : other?.id ?? '',
          notes: [task.notes, `${entry.id}: ${entry.interpretation}`].filter(Boolean).join('\n') });
      }
      const state = await readState(root);
      relevant ||= typeof state.pickJudgment === 'string' && entry.releases.includes(state.pickJudgment);
      if (!entry.hold && relevant) {
        await updateState(root, { retry: undefined, lastPaused: undefined });
        if (state.state === 'WAIT_JUDGMENT') await transitionState(root, state.resumeState ?? 'PICK', { judgmentApplied: true });
        else if (state.state === 'paused(cleanup)' && entry.resolution === 'cleanup') {
          const { cleanupReport } = await import('./reclaim.ts');
          if ((await cleanupReport(root)).ok) {
            const pending = state.pendingReclaim as { taskId: string; judgmentId: string } | undefined;
            if (pending) {
              const blocking = document.items.find(item => item.id === pending.judgmentId);
              await setTask(root, pending.taskId, { status: blocking ? `blocked(${blocking.id})` : 'ready', judgment: blocking?.id ?? '' });
            }
            await updateState(root, { pendingReclaim: undefined });
            await transitionState(root, 'PICK');
            await updateState(root, { pickJudgment: undefined });
          }
        }
      }
      if (entry.hold) await writeJudgmentStatus(root, `${entry.id} 보류 — ${entry.interpretation}`);
      applied.push({ id: entry.id, interpretation: entry.interpretation });
      journal = journal.filter(item => item.id !== entry.id); await persist();
    };
    for (const pending of [...journal]) await finish(pending);
    const document = await readJudgment(root);
    const config = await loadConfig(root);
    for (const id of ids ?? []) {
      if (!document.items.some(item => item.id === id) && !document.completed.some(item => item.id === id)) {
        unapplied.push({ id, reason: '열린 판단 항목을 찾을 수 없습니다' });
      }
    }
    for (const item of document.items.filter(item => !ids?.length || ids.includes(item.id))) {
      if (!ids?.length && activeSnapshot && rawAnswer(item) !== activeSnapshot.answers[item.id]) {
        unapplied.push({ id: item.id, reason: '두뇌 턴 진행 중(턴 종료 뒤 held 로 확인)' }); continue;
      }
      if (item.held) { unapplied.push({ id: item.id, reason: '두뇌 턴 중 변경된 답입니다. /judged 로 확인하세요' }); continue; }
      // Automatic application must not accept a new answer typed after its stability check.
      if (expectedAnswers && expectedAnswers[item.id] !== item.raw) throw new JudgmentConflict();
      if (item.followup) { unapplied.push({ id: item.id, reason: `후속 질문 ${item.followup}의 답을 기다립니다` }); continue; }
      const requiresApproval = approvalRequired(item, config.requiresApproval);
      const classification = classifyItemAnswer(item, item.answerRev, requiresApproval);
      if (!classification.applicable) {
        const reason = classification.reason ?? '미답';
        unapplied.push({ id: item.id, reason });
        if (classification.kind === 'empty') continue;
        const next = await addJudgment(root, { title: `${item.id} 재질문: ${item.title}`, background: `${reason}. 이전 답: ${item.answer}. 번호 하나만 쓰세요(예: 2). 조건은 번호 뒤에(예: 2 iOS 먼저).`,
          options: item.options, recommend: item.recommend, blocks: item.blocks, requiresApproval,
          reaskOf: item.id, resolution: item.resolution, dedupeKey: `reask:${item.id}:${item.rev}:${hash(item.answer)}` });
        await markFollowup(root, item, next.item.id);
        continue;
      }
      if (item.resolution && !classification.selection) {
        unapplied.push({ id: item.id, reason: '재개 또는 보류의 선택 번호가 필요합니다' }); continue;
      }
      if (item.resolution === 'cleanup' && classification.selection === 1) {
        const { cleanupReport } = await import('./reclaim.ts');
        if (!(await cleanupReport(root)).ok) {
          unapplied.push({ id: item.id, reason: '프로세스 레지스트리 잔존이 있습니다' }); continue;
        }
      }
      const interpretation = classification.interpretation ?? `사용자 지시: ${item.answer}`;
      const stateBefore = await readState(root);
      const entry: ApplyJournal = { id: item.id, rev: item.rev, answer: item.answer, interpretation,
        releases: relatedChain(document.items, item).map(member => member.id),
        hold: !!item.resolution && classification.selection === 2, resolution: item.resolution,
        relevant: (await listBacklog(root)).some(task => relatedChain(document.items, item).some(member => task.status === `blocked(${member.id})`))
          || relatedChain(document.items, item).some(member => stateBefore.pickJudgment === member.id),
      };
      journal = [...journal.filter(record => record.id !== item.id), entry]; await persist();
      await completeJudgment(root, item.id, { interpretation, commit: '판단 적용; 코드 커밋 없음', requiresApproval, expectedRaw: item.raw, resolveChain: true });
      await finish(entry);
    }
    const remaining = new Set((await readJudgment(root)).items.map(item => item.id));
    return { applied, unapplied: unapplied.filter(item => remaining.has(item.id) || !document.items.some(open => open.id === item.id)) };
  }));
}

interface HeldAnswer { id: string; answer: string; held: NonNullable<JudgmentItem['held']> }
async function releaseHeldAnswers(root: string, ids?: string[]): Promise<void> {
  const path = harnessPath(root, 'harness-judgment-held.json');
  await withFileLock(path, async () => {
    const records = await readJson<HeldAnswer[]>(path, []);
    await atomicWrite(path, JSON.stringify(ids?.length ? records.filter(item => !ids.includes(item.id)) : []) + '\n');
  });
}
interface JudgmentSnapshot { pid?: number; runId: string; startedAt: string; answers: Record<string, string> }
const snapshotPath = (root: string) => harnessPath(root, 'harness-judgment-snapshot.json');
const rawAnswer = (item: JudgmentItem) => item.raw.match(/^- 답:[^\r\n]*$/mu)?.[0] ?? '';

export async function hasActiveJudgmentSnapshot(root: string): Promise<boolean> {
  const turn = (await readState(root)).brainTurn;
  const snapshot = await readJson<JudgmentSnapshot | null>(snapshotPath(root), null);
  return !!turn && !turn.endedAt && snapshot?.runId === turn.runId;
}
const snapshotSkips = new Set<string>();
async function notifyHeld(root: string, ids: string[]): Promise<void> {
  if (ids.length) await notify(root, { key: 'judgment:held', title: '판단 답 확인', level: 'warning',
    body: '판단 답이 두뇌 턴 중에 바뀌었습니다. 사용자가 쓴 답이면 /judged 로 확인하세요' });
}
const recoveryEnd = (state: Awaited<ReturnType<typeof readState>>) =>
  typeof state.lastEventAt === 'string' ? state.lastEventAt : new Date().toISOString();
export async function beginJudgmentSnapshot(root: string, turn: BrainTurn): Promise<void> {
  await withFileLock(harnessPath(root, 'harness-judgment-apply'), async () => {
    if (await readJson<JudgmentSnapshot | null>(snapshotPath(root), null)) {
      await notifyHeld(root, await settleSnapshot(root, recoveryEnd(await readState(root))));
    }
    const path = await location(root);
    await withFileLock(path, async () => {
      const answers = Object.fromEntries(parseJudgment(await readText(path)).items.map(item => [item.id, rawAnswer(item)]));
      await atomicWrite(snapshotPath(root), JSON.stringify({ pid: process.pid, runId: turn.runId, startedAt: await processStartedAt(process.pid) ?? new Date(Date.now() - process.uptime() * 1000).toISOString(), answers }) + '\n');
      await updateState(root, { brainTurn: turn });
    });
  });
}
// Callers own harness-judgment-apply; never reacquire that non-reentrant lock here.
async function settleSnapshot(root: string, endedAt: string): Promise<string[]> {
  const snapshot = await readJson<JudgmentSnapshot | null>(snapshotPath(root), null);
  const ids: string[] = [];
  if (snapshot) {
    const path = await location(root);
    await withFileLock(path, async () => {
      const changed = parseJudgment(await readText(path)).items.filter(item => !item.followup && item.answer.trim()
        && rawAnswer(item) !== snapshot.answers[item.id]);
      const heldPath = harnessPath(root, 'harness-judgment-held.json');
      await withFileLock(heldPath, async () => {
        let records = await readJson<HeldAnswer[]>(heldPath, []);
        for (const item of changed) {
          if (records.some(record => record.id === item.id && record.answer === item.answer)) continue;
          records = records.filter(record => record.id !== item.id);
          records.push({ id: item.id, answer: item.answer, held: { at: endedAt, reason: 'brain-turn', runId: snapshot.runId } });
          ids.push(item.id);
        }
        if (ids.length) await atomicWrite(heldPath, JSON.stringify(records, null, 2) + '\n');
      });
    });
    if (ids.length) await appendLedger(root, { runId: snapshot.runId, action: 'judgment:held', status: 'skip', evidence: { ids } });
  }
  const turn = (await readState(root)).brainTurn;
  if (turn && !turn.endedAt) await updateState(root, { brainTurn: { ...turn, endedAt } });
  if (snapshot) await unlink(snapshotPath(root));
  return ids;
}

export async function finishJudgmentSnapshot(root: string, endedAt = new Date().toISOString()): Promise<void> {
  const ids = await withFileLock(harnessPath(root, 'harness-judgment-apply'), () => settleSnapshot(root, endedAt));
  await notifyHeld(root, ids);
}
export async function recoverJudgmentSnapshot(root: string): Promise<void> {
  const ids = await withFileLock(harnessPath(root, 'harness-judgment-apply'), async () => {
    const snapshot = await readJson<JudgmentSnapshot | null>(snapshotPath(root), null);
    if (snapshot?.pid === process.pid) {
      const { isTurnInProgress } = await import('../provider/turn.ts');
      if (isTurnInProgress(root)) return [];
    } else if (snapshot?.pid && snapshot.pid > 0) {
      if (await lockOwnerAlive({ pid: snapshot.pid, startedAt: snapshot.startedAt, token: snapshot.runId })) {
        const key = JSON.stringify([resolve(root), snapshot.runId, snapshot.startedAt, snapshot.pid]);
        if (!snapshotSkips.has(key)) {
          await appendLedger(root, { runId: snapshot.runId, action: 'judgment:snapshot-skip', status: 'skip', evidence: { pid: snapshot.pid } });
          snapshotSkips.add(key);
        }
        return [];
      }
    }
    return settleSnapshot(root, recoveryEnd(await readState(root)));
  });
  await notifyHeld(root, ids);
}

function parsedOptions(raw: string): string[] {
  const value = field(raw, '선택지');
  if (value) return optionsOf(value);
  const lines = raw.split('\n'), index = lines.findIndex(line => /^- 선택지:[ \t]*\r?$/u.test(line));
  const options: string[] = [];
  if (index < 0) return options;
  for (const line of lines.slice(index + 1)) {
    if (!/^[ \t]+\S/u.test(line)) break;
    options.push(line.trim().replace(/^(?:[①-⑳]|\d+[.)]|[-*])\s*/u, '').trim());
  }
  return options;
}
function section(text: string, name: string) {
  const heading = new RegExp(`^## ${name}[ \\t]*\\r?\\n`, 'mu').exec(text);
  if (!heading) return undefined;
  const start = heading.index, bodyStart = start + heading[0].length;
  const boundary = text.slice(bodyStart).search(/^#{1,2} /mu);
  const end = boundary < 0 ? text.length : bodyStart + boundary;
  return { start, bodyStart, end, body: text.slice(bodyStart, end) };
}
const short = (value: string, limit: number) => [...oneLine(value)].slice(0, limit).join('') + ([...oneLine(value)].length > limit ? '…' : '');
export function latestCompleted(items: CompletedJudgment[], count: number): CompletedJudgment[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => b.item.date.localeCompare(a.item.date) || b.index - a.index)
    .slice(0, count).map(({ item }) => item);
}
export function renderDerived(text: string, context: { recent: number; completed: CompletedJudgment[] }): string {
  const items = parseJudgment(text).items;
  const overview = items.length ? '| 번호 | 제목 | 막힌 작업 | 추천 |\n|---|---|---|---|\n' + items.map(item =>
    `| ${item.id} | ${tableValue(short(item.title, 40))} | ${tableValue(short(item.blocks, 24))} | ${tableValue(short(item.recommend.split(/ — |—|:/u)[0], 24))} |`).join('\n') : '열린 판단 없음';
  const replaceSection = (name: string, body: string, before?: string) => {
    const current = section(text, name);
    if (current) {
      text = text.slice(0, current.bodyStart) + `\n${body ? body + '\n\n' : ''}` + text.slice(current.end);
      return;
    }
    const at = before ? section(text, before)?.start ?? text.length : text.length;
    text = text.slice(0, at) + `${at && !text.slice(0, at).endsWith('\n\n') ? '\n' : ''}## ${name}\n\n${body ? body + '\n\n' : ''}` + text.slice(at);
  };
  replaceSection('한눈에', overview, '열린 판단');
  const recent = latestCompleted(context.completed, context.recent).map(item =>
    `- ${item.id} · ${item.date} · ${short(item.title ?? item.id, 30)} → 답 "${short(item.answer, 30)}"${item.answerSource === '오토파일럿' ? '(오토)' : ''} · [기록](${item.path})`).join('\n');
  if (context.recent > 0 || section(text, '최근 결정')) replaceSection('최근 결정', recent);
  return text;
}
const kstDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
async function archiveFiles(root: string, archive?: string): Promise<string[]> {
  const dir = resolve(root, archive ?? (await loadConfig(root)).judgment.archive);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => resolve(entry.parentPath, entry.name)).sort();
}
export function parseArchive(text: string, path?: string): CompletedJudgment[] {
  return [...text.matchAll(/^### (A\d+(?:-\d+)?) — (.*?) \(rev (\d+)\)[ \t]*\r?\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gmu)].flatMap(match => {
    const raw = match[4];
    if (!/^- 결정일:/mu.test(raw)) return [];
    return [{ ...(field(raw, '답 출처') ? { answerSource: field(raw, '답 출처') } : {}), id: match[1], title: match[2], rev: Number(match[3]), answer: field(raw, '답'), interpretation: field(raw, '해석'), commit: field(raw, '반영'), date: field(raw, '결정일'), path }];
  });
}
export async function readArchive(root: string): Promise<CompletedJudgment[]> {
  const directory = dirname(await location(root));
  const records: CompletedJudgment[] = [];
  for (const path of await archiveFiles(root)) records.push(...parseArchive(await readText(path), relative(directory, path)));
  return records;
}
async function highestNumber(root: string, text: string, archive?: string): Promise<number> {
  const seq = await readJson<{ last: number }>(harnessPath(root, 'harness-judgment-seq.json'), { last: 0 });
  let last = seq.last;
  for (const body of [text, ...await Promise.all((await archiveFiles(root, archive)).map(path => readText(path)))]) {
    for (const match of body.matchAll(/(?<![A-Za-z0-9_])A(\d+)(?:-\d+)?(?![0-9])/gu)) last = Math.max(last, Number(match[1]));
  }
  return last;
}
const koreanApproval = (text: string) => text.replace(/^- 승인 필수:[ \t]*true[ \t]*$/gmu, '- 승인 필수: 예');
function archiveBlock(item: CompletedJudgment, raw = ''): string {
  const rest = koreanApproval(raw).split('\n').filter(line => !/^### |^- (?:답|답 기준 rev|답 출처|회신):|^<!-- fodh-(?:dedupe|answer):/u.test(line)).join('\n').trim();
  return `### ${item.id} — ${oneLine(item.title ?? item.id)} (rev ${item.rev ?? 1})\n- 결정일: ${oneLine(item.date)}\n- 답: ${oneLine(item.answer)}\n${item.answerSource ? `- 답 출처: ${oneLine(item.answerSource)}\n` : ''}- 해석: ${oneLine(item.interpretation)}\n- 반영: ${oneLine(item.commit)}\n${rest ? rest + '\n' : ''}`;
}
function archiveAppend(text: string, item: CompletedJudgment, sourceFile: string, targetFile: string, raw = ''): string {
  const block = rebaseJudgmentLinks(archiveBlock(item, raw), sourceFile, targetFile);
  const answer = field(block, '답');
  if (parseArchive(text).some(record => record.id === item.id && record.rev === (item.rev ?? 1) && record.answer === answer)) return text;
  return text.trimEnd() + '\n\n' + block;
}
function archivedIdentity(record: CompletedJudgment, item: Pick<CompletedJudgment, 'id' | 'rev' | 'answer'>, sourceFile: string): boolean {
  const answer = record.path ? rebaseJudgmentLinks(oneLine(item.answer), sourceFile, resolve(dirname(sourceFile), record.path)) : oneLine(item.answer);
  return record.id === item.id && record.rev === (item.rev ?? 1) && record.answer === answer;
}
// Caller holds the judgment lock (and apply lock), each archive is changed under its own lock.
async function removeArchivedJudgment(root: string, entry: ApplyJournal, sourceFile: string): Promise<boolean> {
  let removed = false;
  for (const path of await archiveFiles(root)) await withFileLock(path, async () => {
    const original = await readText(path);
    const text = original.replace(/^### A\d+(?:-\d+)? — .*? \(rev \d+\)[ \t]*\r?\n[\s\S]*?(?=^#{1,3} |$(?![\s\S]))/gmu, block => {
      const record = parseArchive(block, relative(dirname(sourceFile), path))[0];
      return record && archivedIdentity(record, entry, sourceFile) ? '' : block;
    });
    if (text !== original) { await atomicWrite(path, text); removed = true; }
  });
  return removed;
}
async function appendArchive(root: string, item: CompletedJudgment, raw = '') {
  const config = await loadConfig(root), month = /^\d{4}-\d{2}-\d{2}$/u.test(item.date) ? item.date.slice(0, 7) : '이전';
  const sourceFile = await location(root);
  const existing = (await readArchive(root)).find(record => archivedIdentity(record, item, sourceFile));
  if (existing?.path) {
    const path = resolve(dirname(await location(root)), existing.path), original = await readText(path);
    return { path, original, text: original };
  }
  const path = resolve(root, config.judgment.archive, `${month}.md`);
  return withFileLock(path, async () => {
    const original = await readText(path), text = archiveAppend(original || `# 판단기록 ${month}\n`, item, sourceFile, path, raw);
    if (text !== original) await atomicWrite(path, text);
    return { path, original, text };
  });
}
// Keep the old parser/hash contract; uncertain inline markers require a human.
function ambiguousInlineOptions(item: JudgmentItem): boolean {
  const value = field(item.raw, '선택지');
  if (!value) return false;
  const markers = [...value.matchAll(/[①-⑳]|\d+[.)]/gu)];
  if (!markers.length) return false; // Unnumbered pipe-separated options are unambiguous.
  return markers.some((match, index) => {
    const at = match.index!;
    const number = circled.includes(match[0]) ? circled.indexOf(match[0]) + 1 : Number.parseInt(match[0], 10);
    return number !== index + 1 || at > 0 && !/\s/u.test(value[at - 1]) || index === 0 && at !== 0;
  });
}
function migrateItem(item: JudgmentItem): string {
  const lines = koreanApproval(item.raw).split('\n'), known = /^(?:### |^- (?:배경|선택지|추천|막힌 작업|자세히|답|답 기준 rev|답 출처|적용 정책|승인 필수|재질문 원본|후속 질문|회신):|<!-- fodh-(?:dedupe|answer):)/u;
  let optionContinuation = false;
  const unknown = lines.filter(line => {
    if (/^- 선택지:[ \t]*$/u.test(line)) { optionContinuation = true; return false; }
    if (optionContinuation && /^[ \t]+\S/u.test(line)) return false;
    optionContinuation = false;
    return !known.test(line);
  }).join('\n').replace(/^\n+|\n+$/gu, '');
  const ordered = [
    `### ${item.id} — ${item.title} (rev ${item.rev})`,
    ...['배경'].map(key => lines.find(line => line.startsWith(`- ${key}:`)) ?? `- ${key}:`),
    ...(ambiguousInlineOptions(item) ? lines.filter(line => line.startsWith('- 선택지:'))
      : ['- 선택지:', ...item.options.map((option, index) => `  ${circled[index] ?? `${index + 1}.`} ${option}`)]),
    ...['추천', '막힌 작업', '자세히', '답', '답 기준 rev', '답 출처', '적용 정책', '승인 필수', '재질문 원본', '후속 질문']
      .flatMap(key => lines.filter(line => line.startsWith(`- ${key}:`))),
    ...lines.filter(line => line.startsWith('<!-- fodh-answer:')),
    ...lines.filter(line => line.startsWith('<!-- fodh-dedupe:')),
  ];
  return ordered.join('\n') + '\n' + (unknown ? unknown + '\n' : '') + '\n';
}
export async function migrateJudgment(root: string, options: { dryRun?: boolean } = {}) {
  await assertNotBrain(root, 'judgment migrate');
  return withFileLock(harnessPath(root, 'harness-judgment-apply'), async () => {
    if (await hasActiveJudgmentSnapshot(root)) throw new Error('두뇌 턴의 활성 판단 스냅샷이 있어 migrate 할 수 없습니다');
    if ((await readJson<ApplyJournal[]>(harnessPath(root, 'harness-judgment-apply.json'), [])).length) throw new Error('판단 적용 저널이 비어 있지 않아 migrate 할 수 없습니다');
    const config = await loadConfig(root, undefined, { dryRun: true }), path = resolve(root, config.judgment.file);
    return withFileLock(path, async () => {
      const original = await readText(path), before = parseJudgment(original, { migrate: true });
      let text = original || initial;
      for (const item of [...before.items].reverse()) text = text.slice(0, item.start) + migrateItem(item) + text.slice(item.end);
      const after = parseJudgment(text).items;
      if (before.items.some((item, i) => questionHash(item) !== questionHash(after[i]) || rawAnswer(item) !== rawAnswer(after[i]))) throw new Error('migrate 전후 질문 해시 또는 답 줄이 다릅니다');
      const writes = new Map<string, string>();
      const originals = new Map<string, string>();
      const get = async (file: string) => {
        if (!originals.has(file)) originals.set(file, await readText(file));
        return writes.get(file) ?? originals.get(file)!;
      };
      const legacy = resolve(root, config.judgment.archive, '이전.md');
      let rows = 0, paragraphs = 0;
      const preserve = async (name: string, body: string) => {
        if (!body.trim()) return;
        const existing = await get(legacy), block = `## ${kstDate()} 이관 전 ${name}\n${rebaseJudgmentLinks(body, path, legacy)}`;
        if (!existing.includes(block)) writes.set(legacy, (existing || '# 판단기록 이전\n').trimEnd() + '\n\n' + block);
        paragraphs += body.trim().split(/\n[ \t]*\n/u).length;
      };
      const completed = section(text, '결정 완료');
      if (completed) {
        const lines = completed.body.split('\n');
        let standard = false;
        const leftover: string[] = [];
        for (const line of lines) {
          if (line.trim().startsWith('|') && cells(line)[0] === '번호') {
            standard = cells(line).join('|') === '번호|rev|답(원문)|해석|반영 커밋|날짜';
            if (standard) continue;
          }
          if (standard && /^\|[\s|:-]+\|\s*$/u.test(line)) continue;
          if (standard && /^A\d+(?:-\d+)?$/u.test(cells(line)[0] ?? '') && line.trim().startsWith('|')) {
            const [id, rev, answer, interpretation, commit, date] = cells(line);
            const month = /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date.slice(0, 7) : '이전';
            const file = resolve(root, config.judgment.archive, `${month}.md`);
            writes.set(file, archiveAppend(await get(file) || `# 판단기록 ${month}\n`, { id, rev: Number(rev) || 1, answer, interpretation, commit, date }, path, file));
            rows++; continue;
          }
          if (line.trim() && !line.trim().startsWith('|')) standard = false;
          leftover.push(line);
        }
        await preserve('결정 완료', leftover.join('\n'));
        text = text.slice(0, completed.start) + text.slice(completed.end);
      }
      const status = section(text, '지금 상태');
      if (status) {
        const match = /^(\s*\S[\s\S]*?)(\r?\n[ \t]*\r?\n)([\s\S]*)$/u.exec(status.body);
        if (match?.[3].trim()) {
          await preserve('지금 상태 이력', match[3]);
          text = text.slice(0, status.bodyStart) + match[1] + '\n\n' + text.slice(status.end);
        }
      }
      const header = preamble(relative(dirname(path), resolve(root, config.judgment.archive)));
      text = text.replace(/^편집기는 외부 변경 자동 새로고침을 켜 둘 것\.\r?\n\n?/mu, '');
      if (!text.includes(header)) text = text.replace(/^(#[^\n]*\n)/u, (_, title: string) => `${title}\n${header}\n`);
      const records: CompletedJudgment[] = [];
      const allFiles = new Set([...await archiveFiles(root, config.judgment.archive), ...writes.keys()]);
      for (const file of [...allFiles].sort()) {
        const original = await get(file), normalized = koreanApproval(original);
        if (normalized !== original) writes.set(file, normalized);
        records.push(...parseArchive(normalized, relative(dirname(path), file)));
      }
      text = renderDerived(text, { recent: config.judgment.recent, completed: records });
      const changedArchives = [...writes].filter(([file, value]) => value !== originals.get(file));
      const last = await highestNumber(root, original, config.judgment.archive);
      const seqPath = harnessPath(root, 'harness-judgment-seq.json'), seqText = JSON.stringify({ last }) + '\n';
      const seqChanged = await readText(seqPath) !== seqText;
      const files = [...changedArchives.map(([file]) => relative(root, file)),
        ...(text !== original ? [relative(root, path), '.pi/harness-watcher.json'] : []),
        ...(seqChanged ? ['.pi/harness-judgment-seq.json'] : [])];
      const warnings = before.items.filter(ambiguousInlineOptions).map(item => `선택지 수동 확인 필요: ${item.id}`);
      const result = { changed: files.length > 0, files, rows, paragraphs, bytes: Buffer.byteLength(text), warnings };
      if (options.dryRun || !result.changed) return result;
      // Preserve the pre-migration high-water mark, including unstructured legacy IDs.
      for (const [file, value] of changedArchives) await withFileLock(file, async () => {
        if (await readText(file) !== originals.get(file)) throw new JudgmentConflict();
        await atomicWrite(file, value);
      });
      if (text !== original) await save(root, path, text, original);
      if (seqChanged) await atomicWrite(seqPath, seqText);
      return result;
    });
  });
}
export async function warnLegacyJudgment(root: string): Promise<void> {
  const text = await readText(await location(root));
  const items = parseJudgment(text, { migrate: true }).items;
  if (section(text, '결정 완료')?.body.trim() || items.some(item => !/\(rev\s+\d+\)\s*$/u.test(item.raw.split('\n')[0]) || field(item.raw, '선택지'))) await notify(root, {
    key: 'judgment:legacy-format', level: 'warning', title: '옛 판단 파일 형식', body: '사용자 터미널에서 fodh judgment migrate',
  });
}
