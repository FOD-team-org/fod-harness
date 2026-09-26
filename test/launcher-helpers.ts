import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// No inherited PATH: even a missing fake pi can never fall through to an installed brain.
export async function launcherPath(parent: string) {
  const bin = join(parent, 'safe-bin'), node = join(parent, 'node-bin');
  await mkdir(bin); await mkdir(node);
  await symlink(process.execPath, join(node, 'node'));
  for (const command of ['dirname', 'readlink', 'env', 'git']) await symlink(`/usr/bin/${command}`, join(bin, command));
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nprintf "FAKE_PI\\n"\n', { mode: 0o755 });
  return { bin, path: `${bin}:${node}` };
}
