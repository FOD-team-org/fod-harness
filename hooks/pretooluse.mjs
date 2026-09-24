import { readFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this literal identical to src/provider/privacy.ts (covered by hook tests).
const secretPattern = /sk-ant-[A-Za-z0-9_-]*|sk-proj-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|xox[abp]-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]*|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|Bearer [A-Za-z0-9._-]{20,}/;

const deny = message => {
  process.stderr.write(`하네스 가드: ${message}\n`);
  process.exit(2);
};

// Parse shell words without executing expansions. Separators inside quotes remain arguments.
function tokenize(command) {
  const groups = [[]];
  let word = '', quote = '', started = false;
  const flush = () => {
    if (started) groups.at(-1).push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\' && quote !== "'") {
      word += command[++i] ?? '';
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/[;|&\n]/.test(char)) {
      flush();
      groups.push([]);
    } else if (/\s/.test(char)) {
      flush();
    } else if (char === '>' || char === '<') {
      flush();
      groups.at(-1).push(char);
    } else {
      word += char;
      started = true;
    }
  }
  flush();
  return groups;
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
  const hooks = dirname(fileURLToPath(import.meta.url));
  const command = String(input.command ?? '');
  const editing = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/i.test(name);
  const bash = name === 'Bash';
  const extraProtected = ['.pi/interview-bank.md', '.pi/templates', ...(process.env.FODH_PROTECTED_EXTRA ?? '').split(':').filter(Boolean)].map(value => resolve(root, value));
  const protectedPath = value => {
    const path = resolve(cwd, value);
    return extraProtected.some(extra => path === extra || path.startsWith(`${extra}${sep}`))
      || path === resolve(root, '.claude/settings.json')
      || path === resolve(root, '.claude/settings.local.json')
      || path.startsWith(`${hooks}${sep}`)
      || (dirname(path) === resolve(root, '.pi') && /^harness.*\.jsonl?$/.test(basename(path)));
  };
  if ((editing || bash) && secretPattern.test(text)) {
    deny('비밀값 패턴을 기록할 수 없습니다.');
  }
  if (editing && protectedPath(input.file_path ?? input.notebook_path ?? '')) {
    deny('가드 설정은 fodh로만 변경할 수 있습니다.');
  }
  if (!bash) process.exit(0);

  const groups = tokenize(command);
  for (const words of groups) {
    const assignment = words.some(word => /^FODH_[A-Z_]*=/.test(word));
    const unset = words.some((word, index) => basename(word) === 'unset' && words.slice(index + 1).some(arg => /^FODH_[A-Z_]+$/.test(arg)));
    const clearedEnv = words.some((word, index) => basename(word) === 'env' && words.slice(index + 1).some((arg, offset, args) =>
      arg === '-i' || arg === '--ignore-environment' || /^-uFODH_[A-Z_]+$/.test(arg) || /^--unset=FODH_[A-Z_]+$/.test(arg)
      || (arg === '-u' || arg === '--unset') && /^FODH_[A-Z_]+$/.test(args[offset + 1] ?? '')));
    if (assignment || unset || clearedEnv) deny('하네스 환경변수는 바꿀 수 없습니다.');
  }
  const commands = groups.filter(words => words.length).map(commandWords);
  for (const words of groups) {
    const executable = basename(commandWords(words)[0] ?? '');
    const writes = words.includes('>')
      || /^(?:tee|cp|mv|rm|touch|install|truncate|dd|perl|python\w*|node|ruby)$/.test(executable)
      || (executable === 'sed' && words.some(word => /^-[^-]*i/.test(word)));
    if (writes && words.some(word => protectedPath(word.replace(/^[A-Za-z_][A-Za-z_\d]*=/, '')))) {
      deny('가드 설정은 fodh로만 변경할 수 있습니다.');
    }
  }
  const firstWords = groups[0];
  const fodhWords = firstWords[0] === 'npx' ? firstWords.slice(1) : firstWords;
  if (groups.length === 1 && basename(fodhWords[0] ?? '') === 'fodh') process.exit(0);

  for (const words of commands) {
    const executable = basename(words[0] ?? '');
    if (executable === 'codex') deny('codex 직접 실행은 금지합니다. fodh codex를 사용하세요.');
    if (executable === 'git' && ['commit', 'push', 'merge'].includes(gitAction(words))) {
      let state;
      try { state = JSON.parse(readFileSync(resolve(root, '.pi/harness-state.json'), 'utf8')).state; }
      catch { deny('상태를 확인할 수 없어 git 변경을 거부합니다.'); }
      const allowed = gitAction(words) === 'commit'
        ? ['MERGE', 'DOCS', 'PLANNING', 'INTERVIEW', 'RESEARCH', 'PRD_DRAFT', 'ARCH', 'REVIEW'] : ['MERGE', 'DOCS'];
      if (!allowed.includes(state)) deny('현재 상태에서는 해당 git 변경을 허용하지 않습니다.');
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
    deny('승인 필수 시험 동작입니다. 판단대기 항목을 만들어라.');
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
      deny(`승인 필수 동작(${category})입니다. 판단대기 항목을 만들어라.`);
    }
  }
} catch { deny('훅 입력을 해석할 수 없습니다.'); }
