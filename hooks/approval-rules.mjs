export const builtinApprovalIds = ['prod-migration', 'store-upload', 'payment', 'push-main', 'env-delete',
  'external-send', 'prod-deploy', 'account-admin', 'system-settings', 'paid-resource', 'dns'];
export function approvalRules(value = []) {
  if (!Array.isArray(value)) throw new Error('approvalRules는 배열이어야 합니다');
  const ids = new Set();
  return value.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(rule.id)
      || builtinApprovalIds.includes(rule.id) || ids.has(rule.id)
      || typeof rule.pattern !== 'string' || rule.flags !== undefined && rule.flags !== 'i'
      || rule.description !== undefined && typeof rule.description !== 'string') throw new Error('approvalRules 규칙이 올바르지 않습니다');
    if (!safePattern(rule.pattern)) throw new Error('approvalRules pattern은 200자 이하이며 역참조·중첩 수량자를 사용할 수 없습니다');
    try { new RegExp(rule.pattern, rule.flags); } catch { throw new Error('approvalRules pattern 정규식이 올바르지 않습니다'); }
    ids.add(rule.id);
    return { ...rule };
  });
}

// Deliberately conservative static check, never benchmark an untrusted regexp.
function safePattern(pattern) {
  if (pattern.length > 200 || /\\(?:[1-9]|k<)/.test(pattern)) return false;
  const groups = [];
  let characterClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') characterClass = true;
    if (c === ']' && characterClass) { characterClass = false; continue; }
    if (characterClass) continue;
    if (c === '(') groups.push(false);
    else if (c === ')') {
      const innerQuantifier = groups.pop();
      const repeated = /^(?:[+*?]|\{\d+(?:,\d*)?\})/.test(pattern.slice(i + 1));
      if (innerQuantifier && repeated) return false;
      if (groups.length && (innerQuantifier || repeated)) groups[groups.length - 1] = true;
    } else if (groups.length && (/[+*?]/.test(c) && !(c === '?' && pattern[i - 1] === '(')
      || c === '{' && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(i)))) groups[groups.length - 1] = true;
  }
  return true;
}
