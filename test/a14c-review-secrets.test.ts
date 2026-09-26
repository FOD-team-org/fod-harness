import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { invoke, type HookOptions } from './hook-helpers.ts';
import { secretReadGuard } from '../hooks/secret-reads.mjs';
import { shellCommands } from '../hooks/shell-commands.mjs';
import { globsOverlap, scanSecretFiles, secretPolicy } from '../hooks/secret-paths.mjs';
const run = promisify(execFile);
const fixture = (): HookOptions => ({ nonTempRoot: true, homeLayout: 'inside', env: { FODH_BRAIN: '1' }, setup: async root => {
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.ts'), 'FAKE_VALUE');
  await writeFile(join(root, '.env'), 'FAKE_VALUE'); await writeFile(join(root, '.env.ts'), 'FAKE_VALUE');
} });
it.each([
  '[ -f .env ]', '[ -e .env ]', 'test -f .env', '[[ -f .env ]]',
  'if [ -f .env ]; then echo ok; fi', '(test -f .env)', '{ test -f .env; }',
  'echo "$(test -f .env)"', 'env test -f .env', 'sh -c "test -f .env"',
])('R5회차 HOME 내부 비밀 파일 존재 확인은 허용: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', fixture())).toMatchObject({ code: 0 });
});
it.each([
  'if [ -f .env ]; then npm run db:migrate; fi',
  'if [ -e .env ]; then npm run db:migrate; fi',
  'if test -f .env; then npm run db:migrate; fi',
  'if [[ -f .env ]]; then npm run db:migrate; fi',
  '(test -f .env && npm run db:migrate)',
  '{ test -f .env; npm run db:migrate; }',
  'echo "$(test -f .env && npm run db:migrate)"',
  'sh -c "test -f .env && npm run db:migrate"',
  'env test -f .env && env npm run db:migrate',
])('R5회차 존재 확인 뒤 마이그레이션은 승인 검사: %s', async command => {
  const options = fixture(), setup = options.setup!;
  options.setup = async root => {
    await setup(root);
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [{ id: 'db-migrate', pattern: 'db:migrate' }] }));
  };
  expect(await invoke('Bash', { command }, 'IMPLEMENT', options)).toMatchObject({ code: 2, stderr: expect.stringContaining('[승인]') });
});
it.each([
  'if cat .env; then echo ok; fi', '(cat .env)',
  'test -f .env < .env', 'if [ -f .env ] < .env; then echo ok; fi',
  'test -f "$(cat .env)"', 'sh -c "test -f .env && cat .env"',
])('R5회차 조건·그룹·리다이렉트·치환의 실제 읽기는 계속 거부: %s', async command => {
  expect(await invoke('Bash', { command }, 'IMPLEMENT', fixture())).toMatchObject({ code: 2, stderr: expect.stringContaining('비밀 파일은 두뇌가 읽을 수 없습니다') });
});
it.each(['*.ts', '**/*.tsx', '*.dart', '*.md', '*.json', '*.{ts,tsx}', 'src/**/*.ts', '*'])('R1 일반 Grep glob 허용 %s', async glob => {
  expect((await invoke('Grep', { glob, path: '.', pattern: 'X' }, 'IMPLEMENT', fixture())).code).toBe(0);
});
it.each(['.env*', '**/.env', '.env.*'])('R1 명시 비밀 glob 거부 %s', async glob => {
  expect((await invoke('Grep', { glob, path: '.', pattern: 'X' }, 'IMPLEMENT', fixture())).code).toBe(2);
});
it('R1 디렉터리 Grep·셸 wildcard 기존 의미 및 점 규칙', async () => {
  expect((await invoke('Grep', { path: '.', pattern: 'X' }, 'IMPLEMENT', fixture())).code).toBe(0);
  for (const pattern of ['*', '?env', '[.]env', '*.ts']) expect(globsOverlap(pattern, '.env*')).toBe(false);
});
it('R1 로컬 rg 명시 glob은 hidden 플래그 없이도 점 파일 매칭 (이름만 확인)', async () => {
  const options = fixture(), setup = options.setup!;
  options.setup = async root => {
    await setup(root);
    const visible = await run('rg', ['--files', '-g', '*.ts'], { cwd: root });
    expect(visible.stdout.split('\n')).toContain('.env.ts');
    const hidden = await run('rg', ['--files', '--hidden', '-g', '*.ts'], { cwd: root });
    expect(hidden.stdout.split('\n')).toContain('.env.ts');
  };
  expect((await invoke('Grep', { glob: '*.ts', pattern: 'X' }, 'IMPLEMENT', options)).code).toBe(0);
});
it.each(['rg -uu --max-depth 2 DATABASE_URL', 'rg -uuu --sort path X', 'rg -uu -j 2 X', 'rg -uu --unknown-value value X'])('R2 미해석 옵션 값이어도 cwd 검사 %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', fixture())).code).toBe(2);
});
it.each(["grep -rn '.env' src", "rg -n '.env' src", "ag -n '.env' src", "rg -e '.env' src", "grep -e .env -rn src", "printf '%s\\n' .env", 'rg --files --hidden'])('R5 읽기 아닌 인자·이름만 조회 %s', async command => {
  expect((await invoke('Bash', { command }, 'CLEANUP', fixture())).code).toBe(0);
});
it.each(['git show HEAD:.env status', 'git show HEAD:.env', 'git cat-file -p HEAD:.env', 'git -C . --no-pager show HEAD:.env', 'git -c color.ui=false show HEAD:.env'])('R6 실제 하위 명령의 비밀 blob 읽기 거부 %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', fixture())).code).toBe(2);
});
it.each(['git -C . status -- .env', 'git --no-pager ls-files .env', 'git -c color.ui=false check-ignore .env', 'git show HEAD:.env.example'])('R6 실제 metadata 하위 명령·허용 파일 %s', async command => {
  expect((await invoke('Bash', { command }, 'IMPLEMENT', fixture())).code).toBe(0);
});
it.each([["grep -rn --exclude='.env*' X .", 0], ["rg --hidden -g '!.env*' X .", 0], ['rg --hidden X .', 2], ["rg --hidden --no-ignore -g '!.env*' X .", 2]] as const)('R3 큰 HOME 내부 저장소·깊이·ignore 가지치기 %s', async (command, code) => {
  const options = fixture(), setup = options.setup!; let began = 0;
  options.setup = async root => {
    await setup(root);
    // Git commands are restricted to this disposable test repository.
    await run('git', ['init'], { cwd: root });
    await writeFile(join(root, '.gitignore'), '.env*\nnode_modules/\n');
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await Promise.all(Array.from({ length: 2500 }, (_, i) => writeFile(join(root, 'node_modules/pkg', `${i}.json`), 'FAKE_VALUE')));
    await writeFile(join(root, 'node_modules/pkg/private.pem'), 'FAKE_VALUE');
    await mkdir(join(root, 'deep', ...Array(12).fill('nested')), { recursive: true });
    // Git internals must never be scanned, irrespective of ignore flags.
    await mkdir(join(root, '.git/private')); await writeFile(join(root, '.git/private/secret.pem'), 'FAKE_VALUE');
    began = performance.now();
  };
  const result = await invoke('Bash', { command }, 'IMPLEMENT', options);
  expect(result.code).toBe(code); expect(performance.now() - began).toBeLessThan(1500);
});

it('R3 깊이 도달과 항목 수 초과를 구별한다', async () => {
  const options = fixture(), setup = options.setup!;
  options.setup = async root => {
    await setup(root); await mkdir(join(root, 'deep/a/b/c'), { recursive: true });
    expect(scanSecretFiles(join(root, 'deep'), secretPolicy(root), { depth: 1 }).exceeded).toBe(false);
    expect(scanSecretFiles(root, secretPolicy(root), { limit: 1 }).exceeded).toBe(true);
  };
  await invoke('Grep', { path: '.', pattern: 'X' }, 'IMPLEMENT', options);
});

it('R5 echo의 .env 인자는 읽기 검사 제외, .gitignore 쓰기 경계는 유지', async () => {
  const options = fixture(), setup = options.setup!;
  options.setup = async root => {
    await setup(root); const deny = vi.fn();
    secretReadGuard({ root, cwd: root, deny }).bash(shellCommands('echo .env >> .gitignore').entries);
    expect(deny).not.toHaveBeenCalled();
  };
  const result = await invoke('Bash', { command: 'echo .env >> .gitignore' }, 'CLEANUP', options);
  expect(result.code).toBe(2); expect(result.stderr).toContain('소스 파일은 두뇌가 쓰지 않습니다');
  expect(result.stderr).not.toContain('비밀 파일은 두뇌가 읽을 수 없습니다');
});
