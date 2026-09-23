import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export async function checkBillingEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    if (env[key] !== undefined) throw new Error(`configError: ${key}가 설정되어 있습니다. 값을 제거하세요.`);
  }
  for (const file of [join(env.HOME ?? homedir(), '.claude/settings.json'), join(root, '.claude/settings.json'), join(root, '.claude/settings.local.json')]) {
    try {
      const settings = JSON.parse(await readFile(file, 'utf8'));
      const containsHelper = (value: unknown): boolean => !!value && typeof value === 'object' &&
        Object.entries(value).some(([key, nested]) => key === 'apiKeyHelper' || containsHelper(nested));
      if (containsHelper(settings)) throw new Error('configError: apiKeyHelper 설정을 제거하세요.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof Error && error.message.startsWith('configError:')) throw error;
      throw new Error('configError: Claude 설정 파일을 읽을 수 없습니다.');
    }
  }
}
