import { possibleCwds, commandCwds, gitTargets } from './effective-cwd.mjs';
import { pathInside } from './member-main.mjs';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandWords } from './shell-commands.mjs';
import { withoutRedirects, copyDestinations } from './write-paths.mjs';
import { unquoted } from './shell-parts.mjs';
import { globRegex } from './path-patterns.mjs';
import { secretPolicy, expandSecretGlob, globsOverlap, scanSecretFiles, directoryExists } from './secret-paths.mjs';

const filterOptions = ['--exclude', '--exclude-dir', '--include', '-g', '--glob', '--iglob'];
const searchValues = new Set([...filterOptions, '-e', '--regexp', '-f', '--file', '-d', '--directories', '-A', '-B', '-C', '-m', '--max-count',
  '--max-depth', '--sort', '--sortr', '-j', '--threads', '--encoding', '-E', '--type', '-t', '--type-not', '-T', '--max-columns', '--max-filesize', '--context', '--after-context', '--before-context']);
function searchArgs(args) {
  const skip = new Set(), paths = [], filters = [];
  let patternSeen = args.some(w => ['-e', '--regexp', '-f', '--file'].includes(w) || /^-(?:e|f).+/.test(w) || /^--(?:regexp|file)=/.test(w)), literal = false;
  for (let i = 1; i < args.length; i++) {
    const w = args[i], opt = w.split('=')[0];
    if (!literal && w === '--') { literal = true; continue; }
    if (!literal && searchValues.has(opt)) {
      const attached = w.includes('='), value = attached ? w.slice(w.indexOf('=') + 1) : args[i + 1];
      const file = ['-f', '--file'].includes(opt);
      if (!file) { skip.add(i); if (!attached) skip.add(i + 1); }
      if (filterOptions.includes(opt) && value) filters.push([opt, value]);
      if (!attached) i++;
      continue;
    }
    if (!literal && /^-e.+/.test(w)) { skip.add(i); continue; }
    if (!literal && w.startsWith('-')) continue;
    if (!patternSeen) { patternSeen = true; skip.add(i); } else paths.push(w);
  }
  return { skip, paths, filters };
}
function gitSubcommand(args) {
  for (let i = 1; i < args.length; i++) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) return args[i];
  }
}

export function secretReadGuard({ root, cwd, cwdSet, config, deny, members, worktrees = [] }) {
  const policies = [secretPolicy(root, config)];
  let memberPolicyError = false;
  try { policies.push(...(members ?? []).filter(m => m.secrets !== undefined).map(m => secretPolicy(m.path, m.secrets))); }
  catch { memberPolicyError = true; }
  const policy = { ...policies[0], secretPath: path => policies.some(p => p.secretPath(path)), basenameDenied: name => policies.some(p => p.basenameDenied(name)) };
  let bases = [cwd], cwdUnknown = false;
  const rejected = path => deny(`비밀 파일은 두뇌가 읽을 수 없습니다: ${basename(path)}. 값이 필요하면 판단으로 사용자에게 요청하세요`, 'boundary');
  const expanded = (word, base = cwd) => resolve(base, word.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
    .replace(/\$(?:HOME\b|\{HOME\})/g, process.env.HOME ?? '$HOME'));
  const checkAt = (word, glob, base) => {
    const path = expanded(word, base);
    if (/[$`]/.test(path)) {
      const last = basename(word);
      if (!/[$`]/.test(last) && policy.basenameDenied(last)) rejected(last);
      return;
    }
    let targets;
    try { targets = glob && /[*?\[]/.test(word) ? expandSecretGlob(path) : [path]; }
    catch { rejected('탐색 상한 초과'); return; }
    for (const target of targets) if (policy.secretPath(target)) rejected(target);
  };
  const check = (word, glob = true) => {
    // Keep event cwd first, even when the new calculation cannot resolve cwd.
    for (const base of bases) {
      try { checkAt(word, glob, base); } catch { rejected('경로 확인 불가'); }
    }
    if (cwdUnknown && policy.basenameDenied(basename(word))) rejected(word);
  };
  const fileTool = (name, input) => {
    if (memberPolicyError) { deny('하네스 설정을 읽을 수 없습니다.', 'guard'); return; }
    if (/^(?:Read|NotebookRead)$/i.test(name) || name === 'Grep') {
      const path = input.file_path ?? input.notebook_path ?? input.path;
      if (typeof path === 'string') check(path, false);
    }
    if (name === 'Grep' && typeof input.glob === 'string') {
      const pattern = basename(input.glob);
      // Broad filename selection is not evidence of intent to read a secret.
      if (/^\*+$/u.test(pattern)) return;
      for (const policy of policies) if (policy.basenameDenied(pattern) || !policy.readAllow.includes(pattern)
        && policy.readDeny.filter(p => !p.includes('/')).some(p => globsOverlap(pattern, p))) {
        // Exact allowlisted filenames do not become denied just because they also match a deny glob.
        if (!/[*?\[]/.test(pattern) && !policy.basenameDenied(pattern)) continue;
        rejected(pattern);
      }
    }
  };
  const bash = entries => {
    if (memberPolicyError) { deny('하네스 설정을 읽을 수 없습니다.', 'guard'); return; }
    const set = cwdSet ?? possibleCwds(entries, cwd, { workspace: !!members });
    for (const { words, rawWords, normalizedWords } of entries) {
      const effective = commandCwds(words, set);
      cwdUnknown = effective.unknown;
      bases = [...new Set([cwd, ...effective.cwds, ...(cwdUnknown && members ? [...members.map(m => m.path), ...worktrees.map(w => w.path)] : [])])];
      const args = commandWords(withoutRedirects(words)), exe = basename(args[0] ?? '');
      for (let i = 0; i < words.length; i++) if (['<', '<>'].includes(words[i]) && words[i + 1]) check(words[i + 1]);
      // Original tokens also contain control/group syntax. Classify metadata by the
      // normalized executable; redirects above and nested substitutions still get checked.
      const metadataExe = basename(commandWords(withoutRedirects(normalizedWords ?? words))[0] ?? '');
      const search = /^(?:grep|egrep|fgrep|rg|ag)$/.test(exe) ? searchArgs(args) : undefined;
      const subcommand = exe === 'git' ? gitSubcommand(args) : undefined;
      if (['echo', 'printf'].includes(exe) || exe === 'rg' && args.includes('--files')) continue;
      if (['ls', 'stat', 'test', '[', '[[', 'file', 'du', 'rm', 'mv'].includes(metadataExe)
        || exe === 'git' && ['check-ignore', 'ls-files', 'status'].includes(subcommand)) continue;
      const inlineIndex = args.findIndex((w, i) => i > 0 && (
        /^(?:node|bun)$/.test(exe) && ['-e', '--eval', '-p', '--print'].includes(w)
        || /^(?:python[\w.]*|perl|ruby)$/.test(exe) && w === (exe.startsWith('python') ? '-c' : '-e')
        || exe === 'deno' && w === 'eval'));
      const inline = inlineIndex > 0 ? args[inlineIndex + 1] : /^(?:node|bun)$/.test(exe)
        ? args.find(w => /^--(?:eval|print)=/.test(w))?.split('=').slice(1).join('=') : undefined;
      if (inline) for (const literal of inline.match(/[~\w./-]+/gu) ?? []) {
        check(literal, false);
      }
      // Shell source is parsed separately by shellCommands, not used as a filename here.
      const nested = /^(?:sh|bash|zsh|dash|ksh|fish|eval)$/.test(exe);
      const copies = ['cp', 'rsync', 'ditto', 'install', 'ln'].includes(exe);
      const singleLinkSource = exe === 'ln' && args.slice(1).filter(w => !w.startsWith('-')).length === 1;
      const destinations = copies && !singleLinkSource ? copyDestinations(args) : [];
      if (exe !== 'find') for (let i = 1; i < args.length; i++) {
        let word = args[i];
        if (search?.skip.has(i)) continue;
        if (exe === 'git' && ['show', 'cat-file'].includes(subcommand)
          && (/^[^:]+:.+/.test(word) || /^:(?:[0-3]:)?[^/].*/.test(word))) {
          const path = word.startsWith(':') ? word.replace(/^:(?:[0-3]:)?/, '') : word.slice(word.indexOf(':') + 1);
          check(path, false);
          try {
            const targets = gitTargets(words, { cwds: bases, unknown: cwdUnknown });
            for (const target of targets.cwds) {
              const tree = worktrees.find(w => pathInside(target, w.path));
              const member = members?.find(m => pathInside(target, m.path));
              let tops;
              if (tree) tops = [tree.path, members?.find(m => m.name === tree.repo)?.path ?? root];
              else if (member) tops = [member.path];
              else if (pathInside(target, root)) tops = [root];
              else {
                const top = spawnSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 });
                tops = [top.status === 0 && top.stdout.trim() ? top.stdout.trim() : target];
              }
              const candidates = [...tops.map(top => resolve(top, path)), ...(/^(?:\.\/|\.\.\/)/.test(path) ? [resolve(target, path)] : [])];
              for (const candidate of candidates) check(candidate, false);
            }
          } catch { rejected('경로 확인 불가'); }
          continue;
        }
        if (word === inline || nested || destinations.includes(word)) continue;
        if (filterOptions.includes(word)) { i++; continue; }
        if (filterOptions.some(opt => word.startsWith(opt + '='))) continue;
        if (word.startsWith('--') && word.includes('=')) word = word.slice(word.indexOf('=') + 1);
        else if (word.startsWith('-')) continue;
        const raw = rawWords[words.indexOf(args[i])] ?? word;
        check(word, /[*?\[]/.test(unquoted(raw)));
      }
      const grep = /^(?:grep|egrep|fgrep)$/.test(exe), rg = exe === 'rg', ag = exe === 'ag';
      const findRead = exe === 'find' && args.some((w, i) => ['-exec', '-execdir', '-ok'].includes(w)
        && /^(?:cat|head|tail|less|more|grep|egrep|fgrep|sed|awk|strings|xxd|od|hexdump|base64|jq)$/.test(basename(args[i + 1] ?? '')));
      const recursive = findRead || grep && args.some((w, i) => /^-[^-]*[rR]/.test(w) || ['--recursive', '--dereference-recursive'].includes(w) || w === '-d' && args[i + 1] === 'recurse')
        || rg && args.some(w => /^-[^-]*u/.test(w) || ['--hidden', '--unrestricted', '-.'].includes(w) || w.startsWith('--no-ignore'))
        || ag && args.some(w => /^-[^-]*[uU]/.test(w) || ['--unrestricted', '--hidden'].includes(w));
      if (!recursive) continue;
      const exclude = [], excludeDirs = [], include = [], rgExclude = [];
      for (const [opt, value] of search?.filters ?? []) {
        if (opt === '--exclude') exclude.push(value);
        else if (opt === '--exclude-dir') excludeDirs.push(value);
        else if (opt === '--include') include.push(value);
        else if (value.startsWith('!')) rgExclude.push({ value: value.slice(1), insensitive: opt === '--iglob' });
      }
      const findOptions = args.findIndex((w, i) => i > 0 && w.startsWith('-'));
      const operands = search?.paths ?? args.slice(1, findOptions < 0 ? undefined : findOptions);
      const paths = operands.filter(w => !/[$`]/.test(w)).flatMap(word => bases.map(base => expanded(word, base))).filter(existsSync);
      // Unknown value-taking options may have consumed the pattern. Never silently scan nothing.
      const targets = paths.length ? paths.filter(directoryExists) : bases;
      const ignores = rg && !args.some(w => /^-[^-]*u/.test(w) || w === '--unrestricted' || w.startsWith('--no-ignore'))
        || ag && !args.some(w => /^-[^-]*[uU]/.test(w) || w === '--unrestricted');
      const pruneDirectories = directories => {
        if (!ignores) return new Set();
        const groups = new Map();
        try {
          for (const directory of directories) {
            let owner = cwd;
            if (members) {
              const tree = worktrees.find(w => pathInside(directory, w.path));
              const member = members.find(m => pathInside(directory, m.path));
              if (tree) owner = tree.path;
              else if (member) { if (!existsSync(resolve(member.path, '.git'))) continue; owner = member.path; }
              else if (!existsSync(resolve(root, '.git'))) continue;
            } else if (!existsSync(resolve(root, '.git'))) continue;
            const paths = groups.get(owner) ?? []; paths.push(directory); groups.set(owner, paths);
          }
          const result = new Set();
          for (const [owner, paths] of groups) {
            const ignored = spawnSync('git', ['-C', owner, 'check-ignore', '--stdin', '-z'], {
              input: paths.map(p => p + '/').join('\0') + '\0', encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
            });
            if (ignored.status === 0 || ignored.status === 1) for (const path of ignored.stdout.split('\0')) result.add(path.replace(/\/$/, ''));
          }
          return result;
        } catch { return new Set(); }
      };
      const match = (pattern, name) => globRegex(pattern)?.test(name);
      for (const dir of targets) {
        const scan = scanSecretFiles(dir, policy, { skip: rg || ag ? ['.git'] : ['.git', 'node_modules'], pruneDirectories,
          excludeDir: name => excludeDirs.some(p => match(p, name)) });
        const files = scan.files.filter(path => {
          const name = basename(path);
          return !exclude.some(p => match(p, name)) && (!include.length || include.some(p => match(p, name)))
            && !rgExclude.some(({ value, insensitive }) => {
              const candidate = value.includes('/') ? path.slice(resolve(dir).length + 1) : name;
              return match(insensitive ? value.toLowerCase() : value, insensitive ? candidate.toLowerCase() : candidate);
            });
        });
        if (files.length || scan.exceeded) deny(`비밀 파일(${files.length ? basename(files[0]) : '탐색 상한 초과'})이 있는 디렉터리를 재귀로 읽습니다. rg(기본으로 .gitignore·숨김 제외) 또는 --exclude='.env*' 를 쓰세요`, 'boundary');
      }
    }
  };
  return { fileTool, bash };
}
