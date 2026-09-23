import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { readState, updateState } from './state.ts';
import { listBacklog, setTask } from './backlog.ts';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';

export interface JudgmentItem {
  id: string; title: string; rev: number; background: string; options: string[]; recommend: string;
  blocks: string; answer: string; answerRev?: number; classification?: AnswerClassification;
  requiresApproval?: boolean; reaskOf?: string; followup?: string; dedupeKey?: string; raw: string; start: number; end: number;
}
export interface CompletedJudgment { id: string; rev?: number; answer: string; interpretation: string; commit: string; date: string }
export interface JudgmentDocument { items: JudgmentItem[]; completed: CompletedJudgment[] }
export interface JudgmentInput {
  title: string; background: string; options: string | string[]; recommend: string;
  blocks: string | string[]; dedupeKey?: string; requiresApproval?: boolean; reaskOf?: string;
}
export interface AnswerClassification {
  kind: 'choice' | 'conditional' | 'freeform' | 'ambiguous' | 'revision-mismatch' | 'empty';
  applicable: boolean; selection?: number; interpretation?: string; condition?: string; reason?: string;
}

const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const initial = '# 판단대기\n\n## 지금 상태\n\n대기 중\n\n## 열린 판단\n\n## 결정 완료\n\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n';
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
  // 번호 사이 공백·접속사 유무와 관계없이 복수 선택은 재질문한다.
  // 단, "2, 단 1회만" 같은 조건의 수량은 선택 번호로 세지 않는다.
  const references = [...answer.matchAll(/\d+|[①-⑳]/gu)].filter(match => {
    if (circled.includes(match[0])) return true;
    const suffix = answer.slice(match.index! + match[0].length);
    return !/^\s*(?:회|분|초|시간|일|월|년|개|명|%)(?=$|\s|[,.;]|만|까지|이내|후|내|동안|마다)/u.test(suffix);
  });
  if (references.length > 1) return { kind: 'ambiguous', applicable: false, reason: '선택 번호가 여러 개입니다' };
  if (/모두|제외|전부/u.test(answer) && references.length === 0
    && /선택|항목|옵션|둘|다|모두|전부/u.test(answer)) {
    return { kind: 'ambiguous', applicable: false, reason: '다중 선택 문맥입니다' };
  }
  const normalized = [...answer].map(value => circled.includes(value) ? String(circled.indexOf(value) + 1) : value).join('');
  if (/^\d+\s*(?:[,/]|또는|혹은|및|와|과|하고|\s)\s*\d+(?:\D|$)/u.test(normalized)) {
    return { kind: 'ambiguous', applicable: false, reason: '선택 번호가 여러 개입니다' };
  }
  const match = normalized.match(/^(\d+)(?=$|[\s,.，:.)]|번)(?:번)?[.)]?\s*(.*)$/u);
  if (match) {
    const selection = Number(match[1]);
    if (selection < 1 || selection > options.length) return { kind: 'ambiguous', applicable: false, reason: '선택지 범위를 벗어났습니다' };
    const condition = match[2]!.replace(/^[,，:]\s*/u, '').trim();
    const interpretation = options[selection - 1]!;
    return condition
      ? { kind: 'conditional', applicable: true, selection, condition, interpretation: `${interpretation}; 조건: ${condition}` }
      : { kind: 'choice', applicable: true, selection, interpretation };
  }
  const approved = /(?:^|[\s,.:;])(승인|진행)(?=$|[\s,.:;])/u.test(answer);
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
export async function readJudgment(root: string, options: { answered?: boolean } = {}): Promise<JudgmentDocument & {
  expectedHash: string;
}> {
  const config = await loadConfig(root);
  const path = await location(root);
  return withFileLock(path, async () => {
    const original = await readText(path, initial);
    const text = await reconcileEdits(root, path, original);
    const expectedHash = await save(root, path, text);
    const document = parseJudgment(text);
    return { ...document, items: document.items.filter(item => !options.answered || item.answer.trim()).map(item => ({
      ...item, ...(options.answered ? { classification: classifyAnswer(item.answer, item.options, item.rev, item.answerRev, approvalRequired(item, config.requiresApproval)) } : {}),
    })), expectedHash };
  });
}

async function save(root: string, path: string, text: string): Promise<string> {
  const expectedHash = hash(text);
  const watcherPath = harnessPath(root, 'harness-watcher.json');
  // 기대 해시를 먼저 영속화해 문서 rename 직후의 워처 이벤트도 억제한다.
  await withFileLock(watcherPath, async () => {
    const watcher = await readJson<Record<string, unknown>>(watcherPath, {});
    await atomicWrite(watcherPath, JSON.stringify({ ...watcher, judgment: { path, expectedHash, questions: Object.fromEntries(
      parseJudgment(text).items.map(item => [item.id, { hash: questionHash(item), rev: item.rev }]),
    ), savedAt: new Date().toISOString() } }, null, 2) + '\n');
    await atomicWrite(path, text);
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
  return withFileLock(path, async () => {
    let text = await reconcileEdits(root, path, await readText(path, initial));
    const document = parseJudgment(text);
    const dedupeKey = input.dedupeKey ? hash(input.dedupeKey) : undefined;
    const found = dedupeKey && document.items.find(item => item.dedupeKey === dedupeKey);
    if (found) return { item: found, expectedHash: await save(root, path, text) };
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
      `${input.requiresApproval ? '- 승인 필수: true\n' : ''}${input.reaskOf ? `- 재질문 원본: ${oneLine(input.reaskOf)}\n` : ''}`,
      `${dedupeKey ? `<!-- fodh-dedupe: ${dedupeKey} -->\n` : ''}\n`,
    ].join('');
    if (!/^## 열린 판단\s*$/mu.test(text)) text += '\n## 열린 판단\n\n';
    const open = /^## 열린 판단\s*$/mu.exec(text)!;
    const afterOpen = open.index + open[0].length;
    const nextHeading = text.slice(afterOpen).search(/^## /mu);
    const at = nextHeading < 0 ? text.length : afterOpen + nextHeading;
    text = text.slice(0, at).trimEnd() + '\n\n' + section + text.slice(at);
    const expectedHash = await save(root, path, text);
    return { item: requireItem(text, id), expectedHash };
  });
}

export async function answerJudgment(root: string, id: string, answer: string): Promise<{ item: JudgmentItem; expectedHash: string }> {
  if (/[\r\n]/u.test(answer)) throw new Error('답은 한 줄로 입력해야 합니다');
  const path = await location(root);
  return withFileLock(path, async () => {
    let text = await reconcileEdits(root, path, await readText(path, initial));
    const item = requireItem(text, id);
    let replacement = item.raw.replace(/^- 답:[^\r\n]*$/mu, () => `- 답: ${answer}`);
    replacement = replacement.replace(/^- 답 기준 rev:[^\r\n]*\n?/mu, '');
    replacement = replacement.trimEnd() + `\n- 답 기준 rev: ${item.rev}\n\n`;
    text = text.slice(0, item.start) + replacement + text.slice(item.end);
    return { item: requireItem(text, id), expectedHash: await save(root, path, text) };
  });
}

export async function writeJudgmentStatus(root: string, status: string): Promise<{ expectedHash: string }> {
  const path = await location(root);
  return withFileLock(path, async () => {
    let text = await reconcileEdits(root, path, await readText(path, initial));
    if (!/^## 지금 상태\s*$/mu.test(text)) text = `## 지금 상태\n\n${text}`;
    const heading = /^## 지금 상태[^\r\n]*\r?\n/mu.exec(text)!;
    const start = heading.index + heading[0].length;
    const boundary = text.slice(start).search(/^## /mu);
    const end = boundary < 0 ? text.length : start + boundary;
    text = text.slice(0, start) + `\n${oneLine(status)}\n\n` + text.slice(end);
    return { expectedHash: await save(root, path, text) };
  });
}

const tableValue = (value: string): string => value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
export async function completeJudgment(
  root: string, id: string,
  input: { interpretation: string; commit: string; answerRev?: number; requiresApproval?: boolean; expectedRaw?: string },
): Promise<{ expectedHash: string; completed: CompletedJudgment }> {
  const path = await location(root);
  return withFileLock(path, async () => {
    let text = await reconcileEdits(root, path, await readText(path, initial));
    const item = requireItem(text, id);
    if (input.expectedRaw !== undefined && input.expectedRaw !== item.raw) throw new Error('판단 내용이 변경되었습니다. 다시 읽어 주세요');
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
    text = text.slice(0, item.start) + text.slice(item.end);
    if (!/^## 결정 완료\s*$/mu.test(text)) text += '\n## 결정 완료\n';
    // 구형 완료 표도 보존하고 현재 규격 표를 별도로 덧붙인다.
    if (!text.includes('| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |')) {
      text += '\n| 번호 | rev | 답(원문) | 해석 | 반영 커밋 | 날짜 |\n|---|---|---|---|---|---|\n';
    }
    text = text.trimEnd() + `\n| ${[
      id, String(item.rev), item.answer, input.interpretation, input.commit, completed.date,
    ].map(tableValue).join(' | ')} |\n`;
    return { expectedHash: await save(root, path, text), completed };
  });
}

function approvalRequired(item: JudgmentItem, configured: string[] = []): boolean {
  const text = `${item.title} ${item.background} ${item.options.join(' ')}`;
  return item.requiresApproval === true || configured.some(name => text.includes(name))
    || /승인|훅.*거부|프로덕션|운영.*배포|결제|스토어|심사|push|환경변수|비밀값|외부.*발송|약관|개인정보|DNS|키체인/iu.test(text);
}
interface ApplyEntry { id: string; interpretation: string }
interface ApplyJournal { id: string; rev: number; answer: string; interpretation: string; releases: string[] }
async function markFollowup(root: string, original: JudgmentItem, followup: string): Promise<void> {
  const path = await location(root);
  await withFileLock(path, async () => {
    const text = await reconcileEdits(root, path, await readText(path, initial));
    const current = requireItem(text, original.id);
    if (current.raw !== original.raw) throw new Error('판단 내용이 변경되었습니다. 다시 읽어 주세요');
    const raw = current.raw.trimEnd() + `\n- 후속 질문: ${followup}\n\n`;
    await save(root, path, text.slice(0, current.start) + raw + text.slice(current.end));
  });
}
export async function applyJudgments(root: string, ids?: string[]): Promise<{
  applied: ApplyEntry[]; unapplied: { id: string; reason: string }[];
}> {
  return withFileLock(harnessPath(root, 'harness-judgment-apply'), async () => {
    const applied: ApplyEntry[] = [], unapplied: { id: string; reason: string }[] = [];
    const journalPath = harnessPath(root, 'harness-judgment-apply.json');
    let journal = await readJson<ApplyJournal[]>(journalPath, []);
    const persist = () => atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
    const finish = async (entry: ApplyJournal) => {
      const document = await readJudgment(root);
      if (!document.completed.some(item => item.id === entry.id && item.rev === entry.rev && item.answer === entry.answer)) return;
      for (const task of await listBacklog(root)) {
        if (!entry.releases.some(id => task.status === `blocked(${id})`)) continue;
        const other = document.items.find(item => !item.followup && !entry.releases.includes(item.id)
          && item.blocks.split(/[,\s]+/u).includes(task.id));
        await setTask(root, task.id, { status: other ? `blocked(${other.id})` : 'ready', judgment: other?.id ?? '',
          notes: [task.notes, `${entry.id}: ${entry.interpretation}`].filter(Boolean).join('\n') });
      }
      const state = await readState(root);
      if (typeof state.pickJudgment === 'string' && entry.releases.includes(state.pickJudgment)) {
        await updateState(root, { retry: { count: 0 }, lastPaused: undefined, pickJudgment: undefined });
      }
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
      if (item.followup) { unapplied.push({ id: item.id, reason: `후속 질문 ${item.followup}의 답을 기다립니다` }); continue; }
      const requiresApproval = approvalRequired(item, config.requiresApproval);
      const classification = classifyAnswer(item.answer, item.options, item.rev, item.answerRev, requiresApproval);
      if (!classification.applicable) {
        const reason = classification.reason ?? '미답';
        unapplied.push({ id: item.id, reason });
        if (classification.kind === 'empty') continue;
        const next = await addJudgment(root, { title: `${item.id} 재질문: ${item.title}`, background: `${reason}. 이전 답: ${item.answer}`,
          options: item.options, recommend: item.recommend, blocks: item.blocks, requiresApproval,
          reaskOf: item.reaskOf ?? item.id, dedupeKey: `reask:${item.id}:${item.rev}:${hash(item.answer)}` });
        await markFollowup(root, item, next.item.id);
        continue;
      }
      const interpretation = classification.interpretation ?? `사용자 지시: ${item.answer}`;
      const entry: ApplyJournal = { id: item.id, rev: item.rev, answer: item.answer, interpretation,
        releases: [item.id, ...(item.reaskOf ? [item.reaskOf] : [])] };
      journal = [...journal.filter(record => record.id !== item.id), entry]; await persist();
      await completeJudgment(root, item.id, { interpretation, commit: '판단 적용; 코드 커밋 없음', requiresApproval, expectedRaw: item.raw });
      await finish(entry);
    }
    return { applied, unapplied };
  });
}
