// 원문에 자격증명 패턴이 섞여 들어와도 표시·원장·판단대기에 남기지 않는다.
export function redact(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]*/g, '[비밀값 제거]')
    .replace(/AKIA[A-Za-z0-9]*/g, '[비밀값 제거]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[비밀값 제거]');
}
export function safeValue<T>(value: T): T { return JSON.parse(redact(JSON.stringify(value))) as T; }
