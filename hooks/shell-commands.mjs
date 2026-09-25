import { shellParts, unquoted, redirectOperators, withoutExpansions, expansionEnd } from './shell-parts.mjs';
import { basename } from 'node:path';

export function commandWords(words) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z_\d]*=/.test(words[index] ?? '')) index++;
  const wrappers = ['env', 'command', 'sudo', 'npx', 'nohup', 'timeout', 'nice', 'time', 'xargs', 'stdbuf', 'exec', 'builtin', 'script', 'caffeinate', 'arch', 'bunx'];
  const optionValues = {
    exec: ['-a'], script: ['-a'], caffeinate: ['-t', '-w'],
    env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
    sudo: ['-u', '-g', '-h', '-p', '-C', '-T'], npx: ['-p', '--package', '-c', '--call'],
    timeout: ['-k', '--kill-after', '-s', '--signal'], nice: ['-n', '--adjustment'],
    time: ['-o', '--output', '-f', '--format'],
    xargs: ['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'],
    stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  };
  while (wrappers.includes(basename(words[index] ?? ''))
    || ['pnpm', 'yarn'].includes(basename(words[index] ?? '')) && words[index + 1] === 'dlx') {
    const wrapper = basename(words[index++]);
    if (['pnpm', 'yarn'].includes(wrapper)) index++;
    let scriptLog = false;
    while (index < words.length) {
      const word = words[index];
      if (word === '--') { index++; break; }
      if (wrapper === 'env' && (word === '-S' || word === '--split-string' || word.startsWith('--split-string='))) {
        const split = word.startsWith('--split-string=') ? word.slice(15) : words[++index] ?? '';
        return commandWords([...shellParts(split).groups.flat(), ...words.slice(index + 1)]);
      }
      if (wrapper === 'env' && /^[A-Za-z_][A-Za-z_\d]*=/.test(word)) { index++; continue; }
      if (!word.startsWith('-')) break;
      if (wrapper === 'script' && word === '-a') scriptLog = true;
      index += optionValues[wrapper]?.includes(word) ? 2 : 1;
    }
    if (wrapper === 'script' && !scriptLog && words[index]) index++;
    if (['npx', 'bunx', 'pnpm', 'yarn'].includes(wrapper) && /^(?:codex|@openai\/codex[^\s]*)$/.test(words[index] ?? '')) {
      return ['codex', ...words.slice(index + 1)];
    }
    if (wrapper === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(words[index] ?? '')) index++;
  }
  const args = words.slice(index);
  if (basename(args[0] ?? '') === 'node' && /^fodh(?:\.[cm]?[jt]s)?$/.test(basename(args[1] ?? ''))) return ['fodh', ...args.slice(2)];
  return args;
}

function detachRedirects(words, raw = words) {
  const redirects = [], rawRedirects = [];
  while (words.length >= 2 && redirectOperators.includes(words.at(-2))) {
    if (/[)}]$/.test(unquoted(withoutExpansions(raw.at(-1))))) break;
    redirects.unshift(...words.splice(-2));
    if (raw !== words) rawRedirects.unshift(...raw.splice(-2));
  }
  return { redirects, rawRedirects: raw === words ? redirects : rawRedirects };
}
// Group redirections apply to every command enclosed in the group, including empty tails.
function groupRedirects(parsed) {
  const inherited = parsed.groups.map(() => []), stack = [];
  for (let i = 0; i < parsed.groups.length; i++) {
    const words = [...parsed.groups[i]], raw = [...parsed.rawGroups[i]];
    const { redirects, rawRedirects } = detachRedirects(words, raw);
    // Openers are syntax only in command position, never in a substitution or quoted argument.
    for (let j = 0; j < raw.length; j++) {
      const token = unquoted(withoutExpansions(raw[j]));
      if (token === '{' || token === '(' || j === 0 && token.startsWith('(') && !token.startsWith('((')) stack.push({ index: i, close: token === '{' ? '}' : ')' });
    }
    const tail = unquoted(withoutExpansions(raw.at(-1) ?? ''));
    for (const close of tail.match(/[)}]+$/)?.[0] ?? '') {
      if (!stack.length || stack.at(-1).close !== close) break;
      const start = stack.pop().index;
      for (let k = start; k < i; k++) inherited[k].push({ words: redirects, raw: rawRedirects });
    }
  }
  return inherited;
}

// A normalized command view supplements the original tokens; guards also check the original.
function legacyGroups(groups) {
  let parens = 0;
  return groups.map(words => {
    const result = [...words];
    while (result.length) {
      if (['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '('].includes(result[0])) {
        if (result[0] === '(') parens++;
        result.shift();
      } else if (result[0].startsWith('(') && !result[0].startsWith('((')) {
        result[0] = result[0].slice(1); parens++;
      } else break;
    }
    const { redirects } = detachRedirects(result);
    while (result.length) {
      if ([')', '}', 'fi', 'done', 'esac'].includes(result.at(-1))) {
        if (result.at(-1) === ')' && parens) parens--;
        result.pop();
      } else if (parens && result.at(-1).endsWith(')')) {
        result[result.length - 1] = result.at(-1).slice(0, -1); parens--;
      } else break;
    }
    return [...result, ...redirects];
  });
}

// Only recognized structures are consumed. Leftover syntax is never guessed into a command.
function structuredGroups(groups, rawGroups, separators) {
  let unresolved = false, parens = 0, inCase = false, expectPattern = false;
  const normalized = [], normalizedRaw = [];
  const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
  for (let i = 0; i < groups.length; i++) {
    const words = [...groups[i]], raw = [...rawGroups[i]];
    const shift = (n = 1) => { words.splice(0, n); raw.splice(0, n); };
    const head = () => unquoted(raw[0] ?? '');
    if ([';;', ';&', ';;&'].includes(separators[i - 1])) expectPattern = inCase;
    if (head() === 'esac') { inCase = false; shift(); }
    if (inCase && expectPattern && words.length) {
      const end = raw.slice(0, 4).findIndex(word => unquoted(word).endsWith(')'));
      if (end < 0) unresolved = true; else { shift(end + 1); expectPattern = false; }
    }
    while (words.length) {
      const first = head();
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(first) && !/\$\(|`/.test(first)) { shift(); continue; }
      if (first.startsWith('((') && unquoted(raw.join(' ')).trimEnd().endsWith('))')) { shift(words.length); break; }
      if (['repeat', 'foreach', 'select', 'end'].includes(first)) { unresolved = true; break; }
      if (first === 'case') {
        const end = words.indexOf('in');
        if (end < 2) { unresolved = true; break; }
        shift(end + 1); inCase = true; expectPattern = true;
        const patternEnd = raw.slice(0, 4).findIndex(word => unquoted(word).endsWith(')'));
        if (words.length && patternEnd < 0) { unresolved = true; break; }
        shift(patternEnd + 1); if (patternEnd >= 0) expectPattern = false; continue;
      }
      if (first === 'for') {
        if (!identifier.test(words[1] ?? '') || words.length > 2 && words[2] !== 'in') unresolved = true;
        shift(words.length); break;
      }
      if (['time', 'nocorrect', 'noglob', 'command', 'builtin', 'exec'].includes(first)) {
        const wrapper = first; shift();
        while (words[0]?.startsWith('-')) { const takesValue = wrapper === 'exec' && words[0] === '-a'; shift(takesValue ? 2 : 1); }
        continue;
      }
      if (/^[A-Za-z_][A-Za-z_0-9]*\(\)\{?$/.test(first) && (first.endsWith('{') || ['{', '('].includes(words[1]))) { shift(); continue; }
      if (first === 'function') {
        if (!identifier.test((words[1] ?? '').replace(/\(\)$/, '')) || words[2] !== '{') { unresolved = true; break; }
        shift(2); continue;
      }
      if (first === 'coproc') {
        if (!identifier.test(words[1] ?? '') || !['(', '{'].includes(words[2])) { unresolved = true; break; }
        shift(2); continue;
      }
      if (['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '('].includes(first)) {
        if (first === '(') parens++;
        shift(); continue;
      }
      if (first.startsWith('(') && !first.startsWith('((')) {
        words[0] = words[0].slice(1); raw[0] = raw[0].slice(1); parens++; continue;
      }
      break;
    }
    const { redirects, rawRedirects } = detachRedirects(words, raw);
    while (words.length) {
      const tail = unquoted(raw.at(-1));
      if ([')', '}', 'fi', 'done', 'esac'].includes(tail)) {
        if (tail === ')' && parens) parens--;
        words.pop(); raw.pop();
      } else if (parens && tail.endsWith(')')) {
        words[words.length - 1] = words.at(-1).slice(0, -1); raw[raw.length - 1] = raw.at(-1).slice(0, -1); parens--;
      } else break;
    }
    const first = head();
    if (!/^[A-Za-z_][A-Za-z_0-9]*=/.test(first) && /[(){}]/.test(first)) unresolved = true;
    if (raw.some((word, index) => unquoted(withoutExpansions(word)).includes('()')
      || ['(', ')', '{', '}'].includes(unquoted(word)) && !['<', '>'].includes(words[index - 1]))) unresolved = true;
    normalized.push([...words, ...redirects]); normalizedRaw.push([...raw, ...rawRedirects]);
  }
  return { groups: normalized, rawGroups: normalizedRaw, unresolved };
}

// Find command substitutions without executing them. Single-quoted text is data.
function substitutions(text, extended) {
  const commands = [];
  let quote = '', malformed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (c === "'" && !quote) { quote = c; continue; }
    if (c === '"') { quote = quote === '"' ? '' : '"'; continue; }
    if (c === '`' || text.startsWith('$(', i) && !text.startsWith('$((', i) || extended && /[<>]/.test(c) && text[i + 1] === '(') {
      const end = expansionEnd(text, i);
      if (end === undefined) { malformed = true; continue; }
      commands.push(text.slice(i + (c === '`' ? 1 : 2), end - 1)); i = end - 1;
    }
  }
  return { commands, malformed: malformed || !!quote };
}

export function shellCommands(command, { recoverUnterminated = false, extended = true } = {}) {
  const entries = [], heredocs = [];
  let unresolved = false, unterminatedHeredoc = false;
  const visit = (source, tempAllowed, depth, substitutionDepth) => {
    if (depth > 16 || substitutionDepth > 3) { unresolved = true; return; }
    const parsed = shellParts(source, { recoverUnterminated, metadata: true });
    const structure = extended ? structuredGroups(parsed.groups, parsed.rawGroups, parsed.separators) : { groups: legacyGroups(parsed.groups), rawGroups: parsed.rawGroups.map(words => [...words]), unresolved: false };
    const inherited = groupRedirects(parsed);
    const groups = structure.groups; unresolved ||= structure.unresolved || parsed.unterminatedExpansion;
    heredocs.push(...parsed.heredocs); unterminatedHeredoc ||= parsed.unterminatedHeredoc;
    for (let i = 0; i < groups.length; i++) {
      const words = groups[i];
      if (JSON.stringify(words) !== JSON.stringify(parsed.groups[i])) entries.push({ words: parsed.groups[i], rawWords: parsed.rawGroups[i], source, tempAllowed });
      for (const redirect of inherited[i]) { words.push(...redirect.words); structure.rawGroups[i].push(...redirect.raw); }
      entries.push({ words, rawWords: structure.rawGroups[i], source, tempAllowed });
      const args = commandWords(words), executable = basename(args[0] ?? '');
      const shellArgs = extended && ['busybox', 'toybox'].includes(executable) ? args.slice(1) : args;
      const shellName = basename(shellArgs[0] ?? '');
      let nested;
      if (executable === 'eval') nested = args.slice(1).join(' ');
      else if ((extended ? ['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'mksh', 'yash', 'ash', 'pdksh'] : ['sh', 'bash', 'zsh']).includes(shellName)) {
        const flag = shellArgs.findIndex((word, index) => index > 0 && (extended ? /^-[a-zA-Z]*c[a-zA-Z]*$/ : /^-[a-zA-Z]*c$/).test(word));
        if (flag >= 0) nested = shellArgs[flag + 1];
      }
      if (nested) {
        // Match the corresponding original token, not a same-valued quote elsewhere.
        const original = parsed.groups[i], raw = parsed.rawGroups[i];
        const occurrences = original.flatMap((value, index) => value === nested ? [raw[index]] : []);
        const singleQuoted = occurrences.length === 1 && occurrences[0] === "'" + nested + "'";
        visit(nested, tempAllowed && singleQuoted, depth + 1, substitutionDepth);
      }
    }
    // Complete heredoc bodies are data; avoid interpreting their code-like examples.
    const executableSource = parsed.rawGroups.map(words => words.join(' ')).join('\n');
    const expanded = substitutions(extended ? executableSource.replace(/([<>]) \(/g, '$1(') : executableSource, extended);
    unresolved ||= expanded.malformed;
    for (const nested of expanded.commands) visit(nested, false, depth + 1, substitutionDepth + 1);
  };
  visit(command, true, 0, 0);
  return { entries, heredocs, unresolved, unterminatedHeredoc };
}

export function temporaryCommandsSafe(command, parsed) {
  const risky = ['ln', 'mv', 'cp', 'rsync', 'tar', 'unzip', 'ditto', 'bsdtar', 'git'];
  // Raw text also covers opaque function bodies/wrappers. False positives keep the old guard.
  return !parsed.unresolved && !parsed.entries.some(({ words }) => risky.includes(basename(commandWords(words)[0] ?? '')))
    && !/\b(?:ln|mv|cp|rsync|tar|unzip|ditto|bsdtar|git)\b/.test(command);
}
