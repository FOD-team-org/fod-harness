import { basename, isAbsolute } from 'node:path';
import { commandWords } from './shell-commands.mjs';
import { withoutRedirects } from './write-paths.mjs';
import { unquoted } from './shell-parts.mjs';
import { dynamicPathPattern } from './path-patterns.mjs';
import { canonicalMemberPath, expandKnown, pathCandidates, commandCwds, gitTargets, syntaxFragment } from './effective-cwd.mjs';
import { npmWords } from './approval-normalize.mjs';

export const messages = {
  M1: name => `멤버 main(${name})은 읽기만 합니다 — 바꾸거나 실행하는 일은 task 로 위임합니다`,
  M2: '멤버 main 은 fodh worktree merge 로만 바꿉니다',
  M3: 'commit·merge·push 는 루트 저장소나 등록 워크트리를 대상으로만 합니다',
  M4: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요',
  M5: '멤버 main 을 가리킬 수 있는 동적 경로입니다 — 리터럴 경로로 쓰세요',
  M6: 'GIT_* 환경변수는 워크스페이스 모드에서 쓸 수 없습니다',
  M7: 'git 전역 옵션은 -C·--no-pager·-P·--no-optional-locks 만 씁니다',
};
const key = value => { const path = canonicalMemberPath(value); return process.platform === 'darwin' ? path.toLowerCase() : path; };
export function pathInside(path, base) { path = key(path); base = key(base); return path === base || path.startsWith(base === '/' ? '/' : base + '/'); }
// These functions throw only to the local guard's catch, never pretooluse's outer catch.
export function memberMainOf(path, members, worktrees = []) {
  if (worktrees.some(w => pathInside(path, typeof w === 'string' ? w : w.path))) return undefined;
  return members.find(m => pathInside(path, m.path))?.name;
}
export function memberAncestorOf(path, members) { return members.find(m => key(path) !== key(m.path) && pathInside(m.path, path))?.name; }
const deniedLong = (args, denied) => args.some(w => w.startsWith('--') && w.split('=')[0].length >= 3 && denied.some(option => option.startsWith(w.split('=')[0])));
export function gitReadAllowed(action, args) {
  if (action === undefined) return false;
  if (['status', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'merge-base', 'describe', 'name-rev', 'show-ref', 'for-each-ref', 'shortlog', 'blame'].includes(action)) return true;
  if (['log', 'show', 'diff'].includes(action)) return !deniedLong(args, ['--output', '--ext-diff', '--textconv']);
  if (action === 'grep') return !args.some(w => /^-[^-]*O/.test(w)) && !deniedLong(args, ['--open-files-in-pager', '--textconv']);
  if (action === 'cat-file') return !deniedLong(args, ['--textconv', '--filters']);
  if (action === 'stash') return ['list', 'show'].includes(args[0]) && gitReadAllowed(args[0] === 'list' ? 'log' : 'diff', args.slice(1));
  if (action === 'worktree') return args[0] === 'list' && args.slice(1).every(w => ['--porcelain', '-v', '--verbose', '-z'].includes(w));
  if (action === 'remote') return !args.length || args.length === 1 && ['-v', '--verbose'].includes(args[0])
    || args[0] === 'get-url' && args.slice(1).filter(w => !['--push', '--all'].includes(w)).length === 1 && args.slice(1).every(w => !w.startsWith('-') || ['--push', '--all'].includes(w));
  if (action === 'symbolic-ref') return args.filter(w => !w.startsWith('-')).length === 1 && args.every(w => !w.startsWith('-') || ['--short', '-q', '--quiet'].includes(w));
  if (action === 'config') {
    const modes = args.filter(w => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(w));
    const positional = args.filter(w => !w.startsWith('-'));
    return modes.length === 1 && args.every(w => !w.startsWith('-') || [...modes, '--local', '--show-origin'].includes(w))
      && (['--list', '-l'].includes(modes[0]) ? !positional.length : positional.length >= 1 && positional.length <= 2);
  }
  if (action === 'branch') {
    const list = args.some(w => w === '--list' || /^-[arvli]*l[arvli]*$/.test(w));
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (/^-[arvli]+$/.test(w)) continue;
      if (['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'].includes(w)) { if (args[i + 1] && !args[i + 1].startsWith('-')) i++; continue; }
      if (['--list', '--all', '--remotes', '--verbose', '--show-current', '--color', '--no-color', '--column', '--no-column', '--ignore-case'].includes(w)
        || /^--(?:sort|format|color|column|abbrev)=/.test(w)) continue;
      if (!w.startsWith('-') && list) continue;
      return false;
    }
    return true;
  }
  return false;
}
export function readAllowed(args) {
  const exe = basename(args[0] ?? ''), rest = args.slice(1);
  if ('cat head tail wc ls stat du cmp jq cut tr nl column paste comm rev shasum md5 grep egrep fgrep cd pushd popd pwd echo printf true false : test [ [[ realpath readlink basename dirname fodh'.split(' ').includes(exe)) return true;
  if (exe === 'uniq') return rest.filter(w => !w.startsWith('-')).length <= 1;
  if (exe === 'file') return !rest.some(w => /^-[^-]*C/.test(w) || w === '--compile');
  if (exe === 'tree') return !rest.some(w => /^-[^-]*o/.test(w));
  if (exe === 'diff') return !rest.some(w => w === '--output' || w.startsWith('--output='));
  if (exe === 'rg') return !rest.some(w => /^--pre(?:=|$|-glob(?:=|$))/.test(w));
  if (exe === 'find') return !rest.some(w => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(w));
  if (exe === 'sed') return rest[0] === '-n' && /^(?:\d+|\$)(?:,(?:\d+|\$))?p(?:;(?:\d+|\$)(?:,(?:\d+|\$))?p)*$/.test(rest[1] ?? '') && rest.slice(2).every(w => !w.startsWith('-'));
  if (exe === 'sort') return !rest.some(w => /^-[^-]*[oT]/.test(w) || /^--(?:output|temporary-directory|compress-program)(?:=|$)/.test(w));
  if (exe === 'npm') return ['ls', 'view', 'outdated'].includes(npmWords(args).slice(1).find(w => !w.startsWith('-')));
  return ['flutter', 'dart', 'node'].includes(exe) && args.length === 2 && args[1] === '--version';
}

export function gitEnvironment(words, strict = true) {
  const name = strict ? /^GIT_[A-Za-z0-9_]*(?:=)/ : /^GIT_(?:DIR|WORK_TREE)=/;
  if (words.some(w => name.test(w))) return true;
  const declarations = strict ? ['export', 'declare', 'typeset', 'readonly', 'local'] : ['export'];
  return words.some((w, i) => declarations.includes(w) && words.slice(i + 1).some(v => (strict ? /^GIT_[A-Za-z0-9_]+(?:=|$)/ : /^GIT_(?:DIR|WORK_TREE)(?:=|$)/).test(v)))
    || strict && (() => {
      const args = commandWords(words), exe = basename(args[0] ?? '');
      if (['eval', 'source', '.'].includes(exe)) return args.slice(1).some(w => /GIT_[A-Z_]*=/.test(w));
      return args.some((w, i) => (/^(?:sh|bash|zsh)$/.test(exe) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w) || exe === 'node' && ['-e', '--eval'].includes(w)) && /GIT_[A-Z_]*=/.test(args[i + 1] ?? '')
        || exe === 'node' && w.startsWith('--eval=') && /GIT_[A-Z_]*=/.test(w));
    })();
}

export function memberCommand(entry, set, { members, worktrees = [], substitute = () => undefined }) {
  let member, possible = set.unknown, wrapper = false;
  const words = withoutRedirects(entry.words), raw = withoutRedirects(entry.rawWords), args = commandWords(words), exe = basename(args[0] ?? '');
  const replacements = words.flatMap((word, i) => word === '-I' ? [words[i + 1]] : /^-I.+/.test(word) ? [word.slice(2)] : []).filter(Boolean);
  const xargs = words.some(w => basename(w) === 'xargs');
  const git = exe === 'git', targets = git ? gitTargets(words, set) : commandCwds(words, set);
  const allowed = !args.length || (git ? args.length === 2 && ['--version', '--help', '-h'].includes(args[1]) || gitReadAllowed(targets.action, targets.args) : readAllowed(args));
  try {
    possible ||= targets.unknown;
    const inspect = (value, cwd, ancestor, isWrapper = false, literal = false) => {
      if (value === '/') return;
      const paths = pathCandidates(value, cwd, undefined, literal); possible ||= paths.unknown;
      for (const path of paths.cwds) {
        const found = memberMainOf(path, members, worktrees) ?? (ancestor ? memberAncestorOf(path, members) : undefined);
        member ??= found; if (found && isWrapper) wrapper = true;
      }
    };
    for (const cwd of targets.cwds) {
      inspect(cwd, cwd, !git);
      const candidates = git ? targets.args : words;
      for (const [i, word] of candidates.entries()) {
        if (git && word.startsWith('-')) continue;
        const rawWord = git ? raw[words.indexOf(word)] ?? word : raw[i] ?? word;
        let value = word, ancestor = !word.startsWith('-') && !/^[A-Za-z_][\w]*=/.test(word);
        if (/^--[^=]+=/.test(word)) value = word.slice(word.indexOf('=') + 1);
        else if (/^-[^-].+/.test(word)) value = word.slice(2);
        else if (/^[A-Za-z_][\w]*=/.test(word)) value = word.slice(word.indexOf('=') + 1);
        else if (word.startsWith('-')) continue;
        const directory = /^(?:--cwd|--dir|--directory|--project|--prefix)(?:=|$)/.test(word)
          || ['--cwd', '--dir', '--directory', '--project', '--prefix', '-C'].includes(candidates[i - 1])
          || /^-C.+/.test(word) || exe === 'tsc' && (candidates[i - 1] === '-p' || /^-p.+/.test(word));
        ancestor ||= directory;
        const expanded = expandKnown(value, cwd), rawExpanded = expandKnown(rawWord, cwd);
        const replacement = xargs ? replacements.find(token => value.includes(token)) : undefined;
        const pattern = dynamicPathPattern(rawExpanded), dynamic = pattern !== undefined || /[*?\[]/.test(value)
          || unquoted(rawWord).includes('{') || replacement !== undefined || /^~/.test(expanded);
        if (git && dynamic) continue;
        const substitution = substitute(value);
        if (substitution) { inspect(substitution.path, cwd, ancestor); continue; }
        const prefixLength = words.length - args.length;
        const envC = i < prefixLength && (['-C', '--chdir'].includes(words[i - 1]) || /^--chdir=|^-C./.test(word)) && words.slice(0, i).some(w => basename(w) === 'env');
        const isWrapper = !!args.length && !git && i < prefixLength && !envC;
        if (!dynamic) {
          inspect(expanded, cwd, ancestor, isWrapper, true);
        } else {
          if (directory || ['cd', 'pushd'].includes(exe)) possible = true;
          const dynamicValue = pattern ?? (replacement === undefined ? expanded : expanded.replaceAll(replacement, '*'));
          const prefix = dynamicValue.split(/[$`*?\[{]/, 1)[0], slash = prefix.lastIndexOf('/');
          const bases = pathCandidates(slash < 0 ? '.' : prefix.slice(0, slash + 1), cwd);
          for (const path of bases.cwds) {
            const found = memberMainOf(path, members, worktrees);
            member ??= found;
            if (found && isWrapper) wrapper = true;
            if (memberAncestorOf(path, members)) possible = true;
          }
          // dynamicPathPattern collapses an entire expansion, including its
          // internal slashes, so only the suffix can trigger this rule.
          if (/^\*[^/]*\//.test(dynamicValue)) possible = true;
        }
      }
    }
  } catch { possible = true; }
  return { member, possible, allowed: allowed && !wrapper, git, xargs };
}
export function memberCommands(entries, set, options) {
  const results = entries.flatMap((entry, i) => syntaxFragment(entry, entries[i + 1]) ? [] : [memberCommand(entry, set, options)]);
  const someMember = results.some(r => r.member);
  for (const result of results) {
    if (result.member && !result.allowed) return result.git ? messages.M2 : messages.M1(result.member);
    if (!result.allowed && (result.possible || result.xargs && someMember)) return messages.M5;
  }
}
export function memberWrite(value, set, { members, worktrees = [], git = false }) {
  let unknown = set.unknown;
  try {
    for (const cwd of set.cwds) {
      const paths = pathCandidates(value, cwd);
      for (const path of paths.cwds) {
        const member = memberMainOf(path, members, worktrees);
        if (member) return git ? messages.M2 : messages.M1(member);
      }
      unknown ||= paths.unknown;
    }
    if (unknown && (!isAbsolute(value) || /[$`*?\[{]/.test(value))) return messages.M5;
  } catch { return messages.M5; }
}
