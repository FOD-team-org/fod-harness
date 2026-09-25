import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve, dirname, basename, sep, isAbsolute } from 'node:path';
import { shellParts } from './shell-parts.mjs';
import { shellCommands, commandWords } from './shell-commands.mjs';

// No shell evaluation. Resolve existing ancestors so a temporary symlink cannot escape the guard.
export function canonicalPath(value) {
  let path = resolve(value), tail = [];
  for (;;) {
    try { return resolve(realpathSync(path), ...tail); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      tail.unshift(basename(path)); path = parent;
    }
  }
}
// $$ is the only shell expansion with a fixed, path-safe (numeric) shape.
export function literalTempPath(value) {
  const literal = value.replace(/\$\$/g, '12345');
  return /[$`*?\[{}()]/.test(literal) || literal.startsWith('~') ? undefined : literal;
}
export function tempPolicy({ root, worktrees = [], hooks, normalize = canonicalPath }) {
  const key = value => { const p = normalize(value); return process.platform === 'darwin' ? p.toLowerCase() : p; };
  const inside = (a, b) => a === b || a.startsWith(b + sep);
  const bases = [...new Set([tmpdir(), process.env.TMPDIR, '/tmp', '/private/tmp', '/var/tmp'].filter(Boolean).map(key))];
  const project = key(root), trees = worktrees.map(key), hook = hooks && key(hooks);
  const tempSafe = value => {
    const literal = literalTempPath(value);
    if (literal === undefined) return false;
    const path = key(literal);
    return bases.some(base => path !== base && inside(path, base)) && !bases.includes(path)
      && !inside(path, project) && !inside(project, path)
      && !trees.some(tree => inside(tree, path)) && !(hook && inside(path, hook));
  };
  const underTemp = value => bases.some(base => inside(key(value), base));
  return { tempSafe, underTemp };
}
function unquotedAt(text, stop) {
  let quote = '';
  for (let i = 0; i < stop; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; }
    else if ('\'"`'.includes(c)) quote = c;
  }
  return !quote;
}
// Analyze the entire source once, including nested shell strings. Never evaluate shell input.
let previousSource, previousScope;
function tempScope(source) {
  if (source === previousSource) return previousScope;
  const parsed = shellCommands(source);
  const sources = new Set([source, ...parsed.entries.map(entry => entry.source)]);
  const assigned = new Set();
  let uncertain = parsed.heredocs.length > 0 || parsed.unterminatedHeredoc
    || /\(\(|\[\[|\$\{[^}]*=|\$\{\(|\$\{[^}]*\[|\$'|<<<|\bfunction\s|\b[A-Za-z_][A-Za-z_0-9]*\s*\(\s*\)/.test(source);
  uncertain ||= /\b(?:PATH|path|FPATH|fpath|BASH_ENV|ENV|ZDOTDIR|IFS)\s*(?:\+)?=/.test(source);
  for (const text of sources) {
    const parts = shellParts(text.replace(/\$\([^()]*\)|`[^`]*`/g, '$SUBSTITUTION'), { metadata: true });
    uncertain ||= parts.heredocs.length > 0 || parts.unterminatedHeredoc;
    for (let i = 0; i < parts.groups.length; i++) {
      const words = parts.groups[i], args = commandWords(words), executable = basename(args[0] ?? '');
      if (['eval', 'source', '.', 'let', 'read', 'mapfile', 'readarray', 'getopts', 'select', 'coproc', 'trap', 'alias', 'unalias', 'hash', 'enable', 'functions', 'autoload', 'if', 'for', 'while', 'until', 'case'].includes(executable)
        || ['printf', 'print'].includes(executable) && args.some(word => /^-v/.test(word))) uncertain = true;
      // Reuse the scope tokenizer's assignment/declaration and read/for command view.
      for (let j = 0; /^[A-Za-z_][A-Za-z_0-9]*(?:\+)?=/.test(parts.rawGroups[i][j] ?? ''); j++) {
        assigned.add(words[j].split(/[+=]/, 1)[0]);
      }
      if (executable === 'read') for (const name of args.slice(1)) {
        if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) assigned.add(name);
      }
      if (['for', 'select'].includes(executable) && args[2] === 'in' && /^[A-Za-z_][A-Za-z_0-9]*$/.test(args[1] ?? '')) assigned.add(args[1]);
      const declaration = words.findIndex(word => ['export', 'declare', 'typeset', 'local', 'readonly', 'integer', 'float'].includes(word));
      if (declaration >= 0) {
        for (const word of words.slice(declaration + 1)) {
          const match = /^([A-Za-z_][A-Za-z_0-9]*)(?:\+)?=/.exec(word);
          if (match) assigned.add(match[1]);
        }
        if (['declare', 'typeset', 'local'].includes(words[declaration]) && words.slice(declaration + 1).some(word => /^-[^-]*n/.test(word))) uncertain = true;
        if (words.slice(declaration + 1).some(word => /^(?:PATH|path|FPATH|fpath|BASH_ENV|ENV|ZDOTDIR|IFS)(?:=|$)/.test(word))) uncertain = true;
        const offset = declaration;
        const raw = parts.rawGroups[i].slice(offset + 1);
        if (raw.some(word => !word.startsWith('-') && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(word.split('=')[0]))) uncertain = true;
      }
    }
  }
  // Also inspect normalized command positions (control statements and function bodies).
  uncertain ||= parsed.entries.some(({ words }) => ['eval', 'source', '.', 'let', 'read', 'mapfile', 'readarray', 'getopts', 'select', 'coproc', 'trap', 'alias', 'unalias', 'hash', 'enable', 'functions', 'autoload', 'if', 'for', 'while', 'until', 'case'].includes(basename(commandWords(words)[0] ?? '')));
  previousSource = source;
  previousScope = { uncertain, assigned, bare: name => [...source.matchAll(new RegExp('(?<![A-Za-z0-9_])' + name + '(?![A-Za-z0-9_])', 'g'))]
    .filter(match => !/(?:\$|\$\{[#!]?)$/.test(source.slice(0, match.index))) };
  return previousScope;
}
// Message selection only: never grant a temporary-path exception from this information.
export function assignedInCommand(command, name) {
  return !['HOME', 'PWD', 'OLDPWD', 'TMPDIR'].includes(name) && tempScope(command).assigned.has(name);
}
export function tempVariables(command, policy, { wholeCommand = command, enabled = true } = {}) {
  if (!enabled) return () => undefined;
  const scope = tempScope(wholeCommand);
  if (scope.uncertain) return () => undefined;
  const localAssignments = [...command.matchAll(/\b([A-Za-z_][A-Za-z_\d]*)(?:\+)?=/g)];
  const values = new Map();
  const tmpdirChanged = scope.bare('TMPDIR').length > 0;
  for (const match of localAssignments) {
    const name = match[1];
    if (match[0].endsWith('+=')) continue;
    if (scope.bare(name).length !== 1 || !unquotedAt(command, match.index)) continue;
    const before = command.slice(0, match.index);
    if (!/(?:^|[;&|\n])\s*(?:(?:export|local|readonly|declare)\s+)?$/.test(before)) continue;
    if (before.includes('$' + name) || before.includes('${' + name)) continue;
    let value = command.slice(match.index + match[0].length);
    const substitution = /^(?:"?\$\(mktemp\b([^()]*)\)"?|"?`mktemp\b([^`]*)`"?)(?=\s|[;&|]|$)/.exec(value);
    let path;
    if (substitution) {
      if (!/^\s*(?:[;&|]|$)/.test(value.slice(substitution[0].length))) continue;
      const rawArgs = substitution[1] ?? substitution[2];
      if (/[;|&`\n]/.test(rawArgs)) continue;
      if (tmpdirChanged || command !== wholeCommand && /\$(?:\{TMPDIR|TMPDIR\b)/.test(rawArgs)) continue;
      const expanded = rawArgs.replace(/\$\{TMPDIR(?::-([^}]*))?\}|\$TMPDIR\b/g, (_, fallback) => process.env.TMPDIR || fallback || tmpdir());
      if (literalTempPath(expanded) === undefined) continue;
      const args = shellParts(expanded).groups.flat();
      let base = tmpdir(), template, valid = true;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-d' || arg === '-q') continue;
        if (arg === '-t') {
          const prefix = args[++i];
          if (!prefix || /[/\\]/.test(prefix) || prefix.startsWith('-')) valid = false;
        } else if (arg === '-p' || arg === '--tmpdir' || arg.startsWith('--tmpdir=')) {
          base = arg.startsWith('--tmpdir=') ? arg.slice(9) : args[++i];
          if (!base || !isAbsolute(base) || !policy.underTemp(base)) valid = false;
        } else if (arg.startsWith('-') || template) valid = false;
        else template = arg;
      }
      if (template) {
        if (!isAbsolute(template) || !policy.underTemp(template)) valid = false;
        else base = dirname(template);
      }
      if (!valid) continue;
      path = resolve(base, 'fodh-var-' + name);
    } else {
      const literal = /^(?:"([^"$`]+)"|'([^']+)'|([^\s;&|]+))(?=\s|[;&|]|$)/.exec(value);
      if (!literal || !/^\s*(?:[;&|]|$)/.test(value.slice(literal[0].length))) continue;
      path = literal && (literal[1] ?? literal[2] ?? literal[3]);
      if (!path || !isAbsolute(path) || literalTempPath(path) === undefined) continue;
    }
    if (policy.tempSafe(path)) values.set(name, path);
  }
  if (command === wholeCommand && !tmpdirChanged && process.env.TMPDIR && isAbsolute(process.env.TMPDIR)) values.set('TMPDIR', process.env.TMPDIR);
  return value => {
    const match = /^\$(?:([A-Za-z_][A-Za-z_\d]*)|\{([A-Za-z_][A-Za-z_\d]*)\})(\/[^$`*?\[]*)?$/.exec(value);
    if (!match || match[3]?.split('/').includes('..') || match[3] && literalTempPath(match[3]) === undefined) return undefined;
    const name = match[1] ?? match[2];
    // A quoted literal/escaped dollar is not a variable expansion; tokenizer drops those quotes.
    if ([...command.matchAll(/'([^']*)'/g)].some(m => m[1].includes('$' + name) || m[1].includes('${' + name))
      || command.includes('\\$' + name) || command.includes('\\${' + name)) return undefined;
    const base = values.get(name);
    if (!base) return undefined;
    const path = resolve(base, '.' + (match[3] ?? ''));
    return policy.tempSafe(path) ? { path, empty: match[3] ?? '' } : undefined;
  };
}
