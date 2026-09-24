import { assertNotBrain } from './brain-guard.ts';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { commandParts } from '../provider/runner.ts';
import { isAbsolute, relative, resolve } from 'node:path';
import { atomicWrite, harnessPath, readJson, withFileLock } from './storage.ts';
import { notify as sendNotification } from './notify.ts';

export const bundledSkills = ['fodh-workflow', 'fodh-spec-writing', 'fodh-review-checklist', 'fodh-judgment'];
export interface HarnessConfig {
  interview: { enforce: boolean; roundSize: number; maxAsks: number; extraBankFile: string };
  docs: { root: string; overrideDir: string };
  skills: { target: string; install: string[] };
  claudeMd: { targets: ('CLAUDE.md' | 'AGENTS.md')[] };
  brain: {
    command: string | string[]; switchCommand: string | string[]; model: string;
    skipPermissions: boolean; allowPlugins: boolean; maxTurnMinutes: number; doctorTtlHours: number; rotateAtTokens: number;
  };
  delegate: {
    claude: { subagentModel: string; maxChildAgents: number };
    route: Record<string, 'codex' | 'claude'>;
    codex: {
      command: string | string[]; sandbox: 'workspace-write' | 'read-only'; timeoutMinutes: number; waitMinutes: number;
      brainModel: string; brainEffort: string; workerModel: string; workerEffort: string; maxChildAgents: number;
    };
  };
  cleanup: { rebuildablePaths: string[]; keepPaths: string[]; sharedCaches: { enabled: boolean; paths: string[] }; codexRunsKeep: number;
    processes: { neverKill: string[]; killPatterns: string[] }; swapWarnGB: number };
  verify: { commands: string[]; heavy: string[]; timeoutMinutes: number };
  notify: { channels: ('tui' | 'macos' | 'slack' | 'ledger')[] };
  budget: { dailyTurns: number; dailyHours: number };
  worktrees: { root: string; prefix: string };
  watch: { stallMinutes: number; childTimeoutMinutes: number; pollSeconds: number; stableSeconds: number; freeTextStableSeconds: number; tickSeconds: number };
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

const warnedKeysHash = new Map<string, string>();
export async function loadConfig(root: string, candidate?: unknown, options: { dryRun?: boolean } = {}): Promise<HarnessConfig> {
  const raw = object(candidate === undefined ? await readJson<unknown>(harnessPath(root, 'harness.json'), {}) : candidate, '하네스');
  const brain = object(defaultValue(raw.brain, {}), 'brain');
  const judgment = object(defaultValue(raw.judgment, {}), 'judgment');
  const watch = object(defaultValue(raw.watch, {}), 'watch');
  const watching = {
    stallMinutes: positive(defaultValue(watch.stallMinutes, 10), 'watch.stallMinutes', true),
    childTimeoutMinutes: positive(defaultValue(watch.childTimeoutMinutes, 90), 'watch.childTimeoutMinutes', true),
    pollSeconds: positive(defaultValue(watch.pollSeconds, 5), 'watch.pollSeconds'),
    freeTextStableSeconds: positive(defaultValue(watch.freeTextStableSeconds, 60), 'watch.freeTextStableSeconds'),
    stableSeconds: positive(defaultValue(watch.stableSeconds, 10), 'watch.stableSeconds'),
    tickSeconds: positive(defaultValue(watch.tickSeconds, 30), 'watch.tickSeconds'),
  };
  const model = defaultValue(brain.model, 'fable');
  const skipPermissions = defaultValue(brain.skipPermissions, true);
  const allowPlugins = defaultValue(brain.allowPlugins, false);
  if (typeof allowPlugins !== 'boolean') throw new Error('brain.allowPlugins는 불리언이어야 합니다');
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
  const route = { design: 'claude', default: 'codex', ...object(defaultValue(delegate.route, {}), 'delegate.route') };
  for (const [key, value] of Object.entries(route)) {
    if (!['design', 'non-design', 'docs', 'research', 'default'].includes(key) || typeof value !== 'string' || !['codex', 'claude'].includes(value)) {
      throw new Error('delegate.route는 백로그 분류 또는 default 키와 codex, claude 값이어야 합니다');
    }
  }
  const sandbox = defaultValue(codex.sandbox, 'workspace-write');
  if (sandbox !== 'workspace-write' && sandbox !== 'read-only') throw new Error('delegate.codex.sandbox는 workspace-write, read-only 중 하나여야 합니다');
  const wt = object(defaultValue(raw.worktrees, {}), 'worktrees');
  const wtRoot = defaultValue(wt.root, '..'), prefix = defaultValue(wt.prefix, 'wt-');
  if (typeof wtRoot !== 'string' || !wtRoot.trim() || isAbsolute(wtRoot) || /[\r\n\0]/u.test(wtRoot)) throw new Error('worktrees.root는 상대 경로여야 합니다');
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(prefix)) throw new Error('worktrees.prefix는 [A-Za-z0-9_-]+ 이어야 합니다');
  const delegation: HarnessConfig['delegate'] = {
    route: route as HarnessConfig['delegate']['route'],
    claude: { subagentModel: modelName(defaultValue(claude.subagentModel, 'opus'), 'delegate.claude.subagentModel'),
      maxChildAgents: nonnegativeInteger(defaultValue(claude.maxChildAgents, 1), 'delegate.claude.maxChildAgents') },
    codex: {
      command: command(codex.command, 'codex', 'delegate.codex.command'), sandbox,
      waitMinutes: positive(defaultValue(codex.waitMinutes, 8), 'delegate.codex.waitMinutes', true),
      timeoutMinutes: positive(defaultValue(codex.timeoutMinutes, 90), 'delegate.codex.timeoutMinutes', true),
      brainModel: modelName(defaultValue(codex.brainModel, 'gpt-6-astra'), 'delegate.codex.brainModel'),
      brainEffort: effort(defaultValue(codex.brainEffort, 'xhigh'), 'delegate.codex.brainEffort'),
      workerModel: modelName(defaultValue(codex.workerModel, 'gpt-6-sol'), 'delegate.codex.workerModel'),
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
  const cleanup = object(defaultValue(raw.cleanup, {}), 'cleanup');
  const processes = object(defaultValue(cleanup.processes, {}), 'cleanup.processes');
  const caches = object(defaultValue(cleanup.sharedCaches, {}), 'cleanup.sharedCaches');
  const verify = object(defaultValue(raw.verify, {}), 'verify');
  const notify = object(defaultValue(raw.notify, {}), 'notify');
  const budget = object(defaultValue(raw.budget, {}), 'budget');
  const strings = (value: unknown, fallback: string[], label: string): string[] => {
    const list = defaultValue(value, fallback);
    if (!Array.isArray(list) || list.some(v => typeof v !== 'string' || !v.trim() || /[\0\r\n]/u.test(v))) throw new Error(`${label}는 문자열 배열이어야 합니다`);
    return list;
  };
  const commands = (value: unknown, label: string) => strings(value, [], label).map(cmd => { commandParts(cmd); return cmd; });
  const channels = strings(notify.channels, ['tui', 'macos'], 'notify.channels');
  if (channels.some(c => !['tui', 'macos', 'slack', 'ledger'].includes(c))) throw new Error('notify.channels는 tui|macos|slack|ledger만 허용합니다');
  const enabled = defaultValue(caches.enabled, false);
  if (typeof enabled !== 'boolean') throw new Error('cleanup.sharedCaches.enabled는 불리언이어야 합니다');
  const interview = object(defaultValue(raw.interview, {}), 'interview');
  const docs = object(defaultValue(raw.docs, {}), 'docs');
  const skills = object(defaultValue(raw.skills, {}), 'skills');
  const claudeMd = object(defaultValue(raw.claudeMd, {}), 'claudeMd');
  const enforce = defaultValue(interview.enforce, true);
  if (typeof enforce !== 'boolean') throw new Error('interview.enforce는 불리언이어야 합니다');
  const bounded = (value: unknown, fallback: number, low: number, high: number, key: string): number => {
    const n = defaultValue(value, fallback);
    if (typeof n !== 'number' || !Number.isInteger(n) || n < low || n > high) throw new Error(`${key}는 ${low}~${high} 사이 정수여야 합니다`);
    return n;
  };
  const internal = (value: unknown, fallback: string, key: string): string => {
    const v = defaultValue(value, fallback);
    if (typeof v !== 'string' || !v.trim() || /[\0\r\n]/u.test(v) || isAbsolute(v) || relative(resolve(root), resolve(root, v)).startsWith('..')) throw new Error(`${key}은 프로젝트 내부 상대 경로여야 합니다`);
    return v;
  };
  const docsRoot = internal(docs.root, 'docs', 'docs.root');
  const docsPathKey = (path: string) => process.platform === 'darwin' ? path.toLowerCase() : path;
  const docsTarget = docsPathKey(resolve(root, docsRoot));
  if (docsTarget === docsPathKey(resolve(root)) || ['.pi', '.git', '.claude'].some(name => {
    const protectedPath = docsPathKey(resolve(root, name));
    return protectedPath === docsTarget || protectedPath.startsWith(docsTarget + '/');
  })) throw new Error('docs.root은 프로젝트 루트나 .pi·.git·.claude의 조상 또는 그 자체일 수 없습니다');

  const protectedInternal = (value: unknown, fallback: string, key: string): string => {
    const path = internal(value, fallback, key), target = resolve(root, path), docsPath = resolve(root, docsRoot);
    const overlaps = target === docsPath || target.startsWith(docsPath + '/') || docsPath.startsWith(target + '/');
    if (target === resolve(root) || overlaps) {
      throw new Error(`${key}은 .pi/ 아래 또는 docs.root와 겹치지 않는 경로여야 합니다(프로젝트 루트·docs.root 조상 금지)`);
    }
    return path;
  };
  const install = strings(skills.install, bundledSkills, 'skills.install');
  for (const name of install) if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name) || !existsSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url))) throw new Error(`skills.install 에 없는 스킬: ${name}`);
  const targets = strings(claudeMd.targets, ['CLAUDE.md'], 'claudeMd.targets');
  if (!targets.length || new Set(targets).size !== targets.length || targets.some(t => !['CLAUDE.md', 'AGENTS.md'].includes(t))) throw new Error('claudeMd.targets는 CLAUDE.md·AGENTS.md의 중복 없는 비어 있지 않은 배열이어야 합니다');
  const config: HarnessConfig = {
    interview: { enforce, roundSize: bounded(interview.roundSize, 6, 5, 8, 'interview.roundSize'), maxAsks: bounded(interview.maxAsks, 2, 1, 5, 'interview.maxAsks'), extraBankFile: protectedInternal(interview.extraBankFile, '.pi/interview-bank.md', 'interview.extraBankFile') },
    docs: { root: docsRoot, overrideDir: protectedInternal(docs.overrideDir, '.pi/templates/docs', 'docs.overrideDir') },
    skills: { target: internal(skills.target, '.claude/skills', 'skills.target'), install },
    claudeMd: { targets: targets as HarnessConfig['claudeMd']['targets'] },
    brain: {
      command: command(brain.command, 'claude', 'brain.command'),
      switchCommand: command(brain.switchCommand, ['cswap', 'switch'], 'brain.switchCommand'),
      model, skipPermissions, allowPlugins, maxTurnMinutes, doctorTtlHours, rotateAtTokens,
    },
    cleanup: { rebuildablePaths: strings(cleanup.rebuildablePaths, [], 'cleanup.rebuildablePaths'), keepPaths: strings(cleanup.keepPaths, [], 'cleanup.keepPaths'),
      sharedCaches: { enabled, paths: strings(caches.paths, [], 'cleanup.sharedCaches.paths') }, codexRunsKeep: nonnegativeInteger(defaultValue(cleanup.codexRunsKeep, 20), 'cleanup.codexRunsKeep'),
      processes: { neverKill: strings(processes.neverKill, ['nest start --watch', 'qemu-system', 'Simulator', 'ChatGPT'], 'cleanup.processes.neverKill'),
        killPatterns: strings(processes.killPatterns, ['jest', 'flutter_tester', 'GradleDaemon'], 'cleanup.processes.killPatterns') },
      swapWarnGB: atLeast(defaultValue(cleanup.swapWarnGB, 8), 'cleanup.swapWarnGB', 3) },
    verify: { commands: commands(verify.commands, 'verify.commands'), heavy: commands(verify.heavy, 'verify.heavy'), timeoutMinutes: positive(defaultValue(verify.timeoutMinutes, 30), 'verify.timeoutMinutes') },
    notify: { channels: channels as HarnessConfig['notify']['channels'] },
    budget: { dailyTurns: positive(defaultValue(budget.dailyTurns, 200), 'budget.dailyTurns', true), dailyHours: positive(defaultValue(budget.dailyHours, 20), 'budget.dailyHours') },
    delegate: delegation, worktrees: { root: wtRoot, prefix }, watch: watching, judgment: { file }, requiresApproval,
  };
  const unknown = Object.keys(raw).filter(key => !Object.hasOwn(config, key) && key !== 'maxAutoTurns');
  for (const [prefix, values, known] of [
    ['brain', brain, config.brain], ['delegate.codex', codex, config.delegate.codex],
    ['verify', verify, config.verify], ['docs', docs, config.docs],
    ['skills', skills, config.skills], ['notify', notify, config.notify],
  ] as const) {
    unknown.push(...Object.keys(values).filter(key => !Object.hasOwn(known, key)).map(key => `${prefix}.${key}`));
  }
  const warnedPath = harnessPath(root, 'harness-config-warned.json');
  const cacheKey = resolve(warnedPath);
  const keysHash = unknown.length ? createHash('sha256').update(JSON.stringify(unknown.sort())).digest('hex') : '';
  if (!options.dryRun && warnedKeysHash.get(cacheKey) !== keysHash) {
    try {
      if (!unknown.length && !existsSync(warnedPath)) { warnedKeysHash.set(cacheKey, keysHash); return config; }
      const shouldNotify = await withFileLock(warnedPath, async () => {
        // A concurrent load may have completed while this call waited for the lock.
        if (warnedKeysHash.get(cacheKey) === keysHash) return false;
        if (!unknown.length) {
          await unlink(warnedPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
          warnedKeysHash.set(cacheKey, keysHash);
          return false;
        }
        if ((await readJson<{ keysHash: string } | undefined>(warnedPath, undefined))?.keysHash === keysHash) {
          warnedKeysHash.set(cacheKey, keysHash); return false;
        }
        await atomicWrite(warnedPath, JSON.stringify({ keysHash, at: new Date().toISOString() }) + '\n');
        warnedKeysHash.set(cacheKey, keysHash);
        return true;
      });
      if (shouldNotify) await sendNotification(root, { key: 'config:unknown-key', level: 'warning', title: '하네스 설정',
        body: `알 수 없는 설정 키: ${unknown.join(', ')}` }, undefined, { config, dedupe: false });
    } catch { /* A diagnostic must not turn otherwise valid configuration into an error. */ }
  }
  return config;
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
export const approvalConfigKeys = ['delegate.codex.command', 'brain.command', 'brain.switchCommand', 'delegate.codex.sandbox'];
export async function setConfig(root: string, key: string, text: string,
  options: { fromCli?: boolean; approve?: boolean } = {}): Promise<unknown> {
  await assertNotBrain(root, `config set ${key}`);
  if (options.fromCli && !options.approve && approvalConfigKeys.some(k => k === key || k.startsWith(`${key}.`))) {
    throw new Error(`승인 전용 키입니다: ${key}. --approve 를 붙여 사용자 터미널에서 실행하세요`);
  }
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
    await loadConfig(root, raw, { dryRun: true });
    await atomicWrite(path, JSON.stringify(raw, null, 2) + '\n');
    return value;
  });
}

function defaultValue(value: unknown, fallback: unknown): unknown { return value === undefined ? fallback : value; }

function positive(value: unknown, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || integer && !Number.isSafeInteger(value)) {
    throw new Error(`${label}는 ${integer ? '양의 정수' : '양수'}여야 합니다`);
  }
  return value;
}

function atLeast(value: unknown, label: string, minimum: number): number {
  const number = positive(value, label);
  if (number < minimum) throw new Error(`${label}는 ${minimum} 이상이어야 합니다`);
  return number;
}
