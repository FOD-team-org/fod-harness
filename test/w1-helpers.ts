import { afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launcherPath } from './launcher-helpers.ts';
import { acquireLock } from '../src/core/lock.ts';
import { defaultWorkspaceMember } from '../src/core/workspace.ts';
vi.mock('../src/core/process-time.ts', async original => ({ ...await original<object>(), processStartedAt: async () => '2026-09-27T00:00:00Z' }));
const roots: string[] = [], execute = promisify(execFile);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
export async function git(root: string, ...args: string[]) {
  if (!roots.some(parent => root.startsWith(parent + '/'))) throw new Error('temporary repositories only');
  return (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
}
export async function fixture(names = ['web', 'backend', 'app']) {
  const parent = await mkdtemp('/private/tmp/fodh-w1-'); roots.push(parent);
  const root = join(parent, 'workspace'), home = join(parent, 'home'); await mkdir(root); await mkdir(home);
  for (const key of Object.keys(process.env).filter(key => key.startsWith('GIT_') || key === 'EMAIL')) vi.stubEnv(key, undefined);
  vi.stubEnv('HOME', home); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('FODH_BRAIN', ''); vi.stubEnv('FODH_CODEX_CHILD', ''); vi.stubEnv('FODH_PROJECT_ROOT', '');
  vi.stubEnv('PATH', (await launcherPath(parent)).path);
  // Exercise the existing lock start-time injection; process-time is stubbed for implicit file locks.
  const release = await acquireLock(join(parent, 'seed.lock'), { startedAt: async () => '2026-09-27T00:00:00Z' }); await release();
  const repos: Record<string, ReturnType<typeof defaultWorkspaceMember>> = {};
  for (const name of names) {
    const path = join(parent, name); await mkdir(path); await git(path, 'init', '-b', 'main');
    await git(path, 'config', '--local', 'user.name', 'W1 Fixture'); await git(path, 'config', '--local', 'user.email', 'w1@example.invalid');
    await git(path, 'config', '--local', 'commit.gpgsign', 'false');
    await writeFile(join(path, 'code.txt'), 'initial\n'); await git(path, 'add', '--', 'code.txt'); await git(path, 'commit', '-m', 'fixture');
    repos[name] = defaultWorkspaceMember(name, `../${name}`);
  }
  return { parent, root, repos, candidate: { workspace: { repos } }, args: names.map(name => `${name}=../${name}`), member: (name = 'web') => join(parent, name) };
}
export async function writeConfig(root: string, value: unknown) {
  await mkdir(join(root, '.pi'), { recursive: true }); await writeFile(join(root, '.pi/harness.json'), JSON.stringify(value));
}
export async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files[name] = (await readFile(join(root, name))).toString('base64');
    }
  }
  await walk(''); return files;
}
