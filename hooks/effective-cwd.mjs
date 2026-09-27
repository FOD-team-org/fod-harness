import { basename, resolve, isAbsolute, dirname } from 'node:path';
import { statSync, realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { commandWords } from './shell-commands.mjs';
import { withoutRedirects } from './write-paths.mjs';
import { unquoted } from './shell-parts.mjs';

// Same existing-ancestor and dangling-link semantics as pretooluse's resolvePath.
// Unlike normalizePath this throws to the caller's local unknown/fail-closed guard.
export function canonicalMemberPath(value, depth = 0) {
  if (depth > 40) throw new Error('symlink cycle');
  let current = resolve(value); const tail = [];
  for (;;) {
    try { return resolve(realpathSync.native(current), ...tail); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) return canonicalMemberPath(resolve(dirname(current), readlinkSync(current), ...tail), depth + 1);
      } catch (statError) { if (!['ENOENT', 'ENOTDIR'].includes(statError.code)) throw statError; }
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(basename(current)); current = parent;
    }
  }
}

export function expandKnown(value, cwd, home = process.env.HOME ?? '~') {
  return value.replace(/^~(?=\/|$)/, home).replace(/\$(?:HOME\b|\{HOME\})/g, home)
    .replace(/\$(?:PWD\b|\{PWD\}|\(pwd\))/g, cwd);
}
export const dynamicPath = value => /[$`*?\[{]/.test(value) || /^~/.test(value);
// Resolve '..' after the preceding symlink, retaining the logical interpretation too.
export function pathCandidates(value, cwd, home, literal = false) {
  const result = { cwds: [], unknown: false };
  try {
    const expanded = literal ? value : expandKnown(value, cwd, home);
    if (!literal && dynamicPath(expanded)) return { cwds: [], unknown: true };
    result.cwds.push(resolve(cwd, expanded));
    let current = isAbsolute(expanded) ? '/' : cwd;
    for (const part of expanded.split('/')) {
      if (!part || part === '.') continue;
      current = part === '..' ? dirname(canonicalMemberPath(current)) : resolve(current, part);
    }
    result.cwds.push(canonicalMemberPath(current));
  } catch { result.unknown = true; }
  result.cwds = [...new Set(result.cwds)];
  return result;
}

// Skip only proved syntax duplicates; existing guards still inspect all entries.
export function syntaxFragment(entry, next) {
  const words = withoutRedirects(entry.words), raw = withoutRedirects(entry.rawWords);
  if (!words.length || words.every(w => ['{', '}', 'fi', 'done', 'esac', 'then', 'else', 'do', '!'].includes(w))) return true;
  if (['for', 'select', 'case'].includes(words[0]) || words.length === 1 && /^\(\(.*\)\)$/.test(words[0])) return true;
  if (!next) return false;
  const stripped = [...words], tokens = [...raw];
  while (stripped.length) {
    if (['if', 'elif', 'while', 'until', 'then', 'else', 'do', '!', '{'].includes(stripped[0]) && unquoted(tokens[0] ?? '') === stripped[0]
      || /^[A-Za-z_][A-Za-z_0-9]*\(\)\{?$/.test(unquoted(tokens[0] ?? ''))) { stripped.shift(); tokens.shift(); }
    else if (unquoted(tokens[0] ?? '').startsWith('(')) { stripped[0] = stripped[0].replace(/^\(+/, ''); tokens[0] = tokens[0].replace(/^\(+/, ''); if (!stripped[0]) { stripped.shift(); tokens.shift(); } }
    else break;
  }
  if (tokens.length && /(?:\)|;;)$/.test(unquoted(tokens.at(-1)))) stripped[stripped.length - 1] = stripped.at(-1).replace(/(?:\)+|;;)$/, '');
  if (stripped.at(-1) === '') stripped.pop();
  return JSON.stringify(stripped) !== JSON.stringify(words) && JSON.stringify(stripped) === JSON.stringify(withoutRedirects(next.words));
}

export function possibleCwds(entries, cwd, { home = process.env.HOME, workspace = false, cdpath = process.env.CDPATH } = {}) {
  const found = new Set([cwd]); let unknown = false;
  try {
    const operations = [];
    for (const [index, entry] of entries.entries()) {
      const words = withoutRedirects(entry.words), args = commandWords(words), exe = basename(args[0] ?? '');
      if (words.some((w, i) => basename(w) === 'env' && words.slice(i + 1).some(v => v === '-S' || v.startsWith('-S') || v === '--split-string' || v.startsWith('--split-string=')))) unknown = true;
      // Settings anywhere in the parsed line can change the meaning of cd,
      // including assignments inside substitutions and nested shell commands.
      if (words.some(w => w.startsWith('CDPATH='))
        || words.some((w, i) => ['export', 'declare', 'typeset', 'local', 'readonly'].includes(w)
          && words.slice(i + 1).some(v => /^CDPATH(?:=|$)/.test(v)))
        || (exe === 'setopt' || exe === 'set' && args.includes('-o'))
          && args.slice(1).some(w => ['cdablevars', 'autocd'].includes(w.replaceAll('_', '').toLowerCase()))) unknown = true;
      if (syntaxFragment(entry, entries[index + 1])) continue;
      if (['cd', 'pushd'].includes(exe)) {
        const operands = args.slice(1).filter(w => !['-P', '-L', '-e', '-@', '--'].includes(w));
        if (operands.length > 1 || operands[0] === '-' || exe === 'pushd' && (!operands.length || /^[+-]\d+$/.test(operands[0]))) { unknown = true; continue; }
        operations.push({ value: operands[0] ?? home ?? '~', auto: false });
      } else if (words.length === 1 && exe !== 'popd') operations.push({ value: words[0], auto: true });
    }
    // AUTO_CD operations are admitted only when a directory is reachable from a
    // current candidate. They do not consume the seven-cd budget merely as words.
    const active = new Set(operations.flatMap((op, i) => !op.auto ? [i] : []));
    if (active.size >= 7) return { cwds: [...found], unknown: true };
    // Cache only within this call: filesystem state must not survive hook events.
    const pathCache = new Map(), directoryCache = new Map();
    const pathsFor = (value, base) => {
      const key = JSON.stringify([base, value]);
      if (!pathCache.has(key)) pathCache.set(key, pathCandidates(value, base, home));
      return pathCache.get(key);
    };
    const directoryFor = (value, base) => {
      const key = JSON.stringify([base, value]);
      if (!directoryCache.has(key)) directoryCache.set(key, pathsFor(value, base).cwds.some(path => {
        try { return statSync(path).isDirectory(); } catch { return false; }
      }));
      return directoryCache.get(key);
    };
    let expansions = 0;
    const queue = [{ cwd, used: new Set() }], seen = new Set();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      for (const [i, op] of operations.entries()) {
        if (current.used.has(i)) continue;
        if (++expansions > 2000) return { cwds: [...found], unknown: true };
        const value = expandKnown(op.value, current.cwd, home);
        if (op.auto) {
          if (!directoryFor(value, current.cwd)) continue;
          active.add(i); if (active.size >= 7) return { cwds: [...found], unknown: true };
        }
        if (workspace && cdpath && !/^(?:\.{1,2}$|\/|\.\/|\.\.\/)/.test(value)) unknown = true;
        const paths = pathsFor(value, current.cwd); unknown ||= paths.unknown;
        for (const path of paths.cwds) {
          found.add(path); if (found.size > 64) return { cwds: [...found], unknown: true };
          const used = new Set([...current.used, i]), key = JSON.stringify([path, [...used].sort((a, b) => a - b)]);
          if (!seen.has(key)) { seen.add(key); queue.push({ cwd: path, used }); }
        }
      }
    }
  } catch { unknown = true; }
  return { cwds: [...found], unknown };
}

export function commandCwds(words, set) {
  let result = { cwds: [...set.cwds], unknown: set.unknown };
  try {
    const clean = withoutRedirects(words), normalized = commandWords(clean);
    const prefixLength = clean.length - normalized.length;
    for (let i = 0; i < prefixLength; i++) {
      if (basename(clean[i]) !== 'env') continue;
      for (i++; i < prefixLength; i++) {
        const word = clean[i]; let value;
        if (['-C', '--chdir'].includes(word)) value = clean[++i];
        else if (word.startsWith('--chdir=')) value = word.slice(8);
        else if (word.startsWith('-C') && word.length > 2) value = word.slice(2);
        if (value !== undefined) {
          const candidates = result.cwds.map(c => pathCandidates(value, c));
          result = { cwds: [...new Set(candidates.flatMap(c => c.cwds))], unknown: result.unknown || candidates.some(c => c.unknown) };
          if (!result.cwds.length) result.cwds = [...set.cwds];
        }
      }
    }
  } catch { result.unknown = true; }
  return result;
}

export function gitTargets(words, set) {
  const result = commandCwds(words, set);
  let action, args = [], invalidGlobal = false;
  try {
    const command = commandWords(withoutRedirects(words));
    if (command.length === 2 && ['--version', '--help', '-h'].includes(command[1])) return { ...result, action: undefined, args, invalidGlobal: false };
    for (let i = 1; i < command.length; i++) {
      const word = command[i];
      if (word === '-C') {
        const value = command[++i];
        if (value === undefined) { result.unknown = true; continue; }
        const candidates = result.cwds.map(c => pathCandidates(value, c));
        result.unknown ||= candidates.some(c => c.unknown);
        const paths = [...new Set(candidates.flatMap(c => c.cwds))];
        if (paths.length) result.cwds = paths;
      } else if (['--no-pager', '-P', '--no-optional-locks'].includes(word)) continue;
      else if (word.startsWith('-')) {
        invalidGlobal = true;
        if (/^--(?:git-dir|work-tree)(?:=|$)/.test(word)) result.unknown = true;
        if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(word)) i++;
      } else { action = word; args = command.slice(i + 1); break; }
    }
  } catch { result.unknown = true; }
  return { ...result, action, args, invalidGlobal };
}
