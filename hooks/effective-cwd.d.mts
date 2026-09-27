import type { ShellCommand } from './shell-commands.mjs';
export interface CwdSet { cwds: string[]; unknown: boolean }
export function expandKnown(value: string, cwd: string, home?: string): string;
export function dynamicPath(value: string): boolean;
export function pathCandidates(value: string, cwd: string, home?: string, literal?: boolean): CwdSet;
export function syntaxFragment(entry: ShellCommand, next?: ShellCommand): boolean;
export function possibleCwds(entries: ShellCommand[], cwd: string, options?: { home?: string; workspace?: boolean; cdpath?: string }): CwdSet;
export function commandCwds(words: string[], set: CwdSet): CwdSet;
export function gitTargets(words: string[], set: CwdSet): CwdSet & { action?: string; args: string[]; invalidGlobal: boolean };

export function canonicalMemberPath(value: string): string;
