export interface ApprovalRule { id: string; pattern: string; flags?: 'i'; description?: string }
export const builtinApprovalIds: string[];
export function approvalRules(value?: unknown): ApprovalRule[];
