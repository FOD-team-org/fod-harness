// Literal shell tokenizer; no evaluation or dependencies. Complete heredoc bodies are data.
export function shellParts(command, { recoverUnterminated = false } = {}) {
  const groups = [[]], heredocs = [], pending = [];
  let word = '', quote = '', started = false, delimiter, arithmeticDepth = 0;
  let unterminatedHeredoc = false;
  const flush = () => {
    if (started) {
      groups.at(-1).push(word);
      if (delimiter !== undefined) { pending.push({ word, stripTabs: delimiter }); delimiter = undefined; }
    }
    word = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
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
      flush(); groups.push([]);
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
    } else if (command.startsWith('&>', i) || char === '>' || char === '<') {
      if (started && /^\d+$/.test(word)) { word = ''; started = false; }
      flush();
      const operator = /^(?:<<<|&>>|&>|>>|<<-|<<|>|<)/.exec(command.slice(i))[0];
      groups.at(-1).push(operator); i += operator.length - 1;
      if (operator === '<<' || operator === '<<-') delimiter = operator === '<<-';
    } else if (/[;|&]/.test(char)) { flush(); groups.push([]); }
    else if (/\s/.test(char)) flush();
    else { word += char; started = true; }
  }
  flush();
  if (pending.length || delimiter !== undefined) unterminatedHeredoc = true;
  return { groups, heredocs, unterminatedHeredoc };
}
