import { afterEach } from 'vitest';
import { join } from 'node:path';
import { acquireLock } from '../src/core/lock.ts';
const releases: (() => Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
export async function liveHarness(root: string) {
  releases.push(await acquireLock(join(root, '.pi/harness.lock')));
}
