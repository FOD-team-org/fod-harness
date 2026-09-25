import { expansionEnd } from './shell-parts.mjs';

// Glob matching only; never expand through a shell or traverse a wildcard path.
export function globRegex(pattern) {
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') expression += '[^/]*';
    else if (c === '?') expression += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) return undefined;
      const chars = pattern.slice(i + 1, end);
      if (!chars || /[/\\]/.test(chars)) return undefined;
      expression += '[' + (chars.startsWith('!') ? '^' + chars.slice(1) : chars) + ']'; i = end;
    } else expression += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp('^' + expression + '$', process.platform === 'darwin' ? 'i' : ''); } catch { return undefined; }
}

// Quote removal with one path-component wildcard per actual expansion. Never evaluate it.
export function dynamicPathPattern(raw) {
  let pattern = '', quote = '', dynamic = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && quote !== "'") { pattern += raw[++i] ?? ''; continue; }
    if (c === quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue; }
    if (quote !== "'" && (raw.startsWith('$(', i) || c === '`')) {
      const end = expansionEnd(raw, i);
      if (end !== undefined) { pattern += '*'; dynamic = true; i = end - 1; continue; }
    }
    if (quote !== "'") {
      const parameter = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z_0-9]*|\$[0-9@*#?$!-])/.exec(raw.slice(i));
      if (parameter) { pattern += '*'; dynamic = true; i += parameter[0].length - 1; continue; }
    }
    pattern += c;
  }
  return dynamic ? pattern.replace(/\*+/g, '*') : undefined;
}

// Only the written pattern supplies evidence; cwd/HOME prefixes added by resolve do not.
export function specificDynamicPattern(pattern, directoryClues) {
  const components = pattern.split('/').filter(Boolean);
  const stem = (components.at(-1) ?? '')
    .replace(/(?<=[*?\[\]])\.[^./*?\[]+$/, '').replace(/[*?\[\]]/g, '');
  if (/[\p{L}\p{N}]/u.test(stem)) return true;
  const key = value => process.platform === 'darwin' ? value.toLowerCase() : value;
  const directories = components.slice(0, -1);
  return directoryClues.some(clue => {
    const parts = clue.split('/').filter(Boolean);
    return parts.length > 0 && directories.some((_, start) => parts.every((part, offset) => {
      const written = directories[start + offset];
      return written !== undefined && !['.', '..', '~'].includes(written)
        && !/[*?\[]/.test(written) && key(written) === key(part);
    }));
  });
}
