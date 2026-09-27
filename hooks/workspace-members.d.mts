import type { ApprovalRule } from './approval-rules.mjs';
export interface HookMember { name: string; path: string; secrets?: unknown; approvalRules: ApprovalRule[] }
export interface HookWorkspace { enabled: boolean; members: HookMember[] }
export function hookWorkspace(root: string, rawConfig: { workspace?: unknown }): HookWorkspace;
