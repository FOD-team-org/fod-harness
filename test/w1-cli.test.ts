import { expect, it } from 'vitest';
import { cli } from './p5-helpers.ts';
import { fixture } from './w1-helpers.ts';
it.each([
  ['backlog', 'list', '--repo', 'web'], ['backlog', 'sync', '--repo', 'web'],
  ['state', 'get', '--repo', 'web'], ['workspace', 'list', '--repo', 'web'],
  ['workspace', 'add', 'web', '../web', '--repo', 'web'], ['start', '--dry-run', '--repo', 'web'],
  ['backlog', 'add', '--identity', 'User <user@example.invalid>'],
  ['backlog', 'set', 'T01', '--identity', 'User <user@example.invalid>'],
  ['workspace', 'list', '--identity', 'User <user@example.invalid>'], ['init', '--identity', 'User <user@example.invalid>'],
])('해당 명령 밖의 새 옵션은 CLI 오류: %j', async (...args) => {
  const f = await fixture(['web']), result = await cli(f.root, args);
  expect(result.code).toBe(1); expect(result.value.error).toContain('Unknown option');
  expect(result.value.error).toContain('사용법: fodh');
});
it('workspace add 도움말은 경로 기준을 표시한다', async () => {
  const f = await fixture(['web']);
  expect((await cli(f.root, ['workspace', 'add', '--help'])).value.help[0].summary).toContain('경로는 워크스페이스 루트 기준');
});
