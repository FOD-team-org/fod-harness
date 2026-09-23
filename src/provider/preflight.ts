import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const billingEnvKeys = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];
export async function checkBillingEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const key of billingEnvKeys) {
    if (env[key] !== undefined) throw new Error(`configError: ${key}가 설정되어 있습니다. 값을 제거하세요.`);
  }
  const files = [join(env.HOME ?? homedir(), '.claude/settings.json'),
    join(root, '.claude/settings.json'), join(root, '.claude/settings.local.json')];
  for (const file of files) {
    try {
      const settings = JSON.parse(await readFile(file, 'utf8'));
      const containsHelper = (value: unknown): boolean => !!value && typeof value === 'object' &&
        Object.entries(value).some(([key, nested]) => key === 'apiKeyHelper' || containsHelper(nested));
      if (settings.env && billingEnvKeys.some(key => Object.hasOwn(settings.env, key))) {
        throw new Error('configError: Claude settings.env에 과금 환경변수가 있습니다.');
      }
      if (containsHelper(settings)) throw new Error('configError: apiKeyHelper 설정을 제거하세요.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof Error && error.message.startsWith('configError:')) throw error;
      throw new Error('configError: Claude 설정 파일을 읽을 수 없습니다.');
    }
  }
}
