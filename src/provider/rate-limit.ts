export function rateLimitVerdict(info: unknown): 'continue' | 'quota' {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return 'continue';
  return (info as Record<string, unknown>).status === 'rejected' ? 'quota' : 'continue';
}
