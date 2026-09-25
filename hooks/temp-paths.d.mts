export interface TempPolicy { tempSafe(value: string): boolean; underTemp(value: string): boolean }
export function literalTempPath(value: string): string | undefined;
export function canonicalPath(value: string): string;
export function tempPolicy(options: { root: string; worktrees?: string[]; hooks?: string; normalize?: (value: string) => string }): TempPolicy;
export function tempVariables(command: string, policy: TempPolicy, options?: { wholeCommand?: string; enabled?: boolean }): (value: string) => { path: string; empty: string } | undefined;

export function assignedInCommand(command: string, name: string): boolean;
