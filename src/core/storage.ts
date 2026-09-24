import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireLock } from './lock.ts';

export const harnessPath = (root: string, file: string): string => join(root, '.pi', file);

export async function readText(path: string, fallback = ''): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readText(path);
  return text ? JSON.parse(text) as T : fallback;
}

export async function atomicWrite(path: string, text: string, beforeRename?: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await beforeRename?.();
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireLock(`${path}.lock`);
  try { return await action(); } finally { await release(); }
}

export function parseJsonLines<T>(text: string): T[] {
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T);
}
