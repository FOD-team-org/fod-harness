import { expect, it } from 'vitest';
import { fixtureWorkspace } from './w3a-helpers.ts';
import { single, now } from './w3b-helpers.ts';
import { loadConfig } from '../src/core/config.ts';
import { autopilotBlocked, autopilotEligible, autopilotOn } from '../src/core/autopilot.ts';
import { addJudgment, readJudgment, type JudgmentItem } from '../src/core/judgment.ts';
const plain: JudgmentItem = { id: 'A1', rev: 1, title: '방법 선택', background: '화면 비교', options: ['진행', '보류'], recommend: '① 진행', blocks: '-', answer: '', raw: '', start: 0, end: 0 };
async function setup() {
  const f = await fixtureWorkspace(), base = await loadConfig(f.root, {});
  f.repos.web.approvalRules!.push({ id: 'web-seed-desc', pattern: '^never-matches-w5$', description: '데모 시드' });
  f.repos.app.approvalRules = [{ id: 'app-ipa', pattern: '^flutter build ipa\\b' }];
  return { ...f, base, config: { ...base, workspace: { repos: f.repos } } };
}
it.each([
  ['W1', '`npm --prefix ../chemical run seed:demo`', true],
  ['W2', '`npm run seed:demo`', true],
  ['W3', '`node dist/modules/maintenance/cli/purge.js`', true],
  ['W4', '`flutter build ipa`', true],
  ['W5', '데모 시드 데이터를 넣을지 정한다', true],
  ['W7 lint', '`npm run lint`', false],
  ['W7 git', '`git -C ../chemical log --oneline`', false],
  ['W8', '`fodh backlog add --title "npm run seed:demo" --category docs --repo web`', false],
  ['W8 scripts', '`fodh backlog add --title "scripts/seed-demo.ts" --repo web`', false],
  ['W9', '`npm run "seed:demo`', true],
] as const)('%s member approval outcome, with clean prose baseline', async (_name, span, blocked) => {
  const { config, base } = await setup();
  const item = { ...plain, background: `화면 비교 ${span}` };
  expect(autopilotBlocked(plain, config)).toBe(false);
  expect(autopilotBlocked(plain, base)).toBe(false);
  expect(autopilotBlocked(item, base)).toBe(false);
  expect(autopilotBlocked(item, config)).toBe(blocked);
});
it('W6 unlisted top-level rule blocks only workspace', async () => {
  const { config, base } = await setup(); const rules = [{ id: 'bundle', pattern: '^make bundle\\b' }];
  expect(base.requiresApproval).not.toContain('bundle');
  const item = { ...plain, background: '방법으로 `make bundle` 검토' };
  expect(autopilotBlocked(plain, { ...base, approvalRules: rules })).toBe(false);
  expect(autopilotBlocked(plain, { ...config, approvalRules: rules })).toBe(false);
  expect(autopilotBlocked(item, { ...base, approvalRules: rules })).toBe(false);
  expect(autopilotBlocked(item, { ...config, approvalRules: rules })).toBe(true);
});
it('W10 brain origin and enabled autopilot reject normalized code, admit same plain judgment', async () => {
  const { config } = await setup(), { root } = await single();
  await addJudgment(root, { title: plain.title, background: plain.background, options: plain.options, recommend: plain.recommend, blocks: '-', origin: { kind: 'brain' } });
  const item = (await readJudgment(root)).items[0], auto = await autopilotOn(root, { now: new Date(now) });
  expect(autopilotEligible(item, config, auto, new Date(now))).toEqual({ ok: true, option: 1 });
  expect(autopilotEligible({ ...item, background: item.background + ' `npm --prefix ../chemical run seed:demo`' }, config, auto, new Date(now))).toEqual({ ok: false, reason: '승인 필요' });
});
it('W11 malformed member regex is a non-match', async () => {
  const { config, base } = await setup(); config.workspace.repos.app.approvalRules = [{ id: 'bad-rule', pattern: '[' }];
  expect(autopilotBlocked(plain, config)).toBe(false);
  expect(autopilotBlocked({ ...plain, background: '방법으로 `npm run lint` 검토' }, config)).toBe(false);
  expect(autopilotBlocked(plain, base)).toBe(false);
  expect(autopilotBlocked({ ...plain, background: '방법으로 `npm run lint` 검토' }, base)).toBe(false);
});
it('normalized spans are considered in every field; description matching ignores case', async () => {
  const { config } = await setup();
  for (const field of ['title', 'background', 'recommend', 'detail'] as const) {
    expect(autopilotBlocked({ ...plain, [field]: '방법으로 `npm run seed:demo` 검토' }, config)).toBe(true);
  }
  expect(autopilotBlocked({ ...plain, options: ['`npm run seed:demo`', '보류'] }, config)).toBe(true);
  config.workspace.repos.app.approvalRules = [{ id: 'description-only', pattern: '^never$', description: 'Demo Sample' }];
  expect(autopilotBlocked({ ...plain, detail: 'demo sample 검토' }, config)).toBe(true);
});

it('L-1 stray backtick in a different field cannot hide a valid command span', async () => {
  const { config, base } = await setup();
  const item = { ...plain, title: '방법 ` 선택', background: '화면 비교 `npm run seed:demo`' };
  expect(autopilotBlocked(item, base)).toBe(false);
  expect(autopilotBlocked(item, config)).toBe(true);
});
