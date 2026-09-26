import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { canonicalPath } from './temp-paths.mjs';
import { globRegex } from './path-patterns.mjs';

export const defaultReadDeny = ['.env', '.env.*', '*.pem', '*.p8', '*.p12', '*.key', '*.jks', '*.keystore', 'key.properties',
  '~/.ssh/*', '~/.aws/credentials', '~/.netrc', '~/.codex/auth.json', '~/.pi/agent/auth.json', '~/.claude/.credentials.json', '~/.config/gh/hosts.yml'];
export const defaultReadAllow = ['.env.example', '.env.sample', '.env.template', '.env.*.example', '~/.ssh/*.pub', '~/.ssh/known_hosts'];
export function secretSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('secrets 설정은 객체여야 합니다');
  const defaults = value.defaults === undefined ? true : value.defaults;
  if (typeof defaults !== 'boolean') throw new Error('secrets.defaults는 불리언이어야 합니다');
  const list = (key, base) => {
    const values = value[key] === undefined ? [] : value[key];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.trim() || /[\0\r\n]/.test(v) || !globRegex(v))) throw new Error(`secrets.${key}는 글롭 문자열 배열이어야 합니다`);
    return [...new Set([...(defaults ? base : []), ...values])];
  };
  return { defaults, readDeny: list('readDeny', defaultReadDeny), readAllow: list('readAllow', defaultReadAllow) };
}
const key = value => process.platform === 'darwin' ? value.toLowerCase() : value;
export function secretPolicy(root, settings = {}, home = process.env.HOME || homedir()) {
  const config = secretSettings(settings);
  const compile = pattern => {
    if (!pattern.includes('/')) return { basename: true, regex: globRegex(pattern) };
    const path = pattern.startsWith('~/') ? resolve(home, pattern.slice(2)) : resolve(root, pattern);
    // Canonicalize only the static prefix. Wildcard directories are matched without following them.
    const prefix = path.split(/[*?\[]/, 1)[0];
    const base = prefix === path ? path : dirname(prefix.endsWith('/') ? prefix + '_' : prefix);
    return { basename: false, regex: globRegex(resolve(canonicalPath(base), '.' + path.slice(base.length))) };
  };
  const deny = config.readDeny.map(compile), allow = config.readAllow.map(compile);
  const matches = (rules, path) => rules.some(rule => rule.regex?.test(rule.basename ? basename(path) : path));
  const secretPath = path => {
    let actual;
    try { actual = key(canonicalPath(path)); } catch { return false; }
    return matches(deny, actual) && !matches(allow, actual);
  };
  const basenameDenied = name => config.readDeny.filter(p => !p.includes('/')).some(p => globRegex(p)?.test(name))
    && !config.readAllow.filter(p => !p.includes('/')).some(p => globRegex(p)?.test(name));
  return { ...config, secretPath, basenameDenied };
}

// Bounded filename-only walk. Never read file contents or follow directory symlinks.
export function scanSecretFiles(directory, policy, { depth = 8, limit = 20000, skip = ['.git', 'node_modules'], excludeDir = () => false, pruneDirectories = () => new Set() } = {}) {
  const files = []; let count = 0, pending = [directory];
  for (let level = 0; pending.length && level <= depth; level++) {
    const directories = [];
    for (const dir of pending) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++count > limit) return { files, exceeded: true };
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (level < depth && !skip.includes(entry.name) && !excludeDir(entry.name, path)) directories.push(path);
        } else if (policy.secretPath(path)) files.push(path);
      }
    }
    // One batched ignore query per level; ignored dependency trees are never walked.
    const ignored = directories.length ? pruneDirectories(directories) : new Set();
    pending = directories.filter(path => !ignored.has(path));
  }
  return { files, exceeded: false };
}

// Shell glob expansion respects the leading-dot rule for every path component.
export function expandSecretGlob(path, limit = 20000) {
  let paths = ['/'], count = 0;
  for (const part of resolve(path).split('/').filter(Boolean)) {
    if (!/[*?\[]/.test(part)) { paths = paths.map(p => resolve(p, part)); continue; }
    const pattern = globRegex(part), next = [];
    for (const parent of paths) {
      let names; try { names = readdirSync(parent); } catch { continue; }
      for (const name of names) {
        if (++count > limit) throw new Error('glob limit');
        if ((!name.startsWith('.') || part.startsWith('.')) && pattern?.test(name)) next.push(resolve(parent, name));
      }
    }
    paths = next;
  }
  return paths;
}
export function directoryExists(path) { try { return statSync(path).isDirectory(); } catch { return false; } }

// Intersection of two basename glob NFAs, with epsilon edges for '*'.
// Leading dots require a literal dot at the beginning of both patterns.
export function globsOverlap(left, right) {
  const tokens = pattern => pattern.match(/\[[^\]]+\]|[^]/gu) ?? [];
  const a = tokens(left), b = tokens(right), seen = new Set(), queue = [[0, 0, true]];
  const alphabet = [...new Set([...left, ...right, ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'])].filter(c => c !== '/');
  const accepts = (token, char) => token === '*' || token === '?' || globRegex(token)?.test(char);
  while (queue.length) {
    const [i, j, first] = queue.pop(), id = `${i}:${j}:${first}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (i === a.length && j === b.length) return true;
    if (a[i] === '*') queue.push([i + 1, j, first]);
    if (b[j] === '*') queue.push([i, j + 1, first]);
    if (i < a.length && j < b.length && alphabet.some(c => (!first || c !== '.' || a[0] === '.' && b[0] === '.') && accepts(a[i], c) && accepts(b[j], c))) queue.push([i + (a[i] !== '*'), j + (b[j] !== '*'), false]);
  }
  return false;
}
