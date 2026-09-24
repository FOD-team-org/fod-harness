import { unlink } from 'node:fs/promises';
import { notify } from './notify.ts';
import { assertNotBrain } from './brain-guard.ts';
import { appendLedger } from './ledger.ts';
import type { BrainTurn } from './state.ts';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { readState, updateState, transitionState } from './state.ts';
import { listBacklog, setTask } from './backlog.ts';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';

export interface JudgmentItem {
  id: string; title: string; rev: number; background: string; options: string[]; recommend: string;
  held?: { at: string; reason: 'brain-turn'; runId: string };
  blocks: string; answer: string; answerRev?: number; classification?: AnswerClassification;
  resolution?: 'resume' | 'cleanup'; requiresApproval?: boolean; reaskOf?: string; followup?: string; dedupeKey?: string; raw: string; start: number; end: number;
}
export interface CompletedJudgment { id: string; rev?: number; answer: string; interpretation: string; commit: string; date: string }
export interface JudgmentDocument { items: JudgmentItem[]; completed: CompletedJudgment[] }
export interface JudgmentInput {
  title: string; background: string; options: string | string[]; recommend: string;
  blocks: string | string[]; dedupeKey?: string; resolution?: 'resume' | 'cleanup'; requiresApproval?: boolean; reaskOf?: string;
}
export interface AnswerClassification {
  kind: 'choice' | 'conditional' | 'freeform' | 'ambiguous' | 'revision-mismatch' | 'empty';
  applicable: boolean; selection?: number; interpretation?: string; condition?: string; reason?: string;
}

const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const initial = '# 판단대기\n\n편집기는 외부 변경 자동 새로고침을 켜 둘 것.\n\n## 지금 상태\n\n대기 중\n\n## 열린 판단\n\n## 결정 완료\n\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n';
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

export function parseJudgment(text: string): JudgmentDocument {
  const items: JudgmentItem[] = [];
  const headings = [...text.matchAll(/^###\s+(A\d+(?:-\d+)?)\s*[—–-]\s*(.*?)\s*\(rev\s+(\d+)\)\s*$/gmu)];
  const open = /^## 열린 판단[ \t]*\r?$/mu.exec(text);
  const openStart = open ? open.index + open[0].length : -1;
  const nextSection = open ? text.slice(openStart).search(/^#{1,2}[ \t]/mu) : -1;
  const openEnd = nextSection < 0 ? text.length : openStart + nextSection;
  const completedStart = text.search(/^## 결정 완료\s*$/mu);
  for (const heading of headings) {
    const start = heading.index!;
    if (openStart < 0 || start < openStart || start >= openEnd) continue;
    const tail = text.slice(start + heading[0].length);
    const boundary = tail.search(/^#{1,3}\s/mu);
    const end = boundary < 0 ? text.length : start + heading[0].length + boundary;
    const raw = text.slice(start, end);
    const answerRev = field(raw, '답 기준 rev');
    items.push({
      id: heading[1]!, title: heading[2]!, rev: Number(heading[3]), background: field(raw, '배경'),
      options: optionsOf(field(raw, '선택지')), recommend: field(raw, '추천'), blocks: field(raw, '막힌 작업'),
      answer: field(raw, '답'), requiresApproval: field(raw, '승인 필수') === 'true',
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

export function classifyAnswer(text: string, options: string[], rev = 1, answerRev = rev, requiresApproval = false): AnswerClassification {
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
  const numbers = [...answer.matchAll(/(?<![A-Za-z0-9_])(?<!\d\.)(10|[1-9])(?![A-Za-z0-9_]|\.\d)(?=$|[\s\p{P}]|번|과|와|또는|혹은|이나|은|는|을|를|으로|로|하고|및)/gu)];
  if (circles.length + numbers.length > 1) {
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

async function location(root: string): Promise<string> { return resolve(root, (await loadConfig(root)).judgment.file); }
function questionHash(item: JudgmentItem): string {
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
export async function readJudgment(root: string, options: { answered?: boolean } = {}): Promise<JudgmentDocument & {
  expectedHash: string;
}> {
  const config = await loadConfig(root);
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    const text = await reconcileEdits(root, path, original || initial);
    const expectedHash = text === original ? hash(text) : await save(root, path, text, original);
    const document = parseJudgment(text);
    const held = await readJson<HeldAnswer[]>(harnessPath(root, 'harness-judgment-held.json'), []);
    for (const item of document.items) item.held = held.find(record => record.id === item.id && record.answer === item.answer)?.held;
    if (text === original) await rememberQuestions(root, document.items);
    return { ...document, items: document.items.filter(item => !options.answered || item.answer.trim()).map(item => ({
      ...item, ...(options.answered ? { classification: classifyAnswer(item.answer, item.options, item.rev, item.answerRev, approvalRequired(item, config.requiresApproval)) } : {}),
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

export async function addJudgment(root: string, input: JudgmentInput): Promise<{ item: JudgmentItem; expectedHash: string }> {
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const document = parseJudgment(text);
    const dedupeKey = input.dedupeKey ? hash(input.dedupeKey) : undefined;
    const found = dedupeKey && document.items.find(item => item.dedupeKey === dedupeKey);
    if (found) return { item: found, expectedHash: await save(root, path, text, original) };
    if (!input.title.trim()) throw new Error('판단 제목이 필요합니다');
    const numbers = [...text.matchAll(/\bA(\d+)(?:-\d+)?\b/gu)].map(match => Number(match[1]));
    const id = `A${Math.max(0, ...numbers) + 1}`;
    const options = typeof input.options === 'string' ? optionsOf(input.options) : input.options;
    if (!options.length) throw new Error('판단 선택지가 필요합니다');
    const section = [
      `### ${id} — ${oneLine(input.title)} (rev 1)\n- 배경: ${oneLine(input.background)}\n`,
      `- 선택지: ${options.map((option, index) => `${circled[index] ?? `${index + 1}.`} ${oneLine(option)}`).join(' ')}\n`,
      `- 추천: ${oneLine(input.recommend)}\n`,
      `- 막힌 작업: ${oneLine(Array.isArray(input.blocks) ? input.blocks.join(', ') : input.blocks)}\n`,
      '- 회신: 번호 하나 또는 자유 서술. 승인이 필요한 동작이면 번호 또는 승인/진행 토큰을 포함.\n- 답:\n',
      `${input.resolution ? `- 적용 정책: ${input.resolution}\n` : ''}`,
      `${input.requiresApproval ? '- 승인 필수: true\n' : ''}${input.reaskOf ? `- 재질문 원본: ${oneLine(input.reaskOf)}\n` : ''}`,
      `${dedupeKey ? `<!-- fodh-dedupe: ${dedupeKey} -->\n` : ''}\n`,
    ].join('');
    if (!/^## 열린 판단\s*$/mu.test(text)) text += '\n## 열린 판단\n\n';
    const open = /^## 열린 판단\s*$/mu.exec(text)!;
    const afterOpen = open.index + open[0].length;
    const nextHeading = text.slice(afterOpen).search(/^## /mu);
    const at = nextHeading < 0 ? text.length : afterOpen + nextHeading;
    text = text.slice(0, at).trimEnd() + '\n\n' + section + text.slice(at);
    const expectedHash = await save(root, path, text, original);
    return { item: requireItem(text, id), expectedHash };
  }));
}

export async function answerJudgment(root: string, id: string, answer: string): Promise<{ item: JudgmentItem; expectedHash: string }> {
  await assertNotBrain(root, '판단 답변');
  if (/[\r\n]/u.test(answer)) throw new Error('답은 한 줄로 입력해야 합니다');
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    const item = requireItem(text, id);
    let replacement = item.raw.replace(/^- 답:[^\r\n]*$/mu, () => `- 답: ${answer}`);
    replacement = replacement.replace(/^- 답 기준 rev:[^\r\n]*\n?/mu, '');
    replacement = replacement.trimEnd() + `\n- 답 기준 rev: ${item.rev}\n\n`;
    text = text.slice(0, item.start) + replacement + text.slice(item.end);
    return { item: requireItem(text, id), expectedHash: await save(root, path, text, original) };
  }));
}

export async function writeJudgmentStatus(root: string, status: string): Promise<{ expectedHash: string }> {
  const path = await location(root);
  return retryJudgment(() => withFileLock(path, async () => {
    const original = await readText(path);
    let text = await reconcileEdits(root, path, original || initial);
    if (!/^## 지금 상태\s*$/mu.test(text)) text = `## 지금 상태\n\n${text}`;
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
    const classification = classifyAnswer(
      item.answer, item.options, item.rev, input.answerRev ?? item.answerRev ?? item.rev, input.requiresApproval ?? approvalRequired(item),
    );
    if (!classification.applicable) throw new Error('적용할 수 없는 답입니다');
    if (!input.interpretation.trim() || !input.commit.trim()) throw new Error('해석과 반영 커밋이 필요합니다');
    const completed: CompletedJudgment = {
      id, rev: item.rev, answer: item.answer, interpretation: input.interpretation, commit: input.commit,
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()),
    };
    const chain = input.resolveChain ? relatedChain(parseJudgment(text).items, item) : [item];
    for (const member of [...chain].sort((a, b) => b.start - a.start)) text = text.slice(0, member.start) + text.slice(member.end);
    if (!/^## 결정 완료\s*$/mu.test(text)) text += '\n## 결정 완료\n';
    // 구형 완료 표도 보존하고 현재 규격 표를 별도로 덧붙인다.
    if (!text.includes('| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |')) {
      text += '\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n';
    }
    for (const member of chain) text = text.trimEnd() + `\n| ${[
      member.id, String(member.rev), member.id === id ? item.answer : `모호: ${member.answer} → ${id}: ${item.answer}`,
      input.interpretation, input.commit, completed.date,
    ].map(tableValue).join(' | ')} |\n`;
    return { expectedHash: await save(root, path, text, original), completed };
  });
}

function approvalRequired(item: JudgmentItem, configured: string[] = []): boolean {
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
      const document = await readJudgment(root);
      if (!document.completed.some(item => item.id === entry.id && item.rev === entry.rev && item.answer === entry.answer)) return;
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
      const classification = classifyAnswer(item.answer, item.options, item.rev, item.answerRev, requiresApproval);
      if (!classification.applicable) {
        const reason = classification.reason ?? '미답';
        unapplied.push({ id: item.id, reason });
        if (classification.kind === 'empty') continue;
        const next = await addJudgment(root, { title: `${item.id} 재질문: ${item.title}`, background: `${reason}. 이전 답: ${item.answer}`,
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
      await atomicWrite(snapshotPath(root), JSON.stringify({ pid: process.pid, runId: turn.runId, startedAt: turn.startedAt, answers }) + '\n');
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
      let alive = false;
      try { process.kill(snapshot.pid, 0); alive = true; } catch { /* No live owner confirmed. */ }
      if (alive) {
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
