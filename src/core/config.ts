import { isAbsolute, relative, resolve } from 'node:path';
import { harnessPath, readJson } from './storage.ts';

export interface HarnessConfig {
  brain: { command: string | string[]; switchCommand: string | string[]; model: string; skipPermissions: boolean; maxTurnMinutes: number };
  judgment: { file: string };
  requiresApproval: string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 설정은 객체여야 합니다`);
  return value as Record<string, unknown>;
}

function command(value: unknown, fallback: string | string[], label: string): string | string[] {
  const result = value ?? fallback;
  if (typeof result === 'string' && result.trim() && !/[\r\n\0]/u.test(result)) return result;
  if (Array.isArray(result) && result.length > 0 && result.every(part => typeof part === 'string' && part.length > 0 && !part.includes('\0'))) return result as string[];
  throw new Error(`${label} 명령이 올바르지 않습니다`);
}

export async function loadConfig(root: string): Promise<HarnessConfig> {
  const raw = object(await readJson<unknown>(harnessPath(root, 'harness.json'), {}), '하네스');
  const brain = object(raw.brain ?? {}, 'brain');
  const judgment = object(raw.judgment ?? {}, 'judgment');
  const model = brain.model ?? 'opus';
  const skipPermissions = brain.skipPermissions ?? true;
  const maxTurnMinutes = brain.maxTurnMinutes ?? 45;
  if (typeof model !== 'string' || !['opus', 'sonnet', 'haiku'].includes(model)) throw new Error('brain.model은 opus, sonnet, haiku 중 하나여야 합니다');
  if (typeof skipPermissions !== 'boolean') throw new Error('brain.skipPermissions는 불리언이어야 합니다');
  if (typeof maxTurnMinutes !== 'number' || !Number.isFinite(maxTurnMinutes) || maxTurnMinutes <= 0) throw new Error('brain.maxTurnMinutes는 양수여야 합니다');
  const file = judgment.file ?? 'docs/판단대기.md';
  if (typeof file !== 'string' || !file.trim() || isAbsolute(file) || relative(resolve(root), resolve(root, file)).startsWith('..')) throw new Error('judgment.file은 프로젝트 내부 상대 경로여야 합니다');
  const requiresApproval = raw.requiresApproval ?? ['prod-migration', 'store-upload', 'payment', 'push-main', 'env-delete', 'external-send'];
  if (!Array.isArray(requiresApproval) || requiresApproval.some(value => typeof value !== 'string' || !value.trim())) throw new Error('requiresApproval은 문자열 배열이어야 합니다');
  return { brain: { command: command(brain.command, 'claude', 'brain.command'), switchCommand: command(brain.switchCommand, ['cswap', 'switch'], 'brain.switchCommand'), model, skipPermissions, maxTurnMinutes }, judgment: { file }, requiresApproval };
}
