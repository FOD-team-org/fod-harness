import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const deny = message => { process.stderr.write(`하네스 가드: ${message}\n`); process.exit(2); };
try {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const name = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};
  const text = JSON.stringify(input);
  const cwd = event.cwd ?? process.cwd();
  const command = String(input.command ?? '');
  const editing = /Write|Edit|NotebookEdit/i.test(name);
  const bash = name === 'Bash';
  if ((editing || bash) && /sk-ant-|AKIA|-----BEGIN [A-Z ]*PRIVATE KEY/.test(text)) deny('비밀값 패턴을 기록할 수 없습니다.');
  const protectedPath = /(?:^|[\s/'"=])(?:\.claude\/settings(?:\.local)?\.json|hooks\/[^\s'";]*|\.pi\/harness[^\s'";]*\.jsonl?)(?:$|[\s'";])/;
  if (editing && protectedPath.test(resolve(cwd, input.file_path ?? input.notebook_path ?? ''))) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
  if (bash && protectedPath.test(command) && /(?:>|\b(?:tee|cp|mv|rm|touch|install|truncate|dd|perl|python\w*|node|ruby)\b|\bsed\b[^;]*-[^\s]*i)/.test(command)) deny('가드 설정은 fodh로만 변경할 수 있습니다.');
  if (bash) {
    const directCodex = command.replace(/\bfodh\s+codex\b/g, 'FODH_DELEGATE');
    if (/(?:^|[\s/;|&("'])codex(?:\s|$|["'])/.test(directCodex)) deny('codex 직접 실행은 금지합니다. fodh codex를 사용하세요.');
    if (/\bgit\b[^;|&\n]*\b(commit|push|merge)\b/.test(command)) {
      let state;
      try { state = JSON.parse(readFileSync(resolve(cwd, '.pi/harness-state.json'), 'utf8')).state; }
      catch { deny('상태를 확인할 수 없어 git 변경을 거부합니다.'); }
      if (!['MERGE', 'DOCS'].includes(state)) deny('git commit·push·merge는 MERGE 또는 DOCS 상태에서만 허용됩니다.');
    }
  }
  let configured = ['prod-migration','store-upload','payment','push-main','env-delete','external-send','prod-deploy','account-admin','system-settings'];
  try {
    const config = JSON.parse(readFileSync(resolve(cwd, '.pi/harness.json'), 'utf8'));
    if (Array.isArray(config.requiresApproval)) configured = config.requiresApproval;
  } catch (error) { if (error.code !== 'ENOENT') deny('하네스 설정을 읽을 수 없습니다.'); }
  const rules = {
    'prod-migration': /(?:prod|production)[\s\S]*(?:migrat|delete|drop|truncate)|(?:migrat|delete|drop|truncate)[\s\S]*(?:prod|production)/i,
    'store-upload': /\b(?:fastlane|altool|iTMSTransporter)\b[\s\S]*\b(?:upload|deliver|pilot|submit)\b|\beas\s+submit\b/i,
    'payment': /\b(?:stripe|billing|payment|subscription)\b[\s\S]*(?:create|update|delete|change|pay|purchase)/i,
    'push-main': /\bgit\b[^;\n]*\bpush\b[^;\n]*(?:\bmain\b|\bmaster\b|--force|-f\b|--delete|\s:[^\s]+)|\bgit\s+(?:branch|tag)\s+[^;\n]*-[dD]/,
    'env-delete': /\b(?:env|environment|secret|token|credential)\b[\s\S]*(?:delete|remove|rotate|create)|\b(?:rm|unset)\b[^;\n]*(?:\.env|TOKEN|KEY)/i,
    'external-send': /(?:slack|email|gmail|outlook|sns|tweet|social)[\s\S]*(?:send|post|publish|reply)|(?:send|post|publish|reply)[\s\S]*(?:slack|email|gmail|outlook|sns|tweet|social)/i,
    'prod-deploy': /\b(?:vercel|netlify|firebase|wrangler|fly|railway)\b[^;\n]*(?:--prod|deploy)|\bdeploy\b[^;\n]*\b(?:prod|production)\b/i,
    'account-admin': /(?:user|account|permission|role)[\s\S]*(?:create|delete|grant|revoke)|(?:create|delete|grant|revoke)[\s\S]*(?:user|account|permission|role)/i,
    'system-settings': /\b(?:launchctl|security\s+(?:add|delete|set)|defaults\s+write)\b|(?:>|tee|sed)[^;\n]*\.(?:zshrc|bashrc|profile)/i,
    'paid-resource': /(?:plan|resource|subscription)[\s\S]*(?:purchase|upgrade|create)/i,
    'dns': /\b(?:dns|domain|certificate)\b[\s\S]*(?:create|delete|update|register)/i,
    'legal': /(?:privacy|terms|개인정보|약관)/i,
  };
  if (/FODH_DOCTOR_MARKER|FORBIDDEN_MARKER/.test(text)) deny('승인 필수 시험 동작입니다. 판단대기 항목을 만들어라.');
  for (const category of configured) {
    if (rules[category]?.test(`${name} ${text}`)) deny(`승인 필수 동작(${category})입니다. 판단대기 항목을 만들어라.`);
  }
} catch { deny('훅 입력을 해석할 수 없습니다.'); }
