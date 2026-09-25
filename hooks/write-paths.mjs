import { basename } from 'node:path';
import { commandWords } from './shell-commands.mjs';
import { redirectOperators, isWriteRedirect } from './shell-parts.mjs';

export function withoutRedirects(words) {
  return words.filter((word, i) => !redirectOperators.includes(word) && !redirectOperators.includes(words[i - 1]));
}
export function copyDestinations(args) {
  const explicit = args.flatMap((word, i) => ['-t', '--target-directory'].includes(word) ? [args[i + 1]]
    : word.startsWith('--target-directory=') ? [word.slice(19)] : []);
  return explicit.length ? explicit.filter(Boolean) : [args.at(-1)].filter(Boolean);
}
// Literal write operands only. Copy sources are reads; moving/removing sources still writes.
export function writePaths(words) {
  const args = commandWords(withoutRedirects(words)), executable = basename(args[0] ?? '');
  const redirects = words.flatMap((word, i) => isWriteRedirect(word, words[i + 1])
    && !(['>', '<'].includes(word) && words[i + 1]?.startsWith('(')) ? [words[i + 1]] : []).filter(Boolean);
  const outputOptions = (short, long) => args.flatMap((word, i) => word === short || word === long ? [args[i + 1]]
    : long && word.startsWith(long + '=') ? [word.slice(long.length + 1)]
    : new RegExp('^-[^-]*' + short.slice(1)).test(word) ? [word.slice(word.indexOf(short.slice(1)) + 1) || args[i + 1]] : []).filter(Boolean);
  let operands = [];
  if (['cp', 'install', 'ditto', 'rsync'].includes(executable)) {
    operands = copyDestinations(args);
    if (executable === 'cp' && args.some(word => /^-[^-]*[ls]/.test(word) || ['--link', '--symbolic-link'].includes(word))
      || executable === 'rsync' && args.some(word => ['--remove-source-files', '--remove-sent-files'].includes(word)) || executable === 'install' && args.includes('-d')) operands = args.slice(1);
  } else if (/^(?:tee|mv|rm|touch|truncate)$/.test(executable)) operands = args.slice(1);
  else if (executable === 'sort') operands = outputOptions('-o', '--output');
  else if (executable === 'curl') {
    operands = outputOptions('-o', '--output');
    if (args.some(word => /^-[^-]*O/.test(word) || word === '--remote-name')) operands.push('.');
  } else if (executable === 'wget') {
    operands = [...outputOptions('-O', '--output-document'), ...outputOptions('-P', '--directory-prefix')];
    if (!operands.length) operands.push('.');
  } else if (executable === 'split') {
    const files = [];
    for (let i = 1; i < args.length; i++) {
      if (['-a', '-b', '-C', '-l', '-n', '--suffix-length', '--bytes', '--line-bytes', '--lines', '--number', '--additional-suffix'].includes(args[i])) { i++; continue; }
      if (!args[i].startsWith('-') || args[i] === '-') files.push(args[i]);
    }
    operands = [files.length > 1 ? files.at(-1) : 'x'];
  } else if (executable === 'patch') operands = outputOptions('-o', '--output');
  else if (executable === 'dd') operands = args.slice(1).filter(w => w.startsWith('of=')).map(w => w.slice(3));
  else if (executable === 'sed' && args.some(w => /^-[^-]*i/.test(w) || w === '--in-place')) {
    operands = args.slice(1).filter(w => w && !w.startsWith('-'));
    if (!args.includes('-f')) operands = operands.slice(1);
  } else if (executable === 'git') {
    let index = 1;
    for (; index < args.length; index++) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[index])) index++;
      else if (!args[index].startsWith('-')) break;
    }
    const action = args[index];
    if (action === 'restore' || action === 'stash' && !['list', 'show'].includes(args[index + 1]) || action === 'checkout' && args.includes('--')) {
      operands = action === 'checkout' ? args.slice(args.indexOf('--') + 1) : args.slice(index + 1);
      if (!operands.some(w => !w.startsWith('-'))) operands.push('.');
      if (action === 'stash') operands = ['.'];
    }
  }
  return [...redirects, ...operands.filter(w => w && !w.startsWith('-') && !redirectOperators.includes(w))];
}
