export interface SecretSettings { defaults: boolean; readDeny: string[]; readAllow: string[] }
export interface SecretPolicy extends SecretSettings { secretPath(path: string): boolean; basenameDenied(name: string): boolean }
export const defaultReadDeny: string[];
export const defaultReadAllow: string[];
export function secretSettings(value?: unknown): SecretSettings;
export function secretPolicy(root: string, settings?: unknown, home?: string): SecretPolicy;
export function scanSecretFiles(directory: string, policy: SecretPolicy, options?: { depth?: number; limit?: number; skip?: string[]; excludeDir?: (name: string, path: string) => boolean; pruneDirectories?: (paths: string[]) => Set<string> }): { files: string[]; exceeded: boolean };
export function expandSecretGlob(path: string, limit?: number): string[];
export function directoryExists(path: string): boolean;
export function globsOverlap(left: string, right: string): boolean;
