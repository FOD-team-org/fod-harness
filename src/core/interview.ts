import { redact } from '../provider/privacy.ts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, getConfig } from './config.ts';
import { readState } from './state.ts';
import { addJudgment, parseJudgment, readArchive } from './judgment.ts';
import { appendLedger } from './ledger.ts';
import { atomicWrite, harnessPath, readJson, readText, withFileLock } from './storage.ts';
import { projectPath, todayKst } from './template-values.ts';

export const interviewAreas = ['문제·목적', '사용자·시나리오', '범위·MVP', '플랫폼', '스택·기존 자산', '데이터·개인정보', '인증', '결제·광고', '인프라·비용', '외부 API', '디자인·브랜드', '일정', '지표', '비기능', '운영', '법무·심사', '팀 규칙', '리스크·가정'];
export interface Question { id: string; area: string; must: boolean; kind: 'free' | 'choice'; text: string; options?: string[]; recommend: string }
export interface Answer { status: 'open' | 'asked' | 'answered' | 'judgment' | 'skipped'; answer?: string; source?: string; judgmentId?: string; askCount: number; round?: number }
export interface Interview { startedAt: string; docFile: string; round: number; questions: Record<string, Answer>; added: Question[]; openRound?: { round: number; ids: string[]; processed?: boolean } }
export function parseBank(text: string, file = 'bank.md'): Question[] {
  let area = ''; const questions: Question[] = [], seenAreas = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || /^# [^#]/u.test(line)) continue;
    const fail = (): never => { throw new Error(`인터뷰 은행 형식 오류: ${file}:${index + 1}`); };
    const heading = /^## (\d{2}) (.+)$/u.exec(line);
    if (heading) {
      area = heading[1];
      if (interviewAreas[Number(area) - 1] !== heading[2] || seenAreas.has(area)) fail();
      seenAreas.add(area); continue;
    }
    const q = /^- \[(필수|선택)\] (Q(\d{2})-\d{2}) \| (free|choice: .+) \| ([^|]+) \| 추천: ([^|]+)$/u.exec(line);
    if (!q || !area || q[3] !== area || questions.some(v => v.id === q[2])) fail();
    const match = q!;
    const options = match[4].startsWith('choice: ') ? match[4].slice(8).split('/').map(v => v.trim()) : undefined;
    if (options && (options.length < 2 || options.some(v => !v))) fail();
    if (!match[5].trim() || !match[6].trim()) fail();
    for (const token of match[6].matchAll(/\{\{(.*?)\}\}/gu)) if (!/^config:[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u.test(token[1])) fail();
    questions.push({ id: match[2], area, must: match[1] === '필수', kind: options ? 'choice' : 'free', text: match[5].trim(), recommend: match[6].trim(), ...(options ? { options } : {}) });
  }
  return questions;
}
export async function readInterview(root: string): Promise<Interview | undefined> { return readJson(harnessPath(root, 'harness-interview.json'), undefined); }
export async function loadBank(root: string, interview?: Interview): Promise<Question[]> {
  const config = await loadConfig(root), file = new URL('../../templates/interview/bank.md', import.meta.url);
  const base = parseBank(await readFile(file, 'utf8'), file.pathname);
  const extraPath = await projectPath(root, config.interview.extraBankFile);
  const extra = parseBank(await readText(extraPath), extraPath);
  const merged = new Map(base.map(q => [q.id, q]));
  for (const q of [...extra, ...(interview?.added ?? [])]) merged.set(q.id, q);
  return [...merged.values()].sort((a, b) => a.area.localeCompare(b.area) || a.id.localeCompare(b.id));
}
const pending = (a?: Answer) => !a || a.status === 'open' || a.status === 'asked';
async function view(root: string, data?: Interview) {
  const config = await loadConfig(root), bank = await loadBank(root, data);
  const completed = [...parseJudgment(await readText(await projectPath(root, config.judgment.file))).completed, ...await readArchive(root)];
  const questions = Object.fromEntries(bank.map(q => {
    const answer = data?.questions[q.id] ?? { status: 'open' as const, askCount: 0 };
    const decision = answer.status === 'judgment' && completed.find(c => c.id === answer.judgmentId);
    if (q.must && answer.status === 'skipped' || decision && q.kind === 'free' && /^(?:2[.)]?|②|직접 답하기)$/u.test(decision.answer.trim())) {
      return [q.id, { status: 'open' as const, askCount: 0 }];
    }
    return [q.id, decision ? { ...answer, status: 'answered' as const,
      answer: q.kind === 'choice' ? decision.interpretation || decision.answer : decision.answer,
      source: `judgment:${decision.id}` } : answer];
  }));
  const byArea = interviewAreas.map((_, index) => {
    const area = String(index + 1).padStart(2, '0'), qs = bank.filter(q => q.area === area);
    return { area, mustTotal: qs.filter(q => q.must).length,
      mustDone: qs.filter(q => q.must && ['answered', 'judgment'].includes(questions[q.id].status)).length,
      optionalDone: qs.filter(q => !q.must && !pending(questions[q.id])).length,
      open: qs.filter(q => pending(questions[q.id])).map(q => q.id) };
  });
  const remainingMust = byArea.reduce((sum, a) => sum + a.mustTotal - a.mustDone, 0);
  const waiting = data?.openRound && !data.openRound.processed ? data.openRound.ids : [];
  const exhausted = bank.filter(q => pending(questions[q.id]) && questions[q.id].askCount >= config.interview.maxAsks && !waiting.includes(q.id));
  const skipDue = exhausted.filter(q => !q.must).map(q => q.id);
  return { complete: !!data && remainingMust === 0 && skipDue.length === 0, remainingMust, byArea,
    mustDefer: exhausted.filter(q => q.must).map(q => q.id), skipDue,
    docFile: data?.docFile, questions, bank };
}
export async function interviewStatus(root: string) {
  const { bank: _bank, ...status } = await view(root, await readInterview(root)); return status;
}
export function remainingAreas(status: Awaited<ReturnType<typeof interviewStatus>>): string {
  return status.byArea.filter(a => a.mustTotal > a.mustDone).map(a => `${a.area}(${a.mustTotal - a.mustDone})`).join(', ');
}
const cell = (value: string) => redact(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
async function save(root: string, data: Interview) {
  const status = await view(root, data);
  let doc = '# 인터뷰 기록\n\n이 문서는 상태 파일에서 다시 그리는 뷰입니다. 사람이 편집한 내용은 보존하지 않습니다.\n\n## 요약\n\n남은 필수 '+status.remainingMust+'개\n';
  for (const [index, name] of interviewAreas.entries()) {
    const area = String(index + 1).padStart(2, '0');
    doc += `\n### ${area} ${name}\n\n| ID | 필수 | 질문 | 상태 | 답 | 출처 |\n|---|---|---|---|---|---|\n`;
    for (const q of status.bank.filter(q => q.area === area)) {
      const a = status.questions[q.id];
      doc += '| '+[q.id, q.must ? '필수' : '선택', q.text, a.status, a.answer ?? '', a.source ?? a.judgmentId ?? ''].map(cell).join(' | ')+' |\n';
    }
  }
  const path = await projectPath(root, data.docFile);
  await atomicWrite(harnessPath(root, 'harness-interview.json'), JSON.stringify(data, null, 2)+'\n');
  await atomicWrite(path, doc);
}
async function allowed(root: string, review = false) {
  const state = (await readState(root)).state;
  if (state !== 'INTERVIEW' && !(review && state === 'REVIEW')) throw new Error(`현재 상태 ${state}에서 인터뷰 명령을 실행할 수 없습니다`);
}
export async function startInterview(root: string) {
  return withFileLock(harnessPath(root, 'harness-interview.json'), async () => {
    await allowed(root);
    const current = await readInterview(root); if (current) return { created: false, ...current };
    const config = await loadConfig(root);
    const data: Interview = { startedAt: new Date().toISOString(), docFile: join(config.docs.root, '결정기록', `${todayKst()}-인터뷰.md`), round: 0, questions: {}, added: [] };
    await save(root, data); return { created: true, ...data };
  });
}
async function mutate<T>(root: string, action: string, fn: (data: Interview, bank: Question[]) => Promise<{ result: T; ids: string[] }>, review = false): Promise<T> {
  return withFileLock(harnessPath(root, 'harness-interview.json'), async () => {
    await allowed(root, review);
    const data = await readInterview(root); if (!data) throw new Error('인터뷰 기록이 없습니다. fodh interview start 를 먼저 실행하세요');
    const effective = await view(root, data);
    data.questions = { ...data.questions, ...effective.questions };
    const { result, ids } = await fn(data, effective.bank);
    if (['record', 'defer', 'skip'].includes(action) && data.openRound && ids.some(id => data.openRound!.ids.includes(id))) {
      data.openRound.ids = data.openRound.ids.filter(id => !ids.includes(id));
      data.openRound.processed = true;
      if (!data.openRound.ids.length) delete data.openRound;
    }
    await save(root, data);
    await appendLedger(root, { runId: randomUUID(), action: `interview:${action}`, status: 'ok', evidence: ids.map(id => ({ id, status: data.questions[id]?.status ?? 'open' })) });
    return result;
  });
}
async function recommendation(root: string, q: Question): Promise<Question> {
  let recommend = q.recommend;
  for (const match of [...recommend.matchAll(/\{\{config:([^{}]+)\}\}/gu)]) {
    const value = await getConfig(root, match[1]);
    recommend = recommend.replace(match[0], typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { ...q, recommend };
}
export async function nextInterview(root: string, count?: number) {
  return mutate(root, 'next', async (data, bank) => {
    const config = await loadConfig(root), n = count ?? config.interview.roundSize;
    if (!Number.isSafeInteger(n) || n < 1 || n > 8) throw new Error('count는 1~8 사이 정수여야 합니다');
    const deferred: { id: string; judgmentId: string }[] = [];
    // Normalize an open round saved before choice questions were deferred by next.
    if (data.openRound) {
      for (const id of data.openRound.ids) {
        const q = bank.find(q => q.id === id);
        if (q?.kind === 'choice' && pending(data.questions[id])) {
          const answer = await deferQuestion(root, data, await recommendation(root, q));
          deferred.push({ id, judgmentId: answer.judgmentId! });
        }
      }
      data.openRound.ids = data.openRound.ids.filter(id => bank.find(q => q.id === id)?.kind === 'free');
      if (!data.openRound.ids.length) delete data.openRound;
    }
    const status = await view(root, data);
    if (data.openRound && !data.openRound.processed && data.openRound.ids.every(id => bank.some(q => q.id === id) && pending(data.questions[id]))) {
      const questions = await Promise.all(data.openRound.ids.map(id => recommendation(root, question(bank, id))));
      return { result: { round: data.openRound.round, questions, deferred, repeated: true, mustDefer: status.mustDefer, skipDue: status.skipDue, remainingMust: status.remainingMust, complete: status.complete }, ids: deferred.map(q => q.id) };
    }
    delete data.openRound;
    const priority = (q: Question) => q.must ? (data.questions[q.id]?.askCount ? 0 : 1) : 2;
    const candidates = bank.filter(q => pending(data.questions[q.id]) && !status.mustDefer.includes(q.id) && !status.skipDue.includes(q.id)).sort((a, b) => priority(a) - priority(b));
    const selected = candidates.slice(0, n);
    for (let i = selected.length; !selected.some(q => q.kind === 'free') && i < candidates.length; i++) selected.push(candidates[i]);
    const questions = await Promise.all(selected.filter(q => q.kind === 'free').map(q => recommendation(root, q)));
    data.round++;
    for (const q of selected) {
      if (q.kind === 'choice') {
        const answer = await deferQuestion(root, data, await recommendation(root, q));
        deferred.push({ id: q.id, judgmentId: answer.judgmentId! });
      } else data.questions[q.id] = { status: 'asked', askCount: (data.questions[q.id]?.askCount ?? 0) + 1, round: data.round };
    }
    if (questions.length) data.openRound = { round: data.round, ids: questions.map(q => q.id) };
    const current = await view(root, data);
    return { result: { round: data.round, questions, deferred, repeated: false, mustDefer: current.mustDefer, skipDue: current.skipDue, remainingMust: current.remainingMust, complete: current.complete }, ids: [...new Set([...selected.map(q => q.id), ...deferred.map(q => q.id)])] };
  });
}
function question(bank: Question[], id: string): Question { const q = bank.find(q => q.id === id); if (!q) throw new Error(`인터뷰 질문을 찾을 수 없습니다: ${id}`); return q; }
export async function recordInterview(root: string, id: string, answer: string, source = 'user') {
  if (!answer?.trim() || !['user', 'default'].includes(source)) throw new Error('답 원문과 user|default 출처가 필요합니다');
  if (redact(answer) !== answer) throw new Error('답에 비밀값으로 보이는 문자열이 있습니다. 값을 빼고 다시 기록하세요');
  return mutate(root, 'record', async (data, bank) => {
    question(bank, id); data.questions[id] = { ...data.questions[id], askCount: data.questions[id]?.askCount ?? 0, status: 'answered', answer, source };
    return { result: data.questions[id], ids: [id] };
  }, true);
}
export async function deferInterview(root: string, id: string) {
  return mutate(root, 'defer', async (data, bank) => {
    const q = await recommendation(root, question(bank, id));
    return { result: await deferQuestion(root, data, q), ids: [id] };
  });
}
async function deferQuestion(root: string, data: Interview, q: Question): Promise<Answer> {
  const id = q.id;
  if (['answered', 'skipped'].includes(data.questions[id]?.status)) throw new Error('이미 답하거나 건너뛴 질문은 판단대기로 넘길 수 없습니다');
  if (data.questions[id]?.status === 'judgment') return data.questions[id];
  const options = [...(q.options ?? ['추천안 채택', '직접 답하기'])];
  const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
  const recommended = q.options ? options.findIndex(option => normalize(option) === normalize(q.recommend)) : -1;
  if (recommended > 0) options.unshift(...options.splice(recommended, 1));
  const added = await addJudgment(root, { origin: { kind: 'interview' }, title: q.text, background: `인터뷰 영역 ${q.area}`, options, recommend: q.recommend, blocks: '-', dedupeKey: `interview:${id}` });
  return data.questions[id] = { askCount: data.questions[id]?.askCount ?? 0, round: data.questions[id]?.round, status: 'judgment', judgmentId: added.item.id };
}
export async function skipInterview(root: string, id: string, reason: string) {
  return mutate(root, 'skip', async (data, bank) => {
    if (question(bank, id).must) throw new Error('필수 질문은 건너뛸 수 없습니다. 답을 받거나 fodh interview defer 로 판단대기에 넘기세요');
    if (!reason?.trim()) throw new Error('건너뛸 이유가 필요합니다');
    data.questions[id] = { askCount: data.questions[id]?.askCount ?? 0, status: 'skipped', answer: reason, source: 'user' };
    return { result: data.questions[id], ids: [id] };
  });
}
export async function addInterview(root: string, input: { area: string; text: string; must?: boolean; recommend?: string }) {
  return mutate(root, 'add', async (data, bank) => {
    if (!/^(0[1-9]|1[0-8])$/u.test(input.area) || !input.text?.trim()) throw new Error('영역 01~18과 질문이 필요합니다');
    const prefix = `Q${input.area}-x`, max = Math.max(0, ...bank.filter(q => q.id.startsWith(prefix)).map(q => Number(q.id.slice(prefix.length))));
    const q: Question = { id: prefix + String(max + 1).padStart(2, '0'), area: input.area, text: input.text, must: input.must ?? false, kind: 'free', recommend: input.recommend?.trim() || '직접 답하기' };
    data.added.push(q); return { result: q, ids: [q.id] };
  }, true);
}

export async function validateInterviewStart(root: string): Promise<void> {
  await loadBank(root);
  const config = await loadConfig(root);
  parseJudgment(await readText(await projectPath(root, config.judgment.file)));
  const current = await readInterview(root);
  await projectPath(root, current?.docFile ?? join(config.docs.root, '결정기록', `${todayKst()}-인터뷰.md`));
}
