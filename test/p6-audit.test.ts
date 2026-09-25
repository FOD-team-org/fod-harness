import { expect, it } from 'vitest';
import { auditPaths, auditPathReport } from '../src/core/audit.ts';
const context = { root: '/project', docsRoot: 'docs', worktrees: [{ path: '/wt' }] };
const audit = (command: string) => auditPaths('Bash', { command }, context);
it.each([
  'grep -q foo <<< "$v"\necho x > src/a.ts',
  'echo $((1<<2))\necho x > src/a.ts',
  "cat <<'EOF'\necho x > src/a.ts",
  "cat <<A <<B\nhello\nA\necho x > src/a.ts",
])('N1 here-string·산술식·미종료 heredoc 뒤 쓰기를 감사한다: %s', command => {
  expect(audit(command)).toEqual(['/project/src/a.ts']);
});
it('N1 산술식 내부 비교·시프트는 리다이렉트가 아니다', () => {
  expect(audit('echo $((8 >> 1))\n((a = (1 << 2) > 0 && 1 < 2))')).toEqual([]);
});
it.each([
  "sed -n '1,9p' src/x.ts", "grep -n foo src/a.ts | sed 's/a/b/'",
  `cat package.json | node -e "console.log('x'.split('/'))"`,
  `node -e "require('fs').readFileSync('package.json')"`, `python3 -c "open('src/z.ts','r').read()"`,
  'ls docs 2>/dev/null', 'tee docs/a.md 2>/dev/null', 'git apply --check x.patch', 'git apply --stat x.patch', 'patch --dry-run',
  'git -C /wt apply x.patch', 'patch --directory=/wt -p1 < docs/x.diff',
])('M2/M3 읽기·워크트리·패치 검사는 경고하지 않는다: %s', command => expect(audit(command)).toEqual([]));
it.each([
  [`node -e "require('fs').writeFileSync('src/w.ts','x')"`, 'src/w.ts'],
  [`python3 -c "open('src/z.ts','w').write('x')"`, 'src/z.ts'],
  [`node --eval="require('fs').appendFile('src/a.ts','x')"`, 'src/a.ts'],
  [`node -e "require('fs').createWriteStream('src/s.ts')"`, 'src/s.ts'],
  ["python3 <<'PY'\nopen('src/h.ts', 'a').write('x')\nPY", 'src/h.ts'],
  ['echo hi >> src/out.ts', 'src/out.ts'], ['cmd &>src/out.ts', 'src/out.ts'],
  ['tee -a src/out.ts', 'src/out.ts'], ["sed -i '' 's/a/b/' src/out.ts", 'src/out.ts'],
  ["perl -pi -e 's/a/b/' src/out.ts", 'src/out.ts'],
  ['cp src/read.ts src/out.ts', 'src/out.ts'], ['mv src/old.ts src/out.ts', 'src/out.ts'],
  ['install -m 600 src/read.ts src/out.ts', 'src/out.ts'], ['rsync src/read.ts src/out.ts', 'src/out.ts'],
  ['dd if=src/read.ts of=src/out.ts', 'src/out.ts'], ['touch src/out.ts', 'src/out.ts'], ['truncate -s 0 src/out.ts', 'src/out.ts'],
])('M3 쓰기 대상만 후보: %s', (command, path) => expect(audit(command)).toEqual(['/project/' + path]));
it.each(['git apply .pi/scratch/fix.patch', 'patch -p1 < docs/x.diff'])('M2 패치 파일 대신 대상 트리를 경고한다: %s', command => expect(audit(command)).toEqual(['/project']));
it('M3 heredoc 문서 내용의 > 인용은 경로 후보가 아니다', () => {
  expect(audit("cat > docs/a.md <<'EOF'\n> 인용\ncodex x\nEOF")).toEqual([]);
});

it.each(['echo > $f', 'echo > `target`', 'echo > src/*.ts'])('H4 확장 경로는 boundary 대신 unresolved: %s', command => {
  const result = auditPathReport('Bash', { command }, context);
  expect(result.boundary).toEqual([]); expect(result.unresolved.length).toBeGreaterThan(0);
});
it.each(['T=$(mktemp -d); echo > $T/out', 'bash -c \'T=$(mktemp -d); echo > $T/out\''])('H4 입증된 임시 변수는 원장 후보 없음: %s', command => {
  expect(auditPathReport('Bash', { command }, context)).toEqual({ boundary: [], unresolved: [] });
});
it('H4 리터럴 소스 쓰기는 경고 유지·미확정 경로 중복 제거', () => {
  expect(auditPathReport('Bash', { command: 'echo x > src/a.ts; echo > $f; echo > $f' }, context))
    .toEqual({ boundary: ['/project/src/a.ts'], unresolved: ['$f'] });
});
it.each(['ls src/*.ts', 'grep foo $HOME/x', 'echo $PATH', 'for f in src/*.ts; do cat $f > /tmp/x; done'])('R7 읽기 피연산자는 unresolved 없음: %s', command => {
  expect(auditPathReport('Bash', { command }, context)).toEqual({ boundary: [], unresolved: [] });
});
it.each(['echo x > $f', 'rm -f $f', 'echo x > /tmp/{a,b}', 'echo x > /tmp/x(:h:h)', 'TMPDIR=/project sh -c "echo x > \\$TMPDIR/src/a.ts"'])('R1/R2/R7 쓰기 확장은 감사 증거 유지: %s', command => {
  expect(auditPathReport('Bash', { command }, context).unresolved.length).toBeGreaterThan(0);
});
it.each([
  'NAME=$(mktemp -d); NAME[0]=src; echo x > "$NAME"',
  'NAME=$(mktemp -d); readarray NAME; rm -rf "$NAME"',
  'NAME=$(mktemp -d); export "$DYNAMIC"=src; echo x > "$NAME"',
  'source config.sh; bash -c \'echo x > "$TMPDIR/x"\'',
])('Q3/Q4 감사도 불확실 임시 치환을 하지 않는다: %s', command => {
  expect(auditPathReport('Bash', { command }, context).unresolved.length).toBeGreaterThan(0);
});
it.each([
  'f() { echo x > src/a.ts; }; f', 'case $x in a) echo x > src/a.ts;; esac',
  'cat <(echo x > src/a.ts)', 'coproc echo x > src/a.ts',
])('Q1 감사도 복합 구문의 소스 쓰기를 찾는다: %s', command => {
  expect(audit(command)).toContain('/project/src/a.ts');
});
it.each(['>|', '>>|', '>!', '>>!', '&>|', '>&', '<>', '>>&'])('P6 사후 감사도 리다이렉트 %s의 목적지를 찾는다', operator => {
  expect(audit(`cmd ${operator} src/a.ts`)).toEqual(['/project/src/a.ts']);
});
it.each(['cmd 2>&1', 'cmd >&2', 'cmd 3<&0'])('P6 fd 복제는 쓰기 경로가 아니다: %s', command => {
  expect(auditPathReport('Bash', { command }, context)).toEqual({ boundary: [], unresolved: [] });
});
