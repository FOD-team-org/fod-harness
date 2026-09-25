import { afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const roots: string[] = [];
export interface HookOptions {
  nonTempRoot?: boolean;
  homeLayout?: 'outside' | 'inside';
  env?: NodeJS.ProcessEnv;
  projectEnv?: 'FODH_PROJECT_ROOT' | 'CLAUDE_PROJECT_DIR';
  cwdRelative?: string;
  approval?: string[];
  setup?: (root: string) => Promise<void>;
  worktrees?: boolean; stateFile?: 'missing' | 'invalid'; configFile?: 'invalid' | 'missing';
}
export async function invoke(tool_name: string, tool_input: unknown, state = 'IMPLEMENT', options: HookOptions = {}) {
  const fixture = await mkdtemp(options.nonTempRoot ? resolve('.a14b-hook-') : '/private/tmp/fodh-hook-');
  roots.push(fixture);
  const home = options.homeLayout ? join(fixture, 'Users/me') : undefined;
  const root = home ? options.homeLayout === 'inside' ? join(home, 'Desktop/proj') : join(fixture, 'proj') : fixture;
  if (home) await mkdir(home, { recursive: true });
  await mkdir(join(root, '.pi'), { recursive: true });
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state, worktrees: options.worktrees ? [{ path: join(root, 'wt') }, { path: root + '-wt' }] : [] }));
  await writeFile(join(root, '.pi/harness.json'), '{}');
  if (options.stateFile === 'missing') await rm(join(root, '.pi/harness-state.json'));
  if (options.stateFile === 'invalid') await writeFile(join(root, '.pi/harness-state.json'), '{');
  if (options.configFile === 'invalid') await writeFile(join(root, '.pi/harness.json'), '{');
  if (options.configFile === 'missing') await rm(join(root, '.pi/harness.json'));
  if (options.approval) {
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ requiresApproval: options.approval }));
  }
  await options.setup?.(root);
  const cwd = options.cwdRelative ? join(root, options.cwdRelative) : options.projectEnv ? join(root, 'worktree') : root;
  if (options.projectEnv || options.cwdRelative) await mkdir(cwd, { recursive: true });
  const env = { ...process.env };
  if (home) env.HOME = home;
  delete env.FODH_PROJECT_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.FODH_TEST_MARKERS;
  delete env.FODH_BRAIN; delete env.FODH_DOCS_ROOT; delete env.FODH_CODEX_CHILD;
  if (options.projectEnv) env[options.projectEnv] = root;
  if (options.cwdRelative) env.FODH_PROJECT_ROOT = root;
  Object.assign(env, Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, value?.replaceAll('@root@', root)])));
  const input = JSON.parse(JSON.stringify(tool_input)
    .replaceAll('@relative-root@', root.slice(1)).replaceAll('@root@', root).replaceAll('@pkg@', resolve('.')));
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult, reject) => {
    const child = spawn(resolve('hooks/pretooluse.sh'), [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify({ cwd, tool_name, tool_input: input }));
  });
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

