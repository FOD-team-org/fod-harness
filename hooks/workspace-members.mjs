import { realpathSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { approvalRules } from './approval-rules.mjs';
import { secretPolicy } from './secret-paths.mjs';

// Deliberately only a subset of loadConfig: this standalone guard must accept
// every configuration the application accepts. Callers choose audience fallback.
export function hookWorkspace(root, rawConfig) {
  if (rawConfig.workspace === undefined) return { enabled: false, members: [] };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const workspace = rawConfig.workspace;
  if (!object(workspace) || !object(workspace.repos) || !Object.keys(workspace.repos).length) throw new Error('workspace');
  const members = Object.entries(workspace.repos).map(([name, member]) => {
    if (!object(member) || typeof member.path !== 'string' || !member.path.trim() || isAbsolute(member.path)) throw new Error('member');
    const path = realpathSync.native(resolve(root, member.path));
    if (!statSync(path).isDirectory()) throw new Error('directory');
    const rules = approvalRules(member.approvalRules);
    if (member.secrets !== undefined) secretPolicy(path, member.secrets);
    return { name, path, secrets: member.secrets, approvalRules: rules };
  });
  return { enabled: true, members };
}
