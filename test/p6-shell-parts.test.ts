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

it('R2 리다이렉트가 있어도 원문 인용 메타데이터의 단어 위치가 같다', () => {
  const result = shellParts(`bash > /tmp/out -c 'T=$(mktemp -d); rm -rf "$T"'`, { metadata: true });
  expect(result.rawGroups?.[0]).toEqual(['bash', '>', '/tmp/out', '-c', `'T=$(mktemp -d); rm -rf "$T"'`]);
  expect(result.groups[0]).toHaveLength(result.rawGroups![0].length);
});
it.each(['>>|', '>|', '>>!', '>!', '&>|', '>&', '<&', '<>', '>>&'])('P6 fd 접두·긴 리다이렉트 연산자 %s 유지', operator => {
  expect(shellParts(`cmd 2${operator} output; echo ok`).groups).toEqual([['cmd', operator, 'output'], ['echo', 'ok']]);
});
