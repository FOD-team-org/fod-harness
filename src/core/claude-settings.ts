import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Shared static preflight for doctor, installation and the shell launcher.
export async function claudeHookStatus(root: string) {
  let text = '';
  try { text = await readFile(join(root, '.claude/settings.json'), 'utf8'); } catch { /* Missing/unreadable is not proof of a guard. */ }
  let present = false;
  try {
    const settings = JSON.parse(text);
    present = settings?.disableAllHooks !== true && Array.isArray(settings?.hooks?.PreToolUse)
      && settings.hooks.PreToolUse.some((entry: { matcher?: unknown; hooks?: unknown[] }) =>
        entry && (entry.matcher === undefined || entry.matcher === '' || entry.matcher === '*') && Array.isArray(entry.hooks)
        && entry.hooks.some(hook => !!hook && typeof hook === 'object' && 'type' in hook && hook.type === 'command'
          && 'command' in hook && typeof hook.command === 'string' && /pretooluse\.(?:sh|mjs)\b/u.test(hook.command)));
  } catch { /* Malformed settings require a manual merge. Never include their content in errors. */ }
  return { settingsNeedsHook: !present, claudeSettingsStale: text.includes(':?FODH_PACKAGE_ROOT') };
}
export async function hookMergeGuidance() {
  const hookPatch = JSON.parse(await readFile(new URL('../../templates/claude-settings.json', import.meta.url), 'utf8'));
  const reason = '프로젝트 .claude/settings.json 에 하네스 PreToolUse 훅이 없습니다. 기존 설정을 보존하고 아래 JSON의 hooks.PreToolUse 항목을 합친 뒤 fodh 를 다시 실행하세요. disableAllHooks가 true이면 해제하세요.\n'
    + JSON.stringify(hookPatch, null, 2);
  return { reason, hookPatch };
}

export class HarnessHookRequired extends Error {}
