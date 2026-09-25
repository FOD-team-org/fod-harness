import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { invoke } from './hook-helpers.ts';

// Reproduction strings are only hook JSON input, never executed by a shell.
describe.each(['outside', 'inside'] as const)('X1~X3 root HOME %s', homeLayout => {
  const hook = (command: string, brain = true, env: NodeJS.ProcessEnv = {}) => invoke('Bash', { command }, 'IMPLEMENT', {
    homeLayout, env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp', ...env },
    setup: async root => {
      for (const path of ['.pi/templates/t.md', '.pi/templates/docs/plan.md', 'config/guard/state.json', '../outside/guard/state.json']) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), 'fixture');
      }
    },
  });
  it.each([
    'echo x > "@root@/docs/${TOPIC}.md"', 'touch @root@/docs/$NAME.md',
    'cp README.md @root@/docs/$NAME.md', "cat > @root@/docs/$NAME.md <<'EOF'\nx\nEOF",
    'echo x > "@root@/docs/$F"', 'echo x > docs/${PREFIX}${NAME}.md',
    'echo x > "docs/$(date +%F)$NAME.md"', 'echo x > docs/$A$B.md', 'echo x > docs/$NAME.$EXT',
  ])('X1~X3 두뇌 문서 쓰기 허용: %s', async command => expect(await hook(command)).toMatchObject({ code: 0 }));
  it.each([
    'cp README.md "@root@/$DEST"', 'cp -r src "@root@/$OUT"', 'mv a @root@/$DEST',
    'cp a "$OUT/$name$ext"', 'echo x > "$D/$A$B"', 'cp a "$DIR/${NAME}${SUFFIX}"',
    'mv a "$DEST/$NAME$EXT"', 'echo x | tee "$OUT/$base$ext"', 'cp a "$OUT/$A_$B.json"',
    'cp a "$OUT/$NAME-$VER.json"', 'echo x > "$D/$F.$E"', 'cp a "$OUT/$A.$B.json"',
    'cp a "$OUT/templates/$F"', 'echo x > "$D/templates/$F"',
  ])('X1~X3 사용자 복사·쓰기 허용: %s', async command => expect(await hook(command, false)).toMatchObject({ code: 0 }));
  it.each([
    'echo x > @root@/.pi/$X', 'echo x > "@root@/.claude/$F"', 'echo x > .pi/$A$B',
    'echo x > .pi/templates/$X', 'cp -r x "$D/.pi"', 'cp a.txt "$D/harness.json"',
    'echo x > "$D/settings.local.json"', 'echo x > "$D/$F.local.json"',
    'echo x > .pi/harness.json$(true)', 'echo x > .pi/$X', 'echo x > .pi/$X.json',
    'echo x > $D/settings.json', 'cp x .pi/$X',
  ])('X1~X3 사용자·두뇌 보호 거부 유지: %s', async command => {
    for (const brain of [true, false]) expect(await hook(command, brain)).toMatchObject({ code: 2 });
  });
  it.each(['echo x > docs/판단대기$X.md', 'echo x > ~/.zsh$X', 'echo x > "@root@/docs/판단대기$X.md"'])('X1~X3 두뇌 판단·시작 파일 거부: %s', async command => expect(await hook(command)).toMatchObject({ code: 2 }));
  it('X1 루트 직속 보호 파일도 루트 이름을 단서로 추가하지 않는다', async () => {
    const env = { FODH_PROTECTED_EXTRA: '@root@/direct.json' };
    expect(await hook('echo x > "@root@/docs/$NAME.md"', true, env)).toMatchObject({ code: 0 });
    expect(await hook('cp a "@root@/$DEST"', false, env)).toMatchObject({ code: 0 });
  });
  it('X1 일반 가드 이름은 전체 상대 경로를 연속으로 적어야 한다', async () => {
    const env = { FODH_PROTECTED_EXTRA: 'config/guard/state.json' };
    expect(await hook('echo x > "$D/guard/$F.json"', false, env)).toMatchObject({ code: 0 });
    for (const brain of [true, false]) expect(await hook('echo x > config/guard/$F.json', brain, env)).toMatchObject({ code: 2 });
    expect(await hook('cp a "$SITE/$LANG/docs/$F"', false, { FODH_PROTECTED_EXTRA: '.pi/templates/docs' })).toMatchObject({ code: 0 });
  });
  it('X1 루트 밖 가드 디렉터리는 이름 단서로 쓰지 않는다', async () => {
    const env = { FODH_PROTECTED_EXTRA: '@root@/../outside/guard/state.json' };
    expect(await hook('echo x > "@root@/../outside/guard/$F.json"', false, env)).toMatchObject({ code: 0 });
    expect(await hook('echo x > "@root@/../outside/guard/state.json$X"', false, env)).toMatchObject({ code: 2 });
  });
  it('X1 시작 파일의 비-HOME 전용 디렉터리는 두뇌에만 단서다', async () => {
    const env = { CLAUDE_ENV_FILE: '@root@/shell/startup.sh' };
    expect(await hook('echo x > "@root@/shell/$F.sh"', true, env)).toMatchObject({ code: 2 });
    expect(await hook('echo x > "@root@/shell/$F.sh"', false, env)).toMatchObject({ code: 0 });
    expect(await hook('echo x > "@root@/$F.sh"', false, { CLAUDE_ENV_FILE: '@root@/startup.sh' })).toMatchObject({ code: 0 });
  });
  it.skipIf(process.platform !== 'darwin')('X1 전용 디렉터리 단서 대소문자 무시', async () => {
    for (const brain of [true, false]) expect(await hook('echo x > @root@/.PI/$A$B', brain)).toMatchObject({ code: 2 });
  });
});
