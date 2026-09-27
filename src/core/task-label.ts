import type { HarnessConfig } from './config.ts';
import { harnessPath, readJson } from './storage.ts';

export const formatTaskLabel = (id: string, repo?: string): string => repo ? `${id}·${repo}` : id;
export async function taskLabel(root: string, config: Pick<HarnessConfig, 'workspace'>, taskId?: string): Promise<string | undefined> {
  if (!config.workspace || !taskId) return undefined;
  try {
    const backlog = await readJson<{ tasks: { id: string; repo?: string }[] }>(harnessPath(root, 'harness-backlog.json'), { tasks: [] });
    return formatTaskLabel(taskId, backlog.tasks.find(task => task.id === taskId)?.repo);
  } catch { return taskId; }
}
