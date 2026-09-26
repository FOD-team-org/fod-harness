import type { ShellCommand } from './shell-commands.mjs';
export function secretReadGuard(options: { root: string; cwd: string; config?: unknown; deny: (message: string, kind: string) => void }): {
  fileTool(name: string, input: { file_path?: string; notebook_path?: string; path?: string; glob?: string }): void;
  bash(entries: ShellCommand[]): void;
};
