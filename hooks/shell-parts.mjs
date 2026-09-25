export const redirectOperators = ['>>|', '>>!', '&>|', '&>>', '>>&', '<<<', '<<-', '>|', '>!', '&>', '>&', '<&', '<>', '>>', '<<', '>', '<'];
export function isWriteRedirect(operator, target) {
  if (!redirectOperators.includes(operator) || ['<', '<<', '<<-', '<<<'].includes(operator)) return false;
  if (['>&', '<&'].includes(operator)) return !/^(?:\d+|-)[)}]*$/.test(target ?? '');
  return true;
}
// Characters that the shell sees outside quotes; quoted and escaped characters are data.
export function unquoted(raw) {
  let result = '', quote = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    result += c;
  }
  return result;
}
// Return an exclusive end only when the expansion is closed. Never consume the tail on failure.
export function expansionEnd(text, start, nesting = 0) {
  if (nesting > 64) return undefined;
  const tick = text[start] === '`', arithmetic = text.startsWith('$((', start);
  const pending = [];
  let depth = tick ? 0 : 1, quote = '', started = false, arithmeticDepth = 0;
  for (let i = start + (tick ? 1 : 2); i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i++; started = true; continue; }
    if (tick && c === '`' && !quote) return i + 1;
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (text.startsWith('$(', i) || c === '`' && !tick || !quote && /^[<>]\(/.test(text.slice(i))) {
      const end = expansionEnd(text, i, nesting + 1);
      if (end === undefined) return undefined;
      i = end - 1; started = true; continue;
    }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (!arithmetic && !arithmeticDepth && c === '#' && !started) {
      const end = text.indexOf('\n', i); if (end < 0) return undefined;
      i = end - 1; continue;
    }
    if (!arithmetic && !arithmeticDepth && text.startsWith('<<<', i)) { i += 2; started = false; continue; }
    if (!arithmetic && !arithmeticDepth && text.startsWith('<<', i)) {
      const stripTabs = text[i + 2] === '-';
      let j = i + (stripTabs ? 3 : 2), delimiter = '', delimiterQuote = '', seen = false;
      while (/[ \t]/.test(text[j] ?? '') && j < text.length) j++;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (!delimiterQuote && /[\s;&|<>()]/.test(ch)) break;
        seen = true;
        if (ch === '\\' && delimiterQuote !== "'") { if (++j >= text.length) return undefined; delimiter += text[j]; }
        else if (delimiterQuote) { if (ch === delimiterQuote) delimiterQuote = ''; else delimiter += ch; }
        else if (ch === "'" || ch === '"') delimiterQuote = ch;
        else delimiter += ch;
      }
      if (!seen || delimiterQuote) return undefined;
      pending.push({ delimiter, stripTabs }); i = j - 1; started = true; continue;
    }
    if (c === '\n' && pending.length) {
      let cursor = i + 1;
      for (const doc of pending.splice(0)) {
        let found = false;
        while (cursor < text.length) {
          const end = text.indexOf('\n', cursor), stop = end < 0 ? text.length : end;
          const line = text.slice(cursor, stop); cursor = stop + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) { found = true; break; }
        }
        if (!found) return undefined;
      }
      i = cursor - 1; started = false; continue;
    }
    if (!arithmetic && !arithmeticDepth && text.startsWith('((', i)) arithmeticDepth = 1;
    else if (arithmeticDepth && c === '(') arithmeticDepth++;
    else if (arithmeticDepth && c === ')') arithmeticDepth--;
    if (!tick && c === '(') depth++;
    if (!tick && c === ')' && --depth === 0) return pending.length ? undefined : i + 1;
    started = !/[\s;|&()<>]/.test(c);
  }
  return undefined;
}
export function withoutExpansions(text) {
  let output = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$(', i) || text[i] === '`') {
      const end = expansionEnd(text, i);
      if (end !== undefined) { i = end - 1; continue; }
    }
    const parameter = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z_0-9]*)/.exec(text.slice(i));
    if (parameter) { i += parameter[0].length - 1; continue; }
    output += text[i];
  }
  return output;
}
// Literal shell tokenizer; no evaluation or dependencies. Complete heredoc bodies are data.
export function shellParts(command, { recoverUnterminated = false, metadata = false } = {}) {
  const groups = [[]], rawGroups = [[]], separators = [], cases = [], heredocs = [], pending = [];
  let wordStart = 0, cursor = 0;
  let word = '', quote = '', started = false, delimiter, arithmeticDepth = 0;
  let unterminatedHeredoc = false, unterminatedExpansion = false;
  const flush = () => {
    if (started) {
      if (word === 'case' && groups.at(-1).length === 0) cases.push('header');
      else if (word === 'in' && cases.at(-1) === 'header') cases[cases.length - 1] = 'pattern';
      else if (word === 'esac' && cases.length) cases.pop();
      else if (cases.at(-1) === 'pattern' && word.endsWith(')')) cases[cases.length - 1] = 'body';
      groups.at(-1).push(word);
      rawGroups.at(-1).push(command.slice(wordStart, cursor));
      if (delimiter !== undefined) { pending.push({ word, stripTabs: delimiter }); delimiter = undefined; }
    }
    word = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    cursor = i;
    const char = command[i];
    if (!started && !/[\s;|&<>]/.test(char)) wordStart = i;
    if (!quote && !arithmeticDepth && char === '#' && (!started || /^[()]+$/.test(command.slice(wordStart, i)))) {
      flush();
      const end = command.indexOf('\n', i); i = end < 0 ? command.length : end - 1; continue;
    }
    if (quote !== "'" && (command.startsWith('$(', i) || char === '`' || !quote && /^[<>]\(/.test(command.slice(i)))) {
      const end = expansionEnd(command, i);
      if (end !== undefined) {
        if (!started) wordStart = i;
        word += command.slice(i, end); started = true; i = end - 1; continue;
      }
      unterminatedExpansion = true; // Fall back to the pre-U1 character tokenizer.
    }
    if (char === '\\' && quote !== "'") { word += command[++i] ?? ''; started = true; }
    else if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (arithmeticDepth) {
      if (char === '(') arithmeticDepth++;
      else if (char === ')') arithmeticDepth--;
      word += char;
    } else if (command.startsWith('$((', i) || command.startsWith('((', i)) {
      const opening = char === '$' ? '$((' : '((';
      word += opening; started = true; arithmeticDepth = 2; i += opening.length - 1;
    } else if (char === '\n') {
      flush(); separators.push('\n'); groups.push([]); rawGroups.push([]);
      for (const doc of pending.splice(0)) {
        const body = [];
        let cursor = i + 1, found = false;
        while (cursor < command.length) {
          const end = command.indexOf('\n', cursor), stop = end < 0 ? command.length : end;
          const line = command.slice(cursor, stop); cursor = stop + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.word) { found = true; break; }
          body.push(line);
        }
        heredocs.push(body.join('\n'));
        if (!found) {
          unterminatedHeredoc = true;
          // Audit scans the remaining lines; hooks retain the user's existing body handling.
          if (!recoverUnterminated) i = command.length;
          break;
        }
        i = cursor - 1;
      }
    } else if (started && char === '<' && /^<\d*-\d*>/.test(command.slice(i))) {
      const range = /^<\d*-\d*>/.exec(command.slice(i))[0]; word += range; i += range.length - 1;
    } else if (command.startsWith('&>', i) || char === '>' || char === '<') {
      if (started && /^\d+$/.test(word)) { word = ''; started = false; }
      else if (started && /[)}]+\d+$/.test(word)) {
        const digits = /\d+$/.exec(word)[0]; word = word.slice(0, -digits.length); cursor -= digits.length;
      }
      flush();
      const operator = redirectOperators.find(value => command.startsWith(value, i));
      groups.at(-1).push(operator); rawGroups.at(-1).push(operator); i += operator.length - 1;
      if (operator === '<<' || operator === '<<-') delimiter = operator === '<<-';
    } else if (char === '|' && cases.at(-1) === 'pattern') { word += char; started = true; }
    else if (/[;|&]/.test(char)) {
      flush();
      const separator = /^(?:;;&|;;|;&|&&|\|\||[;|&])/.exec(command.slice(i))[0];
      if ([';;', ';&', ';;&'].includes(separator) && cases.length) cases[cases.length - 1] = 'pattern';
      separators.push(separator); groups.push([]); rawGroups.push([]); i += separator.length - 1;
    }
    else if (/\s/.test(char)) flush();
    else { word += char; started = true; }
  }
  cursor = command.length;
  flush();
  if (pending.length || delimiter !== undefined) unterminatedHeredoc = true;
  return { groups, heredocs, unterminatedHeredoc, ...(metadata ? { rawGroups, separators, unterminatedExpansion } : {}) };
}
