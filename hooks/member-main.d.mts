import type { ShellCommand } from './shell-commands.mjs';
import type { CwdSet } from './effective-cwd.mjs';
export interface MemberPaths { name: string; path: string }
export interface MemberOptions { members: MemberPaths[]; worktrees?: (string | { path: string })[]; substitute?: (value: string) => { path: string } | undefined }
export const messages: { M1(name: string): string; M2: string; M3: string; M4: string; M5: string; M6: string; M7: string };
export function pathInside(path: string, base: string): boolean;
export function memberMainOf(path: string, members: MemberPaths[], worktrees?: (string | { path: string })[]): string | undefined;
export function memberAncestorOf(path: string, members: MemberPaths[]): string | undefined;
export function gitReadAllowed(action: string | undefined, args: string[]): boolean;
export function readAllowed(args: string[]): boolean;
export function gitEnvironment(words: string[], strict?: boolean): boolean;
export function memberCommand(entry: ShellCommand, set: CwdSet, options: MemberOptions): { member?: string; possible: boolean; allowed: boolean; git: boolean; xargs: boolean };
export function memberCommands(entries: ShellCommand[], set: CwdSet, options: MemberOptions): string | undefined;
export function memberWrite(value: string, set: CwdSet, options: MemberOptions & { git?: boolean }): string | undefined;
