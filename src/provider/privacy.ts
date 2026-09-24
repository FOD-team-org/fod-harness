// 문자열 값마다 제거하여 미종료 PEM도 JSON 구조를 손상시키지 않는다.
const secretPattern = /sk-ant-[A-Za-z0-9_-]*|sk-proj-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|xox[abp]-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]*|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|Bearer [A-Za-z0-9._-]{20,}/;
export function redact(text: string): string {
  return text.replace(new RegExp(secretPattern.source, 'g'), '[비밀값 제거]');
}
export function safeValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => safeValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item)])) as T;
  }
  return value;
}
