import { afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { main } from '../src/cli/index.ts';
import { setConfig } from '../src/core/config.ts';
import { updateState } from '../src/core/state.ts';
const roots: string[] = [];
export async function project(state = 'INTERVIEW') {
  const root = await mkdtemp('/private/tmp/fodh-p5-'); roots.push(root);
  await setConfig(root, 'notify.channels', '["ledger"]');
  await updateState(root, { state }); return root;
}
export async function cli(root: string, args: string[]) {
  let output = ''; process.exitCode = 0;
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(v => { output += v; return true; });
  try { await main(args, root); return { code: process.exitCode, value: JSON.parse(output) }; }
  finally { spy.mockRestore(); process.exitCode = 0; }
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
