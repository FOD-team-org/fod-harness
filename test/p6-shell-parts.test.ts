import { expect, it } from 'vitest';
import { shellParts } from '../hooks/shell-parts.mjs';

it('N1 here-string은 단일 연산자와 일반 operand로 남는다', () => {
  expect(shellParts('cat <<< "$v"\necho next')).toEqual({
    groups: [['cat', '<<<', '$v'], ['echo', 'next']], heredocs: [], unterminatedHeredoc: false,
  });
});
it.each(['$((1<<2))', '((a = (8 >> 1) > 0 && 1 < 2))'])(
  'N1 산술식의 괄호 깊이를 추적한다: %s', expression => {
    expect(shellParts(`echo ${expression}\necho next`)).toEqual({
      groups: [['echo', expression], ['echo', 'next']], heredocs: [], unterminatedHeredoc: false,
    });
  },
);
it('N1 여러 heredoc·탭 제거·뒤 명령을 보존한다', () => {
  expect(shellParts("cat <<'A' <<-B\nhello\nA\n\tworld\n\tB\necho next")).toEqual({
    groups: [['cat', '<<', 'A', '<<-', 'B'], ['echo', 'next']],
    heredocs: ['hello', '\tworld'], unterminatedHeredoc: false,
  });
});
it('N1 미종료 본문은 훅에서 보존하고 감사에서만 명령으로 복구한다', () => {
  const command = "cat <<'EOF'\necho x > src/a.ts";
  expect(shellParts(command)).toEqual({
    groups: [['cat', '<<', 'EOF'], []], heredocs: ['echo x > src/a.ts'], unterminatedHeredoc: true,
  });
  expect(shellParts(command, { recoverUnterminated: true })).toEqual({
    groups: [['cat', '<<', 'EOF'], ['echo', 'x', '>', 'src/a.ts']],
    heredocs: ['echo x > src/a.ts'], unterminatedHeredoc: true,
  });
});
