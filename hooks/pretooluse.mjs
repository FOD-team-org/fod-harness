import { shellParts } from './shell-parts.mjs';
import { readFileSync, realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this literal identical to src/provider/privacy.ts (covered by hook tests).
const secretPattern = /sk-ant-[A-Za-z0-9_-]*|sk-proj-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|xox[abp]-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]*|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|Bearer [A-Za-z0-9._-]{20,}/;

const deny = (message, kind = 'guard') => {
  const label = { approval: '승인', boundary: '경계', guard: '보호' }[kind];
  process.stderr.write(`하네스 가드[${label}]: ${message}\n`);
  process.exit(2);
};

function withoutRedirects(words) {
  return words.filter((word, i) => !['>', '>>', '&>', '&>>', '<', '<<<', '<<', '<<-'].includes(word)
    && !['>', '>>', '&>', '&>>', '<', '<<<', '<<', '<<-'].includes(words[i - 1]));
}

function commandWords(words) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z_\d]*=/.test(words[index] ?? '')) index++;
  while (['env', 'command', 'sudo', 'npx'].includes(basename(words[index] ?? ''))) {
    index++;
    while (words[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z_\d]*=/.test(words[index] ?? '')) index++;
  }
  return words.slice(index);
}

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
const sourceMessage = '소스 파일은 두뇌가 쓰지 않습니다. 워크트리로 위임하세요(fodh codex task / Claude Agent).';

// Literal shell operands only: no evaluation, expansions or script interpretation.
function writePaths(words) {
  const args = commandWords(withoutRedirects(words)), executable = basename(args[0] ?? '');
  const redirects = words.flatMap((word, i) => ['>', '>>', '&>', '&>>'].includes(word) ? [words[i + 1]] : []).filter(Boolean);
  let operands = [];
  if (/^(?:tee|cp|mv|rm|touch|install|truncate|rsync)$/.test(executable)) operands = args.slice(1);
  else if (executable === 'dd') operands = args.slice(1).filter(w => w.startsWith('of=')).map(w => w.slice(3));
  else if (executable === 'sed' && args.some(w => /^-[^-]*i/.test(w) || w === '--in-place')) {
    // The first non-option is the expression; -e/-f supply it explicitly.
    operands = args.slice(1).filter(w => w && !w.startsWith('-'));
    if (!args.includes('-f')) operands = operands.slice(1);
  } else if (executable === 'git') {
    const action = gitAction(args), index = args.indexOf(action);
    if (action === 'restore' || action === 'stash' && !['list', 'show'].includes(args[index + 1]) || action === 'checkout' && args.includes('--')) {
      operands = action === 'checkout' ? args.slice(args.indexOf('--') + 1) : args.slice(index + 1);
      if (!operands.some(w => !w.startsWith('-'))) operands.push('.');
      if (action === 'stash') operands = ['.'];
    }
  }
  return [...redirects, ...operands.filter(w => w && !w.startsWith('-') && !['>', '<'].includes(w))];
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
  if (brain && state) {
    try {
      const config = JSON.parse(readFileSync(resolve(root, '.pi/harness.json'), 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config');
    } catch { deny('하네스 설정을 읽을 수 없습니다.'); }
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
      || samePath(path, resolve(root, '.claude/settings.json'))
      || samePath(path, resolve(root, '.claude/settings.local.json'))
      || inside(path, hooks)
      || (samePath(dirname(path), resolve(root, '.pi')) && /^harness.*\.jsonl?$/.test(basename(path)));
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

  const { groups, unterminatedHeredoc } = shellParts(command);
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
  if (input.run_in_background === true && commands.some(words => basename(words[0] ?? '') === 'fodh' && words[1] === 'codex' && words.includes('--wait'))) {
    deny('--wait 를 백그라운드로 돌리지 마라. 포그라운드로 실행하거나 --wait 없이 시작한 뒤 `대기: 위임 <runId>` 로 턴을 끝내라', 'boundary');
  }
  for (const words of groups) {
    const args = commandWords(words), executable = basename(args[0] ?? '');
    const paths = writePaths(words);
    if (brain && paths.some(judgmentPath)) deny(judgmentMessage, 'boundary');
    if (paths.some(protectedPath)) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
    if (process.env.FODH_CODEX_CHILD === '1' && executable === 'fodh') deny('Codex 자식은 fodh를 실행할 수 없습니다.', 'boundary');
    if (brain) {
      if (executable === 'fodh' && args[1] === 'memory' && args[2] === 'reset') deny('두뇌 세션은 memory reset 을 실행할 수 없습니다. 사용자 터미널에서 실행하세요');
      const action = executable === 'git' ? gitAction(args) : undefined;
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
        for (const value of paths) {
          const path = normalizePath(resolve(cwd, value));
          if (samePath(path, root) || samePath(path, docs) || inside(path, resolve(root, '.git'))
            || inside(path, resolve(root, '.pi')) && !(inside(path, resolve(root, '.pi/scratch')) && !samePath(path, resolve(root, '.pi/scratch')))
            || !inside(path, root) && !inWorktree(path)) deny('프로젝트 밖·루트·문서 트리·.git·.pi 삭제는 금지합니다.', 'boundary');
        }
      }
      if (executable === 'find' && args.includes('-delete')) deny('find -delete 대량 삭제는 금지합니다.', 'boundary');
      if (action === 'clean' && !args.some(w => w === '--dry-run' || /^-[^-]*n/.test(w)) && args.some(w => /^-[^-]*[fdx]/.test(w))) {
        const c = args.indexOf('-C'), target = c >= 0 ? resolve(cwd, args[c + 1] ?? '.') : cwd;
        if (!inWorktree(target)) deny('워크트리 밖 git clean은 금지합니다.', 'boundary');
      }
      for (const value of paths) boundary(value, true);
    }
  }
  const firstWords = groups[0];
  const fodhWords = firstWords[0] === 'npx' ? firstWords.slice(1) : firstWords;
  if (groups.length === 1 && basename(fodhWords[0] ?? '') === 'fodh') process.exit(0);

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
  let configured = [
    'prod-migration', 'store-upload', 'payment', 'push-main', 'env-delete',
    'external-send', 'prod-deploy', 'account-admin', 'system-settings',
  ];
  try {
    const config = JSON.parse(readFileSync(resolve(root, '.pi/harness.json'), 'utf8'));
    if (Array.isArray(config.requiresApproval)) configured = config.requiresApproval;
  } catch (error) {
    if (error.code !== 'ENOENT') deny('하네스 설정을 읽을 수 없습니다.');
  }
  if (command.includes('FODH_DOCTOR_MARKER')
    || (process.env.FODH_TEST_MARKERS === '1' && command.includes('FORBIDDEN_MARKER'))) {
    deny('승인 필수 시험 동작입니다. 판단대기 항목을 만들어라.', 'approval');
  }
  for (const category of configured) {
    const prodEnvironment = category === 'prod-migration' && groups.some(words =>
      basename(commandWords(words)[0] ?? '') !== 'fodh'
      && words.some(word => /^DATABASE_URL=.*prod/i.test(word)));
    const matches = commands.some(words => {
      if (category === 'push-main' && !['push', 'branch', 'tag'].includes(gitAction(words))) return false;
      return rules[category]?.test([basename(words[0] ?? ''), ...words.slice(1)].join(' '));
    });
    if (prodEnvironment || matches) {
      deny(`승인 필수 동작(${category})입니다. 판단대기 항목을 만들어라.`, 'approval');
    }
  }
} catch { deny('훅 입력을 해석할 수 없습니다.'); }
