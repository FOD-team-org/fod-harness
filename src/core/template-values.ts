import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function todayKst(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function substitute(template: string, values: Record<string, string>, requireValue = true): string {
  return template.replace(/\{\{([^{}]+)\}\}/gu, (_match, key: string) => {
    if (!Object.hasOwn(values, key) || requireValue && !values[key]) throw new Error(`템플릿 치환 값이 없습니다: {{${key}}}`);
    return values[key];
  });
}
// Lexical validation plus the nearest existing ancestor prevents symlink escapes.
export async function projectPath(root: string, path: string): Promise<string> {
  const target = resolve(root, path), outside = (base: string, value: string) => {
    const rel = relative(base, value); return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
  };
  if (isAbsolute(path) || outside(resolve(root), target)) throw new Error('프로젝트 내부 상대 경로여야 합니다');
  const realRoot = await realpath(root);
  let ancestor = target;
  for (;;) {
    try { if (outside(realRoot, await realpath(ancestor))) throw new Error('프로젝트 밖 심볼릭 링크는 허용하지 않습니다'); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const entry = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (entry?.isSymbolicLink()) throw new Error('대상을 확인할 수 없는 심볼릭 링크는 허용하지 않습니다');
      ancestor = dirname(ancestor);
    }
  }
  return target;
}
