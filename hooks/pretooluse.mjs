import { globRegex, dynamicPathPattern, specificDynamicPattern } from './path-patterns.mjs';
import { writePaths, withoutRedirects, copyDestinations } from './write-paths.mjs';
import { unquoted, withoutExpansions } from './shell-parts.mjs';
import { approvalRules } from './approval-rules.mjs';
import { tempPolicy, tempVariables, assignedInCommand } from './temp-paths.mjs';
import { shellCommands, commandWords, temporaryCommandsSafe } from './shell-commands.mjs';
import { readFileSync, readdirSync, realpathSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this literal identical to src/provider/privacy.ts (covered by hook tests).
const secretPattern = /sk-ant-[A-Za-z0-9_-]*|sk-proj-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|xox[abp]-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]*|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|Bearer [A-Za-z0-9._-]{20,}/;

const deny = (message, kind = 'guard') => {
  const label = { approval: '승인', boundary: '경계', guard: '보호' }[kind];
  process.stderr.write(`하네스 가드[${label}]: ${message}\n`);
  process.exit(2);
};

function gitAction(words) {
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(word)) {
      index++;
    } else if (!word.startsWith('-')) {
      return word;
    }
  }
}

function patchTarget(words, cwd) {
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

// Resolve existing ancestors before comparing even when the destination is new.
function normalizePath(value) {
  try { return resolvePath(value); }
  catch (error) {
    if (!['EACCES', 'ELOOP', 'ENAMETOOLONG'].includes(error.code)) throw error;
    if (process.env.FODH_BRAIN === '1') deny(`경로를 확인할 수 없습니다: ${value}`, 'boundary');
    const path = resolve(value);
    return process.platform === 'darwin' ? path.toLowerCase() : path;
  }
}
function resolvePath(value, depth = 0) {
  if (depth > 40) throw Object.assign(new Error('symlink cycle'), { code: 'ELOOP' });
  let current = resolve(value);
  const tail = [];
  for (;;) {
    try {
      const path = resolve(realpathSync.native(current), ...tail);
      return process.platform === 'darwin' ? path.toLowerCase() : path;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) return resolvePath(resolve(dirname(current), readlinkSync(current), ...tail), depth + 1);
      } catch (statError) { if (!['ENOENT', 'ENOTDIR'].includes(statError.code)) throw statError; }
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(basename(current)); current = parent;
    }
  }
}
const samePath = (a, b) => normalizePath(a) === normalizePath(b);
const inside = (path, base) => {
  path = normalizePath(path); base = normalizePath(base);
  return path === base || path.startsWith(`${base}${sep}`);
};
const tempRemovalMessage = '임시 변수 예외를 줄 수 없는 조합입니다. mktemp 가 출력한 리터럴 경로로 지우세요(셸 변수는 호출 사이에 남지 않습니다)';
const sourceMessage = '소스 파일은 두뇌가 쓰지 않습니다. 워크트리로 위임하세요(fodh codex task / Claude Agent).';

function commandsRiskyForTemp(parsed) {
  const mutations = new Set();
  const risky = parsed.entries.some(({ words, source }) => {
    const args = commandWords(words), exe = basename(args[0] ?? '');
    if (['cp', 'install', 'rsync', 'ditto', 'tar', 'bsdtar', 'gtar', 'unzip', 'cpio', '7z', '7za', '7zz'].includes(exe)) mutations.add(source + JSON.stringify(args));
    return ['ln', 'mv', 'git'].includes(exe) || exe === 'cp' && args.some(word => /^-[^-]*[ls]/.test(word) || ['--link', '--symbolic-link'].includes(word)) || exe === 'rsync' && args.some(word => ['--remove-source-files', '--remove-sent-files'].includes(word));
  });
  return risky || mutations.size > 1;
}

const rules = {
  'prod-migration': /^(?:prisma migrate (?:deploy|reset)\b|psql\b[^;|&\n]*\b(?:drop|truncate|delete)\b|neonctl\b)/i,
  'store-upload': /^(?:fastlane|altool|iTMSTransporter)\b[^;|&\n]*\b(?:upload|deliver|pilot|submit)\b|^eas submit\b/i,
  'payment': /^stripe\b|^curl\b[^;|&\n]*\bapi\.stripe\.com\b/i,
  'push-main': /^git\b[^;|&\n]*\bpush\b[^;|&\n]*(?:\bmain\b|\bmaster\b|--force|-f\b|--delete|\s:[^\s]+)|^git (?:branch|tag) [^;|&\n]*-[dD]/,
  'env-delete':
    /^(?:vercel env (?:rm|add)\b|gh secret (?:set|delete)\b|rm\b[^;|&\n]*(?:^|[\s/])\.env[^\s]*|security delete-generic-password\b)/i,
  'external-send':
    /^(?:slack\b[^;|&\n]*\b(?:send|post|publish|reply)\b|mcporter\b[^;|&\n]*\bsend\b|gh api\b[^;|&\n]*--method (?:POST|DELETE)\b)/i,
  'prod-deploy': /^(?:vercel|netlify|firebase|wrangler|fly|railway)\b[^;|&\n]*(?:--prod|deploy)|^deploy\b[^;|&\n]*\b(?:prod|production)\b/i,
  'account-admin': /^(?:aws iam\b|gcloud iam\b|gh api\b[^;|&\n]*--method (?:POST|DELETE)\b)/i,
  'system-settings':
    /^(?:launchctl\b|security (?:add|delete|set)\b|defaults write\b)|(?:>|\btee\b|\bsed\b)[^;|&\n]*\.(?:zshrc|bashrc|profile)/i,
  'paid-resource':
    /^(?:aws (?:ec2 run-instances|rds create-db-instance)\b|gcloud (?:compute instances create|sql instances create)\b|stripe\b)/i,
  'dns': /^(?:vercel domains (?:add|rm)\b|certbot\b|aws route53 change-resource-record-sets\b|gcloud dns\b)/i,
};

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const name = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};
  const text = JSON.stringify(input);
  const cwd = event.cwd ?? process.cwd();
  const root = resolve(process.env.FODH_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || cwd);
  const brain = process.env.FODH_BRAIN === '1';
  const delegationMessage = '위임은 fodh codex task / Claude Agent 로만 한다';
  if (brain && (name.startsWith('mcp__') && /codex/i.test(name)
    || ['Agent', 'Task'].includes(name) && /^codex:/.test(String(input.subagent_type ?? ''))
    || name === 'Skill' && [input.skill, input.name].some(value => typeof value === 'string' && value.startsWith('codex:')))) deny(delegationMessage, 'boundary');
  const editing = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/i.test(name);
  const bash = name === 'Bash';
  let state;
  try {
    state = JSON.parse(readFileSync(resolve(root, '.pi/harness-state.json'), 'utf8'));
    if (!state || typeof state !== 'object' || typeof state.state !== 'string') throw new Error('state');
  } catch (error) {
    if (error.code !== 'ENOENT' && (brain || editing || bash)) deny('하네스 상태를 읽을 수 없습니다.');
    state = undefined;
  }
  const worktrees = (Array.isArray(state?.worktrees) ? state.worktrees : [])
    .filter(w => typeof w?.path === 'string').map(w => resolve(root, w.path));
  const inWorktree = path => worktrees.some(w => inside(path, w));
  const docs = resolve(root, process.env.FODH_DOCS_ROOT || 'docs');
  const boundary = (value, bashWrite = false) => {
    const path = normalizePath(resolve(cwd, value));
    if (inside(path, resolve(root, '.claude/skills'))) deny('스킬은 fodh skills install로만 변경할 수 있습니다.', 'boundary');
    if (inWorktree(path)) return;
    if (bashWrite && (!inside(path, root) || /^\/dev\/(?:null|stdout|stderr|tty|fd\/.*)$/.test(path))) return;
    if (!inside(path, root)) deny('프로젝트 밖 쓰기는 금지합니다. .pi/scratch/를 사용하세요.', 'boundary');
    if (inside(path, docs) || inside(path, resolve(root, '.pi'))
      || ['CLAUDE.md', 'AGENTS.md', 'README.md'].some(f => samePath(path, resolve(root, f)))) return;
    deny(sourceMessage, 'boundary');
  };
  // An initialized project must not silently ignore an unreadable configuration.
  let projectRules = [];
  {
    try {
      const config = JSON.parse(readFileSync(resolve(root, '.pi/harness.json'), 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config');
      projectRules = approvalRules(config.approvalRules);
    } catch (error) { if (brain) deny('하네스 설정을 읽을 수 없습니다.'); }
  }
  let judgmentFile = 'docs/판단대기.md';
  try {
    const configured = JSON.parse(readFileSync(resolve(root, '.pi/harness.json'), 'utf8')).judgment?.file;
    if (typeof configured === 'string' && configured) judgmentFile = configured;
  } catch { /* Uninitialized projects still protect the default path and journals. */ }
  const judgmentPath = value => {
    const path = normalizePath(resolve(cwd, value));
    return samePath(path, resolve(root, judgmentFile))
      || samePath(dirname(path), resolve(root, '.pi')) && /^harness-judgment.*\.json$/.test(basename(path));
  };
  const judgmentMessage = '판단대기 문서는 사용자만 고칩니다. 새 판단은 fodh judgment add 로 등록하라';
  const hooks = dirname(fileURLToPath(import.meta.url));
  const command = String(input.command ?? '');
  const extraProtected = ['.pi/interview-bank.md', '.pi/templates', ...(process.env.FODH_PROTECTED_EXTRA ?? '').split(':').filter(Boolean)].map(value => resolve(root, value));
  const protectedPath = value => {
    const path = normalizePath(resolve(cwd, value));
    return extraProtected.some(extra => inside(path, extra))
      || samePath(dirname(path), resolve(root, '.claude')) && /^settings.*\.json$/.test(basename(path))
      || inside(path, hooks)
      || (samePath(dirname(path), resolve(root, '.pi')) && /^harness.*\.jsonl?$/.test(basename(path)));
  };
  const startupNames = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.config/fish/config.fish'];
  const startupRoots = [process.env.HOME, process.env.ZDOTDIR].filter(Boolean);
  const startupFiles = [...startupRoots.flatMap(base => startupNames.map(name => resolve(base, name))),
    ...(process.env.CLAUDE_ENV_FILE ? [resolve(process.env.CLAUDE_ENV_FILE)] : [])];
  const expandedPath = value => resolve(cwd, value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
    .replace(/\$(?:\{(HOME|ZDOTDIR|CLAUDE_ENV_FILE)\}|(HOME|ZDOTDIR|CLAUDE_ENV_FILE)\b)/g, (match, a, b) => process.env[a ?? b] ?? match));
  const startupPath = value => brain && startupFiles.some(file => samePath(expandedPath(value), file));
  const startupDirectories = [...new Set([...startupRoots, ...startupFiles.map(dirname)])];
  const startupMessage = '셸 시작 파일은 두뇌가 바꿀 수 없습니다';
  if (brain && editing && startupPath(input.file_path ?? input.notebook_path ?? '')) deny(startupMessage);
  const guardDirectories = [resolve(root, '.pi'), resolve(root, '.claude'), hooks,
    ...extraProtected.flatMap(path => [path, dirname(path)])];
  const judgmentDirectory = dirname(resolve(root, judgmentFile));
  const candidates = [resolve(root, '.pi/harness.json'), resolve(root, '.pi/harness-state.json'),
    resolve(root, '.claude/settings.json'), resolve(root, '.claude/settings.local.json'), ...extraProtected];
  for (const directory of guardDirectories) {
    try { candidates.push(...readdirSync(directory).map(name => resolve(directory, name)).filter(protectedPath)); }
    catch { /* Missing files do not expand as globs; brain also rejects their directory prefix. */ }
  }
  const directoryClues = target => {
    const clues = guardDirectories.filter(dir => inside(target, dir) && inside(dir, root) && !samePath(dir, root))
      .map(dir => {
        const rel = relative(root, dir), first = rel.split(sep)[0];
        return first.startsWith('.') ? first : rel;
      });
    if (brain && startupFiles.some(file => samePath(target, file))) {
      const dir = dirname(target);
      if (!startupRoots.some(base => samePath(dir, base)) && !inside(root, dir)) clues.push(dir);
    }
    return clues;
  };
  const patternGuard = (value, rawWords, words, dynamicPattern) => {
    const syntax = words.flatMap((word, i) => word.includes(value) ? [unquoted(withoutExpansions(rawWords[i] ?? ''))] : []);
    if (brain && syntax.some(word => /\([^()]*\)$/.test(word))) deny('검사할 수 없는 셸 구문입니다. 단순한 명령으로 나눠 쓰세요', 'boundary');
    const literal = syntax.some(word => /[*?\[]/.test(word));
    if (!literal && dynamicPattern === undefined) return;
    const absolute = expandedPath(dynamicPattern ?? withoutExpansions(value)), regex = globRegex(absolute);
    const prefix = absolute.split(/[*?\[]/, 1)[0];
    const directory = prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix);
    const near = dirs => dynamicPattern === undefined && dirs.some(dir => samePath(directory, dir));
    const matches = target => regex?.test(target) && (dynamicPattern === undefined
      || specificDynamicPattern(dynamicPattern, directoryClues(target)));
    const copy = commandWords(withoutRedirects(words));
    if (regex && ['cp', 'mv', 'install', 'ditto', 'rsync', 'ln'].includes(basename(copy[0] ?? ''))
      && copyDestinations(copy).includes(value) && guardDirectories.some(dir => matches(dir)
        // A dynamic parent can be '.', e.g. $D/.pi; keep that explicit W1 copy case protected.
        || dynamicPattern !== undefined && matches(`${dirname(dir)}/./${basename(dir)}`))) {
      deny('가드 설정은 fodh로만 변경할 수 있습니다.');
    }
    if (brain && (regex && startupFiles.some(matches) || (!regex || brain) && near(startupDirectories))) deny(startupMessage);
    if (regex && candidates.some(matches) || (!regex || brain) && near(guardDirectories)) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
    if (brain && (matches(resolve(root, judgmentFile)) || near([judgmentDirectory]))) deny(judgmentMessage, 'boundary');
  };
  if ((editing || bash) && secretPattern.test(text)) {
    deny('비밀값 패턴을 기록할 수 없습니다.');
  }
  if (brain && editing && judgmentPath(input.file_path ?? input.notebook_path ?? '')) deny(judgmentMessage, 'boundary');
  if (editing && protectedPath(input.file_path ?? input.notebook_path ?? '')) {
    deny('가드 설정은 fodh로만 변경할 수 있습니다.');
  }
  if (brain && editing) boundary(input.file_path ?? input.notebook_path ?? '');
  if (!bash) process.exit(0);

  const parsed = shellCommands(command, { extended: brain });
  const { entries, unterminatedHeredoc } = parsed;
  const groups = entries.map(entry => entry.words);
  const tempEnabled = temporaryCommandsSafe(command, parsed);
  const temporary = tempPolicy({ root, worktrees, hooks, normalize: normalizePath });
  const safeDestinationTemps = !parsed.unresolved && !commandsRiskyForTemp(parsed);
  const destinationSubstitutions = new Map(entries.map(entry => [entry.words, tempVariables(entry.source, temporary, { wholeCommand: command, enabled: safeDestinationTemps && entry.tempAllowed })]));
  const rawWordsByGroup = new Map(entries.map(entry => [entry.words, entry.rawWords]));
  const substitutions = new Map(entries.map(entry => [entry.words, tempVariables(entry.source, temporary, { wholeCommand: command, enabled: tempEnabled && entry.tempAllowed })]));
  if (brain && unterminatedHeredoc) deny('heredoc 종료 표지를 찾을 수 없습니다');
  for (const words of groups) {
    const assignment = words.some(word => /^FODH_[A-Z_]*=/.test(word));
    const unset = words.some((word, index) => basename(word) === 'unset' && words.slice(index + 1).some(arg => /^FODH_[A-Z_]+$/.test(arg)));
    const clearedEnv = words.some((word, index) => basename(word) === 'env' && words.slice(index + 1).some((arg, offset, args) =>
      arg === '-i' || arg === '--ignore-environment' || /^-uFODH_[A-Z_]+$/.test(arg) || /^--unset=FODH_[A-Z_]+$/.test(arg)
      || (arg === '-u' || arg === '--unset') && /^FODH_[A-Z_]+$/.test(args[offset + 1] ?? '')));
    const args = commandWords(words), executable = basename(args[0] ?? '');
    const inline = /^(?:sh|bash|zsh|python\w*)$/.test(executable) ? ['-c']
      : executable === 'node' ? ['-e', '--eval'] : executable === 'perl' ? ['-e'] : [];
    const nestedEnv = ['eval', 'source', '.'].includes(executable) && args.slice(1).some(w => /FODH_/.test(w))
      || args.some((word, i) => (inline.includes(word) || /^(?:sh|bash|zsh)$/.test(executable) && /^-[a-zA-Z]*c$/.test(word)) && /FODH_[A-Z_]*/.test(args[i + 1] ?? '')
      || executable === 'node' && word.startsWith('--eval=') && /FODH_[A-Z_]*/.test(word));
    if (assignment || unset || clearedEnv || nestedEnv) deny('하네스 환경변수는 바꿀 수 없습니다.');
  }
  const commands = groups.filter(words => words.length).map(commandWords);
  const globCompanion = word => /[*?\[]/.test(word ?? '') && /plugins\/cache|codex-companion/.test(word);
  const interpreter = executable => /^(?:node|bun|deno|python[\w.]*)$/.test(executable);
  const firstScript = args => {
    for (let i = 1; i < args.length; i++) {
      const word = args[i];
      if (['-e', '--eval', '-c', '-m', '-p', '--print'].includes(word) || /^(?:--eval|--print)=/.test(word)) return undefined;
      if (['-r', '--require', '--loader', '--import'].includes(word)) { i++; continue; }
      if (word === '--') return args[i + 1];
      if (!word.startsWith('-')) return word;
    }
  };
  const directDelegation = words => {
    const executable = basename(words[0] ?? '');
    if (['codex', 'claude', 'cswap'].includes(executable) || globCompanion(words[0])) return true;
    if (interpreter(executable) && globCompanion(firstScript(words))) return true;
    if (words.some(word => !/[*?\[]/.test(word) && (basename(word).startsWith('codex-companion') || word.includes('/plugins/cache/openai-codex/')))) return true;
    if (executable !== 'find') return false;
    const names = words.flatMap((word, i) => ['-name', '-iname', '-path', '-ipath'].includes(word) ? [words[i + 1] ?? ''] : []);
    return words.some((word, i) => {
      if (!['-exec', '-execdir', '-ok'].includes(word)) return false;
      const target = words.slice(i + 1), command = basename(target[0] ?? '');
      if (['codex', 'claude', 'cswap'].includes(command) || globCompanion(target[0])) return true;
      const script = interpreter(command) ? firstScript(target) : target[1];
      if (globCompanion(script)) return true;
      // {} resolves to the paths selected by find, rather than a literal script name.
      return interpreter(command) && script === '{}' && (names.some(globCompanion)
        || words.slice(1, i).some(value => value.includes('/plugins')) && names.some(value => /companion|codex-comp/.test(value)));
    });
  };
  if (brain && commands.some(directDelegation)) deny(delegationMessage, 'boundary');
  if (input.run_in_background === true && commands.some(words => basename(words[0] ?? '') === 'fodh' && words[1] === 'codex' && words.includes('--wait'))) {
    deny('--wait 를 백그라운드로 돌리지 마라. 포그라운드로 실행하거나 --wait 없이 시작한 뒤 `대기: 위임 <runId>` 로 턴을 끝내라', 'boundary');
  }
  for (const words of groups) {
    const args = commandWords(words), executable = basename(args[0] ?? '');
    const destinationOnly = !(executable === 'cp' && args.some(word => /^-[^-]*[ls]/.test(word) || ['--link', '--symbolic-link'].includes(word))) && ['cp', 'install', 'ditto', 'rsync'].includes(executable) && !args.some(word => ['--remove-source-files', '--remove-sent-files'].includes(word));
    const dynamicPatterns = [];
    const resolveCheck = value => {
      const rawWords = rawWordsByGroup.get(words) ?? [];
      patternGuard(value, rawWords, words);
      const substitution = (destinationOnly ? destinationSubstitutions : substitutions).get(words)?.(value);
      if (brain && executable === 'rm' && writePaths(withoutRedirects(words)).includes(value)
        && /^\$(?:[A-Za-z_][A-Za-z_0-9]*|\{[A-Za-z_][A-Za-z_0-9]*\})(?:\/.*)?$/.test(value)
        && assignedInCommand(command, /^\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})/.exec(value).slice(1).find(Boolean))
        && (!substitution || substitution.empty && !temporary.tempSafe(substitution.empty))) deny(tempRemovalMessage, 'boundary');
      if (!substitution) for (let i = 0; i < words.length; i++) {
        if (!words[i].includes(value)) continue;
        const pattern = dynamicPathPattern(rawWords[i] ?? '');
        if (pattern !== undefined) {
          // Remove command prefixes such as dd of= while preserving the raw expansion.
          const prefix = words[i].slice(0, words[i].indexOf(value));
          dynamicPatterns.push({ value, pattern: pattern.startsWith(prefix) ? pattern.slice(prefix.length) : pattern });
        }
      }
      return substitution ? [{ value: substitution.path, tempException: true },
        ...(substitution.empty ? [{ value: substitution.empty, tempException: false }] : [])]
        : [{ value, tempException: tempEnabled, unresolved: /[$`]/.test(value) }];
    };
    const checks = writePaths(words).flatMap(resolveCheck);
    const paths = checks.map(check => check.value);
    {
      const operands = withoutRedirects(args);
      const copying = ['cp', 'mv', 'rsync', 'ditto', 'install'].includes(executable);
      const explicitDestinations = operands.flatMap((word, i) => word === '-t' || word === '--target-directory' ? [operands[i + 1]] : word.startsWith('--target-directory=') ? [word.slice(19)] : []);
      const destinations = copying || executable === 'ln' ? explicitDestinations.length ? explicitDestinations : [operands.at(-1)] : [];
      const targetDirectory = destinations.filter(Boolean).some(value => samePath(resolve(cwd, value), dirname(resolve(root, judgmentFile))));
      const sources = operands.slice(1).filter((word, i) => !word.startsWith('-') && !destinations.includes(word)
        && !['-t', '--target-directory'].includes(operands[i]));
      const sourceDirectory = commands.some(command => basename(command[0] ?? '') === 'cd') || sources.some(word => {
        if (word.endsWith('/')) return true;
        try { return statSync(resolve(cwd, word)).isDirectory(); } catch { return true; }
      });
      const recursive = sourceDirectory && operands.some(word => /^-[^-]*[rRa]/.test(word) || ['--recursive', '--archive'].includes(word));
      const matchingSource = operands.slice(1).some(word => !destinations.includes(word) && basename(word) === basename(judgmentFile));
      const tar = ['tar', 'bsdtar', 'gtar'].includes(executable);
      const archiveRead = executable === 'unzip' && operands.some(word => /^-[^-]*[lvtpczZ]/.test(word))
        || tar && operands.some(word => /^-[^-]*O/.test(word) || word === '--to-stdout');
      const extracting = !archiveRead && (executable === 'cpio' && operands.some(word => /^-[^-]*i/.test(word) || word === '--extract') || ['7z', '7za', '7zz'].includes(executable) && operands[1] === 'x' || executable === 'unzip' || executable === 'ditto' && operands.includes('-x') || tar && (operands.some(word => /^-[^-]*x/.test(word) || word === '--extract' || word === '--get')
        || /^[a-zA-Z]*x[a-zA-Z]*$/.test(operands[1] ?? '')));
      const archiveDestinations = extracting && ['7z', '7za', '7zz'].includes(executable) ? operands.filter(word => word.startsWith('-o')).map(word => word.slice(2)) : extracting && executable === 'ditto' ? [operands.at(-1)] : extracting ? operands.flatMap((word, i) =>
        word === (tar ? '-C' : '-d') || tar && word === '--directory' ? [operands[i + 1]]
          : tar && word.startsWith('--directory=') ? [word.slice(12)]
          : word.startsWith(tar ? '-C' : '-d') && word.length > 2 ? [word.slice(2)] : []) : [];
      const archiveOverwrite = extracting && (archiveDestinations.length
        ? archiveDestinations.some(value => samePath(resolve(cwd, value), dirname(resolve(root, judgmentFile))) || judgmentPath(value))
        : samePath(cwd, dirname(resolve(root, judgmentFile))) || operands.some(word => word.includes(basename(judgmentFile))));
      // Directory destinations can overwrite protected basenames without naming the final path.
      const directoryOverwrite = (protectedFile, directories) => destinations.filter(Boolean).some(value => {
        const dest = expandedPath(value);
        return directories.some(dir => samePath(dest, dir)) && (executable === 'rsync' || executable === 'ditto' && !extracting
          || operands.some(word => /^-[^-]*[rRa]/.test(word) || ['--recursive', '--archive'].includes(word))
          || sources.some(source => /[$`*?\[{}]/.test(source) || protectedFile(resolve(dest, basename(source)))));
      });
      const archiveInto = (directories, exact = false) => extracting && (archiveDestinations.length ? archiveDestinations : [cwd])
        .filter(Boolean).some(value => directories.some(dir => exact ? samePath(expandedPath(value), dir) : inside(expandedPath(value), dir)));
      if (brain && (paths.some(startupPath) || destinations.filter(Boolean).some(startupPath)
        || directoryOverwrite(startupPath, startupDirectories) || archiveInto(startupDirectories, true))) deny(startupMessage);
      if (directoryOverwrite(protectedPath, guardDirectories)
        || archiveInto([resolve(root, '.claude'), hooks, ...extraProtected])
        || executable === 'ln' && operands.slice(1).filter(word => !word.startsWith('-')).some(protectedPath)) {
        deny('가드 설정은 fodh로만 변경할 수 있습니다.');
      }
      if (brain && (targetDirectory && (executable === 'ln' || recursive || matchingSource) || archiveOverwrite)) deny(judgmentMessage, 'boundary');
      if (paths.some(protectedPath)) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
      for (const { value, pattern } of dynamicPatterns) patternGuard(value, rawWordsByGroup.get(words) ?? [], words, pattern);
      if (brain && extracting && (archiveDestinations.length ? archiveDestinations : [cwd]).some(value =>
        inside(expandedPath(value), resolve(root, '.pi')) && !inside(expandedPath(value), resolve(root, '.pi/scratch')))) deny('.pi 아래에는 아카이브를 풀 수 없습니다', 'boundary');
      const recursiveCopy = ['rsync', 'ditto'].includes(executable) && !extracting
        || executable === 'cp' && operands.some(word => /^-[^-]*[rRa]/.test(word) || ['--recursive', '--archive'].includes(word));
      if (brain && (extracting || recursiveCopy)) {
        if (commands.some(words => ['cd', 'pushd', 'popd'].includes(basename(words[0] ?? '')))) deny('추출·재귀 복사의 실행 경로를 확인할 수 없습니다', 'boundary');
        const targets = extracting ? archiveDestinations.length ? archiveDestinations : [cwd] : destinations;
        for (const value of targets.filter(Boolean)) {
          const substitute = destinationSubstitutions.get(words)?.(value);
          const target = substitute?.path ?? expandedPath(value);
          const literal = substitute || !/[$`*?\[(<^#]/.test(value);
          const barriers = [root, ...guardDirectories, ...startupDirectories];
          const allowedTree = worktrees.some(tree => inside(target, tree) && !inside(target, resolve(tree, '.pi')) && !inside(target, resolve(tree, '.claude')));
          const safe = literal && (inside(target, resolve(root, '.pi/scratch')) || temporary.tempSafe(target) || allowedTree);
          if (!literal || barriers.some(dir => inside(dir, target))
            || worktrees.some(tree => inside(target, resolve(tree, '.pi')) || inside(target, resolve(tree, '.claude')))) deny('보호 경로·상위 디렉터리로 추출하거나 재귀 복사할 수 없습니다', 'boundary');
          if (!safe) boundary(target, true);
        }
      }
      const shells = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'mksh', 'yash', 'ash', 'pdksh'];
      const shellArgs = ['busybox', 'toybox'].includes(executable) ? operands.slice(1) : operands;
      const shellName = basename(shellArgs[0] ?? '');
      let script, inlineShell = false, stdinFlag = false;
      for (let i = 1; i < shellArgs.length; i++) {
        const word = shellArgs[i];
        if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(word)) { i++; continue; }
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) { inlineShell = true; break; }
        if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(word)) { stdinFlag = true; continue; }
        if (word === '--') { script = shellArgs[i + 1]; break; }
        if (word.startsWith('-') && word !== '-' || word.startsWith('+')) continue;
        script = word; break;
      }
      const stdinPath = value => value === '-' || value === '/dev/stdin' || /^\/(?:dev\/fd|proc\/self\/fd)\//.test(value ?? '')
        || ['<', '>'].includes(value) || /^[<>]\(/.test(value ?? '');
      if (brain && (shells.includes(shellName) && !inlineShell && (stdinFlag || !script || stdinPath(script) || args.some((word, i) => ['<', '>'].includes(word) && args[i + 1]?.startsWith('(')))
        || ['source', '.'].includes(executable) && stdinPath(args[1]))) {
        deny("표준입력으로 셸에 명령을 넘기는 형태는 검사할 수 없습니다. bash -c '…' 로 쓰세요", 'boundary');
      }
      const interpreters = ['python', 'python3', 'node', 'perl', 'ruby', 'bun', 'deno', 'php', 'osascript'];
      const inline = interpreters.includes(executable)
        && args.some(word => /^-[^-]*[cei]/.test(word) || word === '--eval' || word.startsWith('--eval='));
      const stdinInterpreter = interpreters.includes(executable) && !inline && !operands.includes('-m')
        && (!firstScript(operands) || firstScript(operands) === '/dev/stdin');
      const sedEdit = executable === 'sed' && args.some(word => /^-[^-]*i/.test(word) || word.startsWith('--in-place'));
      const guardMention = value => value.includes('settings') && value.includes('.claude')
        || value.includes('harness') && value.includes('.pi') || value.includes(hooks)
        || value.includes(basename(dirname(hooks)) + '/' + basename(hooks)) || value.includes('pretooluse');
      const inlineText = stdinInterpreter ? command : args.slice(1).join(' ');
      if (brain && (inline || sedEdit || stdinInterpreter)) {
        if (startupNames.some(name => new RegExp('(?:^|[/~\\\'\"\\s=])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\\'\"\\s);])').test(inlineText))
          || process.env.CLAUDE_ENV_FILE && inlineText.includes(process.env.CLAUDE_ENV_FILE)) deny(startupMessage);
        if (guardMention(inlineText)) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
      }
      if (brain && (paths.some(judgmentPath)
        || destinations.filter(Boolean).some(judgmentPath)
        || targetDirectory && (executable === 'ln' || recursive || matchingSource) || archiveOverwrite
        || executable === 'ln' && operands.slice(1).filter(word => !word.startsWith('-')).some(judgmentPath)
        || (inline || sedEdit || stdinInterpreter) && inlineText.includes(basename(judgmentFile)))) deny(judgmentMessage, 'boundary');
    }
    if (paths.some(protectedPath)) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
    if (process.env.FODH_CODEX_CHILD === '1' && executable === 'fodh') deny('Codex 자식은 fodh를 실행할 수 없습니다.', 'boundary');
    if (brain) {
      if (executable === 'fodh' && args[1] === 'memory' && args[2] === 'reset') deny('두뇌 세션은 memory reset 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요');
      const action = executable === 'git' ? gitAction(args) : undefined;
      if (['revert', 'cherry-pick', 'am'].includes(action)) {
        let target = cwd;
        for (let i = 1; i < args.indexOf(action); i++) {
          if (args[i] === '-C') target = resolve(target, args[++i] ?? '.');
          else if (args[i].startsWith('-C') && args[i].length > 2) target = resolve(target, args[i].slice(2));
        }
        if (!inWorktree(target) || commands.some(words => basename(words[0] ?? '') === 'cd')
          || words.some(w => /^GIT_(?:DIR|WORK_TREE)=/.test(w)) || words[0] === 'env' && words.some(w => w === '-C' || w.startsWith('--chdir')) || args.some(w => /^--(?:git-dir|work-tree)(?:=|$)/.test(w))) deny('main 변경은 task 워크트리 위임으로만 한다', 'boundary');
      }
      const patch = patchTarget(words, cwd);
      if (patch && !inWorktree(patch)) deny('패치 적용은 워크트리에서만 허용합니다.', 'boundary');
      if (action === 'worktree' && args.some(w => ['add', 'remove', 'prune'].includes(w))) deny('git worktree 직접 실행 대신 fodh worktree를 사용하세요.', 'boundary');
      const gitArgs = action ? args.slice(args.indexOf(action) + 1) : [];
      if (action === 'branch' && gitArgs.some(w => /^-[^-]*[fDMC]/.test(w) || w === '--force')
        || action === 'checkout' && gitArgs.some(w => w === '-B' || w.startsWith('-B') && w.length > 2)
        || action === 'switch' && gitArgs.some(w => /^-C/.test(w) || w === '--force-create' || w.startsWith('--force-create='))
        || ['fetch', 'push'].includes(action) && gitArgs.some(w => w.startsWith('+'))
        || action === 'merge' && gitArgs.some((w, i) => ['-s', '-X', '--strategy', '--strategy-option'].includes(w) && gitArgs[i + 1] === 'ours'
          || ['-sours', '-Xours', '--strategy=ours', '--strategy-option=ours'].includes(w))
        || ['update-ref', 'rebase', 'filter-branch'].includes(action)
        || action === 'reset' && gitArgs.length > 0
        || action === 'reflog' && gitArgs.includes('expire')) deny('두뇌의 git 이력·참조 재작성은 금지합니다. 사용자 터미널에서 처리하세요.', 'guard');
      if (action === 'push' && args.some(w => w.startsWith('--force') || w === '-f')) deny('두뇌의 파괴적 git 변경은 금지합니다. 사용자 터미널에서 처리하세요.', 'boundary');
      if (executable === 'rm' && args.some(w => /^-[^-]*[rfR]/.test(w) || ['--recursive', '--force'].includes(w))) {
        for (const { value, tempException } of writePaths(withoutRedirects(words)).flatMap(resolveCheck)) {
          const path = normalizePath(resolve(cwd, value));
          if (samePath(path, root) || samePath(path, docs) || inside(path, resolve(root, '.git'))
            || inside(path, resolve(root, '.pi')) && !(inside(path, resolve(root, '.pi/scratch')) && !samePath(path, resolve(root, '.pi/scratch')))
            || worktrees.some(tree => samePath(path, tree) || inside(tree, path))
            || !inside(path, root) && !inWorktree(path) && !(tempException && temporary.tempSafe(value))) deny('프로젝트 밖·루트·문서 트리·.git·.pi 삭제는 금지합니다.', 'boundary');
        }
      }
      if (executable === 'find' && args.includes('-delete')) deny('find -delete 대량 삭제는 금지합니다.', 'boundary');
      if (action === 'clean' && !args.some(w => w === '--dry-run' || /^-[^-]*n/.test(w)) && args.some(w => /^-[^-]*[fdx]/.test(w))) {
        const c = args.indexOf('-C'), target = c >= 0 ? resolve(cwd, args[c + 1] ?? '.') : cwd;
        if (!inWorktree(target)) deny('워크트리 밖 git clean은 금지합니다.', 'boundary');
      }
      for (const check of checks) {
        if (check.unresolved) {
          const prefix = check.value.split(/[$`]/, 1)[0];
          if ((prefix.startsWith('~') || prefix.startsWith('/') && !inside(prefix, root) && !temporary.underTemp(prefix))) deny('동적 쓰기 경로를 확인할 수 없습니다', 'boundary');
        }
        boundary(check.value, true);
      }
    }
  }

  for (const words of commands) {
    const executable = basename(words[0] ?? '');
    if (executable === 'codex') deny('codex 직접 실행은 금지합니다. fodh codex를 사용하세요.', 'boundary');
    if (executable === 'git' && ['commit', 'push', 'merge'].includes(gitAction(words))) {
      let state;
      try { state = JSON.parse(readFileSync(resolve(root, '.pi/harness-state.json'), 'utf8')).state; }
      catch { deny('상태를 확인할 수 없어 git 변경을 거부합니다.'); }
      const allowed = gitAction(words) === 'commit'
        ? ['MERGE', 'DOCS', 'PLANNING', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'] : ['MERGE', 'DOCS'];
      if (!allowed.includes(state)) deny('현재 상태에서는 해당 git 변경을 허용하지 않습니다.', 'boundary');
    }
  }
  if (brain && parsed.unresolved) deny('검사할 수 없는 셸 구문입니다. 단순한 명령으로 나눠 쓰세요', 'boundary');
  let configured = [
    'prod-migration', 'store-upload', 'payment', 'push-main', 'env-delete',
    'external-send', 'prod-deploy', 'account-admin', 'system-settings',
  ];
  try {
    const config = JSON.parse(readFileSync(resolve(root, '.pi/harness.json'), 'utf8'));
    if (Array.isArray(config.requiresApproval)) configured = config.requiresApproval;
  } catch (error) {
    if (brain && error.code !== 'ENOENT') deny('하네스 설정을 읽을 수 없습니다.');
  }
  if (command.includes('FODH_DOCTOR_MARKER')
    || (process.env.FODH_TEST_MARKERS === '1' && command.includes('FORBIDDEN_MARKER'))) {
    deny('승인 필수 시험 동작입니다. 판단대기 항목을 만들어라.', 'approval');
  }
  const rawCandidates = parsed.unresolved && brain
    ? [command, ...[...command.matchAll(/[\s;|&({`"']+/g)].map(match => command.slice(match.index + match[0].length))] : [];
  for (const category of configured) {
    const prodEnvironment = category === 'prod-migration' && groups.some(words =>
      basename(commandWords(words)[0] ?? '') !== 'fodh'
      && words.some(word => /^DATABASE_URL=.*prod/i.test(word)));
    const matches = commands.some(words => {
      if (basename(words[0] ?? '') === 'fodh') return false;
      if (category === 'push-main' && !['push', 'branch', 'tag'].includes(gitAction(words))) return false;
      return rules[category]?.test([basename(words[0] ?? ''), ...words.slice(1)].join(' '));
    });
    if (prodEnvironment || matches || rawCandidates.some(text => rules[category]?.test(text))) {
      deny(`승인 필수 동작(${category})입니다. 판단대기 항목을 만들어라.`, 'approval');
    }
  }
  for (const rule of projectRules) {
    if (commands.some(words => basename(words[0] ?? '') !== 'fodh' && new RegExp(rule.pattern, rule.flags).test([basename(words[0] ?? ''), ...words.slice(1)].join(' '))) || rawCandidates.some(text => new RegExp(rule.pattern, rule.flags).test(text))) {
      deny(`승인 필수 동작(${rule.id})입니다. 판단대기 항목을 만들어라.`, 'approval');
    }
  }
} catch { deny('훅 입력을 해석할 수 없습니다.'); }
