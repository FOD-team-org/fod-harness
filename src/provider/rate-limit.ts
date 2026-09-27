export function rateLimitVerdict(info: unknown): 'continue' | 'quota' | 'billing' {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return 'billing';
  const value = info as Record<string, unknown>;
  if (value.isUsingOverage === true) return 'billing';
  if (value.status === 'rejected') {
    return value.overageStatus === undefined || value.overageStatus === 'rejected' ? 'quota' : 'billing';
  }
  if (value.overageStatus === 'rejected') return 'continue';
  if (!('overageStatus' in value) && value.isUsingOverage === false
    && (value.status === 'allowed' || value.status === 'allowed_warning')) return 'continue';
  return 'billing';
}
