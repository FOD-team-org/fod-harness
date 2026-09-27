import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureWorkspace, invokeWorkspace } from './w3a-helpers.ts';
import { invoke } from './hook-helpers.ts';
import { approvalForms } from '../hooks/approval-normalize.mjs';
import { shellCommands } from '../hooks/shell-commands.mjs';
const db = ['npm --prefix ../chemical run db:migrate', 'npm run-script db:migrate', 'npm exec -- drizzle-kit push', 'pnpm db:migrate', 'npm run db:studio',
  'npm --prefix=../chemical run db:migrate', 'npm -C ../chemical run db:migrate', 'npm --silent run db:migrate', 'npm run --if-present db:migrate',
  'npm rum db:migrate', 'npm urn db:migrate', 'npm -w web run db:migrate', 'npm run db:migrate --prefix ../chemical',
  'npm x drizzle-kit migrate', 'npx -c "npm run db:migrate"', 'npm exec -c "npm run db:migrate"', 'pnpm -C ../chemical db:migrate',
  'pnpm --filter web run db:migrate', 'pnpm exec drizzle-kit push', 'yarn --cwd ../chemical db:migrate', 'yarn run db:migrate',
  'yarn workspace web db:migrate', 'bun run db:migrate', 'bun --cwd ../chemical run db:migrate', 'node --run db:migrate', 'node --run=db:migrate',
  'pnpm --workspace-concurrency 2 db:migrate', 'yarn --mutex network db:migrate', 'npm run db:migrate', 'cd ../chemical && npm run db:migrate'];
it('all member approval rules apply at root and member cwd; builtin order wins', async () => {
  const f = await fixtureWorkspace();
  const cases = [...db.map(c => [c, 'web-db']), ['tsx scripts/seed-x.mts', 'web-scripts'], ['node --import tsx scripts/smoke-prod-auth.mts', 'web-scripts'], ['node dist/modules/maintenance/cli/purge.js', 'be-maintenance'], ['npm exec -- prisma migrate deploy', 'prod-migration']];
  for (const cwd of ['@root@', '@base@/chemical']) for (const [command, id] of cases) expect(await invokeWorkspace('Bash', { command }, { fixture: f, cwd }), command + ' ' + cwd).toEqual({ code: 2, stderr: `하네스 가드[승인]: 승인 필수 동작(${id})입니다. 판단대기 항목을 만들어라.\n` });
  expect((await invokeWorkspace('Bash', { command: 'npm run db:migrate' }, { fixture: f, brain: false })).stderr).toContain('승인 필수 동작(web-db)');
  expect((await invokeWorkspace('Bash', { command: 'npm run db:migrate' }, { fixture: f, config: { ...f.config, approvalRules: [{ id: 'top-migrate', pattern: '^npm run db:migrate\\b' }] } })).stderr).toContain('승인 필수 동작(top-migrate)');
}, 30000);
it('unrelated commands and fodh descriptions retain their decisions', async () => {
  const f = await fixtureWorkspace();
  for (const command of ['npm run lint', 'pnpm install', 'npm ls', 'echo npm run db:migrate', 'npm run db:generate', 'yarn add drizzle-kit', 'fodh judgment add --title q --background "npm run db:migrate 필요"']) expect(await invokeWorkspace('Bash', { command }, { fixture: f }), command).toEqual({ code: 0, stderr: '' });
});
it('single repository approval normalization and bounded raw call forms', async () => {
  for (const command of ['npm --prefix sub run db:migrate', 'npm run-script db:migrate', 'npx -c "npm run db:migrate"']) expect((await invoke('Bash', { command }, 'IMPLEMENT', { homeLayout: 'outside', env: { FODH_BRAIN: '1' }, setup: root => writeFile(join(root, '.pi/harness.json'), JSON.stringify({ approvalRules: [{ id: 'db-migrate', pattern: '^npm run db:(?:migrate|push)\\b|^drizzle-kit (?:migrate|push)\\b' }] })) })).stderr).toContain('승인 필수 동작(db-migrate)');
  expect((await invoke('Bash', { command: 'npm exec -- prisma migrate deploy' })).stderr).toContain('승인 필수 동작(prod-migration)');
  for (const command of ['npx --call="npm run db:migrate"', 'bunx --call="npm run db:migrate"', 'npm x --call="npm run db:migrate"']) {
    const forms = approvalForms(shellCommands(command).entries[0].words);
    expect(forms.map(f => f.join(' '))).toContain('npm run db:migrate'); expect(forms.length).toBeLessThanOrEqual(32);
  }
  const forms = approvalForms(['npx', '-c', '"unterminated/path']);
  expect(forms.some(f => f.raw && f[0] === '"unterminated/path')).toBe(true);
});
