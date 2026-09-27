import type { CwdSet } from './effective-cwd.mjs';
import type { ShellCommand } from './shell-commands.mjs';
export function secretReadGuard(options: { root: string; cwd: string; cwdSet?: CwdSet; config?: unknown; deny: (message: string, kind: string) => void; members?: { name: string; path: string; secrets?: unknown }[]; worktrees?: { path: string; repo?: string }[] }): {
  fileTool(name: string, input: { file_path?: string; notebook_path?: string; path?: string; glob?: string }): void;
  bash(entries: ShellCommand[]): void;
};
