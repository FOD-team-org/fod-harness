import { isAbsolute, relative, resolve } from 'node:path';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';

export interface HarnessConfig {
  brain: {
    command: string | string[]; switchCommand: string | string[]; model: string;
    skipPermissions: boolean; maxTurnMinutes: number; doctorTtlHours: number; rotateAtTokens: number;
  };
  delegate: {
    claude: { subagentModel: string };
    codex: {
      brainModel: string; brainEffort: string; workerModel: string; workerEffort: string; maxChildAgents: number;
    };
  };
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
  if (Array.isArray(result) && result.length > 0
    && result.every(part => typeof part === 'string' && part.length > 0 && !part.includes('\0'))) {
    return result as string[];
  }
  throw new Error(`${label} 명령이 올바르지 않습니다`);
}

export async function loadConfig(root: string, candidate?: unknown): Promise<HarnessConfig> {
  const raw = object(candidate === undefined ? await readJson<unknown>(harnessPath(root, 'harness.json'), {}) : candidate, '하네스');
  const brain = object(defaultValue(raw.brain, {}), 'brain');
  const judgment = object(defaultValue(raw.judgment, {}), 'judgment');
  const model = defaultValue(brain.model, 'fable');
  const skipPermissions = defaultValue(brain.skipPermissions, true);
  const maxTurnMinutes = defaultValue(brain.maxTurnMinutes, 45);
  if (typeof model !== 'string' || !['fable', 'opus', 'sonnet', 'haiku'].includes(model)) {
    throw new Error('brain.model은 fable, opus, sonnet, haiku 중 하나여야 합니다');
  }
  if (typeof skipPermissions !== 'boolean') throw new Error('brain.skipPermissions는 불리언이어야 합니다');
  if (typeof maxTurnMinutes !== 'number' || !Number.isFinite(maxTurnMinutes) || maxTurnMinutes <= 0) {
    throw new Error('brain.maxTurnMinutes는 양수여야 합니다');
  }
  const doctorTtlHours = defaultValue(brain.doctorTtlHours, 12);
  if (typeof doctorTtlHours !== 'number' || !Number.isFinite(doctorTtlHours) || doctorTtlHours <= 0) {
    throw new Error('brain.doctorTtlHours는 양수여야 합니다');
  }
  const rotateAtTokens = nonnegativeInteger(defaultValue(brain.rotateAtTokens, 0), 'brain.rotateAtTokens');
  const delegate = object(defaultValue(raw.delegate, {}), 'delegate');
  const claude = object(defaultValue(delegate.claude, {}), 'delegate.claude');
  const codex = object(defaultValue(delegate.codex, {}), 'delegate.codex');
  const delegation = {
    claude: { subagentModel: modelName(defaultValue(claude.subagentModel, 'opus'), 'delegate.claude.subagentModel') },
    codex: {
      brainModel: modelName(defaultValue(codex.brainModel, 'gpt-6-astra'), 'delegate.codex.brainModel'),
      brainEffort: effort(defaultValue(codex.brainEffort, 'xhigh'), 'delegate.codex.brainEffort'),
      workerModel: modelName(defaultValue(codex.workerModel, 'gpt-5.6-sol'), 'delegate.codex.workerModel'),
      workerEffort: effort(defaultValue(codex.workerEffort, 'xhigh'), 'delegate.codex.workerEffort'),
      maxChildAgents: nonnegativeInteger(defaultValue(codex.maxChildAgents, 1), 'delegate.codex.maxChildAgents'),
    },
  };
  const file = judgment.file ?? 'docs/판단대기.md';
  if (typeof file !== 'string' || !file.trim() || isAbsolute(file)
    || relative(resolve(root), resolve(root, file)).startsWith('..')) {
    throw new Error('judgment.file은 프로젝트 내부 상대 경로여야 합니다');
  }
  const requiresApproval = raw.requiresApproval ?? [
    'prod-migration', 'store-upload', 'payment', 'push-main', 'env-delete', 'external-send',
  ];
  if (!Array.isArray(requiresApproval) || requiresApproval.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('requiresApproval은 문자열 배열이어야 합니다');
  }
  return {
    brain: {
      command: command(brain.command, 'claude', 'brain.command'),
      switchCommand: command(brain.switchCommand, ['cswap', 'switch'], 'brain.switchCommand'),
      model, skipPermissions, maxTurnMinutes, doctorTtlHours, rotateAtTokens,
    },
    delegate: delegation, judgment: { file }, requiresApproval,
  };
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}는 0 이상의 정수여야 합니다`);
  return value;
}
function modelName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}은 비어 있지 않은 문자열이어야 합니다`);
  return value;
}
function effort(value: unknown, label: string): string {
  if (typeof value !== 'string' || !['low', 'medium', 'high', 'xhigh'].includes(value)) {
    throw new Error(`${label}은 low, medium, high, xhigh 중 하나여야 합니다`);
  }
  return value;
}
function keyParts(key: string): string[] {
  const parts = key.split('.');
  if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error('점 표기 설정 키가 올바르지 않습니다');
  }
  return parts;
}
function mergeDefaults(raw: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...raw };
  for (const [key, value] of Object.entries(defaults)) {
    const current = raw[key];
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeDefaults(current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {},
        value as Record<string, unknown>) : value;
  }
  return merged;
}
export async function getConfig(root: string, key?: string): Promise<unknown> {
  const raw = object(await readJson(harnessPath(root, 'harness.json'), {}), '하네스');
  const loaded = await loadConfig(root, raw);
  let value: unknown = mergeDefaults(raw, loaded as unknown as Record<string, unknown>);
  if (key !== undefined) for (const part of keyParts(key)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('설정 키를 찾을 수 없습니다');
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export async function setConfig(root: string, key: string, text: string): Promise<unknown> {
  const parts = keyParts(key), path = harnessPath(root, 'harness.json');
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = text; }
  return withFileLock(path, async () => {
    const raw = object(await readJson(path, {}), '하네스');
    let parent = raw;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part)) parent[part] = {};
      parent = object(parent[part], parts.join('.'));
    }
    parent[parts.at(-1)!] = value;
    await loadConfig(root, raw);
    await atomicWrite(path, JSON.stringify(raw, null, 2) + '\n');
    return value;
  });
}

function defaultValue(value: unknown, fallback: unknown): unknown { return value === undefined ? fallback : value; }
