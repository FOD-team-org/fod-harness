import { expect, it } from 'vitest';
import { fixtureWorkspace, invokeWorkspace, M } from './w3a-helpers.ts';
const cases: [string, string | null][] = [
  ...[
    'npm --prefix ../chemical run format', 'cd ../chemical && npm install', 'eslint --fix ../chemical/src',
    'env -C ../chemical npx tsc', 'npm --prefix=../chemical i', 'npm --prefix "../chemical" i', "npm --prefix '../chemical' i", 'npm --prefix ../chem"ical" i',
    'yarn --cwd=../chemical build', 'pnpm --dir=../chemical build', 'pnpm -C ../chemical build', 'bun --cwd ../chemical run build',
    'make -C../chemical', 'make --directory=../chemical', 'tsc -p ../chemical', 'tsc --project=../chemical/tsconfig.json',
    'npx --prefix ../chemical tsc', 'next build ../chemical', 'time -o ../chemical/x cat package.json',
    'cd ../chemical; npm i', 'cd ../chemical || npm i', 'echo "$(cd ../chemical && npm i)"',
    'bash -c "cd ../chemical && npm i"', 'f(){ npm i; }; cd ../chemical && f',
    'npm --prefix lnk i', 'cd lnk && npm i', 'npm --prefix @base@/chemical i', 'npm --prefix ../workspace/../chemical i',
    'cd ~/../chemical && npm i', 'npm --prefix $HOME/../chemical i', 'cd; cd ../chemical && npm i',
    'npm --prefix .. i', 'cd .. && npm i',
    'sed -n /foo/p ../chemical/package.json', 'sed -e 1p ../chemical/package.json',
    'find ../chemical -name x -exec wc -c {} \\;', 'find ../chemical -fprint .pi/scratch/x', 'rg --pre cat foo ../chemical',
    'diff --output=.pi/scratch/x ../chemical/a ../chemical/b', 'sort -o .pi/scratch/x ../chemical/package.json',
    'tree -o .pi/scratch/t ../chemical', 'file -C -m x ../chemical/package.json', 'cd ../chemical && node -e 1',
    'echo x > ../chemical/f', 'touch ../chemical/f', 'mkdir ../chemical/d', 'cp docs/a ../chemical/',
    'tee ../chemical/f < docs/a', 'sed -i s/a/b/ ../chemical/package.json', 'rm ../chemical/package.json', 'cd ../chemical && echo x > f',
    'npm test && cd ../chemical && git log', 'uniq docs/a ../chemical/f', 'npm --prefix "$PWD/../chemical" i',
  ].map(c => [c, M.M1()] as [string, string]),
  ['(cd ../wisepharm-app && flutter pub get)', M.M1('app')],
  ['npm --prefix lnk/../wisepharm-backend i', M.M1('backend')],
  ...['cd ~other && npm i', 'cd - && npm i', 'npm --prefix $D i', 'D=../chemical; cd $D && npm i',
    'npx eslint ../chem*', 'npx eslint $D/src', 'for d in ../chemical; do (cd $d && npm i); done',
    'ls ../chemical | xargs rm', 'cd $D && echo x > f'].map(c => [c, M.M5] as [string, string]),
  ...[
    'rg foo ../wisepharm-backend/src', 'sed -n 1,40p ../chemical/package.json',
    'cd ../chemical && ls && cat package.json', 'cd ../chemical; git status', '(cd ../chemical && git log)',
    '{ cd ../chemical; ls; }', 'if true; then cd ../chemical; fi; ls', 'echo "$(cd ../chemical && git log --oneline)"',
    'ls ..', 'cd .. && ls chemical', 'du -sh ..', 'node scripts/x.js $(date +%F)', 'npm test -- $X',
    'git ls-files | xargs wc -l', "find . -name '*.md' | xargs npx prettier --check",
    "sed -n '1,5p;10p' ../chemical/package.json", 'sort ../chemical/package.json', 'file ../chemical/package.json',
    "find ../chemical -name '*.ts'", 'npm ls --prefix ../chemical', 'npm --prefix ../chemical outdated', 'npm --prefix ../chemical view react version',
    'cd ../wisepharm-app && flutter --version', 'cd ../chemical && node --version', 'cd ../chemical && fodh state',
    'npm --prefix ../wp-web-T01 i', 'cd ../wp-web-T01 && npm test', 'echo x > ../wp-web-T01/src/a.ts',
    'npm test', 'ls', 'echo x > .pi/scratch/a', '(cd ../chemical && git log) > @root@/.pi/scratch/x', '{ cd ../chemical; ls; } 2>&1',
    'cd ../chemical && git log --format=%an | sort | uniq -c', 'cd ../chemical && git log --oneline | cut -c1-7 | tr a-f A-F',
    'git ls-files | cut -d/ -f1 | sort -u', "awk -F/ '{print $1}' docs/a", 'tr / _ < docs/a', 'IFS=/ read -r a b < docs/a',
    "awk '$2 ~ /fix/ {print $1}' docs/a", 'node scripts/x.js "$(date +%Y/%m)"', 'ls "$PWD/docs"', 'ls $(pwd)/docs', 'ls "$PWD/../chemical"',
  ].map(c => [c, null] as [string, null]),
];
it('member commands: complete specification table', async () => {
  const f = await fixtureWorkspace();
  for (const [command, message] of cases) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: message ? 2 : 0, stderr: message ? `하네스 가드[경계]: ${message}\n` : '' });
}, 30000);
it('existing priority, aliases, tools, cwd and audience', async () => {
  const f = await fixtureWorkspace({ alias: true });
  for (const command of ['npm --prefix ../chemical i', 'npm --prefix ../chem-link i']) expect((await invokeWorkspace('Bash', { command }, { fixture: f })).stderr).toBe(`하네스 가드[경계]: ${M.M1()}\n`);
  for (const [command, message] of [['find ../chemical -delete', 'find -delete 대량 삭제는 금지합니다.'], ['rm -rf ../chemical/dist', '프로젝트 밖·루트·문서 트리·.git·.pi 삭제는 금지합니다.']]) expect((await invokeWorkspace('Bash', { command }, { fixture: f })).stderr).toBe(`하네스 가드[경계]: ${message}\n`);
  for (const command of ['ls', 'git status']) expect((await invokeWorkspace('Bash', { command }, { fixture: f, cwd: '@base@/chemical' })).code).toBe(0);
  for (const command of ['npm i', 'echo x > f']) expect((await invokeWorkspace('Bash', { command }, { fixture: f, cwd: '@base@/chemical' })).stderr).toBe(`하네스 가드[경계]: ${M.M1()}\n`);
  expect((await invokeWorkspace('Bash', { command: 'cd ../chemical && npm install' }, { fixture: f, brain: false })).code).toBe(0);
  expect((await invokeWorkspace('Bash', { command: 'cd chemical && npm i' }, { fixture: f, env: { CDPATH: '@base@' } })).stderr).toBe(`하네스 가드[경계]: ${M.M5}\n`);
  expect((await invokeWorkspace('Read', { file_path: '@base@/chemical/src/app.ts' }, { fixture: f })).code).toBe(0);
  expect((await invokeWorkspace('Edit', { file_path: '@base@/wp-web-T01/src/a.ts' }, { fixture: f })).code).toBe(0);
  expect((await invokeWorkspace('Edit', { file_path: '@base@/chemical/src/app.ts' }, { fixture: f })).stderr).toBe('하네스 가드[경계]: 프로젝트 밖 쓰기는 금지합니다. .pi/scratch/를 사용하세요.\n');
});
it('literal dollars, AUTO_CD, wrappers and readonly option boundaries', async () => {
  const f = await fixtureWorkspace();
  const cases: [string, string | null][] = [
    ["python '../chemical/$X'", M.M1()],
    ["python '../chemical/`literal`'", M.M1()],
    ['../chemical && npm i', M.M1()],
    ['env -C../chemical npx tsc', M.M1()],
    ['env --chdir ../chemical npx tsc', M.M1()],
    ['env --chdir=../chemical npx tsc', M.M1()],
    ['xargs -a ../chemical/list cat docs/a', M.M1()],
    ['cd ../chemical && sort -T .pi/scratch docs/a', M.M1()],
    ['cd ../chemical && sort --compress-program=cat docs/a', M.M1()],
    ['git -C ../chemical', M.M2],
    ['cd ../chemical && git --version', null],
    ['cd ../chemical && git --help', null],
  ];
  for (const [command, message] of cases) expect.soft(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: message ? 2 : 0, stderr: message ? `하네스 가드[경계]: ${message}\n` : '' });
});
