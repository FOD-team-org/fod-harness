export interface ShellParts {
  groups: string[][];
  rawGroups?: string[][];
  separators?: string[];
  unterminatedExpansion?: boolean;
  heredocs: string[];
  unterminatedHeredoc: boolean;
}
export function shellParts(command: string, options?: { recoverUnterminated?: boolean; metadata?: boolean }): ShellParts;

export const redirectOperators: string[];
export function isWriteRedirect(operator: string, target?: string): boolean;
export function unquoted(raw: string): string;

export function expansionEnd(text: string, start: number): number | undefined;
export function withoutExpansions(text: string): string;
