import { expect, it } from 'vitest';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, writeConfig } from './w1-helpers.ts';
import { loadConfig } from '../src/core/config.ts';
import { generateClaudeMd, claudeMdHash } from '../src/core/claude-md.ts';

it('C1-C6 workspace ordered relative member/verification tables and both document targets', async () => {
  const f = await fixture(); f.repos.backend.baseBranch = 'develop';
  f.repos.web.verify = { commands: ['echo "a|b"', 'echo ' + 'sk-' + 'ant-' + 'FAKE_W3B_ONLY'], heavy: ['npm run check-all'] };
  f.repos.backend.verify.commands = ['npm run lint'];
  await writeConfig(f.root, { ...f.candidate, claudeMd: { targets: ['CLAUDE.md', 'AGENTS.md'] } });
  await generateClaudeMd(f.root);
  const claude = await readFile(join(f.root, 'CLAUDE.md'), 'utf8'), agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
  expect(claude.indexOf('## 역할')).toBeLessThan(claude.indexOf('## 워크스페이스'));
  expect(claude.indexOf('## 워크스페이스')).toBeLessThan(claude.indexOf('## 하네스 흐름'));
  expect(claude).toContain('| web | ../web | main |\n| backend | ../backend | develop |\n| app | ../app | main |');
  for (const text of [claude, agents]) {
    expect(text).not.toContain('일반 명령: [');
    expect(text).toContain('| web | ["echo \\"a\\|b\\"","echo [비밀값 제거]"] | ["npm run check-all"] |');
    expect(text).toContain('| backend | ["npm run lint"] | [] |');
    expect(text).not.toContain('sk-' + 'ant-');
  }
  expect(agents).not.toContain('## 워크스페이스'); expect(agents).not.toContain('하네스 흐름');
  expect(claude).toContain('- fodh worktree commit\n- fodh worktree merge\n');
  expect(claude).toContain('| MERGE | fodh worktree merge |\n| DOCS | fodh backlog set |');
  expect(claude).not.toContain('MERGE·DOCS');
  expect(claude.split('\n').filter(line => line.startsWith('- fodh workspace'))).toEqual(['- fodh workspace list']);
  expect(claude).not.toContain('단 거부 문구에');
  // C2 exact prose is also asserted in the dedicated test below.
  expect(await generateClaudeMd(f.root, { check: true })).toEqual({ upToDate: true });
  expect(await generateClaudeMd(f.root)).toEqual({ files: [{ path: 'CLAUDE.md', changed: false }, { path: 'AGENTS.md', changed: false }] });
});
it('C7 visible member settings affect hash; operational settings do not', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate); const config = await loadConfig(f.root), hash = claudeMdHash(config);
  for (const field of ['name', 'path', 'baseBranch', 'commands', 'heavy']) {
    const next = structuredClone(config), member = next.workspace!.repos.web;
    if (field === 'name') next.workspace!.repos = Object.fromEntries(Object.entries(next.workspace!.repos).map(([name, value]) => [name === 'web' ? 'site' : name, value]));
    if (field === 'path') member.path = '../alias';
    if (field === 'baseBranch') member.baseBranch = 'develop';
    if (field === 'commands') member.verify.commands = ['npm run lint'];
    if (field === 'heavy') member.verify.heavy = ['npm run check-all'];
    expect(claudeMdHash(next), field).not.toBe(hash);
  }
  for (const field of ['timeoutMinutes', 'prefix', 'approvalRules', 'secrets']) {
    const next = structuredClone(config), member = next.workspace!.repos.web;
    if (field === 'timeoutMinutes') member.verify.timeoutMinutes = 90;
    if (field === 'prefix') member.worktrees.prefix = 'other-';
    if (field === 'approvalRules') member.approvalRules = [{ id: 'new-rule', pattern: '^example$' }];
    if (field === 'secrets') member.secrets = { readDeny: ['config/example.json'] };
    expect(claudeMdHash(next), field).toBe(hash);
  }
});
it('cell escaping also applies to member path and branch', async () => {
  const f = await fixture(['web']); await rename(f.member(), f.member() + '|pipe');
  f.repos.web.path = '../web|pipe'; f.repos.web.baseBranch = 'feature|branch';
  await writeConfig(f.root, f.candidate); await generateClaudeMd(f.root);
  expect(await readFile(join(f.root, 'CLAUDE.md'), 'utf8')).toContain('| web | ../web\\|pipe | feature\\|branch |');
});

it('C2 workspace advice is exactly the five specified bullets', async () => {
  const f = await fixture(['web']); await writeConfig(f.root, f.candidate); await generateClaudeMd(f.root);
  const text = await readFile(join(f.root, 'CLAUDE.md'), 'utf8');
  expect(text.split('## 워크스페이스')[1].split('## 하네스 흐름')[0].split('\n').filter(line => line.startsWith('- '))).toEqual(["- 멤버 레포 규칙은 `<경로>/CLAUDE.md`·`<경로>/AGENTS.md` 를 먼저 읽는다. 여러 레포에 걸친 원본 규칙은 이 파일의 관리 블록 밖 절을 따른다.", "- task 하나 = 레포 하나. `fodh backlog add` 에는 `--repo <멤버>` 가 필수다. 두 레포를 고쳐야 하면 레포별 task 로 쪼개고 `--depends` 로 잇는다.", "- 멤버 main(기준 브랜치 체크아웃)은 읽기만 한다. 바꾸는 일은 task 위임으로 하고, 병합은 MERGE 에서 `fodh worktree merge <T>` 로만 한다.", "- 멤버는 `git -C <경로> …` 나 경로 인자로 읽는다. 상태는 `git --no-optional-locks -C <경로> status` 로 본다.", "- 한 줄에 `cd <멤버>` 와 다른 명령을 섞지 않는다. `cd`·`git -C`·`--prefix` 에는 리터럴 경로를 쓴다(변수·치환 금지)."]);
});
