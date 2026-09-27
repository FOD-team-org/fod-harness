import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

// Frozen corpus from pre-W3a hook tables. Inputs are JSON data, never shell commands.
const commands = [
  "grep -q foo <<< \"$v\"\nrm -rf .git",
  "cat <<< x\nprisma migrate deploy",
  "echo $((1<<2))\ncodex exec fixture",
  "cat <<< x",
  "echo $((1<<2))",
  "cat <<'EOF'\nhello\nEOF",
  "cat <<'EOF'\n본문",
  "cat <<EOF",
  "cat <<EOF\n",
  "cat <<'EOF' > src/x.ts\nhello\nEOF",
  "cat <<'EOF'>src/x.ts\nhello\nEOF",
  "env FOO=x codex exec task",
  "npm test && codex exec task",
  "fodh codex",
  "echo changed > .claude/settings.json",
  "tee .pi/harness-state.json",
  "sed -i x .claude/settings.json",
  "echo changed>.claude/settings.json",
  "git push origin main",
  "git push -f",
  "git push --force origin branch",
  "vercel --prod",
  "prisma migrate deploy",
  "vercel env rm X production",
  "echo FODH_DOCTOR_MARKER",
  "rm .env.example",
  "vercel env add X",
  "ls",
  "fodh codex task T01",
  "cat .claude/settings.json",
  "fodh judgment add --background \"production 데이터 delete 여부\"",
  "npx /opt/fod-harness/bin/fodh judgment add --background \"git push origin main; codex exec x\"",
  "grep -r codex docs/",
  "grep codex docs/file.md",
  "git merge-base main HEAD",
  "echo \"privacy policy\"",
  "npm test",
  "git log --oneline",
  "echo \"production 데이터 delete 여부\"",
  "echo \"subscription create\"",
  "echo stripe customers create",
  "echo git push origin main",
  "echo \"slack send\"",
  "git log --grep=commit",
  "git status && echo merge",
  "git status; echo push",
  "git commit -m example",
  "vercel domains add example.test",
  "echo FORBIDDEN_MARKER",
  "git commit -m docs",
  "git push origin feature",
  "git merge feature",
  "env FODH_BRAIN=0 fodh config set interview.enforce false",
  "fodh config set custom FODH_BRAIN=0",
  "env -u FODH_BRAIN fodh config set interview.enforce false",
  "env FOO=x -i fodh config get",
  "env -uFODH_BRAIN fodh config get",
  "env --unset=FODH_BRAIN fodh config get",
  "env FOO=x node --version",
  "echo x > src/x.ts",
  "echo x > docs/a.md",
  "sed -i x src/x.ts",
  "echo hi>src/x.ts",
  "echo hi >> src/x.ts",
  "tee src/x.ts",
  "cp a src/b",
  "mv docs/a src/b",
  "touch src/x",
  "dd if=docs/a of=src/b",
  "rsync docs/a src/b",
  "patch src/x.ts",
  "git apply src/a.patch",
  "git checkout -- src/x.ts",
  "git restore src/x.ts",
  "git stash",
  "echo ok > docs/a.md",
  "echo ok >>docs/a.md",
  "sed -i x docs/a.md",
  "sed -i '' 's/a/b/' docs/a.md",
  "cp docs/a wt/src/b",
  "rm docs/a.md",
  "rm -rf @root@/wt/build",
  "rm -rf @root@-wt/build",
  "git -C wt clean -fdx",
  "rm -rf /outside/x",
  "rm -rf .",
  "rm -rf .git",
  "rm -rf .pi",
  "find docs -delete",
  "git clean -fdx",
  "fodh worktree",
  "git branch -D example",
  "git reset --hard",
  "git push --force-with-lease origin feature",
  "fodh config get",
  "npx fodh state get",
  "env FOO=x fodh config get",
  "sh -c 'unset FODH_BRAIN; fodh config set verify.commands true'",
  "bash -c 'unset FODH_BRAIN'",
  "node -e \"delete process.env.FODH_BRAIN\"",
  "node --eval=\"delete process.env.FODH_BRAIN\"",
  "rm -rf /tmp/fixture",
  "ls docs 2>/dev/null",
  "fodh state get 2>/dev/null",
  "tee /dev/stdout",
  "tee /dev/fd/1",
  "tee docs/a.md 2>/dev/null",
  "node scripts/check.mjs",
  "sh scripts/check.sh arg",
  "git stash list",
  "git stash show",
  "echo ok > /tmp/fixture",
  "git apply .pi/scratch/fix.patch",
  "patch -p1 < docs/x.diff",
  "git -C @root@/wt apply x.patch",
  "git apply --directory=@root@/wt docs/x.patch",
  "patch -d @root@/wt -p1 < docs/x.diff",
  "patch --directory=@root@/wt -p1 < docs/x.diff",
  "git apply --check x.patch",
  "git apply --stat x.patch",
  "git apply --numstat x.patch",
  "git apply --summary x.patch",
  "patch --dry-run",
  "fodh memory reset",
  "npx fodh memory reset",
  "bash -lc 'unset FODH_BRAIN'",
  "sh -ec 'unset FODH_BRAIN'",
  "rm -rf .pi/scratch/task",
  "rm -rf docs",
  "rm -rf notes",
  "git clean -nd",
  "git clean --dry-run -fdx",
  "rm -rf /outside/example",
  "fodh codex task T01 --spec docs/task.md --wait",
  "fodh codex task T01 --spec docs/task.md",
  "echo answer >> docs/판단대기.md",
  "echo answer > docs/판단대기.md",
  "tee docs/판단대기.md",
  "sed -i '' 's/a/b/' docs/판단대기.md",
  "cp docs/source.md docs/판단대기.md",
  "mv docs/source.md docs/판단대기.md",
  "cat docs/판단대기.md",
  "grep 답 docs/판단대기.md",
  "fodh judgment add --title 질문",
  "fodh judgment read",
  "fodh judgment write-status 대기",
  "fodh inbox ack item",
  "tee docs/결정.md"
];
const intendedCommands: Record<string, { section: number; message: string; brainOnly?: boolean }> = {
  'git -C .. commit -m x': { section: 1, message: 'commit·merge·push 는 루트 저장소나 등록 워크트리를 대상으로만 합니다' },
  'cd $D && git commit -m x': { section: 1, message: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요' },
  'GIT_DIR=x git commit -m x': { section: 1, message: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요' },
  'git --git-dir=.git commit -m x': { section: 1, message: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요' },
  'git --work-tree=. commit -m x': { section: 1, message: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요' },
  'cd docs && git commit -m x && cd ..': { section: 1, message: 'commit·merge·push 는 루트 저장소나 등록 워크트리를 대상으로만 합니다' },
  'git commit -m x && cd -': { section: 1, message: 'git 변경 대상을 확인할 수 없습니다 — cd·git -C 는 리터럴 경로로 쓰세요' },
  'npm --prefix sub run db:migrate': { section: 2, message: '승인 필수 동작(db-migrate)입니다. 판단대기 항목을 만들어라.' },
  'npm run-script db:migrate': { section: 2, message: '승인 필수 동작(db-migrate)입니다. 판단대기 항목을 만들어라.' },
  'npx -c "npm run db:migrate"': { section: 2, message: '승인 필수 동작(db-migrate)입니다. 판단대기 항목을 만들어라.' },
  'npm exec -- prisma migrate deploy': { section: 2, message: '승인 필수 동작(prod-migration)입니다. 판단대기 항목을 만들어라.' },
  'git show :config/prod.json': { section: 3, brainOnly: true, message: '비밀 파일은 두뇌가 읽을 수 없습니다: prod.json. 값이 필요하면 판단으로 사용자에게 요청하세요' },
  'cd docs && cat ../config/prod.json': { section: 4, brainOnly: true, message: '비밀 파일은 두뇌가 읽을 수 없습니다: prod.json. 값이 필요하면 판단으로 사용자에게 요청하세요' },
};
const config = { approvalRules: [{ id: 'db-migrate', pattern: '^npm run db:(?:migrate|push)\\b|^drizzle-kit (?:migrate|push)\\b' }], secrets: { readDeny: ['config/prod.json'] } };
interface Row { id: string; tool: string; input: Record<string, string>; cwd: string; state: string; brain: boolean; worktrees: boolean; env: Record<string, string>; result: { code: number | null; stderr: string } }
it('single repository frozen decisions and explicitly intended changes', async () => {
  const base = await mkdtemp('/private/tmp/fodh-w3a-golden-'), root = join(base, 'workspace');
  try {
    for (const dir of ['.pi/scratch', 'docs', 'src', 'config', 'wt', 'worktree', 'sub']) await mkdir(join(root, dir), { recursive: true });
    await mkdir(root + '-wt'); await mkdir(join(base, 'home'));
    await writeFile(join(root, '.pi/harness.json'), JSON.stringify(config));
    for (const file of ['docs/a', 'config/prod.json', 'src/app.ts']) await writeFile(join(root, file), 'FAKE_VALUE');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FODH_|GIT_)/.test(key) && !['CLAUDE_PROJECT_DIR', 'CDPATH'].includes(key)));
    Object.assign(env, { HOME: join(base, 'home'), FODH_NOTIFY_OS: 'off', FODH_PROJECT_ROOT: root });
    const inputs: { tool: string; input: Record<string, string> }[] = [...commands, ...Object.keys(intendedCommands), 'cd docs 2>/dev/null && git commit -m x', 'git -C @root@-wt commit -m x'].map(command => ({ tool: 'Bash', input: { command } }));
    for (const tool of ['Read', 'Grep', 'Edit', 'Write']) for (const file_path of ['src/app.ts', 'docs/a', 'config/prod.json', '.env.example']) inputs.push({ tool, input: { file_path } });
    const rows: Row[] = [];
    for (const state of ['IMPLEMENT', 'MERGE', 'DOCS']) for (const brain of [false, true]) {
      await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state, worktrees: [{ path: root + '-wt' }, { path: join(root, 'wt') }] }));
      for (const [i, entry] of inputs.entries()) {
        const input = JSON.parse(JSON.stringify(entry.input).replaceAll('@root@', root));
        const result = spawnSync(process.env.FODH_W3A_HOOK || resolve('hooks/pretooluse.sh'), [], { cwd: root, env: { ...env, ...(brain ? { FODH_BRAIN: '1' } : {}) }, input: JSON.stringify({ cwd: root, tool_name: entry.tool, tool_input: input }), encoding: 'utf8', timeout: 5000 });
        if (result.error) throw result.error;
        rows.push({ id: `${state}-${brain ? 'brain' : 'user'}-${i}`, tool: entry.tool, input: entry.input, cwd: '@root@', state, brain, worktrees: true, env: { HOME: '@root@/../home', FODH_NOTIFY_OS: 'off' }, result: { code: result.status, stderr: result.stderr.replaceAll(root, '@root@') } });
      }
    }
    const file = resolve('test/fixtures/w3a-single-golden.json');
    if (process.env.FODH_W3A_GOLDEN === 'write') {
      await mkdir(resolve('test/fixtures'), { recursive: true });
      // Exclusive creation: never silently replace the pre-change evidence.
      await writeFile(file, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx' });
    } else {
      const golden: Row[] = JSON.parse(await readFile(file, 'utf8'));
      expect(rows.length).toBe(golden.length);
      for (const [i, row] of rows.entries()) {
        expect({ ...row, result: undefined }).toEqual({ ...golden[i], result: undefined });
        const intended = row.tool === 'Bash' && intendedCommands[row.input.command];
        if (intended && (!intended.brainOnly || row.brain)) {
          expect(intended.section).toBeGreaterThanOrEqual(1); expect(intended.section).toBeLessThanOrEqual(4);
          expect(row.result, row.id + ' ' + row.input.command).toEqual({ code: 2, stderr: `하네스 가드[${intended.section === 2 ? '승인' : '경계'}]: ${intended.message}\n` });
        } else expect(row.result, row.id + ' ' + JSON.stringify(row.input)).toEqual(golden[i].result);
      }
    }
  } finally { await rm(base, { recursive: true, force: true }); }
}, 120000);
