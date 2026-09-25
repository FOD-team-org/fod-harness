import { describe, expect, it } from 'vitest';
import { invoke } from './hook-helpers.ts';

// Only JSON is passed to the hook. No example below is executed by a shell.
const hook = (command: string, brain = true) => invoke('Bash', { command }, 'IMPLEMENT', { env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp' } });
describe.each(['outside', 'inside'] as const)('W1 root HOME %s', homeLayout => {
  const hook = (command: string, brain = true) => invoke('Bash', { command }, 'IMPLEMENT', {
    homeLayout, env: { FODH_BRAIN: brain ? '1' : '', TMPDIR: '/private/tmp' },
  });
  it.each([
    'cp README.md "$DEST"', 'cp README.md "$DEST/"', 'cp README.md $DEST', 'mv a "$DEST"',
    'cp -r src "$OUT"', 'rsync -a src/ "$BACKUP/"', 'install -m 755 bin/x "$BIN"',
    'cp a.txt "$1"', 'cp a.txt ./"$NAME"', 'cp "$SRC" "$DST"', 'cp README.md "$(mktemp -d)"',
    'for f in a b; do mv "$f" "$new"; done', 'echo x > "$D/$F"', 'echo x | tee "$D/$F"',
    'echo x > "$HOME/$F"', 'for f in a b; do cp "$f" "$OUT/$f"; done',
    'for f in *.md; do sed -n p "$f" > "$DIR/$f"; done',
    'T=$(mktemp -d); cp a "$T/$f"', 'T=$(mktemp -d); rm -rf $T/$UNKNOWN',
    'echo x > "$D/$NAME.json"', 'cp README.md "$D/$NAME.json"',
  ])('W1 구체적이지 않은 동적 목적지 사용자 허용: %s', async command => expect(await hook(command, false)).toMatchObject({ code: 0 }));
  it.each([
    'echo x > docs/${TOPIC}.md', 'touch docs/$NAME.md', 'cp README.md docs/$NAME.md',
    'cat > docs/$NAME.md <<EOF\nx\nEOF', 'echo x > docs/$(date +%F)-note.md',
    'echo x > .pi/scratch/$NAME.md', 'echo x > "docs/$NAME-notes.md"',
  ])('W1 정상 두뇌 문서 쓰기 허용: %s', async command => expect(await hook(command)).toMatchObject({ code: 0 }));
  it.each([
    'echo x > .pi/harness.json$(true)', 'echo x > .pi/$X', 'echo x > .pi/$X.json',
    'echo x > $D/settings.json', 'cp a.txt "$D/harness.json"', 'cp x .pi/$X', 'cp -r x "$D/.pi"', 'cp -r x "$D/.claude"',
    'echo x > .claude/$F', 'echo x > .claude/$F.json',
    'echo x > .pi/harnes?.json', 'cp x .p*', 'echo x > .pi/harness.json',
  ])('W1 정적 단서·리터럴 glob·비동적 보호 거부 유지: %s', async command => {
    for (const brain of [true, false]) expect(await hook(command, brain)).toMatchObject({ code: 2 });
  });
  it.each([
    'echo x > docs/판단대기$X.md', 'echo x >> ~/.zsh$X', 'echo x >> ~/$F',
    'echo x > docs/판단대?.md', 'T=$(mktemp -d); echo x > "$T/$f"',
  ])('W1 두뇌의 기존 경계 거부 유지: %s', async command => expect(await hook(command)).toMatchObject({ code: 2 }));
});
it.each([
  'T=$(mktemp -d); cp README.md "$T"/; rm -rf "$T"',
  'export T=src; rm -rf "$T"', 'read T; rm -rf "$T"', 'for T in src; do rm -rf "$T"; done',
])('W2 같은 호출에서 대입한 변수는 임시 변수 안내: %s', async command => {
  expect(await hook(command)).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]: 임시 변수 예외를 줄 수 없는 조합입니다.') });
});
it.each(['rm -rf "$HOME"', 'rm -rf "$PWD"', 'rm -rf "$OLDPWD"', 'rm -rf "$TMPDIR"', 'rm -rf $UNKNOWN', 'rm -rf "$T"', 'rm -rf ${T}/x', 'HOME=src; rm -rf "$HOME"'])('W2 환경·미대입 변수는 기존 경계 안내: %s', async command => {
  const result = await hook(command);
  expect(result).toMatchObject({ code: 2, stderr: expect.stringContaining('[경계]') });
  expect(result.stderr).not.toContain('임시 변수 예외를 줄 수 없는 조합');
});

it.each(['/home/fodh', '/Users/fodh'])('W3 시작 파일 문구는 HOME 위치와 무관: %s', async home => {
  const parent = home.slice(0, home.lastIndexOf('/'));
  expect(await invoke('Bash', { command: `echo x > ${parent}/$USER/.zshenv` }, 'IMPLEMENT', {
    env: { FODH_BRAIN: '1', HOME: home },
  })).toMatchObject({ code: 2, stderr: expect.stringContaining('셸 시작 파일은 두뇌가 바꿀 수 없습니다') });
});
