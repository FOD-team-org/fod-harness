import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateClaudeMd } from '../src/core/claude-md.ts';
import { fixture, writeConfig } from './w1-helpers.ts';
it('한 레포 CLAUDE.md는 W1 전 HEAD 생성 결과와 바이트 동일·check 변경 없음', async () => {
  const f = await fixture(['web']); await writeConfig(f.root, {});
  await writeFile(join(f.root, '.pi/harness-state.json'), JSON.stringify({ state: 'IDLE', projectName: 'W1 single repository' }));
  // HEAD 6bfa751 출력 + W3b I1
  const baseline = await readFile(new URL('./w1-single-claude-md.fixture.md', import.meta.url));
  await generateClaudeMd(f.root);
  expect(await readFile(join(f.root, 'CLAUDE.md'))).toEqual(baseline);
  await writeFile(join(f.root, 'CLAUDE.md'), baseline);
  expect(await generateClaudeMd(f.root, { check: true })).toEqual({ upToDate: true });
  expect(await generateClaudeMd(f.root)).toEqual({ files: [{ path: 'CLAUDE.md', changed: false }] });
});
it('워크스페이스 CLAUDE.md는 workspace list만 포함한다', async () => {
  const f = await fixture(); await writeConfig(f.root, f.candidate); await generateClaudeMd(f.root);
  const text = await readFile(join(f.root, 'CLAUDE.md'), 'utf8');
  expect(text.split('\n').filter(line => line.startsWith('- fodh workspace'))).toEqual(['- fodh workspace list']);
});
