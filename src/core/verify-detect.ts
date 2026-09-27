import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Internal Git reads never inherit repository/config overrides or replacement objects. */
export async function harnessGit(cwd: string, args: string[], input?: string): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const pending = promisify(execFile)('git', ['--no-replace-objects', '-C', cwd,
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.trustctime=true',
    '-c', 'core.checkStat=default', '-c', 'core.ignoreStat=false', '-c', 'core.attributesFile=/dev/null', ...args],
  { env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' }, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
  pending.child.stdin?.on('error', () => { /* execFile reports process errors. */ });
  pending.child.stdin?.end(input);
  return (await pending).stdout;
}

export interface DetectedVerify {
  stacks: { stack: string; dir: string; notes: string[] }[];
  commands: string[];
  heavy: string[];
}
const detections = new WeakSet<DetectedVerify>();
export const isDetectedVerify = (value: DetectedVerify): boolean => detections.has(value);
const skipped = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'Pods', 'vendor', 'coverage']);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Resolve the configured docs directory relative to the detection root. */
export function verifySkipDirs(base: string, docsRoot: string, workspaceRoot?: string): string[] {
  const dir = relative(base, resolve(workspaceRoot ?? base, docsRoot));
  return dir === '..' || dir.startsWith('../') || isAbsolute(dir) ? [] : [dir];
}

export class DetectUnreadableError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`검증 명령 감지 실패: 읽을 수 없는 폴더 ${relativePath} — 권한을 확인하거나 사용자가 verify.commands 를 설정해야 합니다`);
    this.name = 'DetectUnreadableError';
    this.relativePath = relativePath;
  }
}

export class DetectGitError extends Error {
  constructor(message = '등록 워크트리에서 git 정보를 읽을 수 없습니다 — .git 과 HEAD 를 확인하세요') {
    super(message);
    this.name = 'DetectGitError';
  }
}
interface TreeEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
interface VerifyTree {
  entries(dir: string): Promise<TreeEntry[]>;
  read(path: string): Promise<string>;
  path(dir: string): Promise<string>;
}
async function verifyTree(base: string, source: 'fs' | 'head' | 'auto', registered: boolean): Promise<VerifyTree> {
  const git = async (...args: string[]) => (await harnessGit(base, args)).toString('utf8');
  let repository = false;
  if (source !== 'fs') {
    try { repository = (await git('rev-parse', '--is-inside-work-tree')).trim() === 'true'; } catch { /* checked below */ }
    if (!repository && (registered || source === 'head')) throw new DetectGitError();
  }
  if (repository) {
    try {
      const prefix = (await git('rev-parse', '--show-prefix')).replace(/\n$/u, '');
      // Pin one committed tree for the entire traversal.
      const head = (await git('rev-parse', '--verify', 'HEAD^{commit}')).trim();
      const root = await realpath(base);
      // One recursive listing supplies directories and test paths; gitlinks are leaves.
      const listing = await git('ls-tree', '--full-tree', '-r', '-t', '-z', `${head}:${prefix}`);
      const directories = new Map<string, TreeEntry[]>();
      const blobs = new Map<string, string>();
      for (const line of listing.split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t'), [mode, kind, oid] = line.slice(0, tab).split(' ');
        const path = line.slice(tab + 1), slash = path.lastIndexOf('/');
        const dir = slash < 0 ? '' : path.slice(0, slash), name = path.slice(slash + 1);
        const entries = directories.get(dir) ?? [];
        entries.push({ name, isFile: () => kind === 'blob' && mode !== '120000',
          isDirectory: () => kind === 'tree', isSymbolicLink: () => mode === '120000' });
        directories.set(dir, entries);
        if (kind === 'blob' && mode !== '120000' && path.split('/').length <= 3
          && ['package.json', 'pubspec.yaml', 'pyproject.toml'].includes(name)
          && !/[\x00-\x1f\x7f]/u.test(path)) blobs.set(path, oid);
      }
      const contents = new Map<string, string>(), oids = [...new Set(blobs.values())];
      if (oids.length) {
        const batch = await harnessGit(base, ['cat-file', '--batch'], oids.join('\n') + '\n');
        let offset = 0;
        for (const oid of oids) {
          const end = batch.indexOf(10, offset), header = batch.subarray(offset, end).toString('utf8');
          const match = /^([0-9a-f]+) blob (\d+)$/u.exec(header);
          if (end < 0 || !match || match[1] !== oid) throw new DetectGitError();
          const size = Number(match[2]); offset = end + 1;
          if (offset + size >= batch.length || batch[offset + size] !== 10) throw new DetectGitError();
          contents.set(oid, batch.subarray(offset, offset + size).toString('utf8'));
          offset += size + 1;
        }
      }
      return {
        entries: async dir => directories.get(dir) ?? [],
        async read(path) {
          const content = contents.get(blobs.get(path) ?? '');
          if (content === undefined) throw new DetectGitError();
          return content;
        },
        path: async dir => join(root, dir),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new DetectGitError('HEAD 목록이 너무 큽니다(16 MiB 초과) — 사용자가 verify.commands 를 설정해야 합니다');
      }
      throw new DetectGitError();
    }
  }
  const readable = async <T>(path: string, read: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch (error) {
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new DetectUnreadableError(path || '.');
      throw error;
    }
  };
  return {
    entries: dir => readable(dir, () => readdir(join(base, dir), { withFileTypes: true }).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
      throw error;
    })),
    read: path => readable(path, () => readFile(join(base, path), 'utf8')),
    path: dir => realpath(join(base, dir)),
  };
}

/** Command bodies always come from the preset table; installation defaults to fs. */
export async function detectVerify(base: string, options: { platform?: NodeJS.Platform; skipPrefixes?: string[]; skipDirs?: string[];
  source?: 'fs' | 'head' | 'auto'; registered?: boolean } = {}): Promise<DetectedVerify | undefined> {
  const tree = await verifyTree(base, options.source ?? 'fs', options.registered ?? false);
  const result: DetectedVerify = { stacks: [], commands: [], heavy: [] };
  const found: { stack: DetectedVerify['stacks'][number]; commands: string[]; heavy: string[] }[] = [];
  const skip = (name: string) => /[\x00-\x1f\x7f]/u.test(name) || name.startsWith('.') || skipped.has(name) || (options.skipPrefixes ?? []).some(prefix => name.startsWith(prefix));
  const skipDirs = (options.skipDirs ?? []).map(dir => relative(base, resolve(base, dir)));
  async function entries(dir: string) {
    const path = relative(base, dir);
    if (skipDirs.some(skip => skip === '' || path === skip || path.startsWith(skip + '/'))) return [];
    return (await tree.entries(path)).filter(entry => !/[\x00-\x1f\x7f]/u.test(entry.name));
  }
  async function hasTests(dir: string): Promise<boolean> {
    let found = false;
    for (const entry of await entries(dir)) {
      if (entry.isSymbolicLink() || skip(entry.name)) continue;
      if (entry.isFile() && entry.name.endsWith('_test.dart')) found = true;
      if (entry.isDirectory() && await hasTests(join(dir, entry.name))) found = true;
    }
    return found;
  }
  async function visit(dir: string, depth: number): Promise<void> {
    const absolute = join(base, dir), children = await entries(absolute);
    const file = (name: string) => children.some(e => e.name === name && e.isFile());
    const folder = (name: string) => children.some(e => e.name === name && e.isDirectory());
    const read = (name: string) => tree.read(join(dir, name));
    let nodeWorkspace = file('pnpm-workspace.yaml');
    let stack = '', commands: string[] = [], heavy: string[] = [], notes: string[] = [];
    if (file('pubspec.yaml')) {
      const flutter = /^\s*sdk:\s*flutter\s*(?:#.*)?$/mu.test(await read('pubspec.yaml'));
      stack = flutter ? 'flutter' : 'dart';
      const nonAscii = flutter && /[^\x00-\x7F]/u.test(await tree.path(dir));
      commands = [`${stack} pub get`, nonAscii ? 'dart analyze' : `${stack} analyze`];
      if (nonAscii) notes.push('flutter analyze 비ASCII 경로 오류 회피');
      if (folder('test') && await hasTests(join(absolute, 'test'))) commands.push(`${stack} test`);
      if (flutter) {
        if (folder('ios') && (options.platform ?? process.platform) === 'darwin') heavy.push('flutter build ios --debug --no-codesign');
        if (folder('android')) heavy.push('flutter build apk --debug');
        if (folder('web')) heavy.push('flutter build web');
      }
    } else if (file('package.json')) {
      let scripts: Record<string, unknown> = {};
      try {
        const pkg = JSON.parse(await read('package.json'));
        scripts = pkg?.scripts ?? {};
        nodeWorkspace ||= pkg != null && Object.hasOwn(pkg, 'workspaces');
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      const pm = file('pnpm-lock.yaml') ? 'pnpm' : file('yarn.lock') ? 'yarn' : file('bun.lock') || file('bun.lockb') ? 'bun' : 'npm';
      for (const name of ['typecheck', 'lint', 'test']) {
        const script = scripts?.[name];
        if (typeof script !== 'string' || !script.trim() || name === 'test' && /^\s*echo\s+(["'])Error: no test specified\1\s*&&\s*exit\s+1\s*$/u.test(script)) continue;
        commands.push(name === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${name}`);
      }
      if (commands.length) {
        stack = 'node';
        if (typeof scripts.build === 'string' && scripts.build.trim()) heavy.push(`${pm} run build`);
      }
    }
    if (!stack) {
      if (file('go.mod')) { stack = 'go'; commands = ['go vet ./...', 'go test ./...']; heavy = ['go build ./...']; }
      else if (file('Cargo.toml')) { stack = 'rust'; commands = ['cargo check', 'cargo test']; heavy = ['cargo build --release']; }
      else if (file('Package.swift')) { stack = 'swift'; commands = ['swift build', ...(folder('Tests') ? ['swift test'] : [])]; }
      else if ((file('pyproject.toml') || file('setup.py') || file('requirements.txt'))
        && (folder('tests') || folder('test') || file('pytest.ini') || file('pyproject.toml') && /^\s*\[tool\.pytest/mu.test(await read('pyproject.toml')))) {
        stack = 'python'; commands = ['python3 -m pytest -q'];
      } else if (file('gradlew')) { stack = 'gradle'; commands = ['./gradlew test']; heavy = ['./gradlew build']; }
    }
    if (stack) {
      const prefix = (cmd: string) => dir ? `cd ${quote(dir.startsWith('-') ? `./${dir}` : dir)} && ${cmd}` : cmd;
      found.push({ stack: { stack, dir, notes }, commands: commands.map(prefix), heavy: heavy.map(prefix) });
      if (depth !== 0 || stack !== 'node' || nodeWorkspace) return;
    }
    if (depth === 2) return;
    for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (child.isDirectory() && !skip(child.name)) await visit(dir ? `${dir}/${child.name}` : child.name, depth + 1);
    }
  }
  if ((await lstat(base)).isSymbolicLink()) return undefined;
  await visit('', 0);
  for (const item of found.sort((a, b) => a.stack.dir < b.stack.dir ? -1 : a.stack.dir > b.stack.dir ? 1 : 0)) {
    result.stacks.push(item.stack); result.commands.push(...item.commands); result.heavy.push(...item.heavy);
  }
  if (!result.stacks.length) return undefined;
  // Reject fabricated or mutated detection objects at the privileged writer boundary.
  for (const stack of result.stacks) { Object.freeze(stack.notes); Object.freeze(stack); }
  Object.freeze(result.stacks); Object.freeze(result.commands); Object.freeze(result.heavy); Object.freeze(result);
  detections.add(result);
  return result;
}
