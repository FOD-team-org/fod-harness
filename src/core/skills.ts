import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { atomicWrite, readJson, readText, withFileLock } from './storage.ts';
import { projectPath } from './template-values.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function inspectSkills(root: string, write: boolean, options: { onlyMissing?: boolean } = {}) {
  const config = await loadConfig(root, undefined, { dryRun: options.onlyMissing }), version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
  const result = { installed: [] as string[], updated: [] as string[], unchanged: [] as string[], conflicts: [] as string[] };
  for (const name of config.skills.install) {
    const target = join(await projectPath(root, config.skills.target), name);
    const inspect = async () => {
      const content = await readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
      const digest = hash(content);
      let exists = false;
      try { const stat = await lstat(target); exists = true; if (!stat.isDirectory()) { result.conflicts.push(name); return; } }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (exists && options.onlyMissing) { result.unchanged.push(name); return; }
      const marker = await projectPath(root, join(config.skills.target, name, '.fodh-managed'));
      let managed: { package?: string; version?: string; hash?: string } | undefined;
      try { managed = await readJson(marker, undefined); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
      if (exists && managed?.package !== 'fod-harness') { result.conflicts.push(name); return; }
      const file = await projectPath(root, join(config.skills.target, name, 'SKILL.md'));
      const current = await readText(file);
      const category = !exists ? 'installed' : managed?.hash === digest && hash(current) === digest ? 'unchanged' : 'updated';
      result[category].push(name);
      if (write && category !== 'unchanged') {
        await mkdir(target, { recursive: true });
        await atomicWrite(file, content);
        await atomicWrite(marker, JSON.stringify({ package: 'fod-harness', version, hash: digest }, null, 2)+'\n');
      }
    };
    if (write) await withFileLock(target, inspect); else await inspect();
  }
  return result;
}
export const installSkills = (root: string, options: { onlyMissing?: boolean } = {}) => inspectSkills(root, true, options);
export const skillsStatus = (root: string) => inspectSkills(root, false);
