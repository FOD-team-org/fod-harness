// 문자열 값마다 제거하여 미종료 PEM도 JSON 구조를 손상시키지 않는다.
export function redact(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]*/g, '[비밀값 제거]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[비밀값 제거]')
    .replace(/\bghp_[A-Za-z0-9]{36}\b/g, '[비밀값 제거]')
    .replace(/github_pat_[A-Za-z0-9_]*/g, '[비밀값 제거]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[비밀값 제거]');
}
export function safeValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => safeValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item)])) as T;
  }
  return value;
}
