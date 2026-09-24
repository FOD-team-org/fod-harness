export interface ShellParts {
  groups: string[][];
  heredocs: string[];
  unterminatedHeredoc: boolean;
}
export function shellParts(command: string, options?: { recoverUnterminated?: boolean }): ShellParts;
