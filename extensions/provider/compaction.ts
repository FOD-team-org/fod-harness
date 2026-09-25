import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function compactionDisabled(root: string, projectTrusted: boolean): boolean {
  const configured = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
  const directory = configured.replace(/^~(?=\/|$)/u, () => homedir());
  const paths = [join(directory, 'settings.json'), ...(projectTrusted ? [join(root, '.pi/settings.json')] : [])];
  let enabled: unknown;
  for (const path of paths) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')).compaction?.enabled;
      if (value !== undefined) enabled = value;
    } catch { /* Missing/unreadable settings leave the preceding setting effective. */ }
  }
  return enabled === false;
}
