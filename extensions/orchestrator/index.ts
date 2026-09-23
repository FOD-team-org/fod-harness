import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadConfig } from '../../src/core/config.ts';
import { readState, updateState, transitionState, stopForJudgment, type HarnessState } from '../../src/core/state.ts';
import { listBacklog } from '../../src/core/backlog.ts';
import { runPick } from '../../src/core/pick.ts';
import { cleanupReport } from '../../src/core/reclaim.ts';
import { applyJudgments, readJudgment } from '../../src/core/judgment.ts';
import { listInbox } from '../../src/core/inbox.ts';
import { unknownEntries } from '../../src/core/ledger.ts';
import { atomicWrite, withFileLock } from '../../src/core/storage.ts';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
const active = new Set(['INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW', 'PLANNING', 'PICK',
  'SPEC', 'IMPLEMENT', 'VERIFY', 'FIX', 'MERGE', 'DOCS', 'CLEANUP', 'RECLAIM', 'recovering']);

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function initialize(root: string): Promise<void> {
  for (const name of ['backlog.md', '작업일지.md']) {
    const path = join(root, 'docs', name);
    await withFileLock(path, async () => {
      if (!await exists(path)) await atomicWrite(path, await readFile(join(templates, name), 'utf8'));
    });
  }
  await readJudgment(root);
}

export async function instruction(root: string, state: HarnessState, promptState = state.state): Promise<string> {
  // Only known state names become filenames; state JSON never chooses an arbitrary path.
  if (!active.has(promptState)) throw new Error(`자동 진행할 수 없는 상태: ${promptState}`);
  const config = await loadConfig(root);
  const prompt = await readFile(join(templates, 'prompts', `${promptState}.md`), 'utf8');
  const values: Record<string, string> = {
    taskId: state.taskId ?? '', judgmentFile: config.judgment.file, backlogFile: 'docs/backlog.md',
  };
  const rendered = prompt.replace(/\{\{(taskId|judgmentFile|backlogFile)\}\}/gu, (_match, key: string) => values[key]!);
  return rendered;
}

export default function orchestrator(pi: ExtensionAPI): void {
  let resuming = false;
  const send = async (root: string, state: HarnessState, promptState = state.state, automatic = false) => {
    pi.sendMessage({ customType: 'harness-orchestrator', content: await instruction(root, state, promptState),
      display: true, details: { state: state.state, taskId: state.taskId } },
    { triggerTurn: true, ...(automatic ? { deliverAs: 'followUp' as const } : {}) });
  };
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'extension') await updateState(ctx.cwd, { awaitingUser: false, autoTurns: 0 });
    return { action: 'continue' };
  });
  pi.registerCommand('project-start', {
    description: '프로젝트 인터뷰 시작',
    handler: async (args, ctx) => {
      if ((await readState(ctx.cwd)).state !== 'IDLE') throw new Error('project-start는 IDLE에서만 시작할 수 있습니다');
      await initialize(ctx.cwd);
      const state = await transitionState(ctx.cwd, 'INTERVIEW');
      await updateState(ctx.cwd, { awaitingUser: false, ...(args.trim() ? { projectName: args.trim() } : {}) });
      await send(ctx.cwd, state);
    },
  });
  pi.registerCommand('develop-start', {
    description: '백로그 계획 또는 작업 선택 시작',
    handler: async (_args, ctx) => {
      let state = await readState(ctx.cwd);
      if (!['IDLE', 'PROJECT_READY', 'DONE_ALL', 'PLANNING', 'PICK', 'WAIT_RETRY', 'WAIT_RESOURCE'].includes(state.state)
        && !state.state.startsWith('paused(')) throw new Error('현재 상태에서 develop-start를 시작할 수 없습니다');
      if (state.state === 'WAIT_RETRY' && state.retry?.nextAt && Date.parse(state.retry.nextAt) > Date.now()) {
        ctx.ui.notify(`${Math.ceil((Date.parse(state.retry.nextAt) - Date.now()) / 60000)}분 뒤 재시도 예정`, 'info'); return;
      }
      const missingBacklog = !await exists(join(ctx.cwd, 'docs/backlog.md'));
      const tasks = await listBacklog(ctx.cwd);
      if (missingBacklog) await initialize(ctx.cwd);
      await updateState(ctx.cwd, { awaitingUser: false, autoTurns: 0 });
      if (!tasks.length && state.state === 'PLANNING') {
        ctx.ui.notify('백로그가 비어 있습니다. PLANNING 을 계속합니다', 'info'); return;
      }
      if (['IDLE', 'PROJECT_READY', 'DONE_ALL'].includes(state.state)) state = await transitionState(ctx.cwd, 'PLANNING');
      if (!tasks.length) {
        if (state.state !== 'PLANNING') throw new Error('백로그 계획은 PLANNING 상태가 필요합니다');
        await send(ctx.cwd, state); return;
      }
      if (state.state !== 'PICK') await transitionState(ctx.cwd, 'PICK');
      const result = await runPick(ctx.cwd);
      state = await readState(ctx.cwd);
      if (active.has(state.state)) await send(ctx.cwd, state);
      else ctx.ui.notify(JSON.stringify(result), 'info');
    },
  });
  pi.registerCommand('status', {
    description: '상태·미적용 인박스·미해결 원장·최근 한도 표시',
    handler: async (_args, ctx) => {
      const [state, inbox, unknown] = await Promise.all([readState(ctx.cwd), listInbox(ctx.cwd), unknownEntries(ctx.cwd)]);
      ctx.ui.notify(JSON.stringify({ state: state.state, task: state.taskId ?? null,
        inbox: inbox.filter(item => item.status !== 'applied'), unknown, rateLimit: state.rateLimitInfo ?? null }), 'info');
    },
  });
  pi.registerCommand('judged', {
    description: '판단 답 적용 후 작업 재개',
    handler: async (args, ctx) => {
      const ids = args.trim() ? args.trim().split(/\s+/u) : undefined;
      if (ids?.some(id => !/^A\d+(?:-\d+)?$/u.test(id))) throw new Error('판단 번호가 올바르지 않습니다');
      const before = await readState(ctx.cwd);
      const result = await applyJudgments(ctx.cwd, ids);
      ctx.ui.notify(JSON.stringify(result), 'info');
      const state = await readState(ctx.cwd);
      if ((before.state === 'WAIT_JUDGMENT' || before.state === 'paused(cleanup)') && result.applied.length && active.has(state.state)) {
        await updateState(ctx.cwd, { awaitingUser: false, autoTurns: 0 });
        await send(ctx.cwd, state, state.state);
      }
    },
  });
  pi.registerCommand('cleanup', {
    description: '프로세스 레지스트리 잔존 보고 (P4 전까지 정리 실행 없음)',
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(await cleanupReport(ctx.cwd)), 'info'); },
  });
  pi.on('agent_end', async (event, ctx) => {
    if (resuming) return;
    resuming = true;
    try {
      const last = [...event.messages].reverse().find(message => message.role === 'assistant');
      if (last?.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason)) return;
      let state = await readState(ctx.cwd);
      if (last?.role === 'assistant' && last.content?.some(block => block.type === 'text' && /^대기: 사용자[ \t]*$/mu.test(block.text))) {
        await updateState(ctx.cwd, { awaitingUser: true, autoTurns: 0 }); return;
      }
      if (state.awaitingUser) { await updateState(ctx.cwd, { autoTurns: 0 }); return; }
      if (!active.has(state.state)) {
        if (['WAIT_JUDGMENT', 'DONE_ALL', 'paused(cleanup)'].includes(state.state)) ctx.ui.notify(`하네스 상태: ${state.state}`, 'info');
        return;
      }
      if (state.state === 'recovering' && state.recoveryAutoResumed === true) return;
      const config = await getConfig(ctx.cwd) as { maxAutoTurns?: unknown };
      const maxAutoTurns = config.maxAutoTurns ?? 3;
      if (!Number.isSafeInteger(maxAutoTurns) || Number(maxAutoTurns) < 1) throw new Error('maxAutoTurns는 1 이상의 정수여야 합니다');
      if (Number(state.autoTurns ?? 0) >= Number(maxAutoTurns)) {
        await stopForJudgment(ctx.cwd);
        ctx.ui.notify('진행 정체를 판단대기에 등록했습니다.', 'warning');
        return;
      }
      state = await updateState(ctx.cwd, current => ({ autoTurns: Number(current.autoTurns ?? 0) + 1,
        ...(current.state === 'recovering' ? { recoveryAutoResumed: true } : {}) }));
      await new Promise(resolve => setTimeout(resolve, 0));
      await send(ctx.cwd, state, state.state, true);
    } finally { resuming = false; }
  });
}
