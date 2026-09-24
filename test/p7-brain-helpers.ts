import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processStartedAt } from '../src/core/process-time.ts';
export async function liveHarness(root: string) {
  await writeFile(join(root, '.pi/harness.lock'), JSON.stringify({ pid: process.pid, startedAt: await processStartedAt(process.pid) ?? '', token: 'live-test' }));
}
