import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateClaudeMd, claudeMdMarker } from '../src/core/claude-md.ts';
import { autopilotBlocked } from '../src/core/autopilot.ts';
import { loadConfig, type HarnessConfig } from '../src/core/config.ts';
import type { JudgmentItem } from '../src/core/judgment.ts';
import { fixture, writeConfig } from './w1-helpers.ts';

const goldenFile = new URL('./fixtures/w3b-single-golden.json', import.meta.url);
const files = ['templates/brain-rules.md', 'skills/fodh-workflow/SKILL.md', 'skills/fodh-spec-writing/SKILL.md', 'templates/prompts/MERGE.md'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function I1(text: string): string {
  const flow = '| MERGE·DOCS | fodh backlog set |', command = '- fodh worktree commit\n';
  for (const target of [flow, command]) if (text.split(target).length !== 2) throw new Error('I1 requires exactly one original target');
  if (text.includes('- fodh worktree merge')) throw new Error('I1 requires pre-W3b output');
  return text.replace(flow, '| MERGE | fodh worktree merge |\n| DOCS | fodh backlog set |')
    .replace(command, command + '- fodh worktree merge\n');
}
async function documents(rich: boolean) {
  const f = await fixture(['web']);
  const rule = { id: 'custom-rule', pattern: '특별.*실행', description: '원격 반영' };
  await writeConfig(f.root, rich ? { claudeMd: { targets: ['CLAUDE.md', 'AGENTS.md'] },
    verify: { commands: ['echo "a|b"', 'echo ' + 'sk-' + 'ant-' + 'FAKE_W3B_ONLY'], heavy: ['npm run check-all'] },
    docs: { root: 'notes' }, requiresApproval: ['custom-rule'], approvalRules: [rule, { id: 'bundle', pattern: '^make bundle\\b', description: '묶음 준비' }] } : {});
  await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', projectName: rich ? 'W3b rich repository' : 'W1 single repository' }));
  const config = await loadConfig(f.root);
  await generateClaudeMd(f.root);
  return { claude: await readFile(join(f.root, 'CLAUDE.md'), 'utf8'),
    ...(rich ? { agents: await readFile(join(f.root, 'AGENTS.md'), 'utf8') } : {}), marker: claudeMdMarker(config) };
}
async function approvalCases() {
  const f = await fixture(['web']); await writeConfig(f.root, {});
  const base = await loadConfig(f.root);
  const rule = { id: 'custom-rule', pattern: '^make bundle\\b|특별.*실행', description: '원격 반영' };
  const configs = [base, await loadConfig(f.root, { requiresApproval: [...base.requiresApproval, rule.id], approvalRules: [rule] }),
    await loadConfig(f.root, { approvalRules: [rule] }),
    { ...base, requiresApproval: [...base.requiresApproval, 'bad-rule'], approvalRules: [{ id: 'bad-rule', pattern: '[' }] }];
  const baseItem: JudgmentItem = { id: 'A1', rev: 1, title: '색상 선택', background: '화면 비교', options: ['파랑', '초록'], recommend: '① 파랑', blocks: '-', answer: '', raw: '', start: 0, end: 0 };
  const words = ['배포', 'MIGRATION', 'deploy', '운영', 'PROD', 'release', '출시', '삭제', 'delete', 'DROP', 'revert', 'reset', 'force', 'TAG', 'TOKEN', 'secret', '키', '과금', 'billing', '계정', '권한', 'permission', 'publish', '게시', '공개', '발송', '이메일', 'SMS', 'stage', 'product', 'preset', 'reinforcement', 'tokenizer',
    '`npm --prefix ../chemical run seed:demo`', '`npm run seed:demo`', '`node dist/modules/maintenance/cli/purge.js`', '`flutter build ipa`', '데모 시드 데이터를 넣을지 정한다', '`make bundle`', '`npm run lint`', '`git -C ../chemical log --oneline`', '`fodh backlog add --title "npm run seed:demo" --category docs --repo web`', '`npm run "seed:demo`', '원격 반영', '특별 항목 실행', 'custom-rule'];
  const items = [...words.map(word => ({ ...baseItem, recommend: `① ${word}` })), { ...baseItem, requiresApproval: true }, { ...baseItem, detail: '[문서](deploy.md)' }];
  return configs.flatMap(config => items.map(item => ({ item, config, blocked: autopilotBlocked(item, config) })));
}
interface Golden { claudeMd: { empty: Awaited<ReturnType<typeof documents>>; rich: Awaited<ReturnType<typeof documents>> }; autopilot: { item: JudgmentItem; config: HarnessConfig; blocked: boolean }[]; before: Record<string, string> }
it('frozen single repository bytes and approval decisions (write once before implementation)', async () => {
  if (process.env.FODH_W3B_GOLDEN === 'write') {
    for (const [file, marker] of [['src/core/claude-md.ts', "c.group === 'worktree' && c.action === 'merge'"],
      ['src/core/autopilot.ts', '  return config.requiresApproval.some(name => {'],
      ['templates/prompts/MERGE.md', 'git merge --no-ff <task 브랜치>']]) expect(await readFile(file, 'utf8')).toContain(marker);
    expect(await readFile('src/core/notify.ts', 'utf8')).not.toContain('taskId');
    const golden: Golden = { claudeMd: { empty: await documents(false), rich: await documents(true) }, autopilot: await approvalCases(),
      before: Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')])))};
    expect(sha(golden.claudeMd.empty.claude)).toBe('802d0d0fd3e0a4fd20e4a0b931981927a74749e011762d47d50f2d6b92124193');
    I1(golden.claudeMd.rich.claude);
    await writeFile(goldenFile, JSON.stringify(golden, null, 2) + '\n', { flag: 'wx' });
    return;
  }
  const golden: Golden = JSON.parse(await readFile(goldenFile, 'utf8'));
  expect(sha(golden.claudeMd.empty.claude)).toBe('802d0d0fd3e0a4fd20e4a0b931981927a74749e011762d47d50f2d6b92124193');
  for (const rich of [false, true]) {
    const before = golden.claudeMd[rich ? 'rich' : 'empty'];
    expect(await documents(rich)).toEqual({ ...before, claude: I1(before.claude) });
  }
  expect(await readFile(new URL('./w1-single-claude-md.fixture.md', import.meta.url), 'utf8')).toBe(I1(golden.claudeMd.empty.claude));
  for (const { item, config, blocked } of golden.autopilot) expect(autopilotBlocked(item, config), JSON.stringify([item, config.requiresApproval])).toBe(blocked);
});
