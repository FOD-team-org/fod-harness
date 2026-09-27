import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../../src/core/config.ts';
import { readState } from '../../src/core/state.ts';
import { taskLabel } from '../../src/core/task-label.ts';

export async function refreshTaskStatus(ctx: Pick<ExtensionContext, 'cwd' | 'ui'>): Promise<void> {
  try {
    const config = await loadConfig(ctx.cwd, undefined, { dryRun: true });
    if (!config.workspace) return;
    const state = await readState(ctx.cwd);
    ctx.ui?.setStatus?.('fodh-task', await taskLabel(ctx.cwd, config, state.taskId));
  } catch { /* Display failures must not interrupt the harness. */ }
}
