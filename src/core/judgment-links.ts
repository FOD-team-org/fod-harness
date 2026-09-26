import { dirname, relative, resolve } from 'node:path';

// Rebase inline Markdown destinations only. Reference definitions stay untouched.
export function rebaseJudgmentLinks(text: string, sourceFile: string, targetFile: string): string {
  const from = dirname(sourceFile), to = dirname(targetFile);
  if (from === to) return text;
  let result = '', copied = 0;
  for (const match of text.matchAll(/\]\(/gu)) {
    let start = match.index! + 2;
    while (/[ \t]/u.test(text[start] ?? '')) start++;
    const angle = text[start] === '<';
    if (angle) start++;
    let end = start, depth = 0;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === '\\') { end++; continue; }
      if (angle ? char === '>' : depth === 0 && (char === ')' || /\s/u.test(char))) break;
      if (char === '\n' || char === '\r') break;
      if (!angle && char === '(') depth++;
      if (!angle && char === ')') depth--;
    }
    const destination = text.slice(start, end);
    const tail = text.slice(end + (angle ? 1 : 0));
    if (!destination || depth !== 0 || angle && text[end] !== '>'
      || !/^[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\))?[ \t]*\)/u.test(tail)
      || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(destination)) continue;
    const suffixAt = destination.search(/[?#]/u);
    const path = suffixAt < 0 ? destination : destination.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? '' : destination.slice(suffixAt);
    result += text.slice(copied, start) + (relative(to, resolve(from, path)) || '.') + suffix;
    copied = end;
  }
  return result + text.slice(copied);
}
