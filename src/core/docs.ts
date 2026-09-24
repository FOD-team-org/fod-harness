import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { readState } from './state.ts';
import { getTask } from './backlog.ts';
import { readText, withFileLock } from './storage.ts';
import { projectPath, substitute, todayKst } from './template-values.ts';

export const docKinds: Record<string, { template: string; target: string; needs?: 'task' | 'topic' | 'subject' }> = {
  prd: { template: 'PRD.md', target: 'PRD.md' },
  arch: { template: '설계/아키텍처.md', target: '설계/아키텍처.md' },
  tools: { template: '설계/도구-스킬-MCP.md', target: '설계/도구-스킬-MCP.md' },
  'backlog-draft': { template: '설계/백로그-초안.md', target: '설계/{{date}}-백로그-초안.md' },
  spec: { template: '위임스펙/템플릿.md', target: '위임스펙/{{date}}-{{taskId}}.md', needs: 'task' },
  'fix-spec': { template: '위임스펙/수정-템플릿.md', target: '위임스펙/{{date}}-{{taskId}}-수정.md', needs: 'task' },
  'review-request': { template: '검수/요청-템플릿.md', target: '검수/{{date}}-{{subject}}-검수요청.md', needs: 'subject' },
  review: { template: '검수/템플릿.md', target: '검수/{{date}}-{{subject}}-검수.md', needs: 'subject' },
  'research-q': { template: '조사/질문.md', target: '조사/{{date}}-{{topic}}-질문.md', needs: 'topic' },
  'research-r': { template: '조사/결과.md', target: '조사/{{date}}-{{topic}}-결과.md', needs: 'topic' },
  backlog: { template: 'backlog.md', target: 'backlog.md' },
  worklog: { template: '작업일지.md', target: '작업일지/{{date}}.md' },
};
export async function scaffoldDoc(root: string, kind: string, opts: { task?: string; taskId?: string; subject?: string; topic?: string; date?: string; ifMissing?: boolean } = {}) {
  const def = docKinds[kind]; if (!def) throw new Error(`지원하지 않는 문서 종류입니다: ${kind}`);
  if (opts.subject !== undefined) {
    if (!['review', 'review-request'].includes(kind) || opts.task || opts.taskId || opts.topic) throw new Error('--subject는 프로젝트 검수에서 단독으로 사용하세요');
    opts = { ...opts, topic: opts.subject };
  }
  const taskId = opts.taskId ?? opts.task;
  if (opts.topic !== undefined && !/^[가-힣A-Za-z0-9_-]{1,40}$/u.test(opts.topic)) throw new Error('topic은 한글·영문·숫자·_·- 1~40자여야 합니다');
  if (taskId !== undefined && !/^T\d+$/u.test(taskId)) throw new Error('task ID가 올바르지 않습니다');
  if (def.needs === 'task' && !taskId || def.needs === 'topic' && !opts.topic || def.needs === 'subject' && !taskId && !opts.topic) throw new Error(`필수 인자가 없습니다: --${def.needs === 'subject' ? 'task 또는 --topic' : def.needs}`);
  const date = opts.date ?? todayKst();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('date는 유효한 YYYY-MM-DD여야 합니다');
  const config = await loadConfig(root), state = await readState(root), task = taskId ? await getTask(root, taskId) : undefined;
  const values = { date, taskId: taskId ?? '', taskTitle: task?.title ?? '', specRev: String(task?.spec?.rev ?? 1), topic: opts.topic ?? '', subject: taskId ?? opts.topic ?? '', projectName: typeof state.projectName === 'string' && state.projectName ? state.projectName : basename(root), judgmentFile: config.judgment.file };
  // Backlog remains fixed for compatibility with the JSON-backed backlog renderer.
  const path = join(kind === 'backlog' ? 'docs' : config.docs.root, substitute(def.target, values));
  const target = await projectPath(root, path);
  return withFileLock(target, async () => {
    try { await readFile(target); if (opts.ifMissing || kind === 'worklog') return { path, created: false }; return { path, error: `이미 있는 문서입니다: ${path}. 기존 문서를 고치세요` }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const override = await projectPath(root, join(config.docs.overrideDir, def.template));
    const marker = '\0missing';
    const custom = await readText(override, marker);
    const template = custom === marker ? await readFile(new URL(`../../templates/docs/${def.template}`, import.meta.url), 'utf8') : custom;
    const content = substitute(template, values);
    await mkdir(dirname(target), { recursive: true });
    // Exclusive create also refuses an external writer that raced the lock.
    try { await writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (kind === 'worklog') return { path, created: false }; return { path, error: `이미 있는 문서입니다: ${path}. 기존 문서를 고치세요` }; }
    return { path, created: true };
  });
}
