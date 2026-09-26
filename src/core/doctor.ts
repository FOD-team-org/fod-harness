import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeHookStatus } from './claude-settings.ts';
import { join, relative } from 'node:path';
import { secretPolicy, scanSecretFiles } from '../../hooks/secret-paths.mjs';
import { loadConfig } from './config.ts';
const execute = promisify(execFile);
export async function doctorFiles(root: string, ignored: (files: string[]) => Promise<string[]> = async files => {
  // stdin contains names only, never contents. Batch to avoid a process per file.
  if (!files.length || !existsSync(join(root, '.git'))) return [];
  try {
    const pending = execute('git', ['-C', root, 'check-ignore', '--stdin', '-z'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    pending.child.stdin?.end(files.join('\0') + '\0');
    return (await pending).stdout.split('\0').filter(Boolean);
  }
  catch (error) { return (error as { stdout?: string }).stdout?.split('\0').filter(Boolean) ?? []; }
}) {
  const config = await loadConfig(root), policy = secretPolicy(root, config.secrets);
  const scanned = scanSecretFiles(root, policy, { depth: 6, limit: 20000 });
  const files = scanned.files.map(path => relative(root, path));
  const excluded = new Set(await ignored(files));
  return { ...await claudeHookStatus(root), secretsNotIgnored: files.filter(path => !excluded.has(path)), secretsScanLimited: scanned.exceeded };
}
