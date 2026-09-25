export interface ShellCommand { words: string[]; rawWords: string[]; source: string; tempAllowed: boolean }
export interface ShellCommands { entries: ShellCommand[]; heredocs: string[]; unresolved: boolean; unterminatedHeredoc: boolean }
export function commandWords(words: string[]): string[];
export function shellCommands(command: string, options?: { recoverUnterminated?: boolean; extended?: boolean }): ShellCommands;
export function temporaryCommandsSafe(command: string, parsed: ShellCommands): boolean;
