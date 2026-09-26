import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHookStatus, hookMergeGuidance, HarnessHookRequired } from '../core/claude-settings.ts';
import { projectRoots, globalProjectLocation, projectFolderHint } from './project-root.ts';
import { initProject } from './init.ts';
import { brainModels, loadConfig } from '../core/config.ts';
import { lockOwnerAlive, ownerAt, type LockOwner } from '../core/lock.ts';

export async function startRoot(cwd = process.cwd(), home?: string): Promise<string> {
  const { harness } = await projectRoots(cwd, home);
  if (!harness) throw new Error('하네스 프로젝트 루트가 아닙니다 — `.pi/harness.json` 이 필요합니다. fodh init 으로 설치하세요');
  return harness;
}
// The shell supplies TTY status before capturing the planner's stdout.
export async function implicitStart(options: { cwd?: string; env?: NodeJS.ProcessEnv; interactive?: boolean;
  ask: (question: string) => Promise<string>; report: (summary: string) => void;
  initialize?: typeof initProject } ) {
  const env = options.env ?? process.env, cwd = options.cwd ?? process.cwd();
  if (env.FODH_BRAIN === '1') return undefined;
  if (env.FODH_CODEX_CHILD) throw new Error('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  if (await globalProjectLocation(cwd, env.HOME)) { options.report(projectFolderHint); return undefined; }
  const { harness, git } = await projectRoots(cwd, env.HOME);
  if (harness) return startPlan({ cwd: harness, env });
  const target = git ?? cwd;
  if (await globalProjectLocation(target, env.HOME)) { options.report(projectFolderHint); return undefined; }
  if (!options.interactive || !/^y$/iu.test((await options.ask(`이 폴더(${target})는 하네스 프로젝트가 아닙니다. 여기에 하네스를 설치하고 열까요? [y/N] `)).trim())) return undefined;
  const result = await (options.initialize ?? initProject)({ cwd: target });
  options.report(`하네스 설치: 생성 ${result.created.length}개 · 있음 ${result.existed.length}개 · 건너뜀 ${result.skipped.length}개\n${result.nextSteps.join('\n')}\n${result.skipped.map(s => s.reason).join('\n')}`);
  if (result.settingsNeedsHook) throw new HarnessHookRequired((await hookMergeGuidance()).reason);
  return startPlan({ cwd: result.root, env });
}
export async function startPlan(options: { cwd?: string; model?: string; dryRun?: boolean; env?: NodeJS.ProcessEnv;
  alive?: (owner: LockOwner) => Promise<boolean> } = {}) {
  const env = options.env ?? process.env;
  if (env.FODH_CODEX_CHILD) throw new Error('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  if (!options.dryRun && env.FODH_BRAIN === '1') throw new Error('두뇌는 fodh start 를 실행할 수 없습니다. --dry-run 만 허용합니다');
  const root = await startRoot(options.cwd, env.HOME), config = await loadConfig(root, undefined, { dryRun: true });
  const hook = await claudeHookStatus(root);
  const guidance = hook.settingsNeedsHook ? await hookMergeGuidance() : undefined;
  if (guidance && !options.dryRun) throw new HarnessHookRequired(guidance.reason);
  const { model } = brainModels({ brain: { ...config.brain, model: options.model ?? config.brain.model } });
  const owner = await ownerAt(join(root, '.pi/harness.lock'));
  if (!options.dryRun && owner && await (options.alive ?? lockOwnerAlive)(owner)) throw new Error(`이미 이 프로젝트의 하네스가 실행 중입니다(pid ${owner.pid}). 그 터미널 창을 쓰세요`);
  let pi: string | undefined;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(root, directory || '.', 'pi');
    if (await access(candidate, constants.X_OK).then(() => true, () => false)
      && await stat(candidate).then(s => s.isFile(), () => false)) { pi = candidate; break; }
  }
  if (!pi && !guidance) throw new Error('pi 를 PATH에서 찾을 수 없습니다. README의 pi 설치 안내를 확인하세요');
  const pkg = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
  const argv = ['pi', ...['provider', 'orchestrator', 'watcher'].flatMap(name => ['-e', join(pkg, 'extensions', name, 'index.ts')]), '--model', `claude-code/${model}`];
  return { cwd: root, command: pi ?? 'pi', argv, allowed: !hook.settingsNeedsHook, settingsNeedsHook: hook.settingsNeedsHook, ...guidance, env: { unset: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY'],
    set: { PI_SKIP_VERSION_CHECK: '1', FODH_PACKAGE_ROOT: pkg } } };
}
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
export function startShell(plan: Awaited<ReturnType<typeof startPlan>>): string {
  if (!plan.allowed) throw new HarnessHookRequired(plan.reason ?? '하네스 PreToolUse 훅이 필요합니다');
  return `cd ${quote(plan.cwd)} && exec env ${plan.env.unset.flatMap(key => ['-u', key]).map(quote).join(' ')} ${Object.entries(plan.env.set).map(([key, value]) => quote(`${key}=${value}`)).join(' ')} ${[plan.command, ...plan.argv.slice(1)].map(quote).join(' ')}`;
}
