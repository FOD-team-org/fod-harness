import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { workspaceMembers } from './workspace.ts';
import { harnessPath, readJson, withFileLock } from './storage.ts';
import { taskGit } from './workspace-task.ts';

export async function withWorktreeLock<T>(root: string, action: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  let entered = false;
  try {
    return await withFileLock(harnessPath(root, 'harness-worktree'), async () => { entered = true; return action(); }, options);
  } catch (error) {
    if (!entered && error instanceof Error && error.message === '다른 하네스가 잠금을 사용 중입니다') {
      // Best effort only: missing/invalid markers must preserve the original lock error.
      const members = await loadConfig(root).then(config => workspaceMembers(root, config)).catch(() => []);
      for (const member of members) {
        try {
          const common = resolve(member.path, (await taskGit(member.path, ['rev-parse', '--git-common-dir'])).trim());
          const marker = await readJson<{ taskId?: string } | null>(resolve(common, 'fodh-merge.json'), null);
          if (typeof marker?.taskId === 'string' && /^T\d+$/u.test(marker.taskId)) {
            error.message += ` — ${marker.taskId} 병합이 진행 중입니다`; break;
          }
        } catch { /* Keep the original lock error. */ }
      }
    }
    throw error;
  }
}
