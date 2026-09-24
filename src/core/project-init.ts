import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, harnessPath, readText, withFileLock } from './storage.ts';

const harnessIgnores = ['.pi/harness.lock', '.pi/harness-*.json', '.pi/harness-*.jsonl', '.pi/scratch/',
  '.pi/codex/', '.pi/cleanup-last.json', '.pi/harness-config-warned.json'];

export async function ensureHarnessGitignore(root: string): Promise<void> {
  const git = await lstat(join(root, '.git')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!git) return;
  await withFileLock(harnessPath(root, 'harness-gitignore'), async () => {
    const path = join(root, '.gitignore'), original = await readText(path);
    const lines = new Set(original.split(/\r?\n/u)), missing = harnessIgnores.filter(line => !lines.has(line));
    if (!missing.length) return;
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    await atomicWrite(path, original + (original && !original.endsWith('\n') ? newline : '') + missing.join(newline) + newline);
  });
}
