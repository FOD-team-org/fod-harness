import { shellParts } from '../../hooks/shell-parts.mjs';
import { basename, resolve, sep } from 'node:path';

function withoutRedirects(words: string[]) {
  return words.filter((word, i) => !['>', '>>', '&>', '&>>', '<', '<<<', '<<', '<<-'].includes(word)
    && !['>', '>>', '&>', '&>>', '<', '<<<', '<<', '<<-'].includes(words[i - 1]));
}

function commandWords(words: string[]) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z_\d]*=/.test(words[index] ?? '')) index++;
  while (['env', 'command', 'sudo', 'npx'].includes(basename(words[index] ?? ''))) {
    index++;
    while (words[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z_\d]*=/.test(words[index] ?? '')) index++;
  }
  return words.slice(index);
}

function gitAction(words: string[]) {
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(word)) {
      index++;
    } else if (!word.startsWith('-')) {
      return word;
    }
  }
}

function patchTarget(words: string[], cwd: string) {
  const args = commandWords(withoutRedirects(words)), executable = basename(args[0] ?? '');
  const apply = executable === 'git' && gitAction(args) === 'apply';
  if (!(apply || executable === 'patch')) return;
  if (apply && args.some(w => ['--check', '--stat', '--numstat', '--summary'].includes(w))
    || executable === 'patch' && args.includes('--dry-run')) return;
  let target = cwd;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === (apply ? '-C' : '-d') || args[i] === '--directory') target = resolve(target, args[++i] ?? '.');
    else if (args[i].startsWith('--directory=')) target = resolve(target, args[i].slice(12));
  }
  return resolve(target);
}


const inside = (path: string, base: string) => path === base || path.startsWith(base + sep);
export interface AuditBoundary { root: string; cwd?: string; docsRoot: string; worktrees: { path: string }[] }

// Only literal arguments in a write context are candidates. No shell/code evaluation.
function fileOperands(args: string[], script = false): string[] {
  const files: string[] = [];
  let expressionSeen = !script;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (['-e', '--expression', '-f', '--file'].includes(arg)) { expressionSeen = true; i++; continue; }
    if (['-s', '--size', '-r', '--reference', '-t', '-d', '--date'].includes(arg)) { i++; continue; }
    if (arg.startsWith('-') || !arg) continue;
    if (!expressionSeen) { expressionSeen = true; continue; }
    files.push(arg);
  }
  return files;
}
function inlineWrites(code: string): string[] {
  const paths: string[] = [];
  const calls = /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|open)\s*\(\s*(['"])((?:\\.|(?!\2)[^\\])*?)\2/gu;
  for (const match of code.matchAll(calls)) {
    if (match[1] === 'open') {
      const mode = /^\s*,\s*(['"])(.*?)\1/su.exec(code.slice(match.index! + match[0].length));
      if (!mode || !/[wa]/u.test(mode[2])) continue;
    }
    paths.push(match[3].replace(/\\(['"\\])/gu, '$1'));
  }
  return paths;
}
export function auditPaths(name: string, input: Record<string, unknown>, context: AuditBoundary): string[] {
  const root = resolve(context.root), cwd = context.cwd ?? root;
  const candidates: string[] = [], patches: string[] = [];
  const bash = name === 'Bash';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path === 'string') candidates.push(path);
  } else if (bash && typeof input.command === 'string') {
    const { groups, heredocs } = shellParts(input.command, { recoverUnterminated: true });
    for (const words of groups) {
      const args = commandWords(withoutRedirects(words)), executable = basename(args[0] ?? '');
      const patch = patchTarget(words, cwd);
      if (patch) patches.push(patch);
      for (let i = 0; i < words.length; i++) {
        if (['>', '>>', '&>', '&>>'].includes(words[i]) && words[i + 1]) candidates.push(words[i + 1]);
      }
      if (executable === 'tee') candidates.push(...fileOperands(args));
      else if (['cp', 'mv', 'install', 'rsync'].includes(executable)) {
        const last = fileOperands(args).at(-1); if (last) candidates.push(last);
      } else if (executable === 'dd') candidates.push(...args.filter(w => w.startsWith('of=')).map(w => w.slice(3)));
      else if (['touch', 'truncate'].includes(executable)) candidates.push(...fileOperands(args));
      else if (executable === 'sed' && args.some(w => /^-[^-]*i/u.test(w) || /^--in-place(?:=|$)/u.test(w))
        || executable === 'perl' && args.some(w => /^-[^-]*i/u.test(w)) && args.some(w => /^-[^-]*p/u.test(w))) {
        candidates.push(...fileOperands(args, true));
      }
      if (/^(?:node|python\w*|perl|ruby|sh|bash|zsh)$/u.test(executable)) {
        for (let i = 1; i < args.length; i++) {
          if (['-e', '--eval', '-c'].includes(args[i]) || /^(?:sh|bash|zsh)$/u.test(executable) && /^-[a-zA-Z]*c$/u.test(args[i])) candidates.push(...inlineWrites(args[++i] ?? ''));
          else if (args[i].startsWith('--eval=')) candidates.push(...inlineWrites(args[i].slice(7)));
        }
      }
    }
    for (const code of heredocs) candidates.push(...inlineWrites(code));
  }
  return [...new Set([...candidates, ...patches].map(value => resolve(cwd, value)).filter(path => {
    if (context.worktrees.some(w => inside(path, resolve(root, w.path)))) return false;
    if (patches.includes(path)) return true;
    if (bash && (!inside(path, root) || /^\/dev\/(?:null|stdout|stderr|tty|fd\/.*)$/u.test(path))) return false;
    if (!inside(path, root)) return true;
    return !(inside(path, resolve(root, context.docsRoot)) || inside(path, resolve(root, '.pi'))
      || ['CLAUDE.md', 'AGENTS.md', 'README.md'].some(p => path === resolve(root, p)));
  }))];
}
