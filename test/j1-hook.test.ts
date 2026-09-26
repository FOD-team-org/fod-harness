import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invoke } from './hook-helpers.ts';
const commands = [
  'echo x >> docs/판단기록/2026-09.md', 'cp note.md docs/판단기록/', 'rm docs/판단기록/*',
  'tar -xf a.tar -C docs/판단기록', `python3 -c "open('docs/판단기록/x.md','w')"`,
  "sed -i '' s/a/b/ docs/판단기록/2026-09.md",
];
for (const homeLayout of ['outside', 'inside'] as const) {
  const setup = async (root: string) => {
    await mkdir(join(root, 'docs/판단기록'), { recursive: true });
    await writeFile(join(root, 'docs/판단기록/2026-09.md'), 'A19');
  };
  it.each(['Write', 'Edit'])('J1 %s 판단기록 두뇌만 차단 ' + homeLayout, async tool => {
    for (const brain of [false, true]) {
      const result = await invoke(tool, { file_path: 'docs/판단기록/2026-09.md', content: 'x' }, 'IMPLEMENT', { homeLayout, setup, env: brain ? { FODH_BRAIN: '1' } : {} });
      expect(result.code).toBe(brain ? 2 : 0); if (brain) expect(result.stderr).toContain('가드[경계]: 판단대기');
    }
  });
  it.each(commands)('J1 ' + homeLayout + ' 쓰기 %s', async command => {
    for (const brain of [false, true]) {
      const result = await invoke('Bash', { command }, 'IMPLEMENT', { homeLayout, setup, env: brain ? { FODH_BRAIN: '1' } : {} });
      expect(result.code, result.stderr).toBe(brain ? 2 : 0); if (brain) expect(result.stderr).toContain('가드[경계]: 판단대기');
    }
  });
  it.each(['cat docs/판단기록/2026-09.md', 'grep -r A19 docs/판단기록'])('J1 ' + homeLayout + ' 읽기 %s', async command => {
    for (const brain of [false, true]) expect((await invoke('Bash', { command }, 'IMPLEMENT', { homeLayout, setup, env: brain ? { FODH_BRAIN: '1' } : {} })).code).toBe(0);
  });
  it('J1 ' + homeLayout + ' 사용자 archive와 X1 동적 경로 단서', async () => {
    const custom = async (root: string) => {
      await writeFile(join(root, '.pi/harness.json'), JSON.stringify({ judgment: { archive: 'records/decisions' } }));
      await mkdir(join(root, 'records/decisions'), { recursive: true });
      await writeFile(join(root, 'records/decisions/a.md'), '기록');
    };
    for (const command of ['echo x > records/decisions/a.md', 'rm records/decisions/*', 'rm records/decisions/$F.md']) {
      const result = await invoke('Bash', { command }, 'IMPLEMENT', { homeLayout, setup: custom, env: { FODH_BRAIN: '1' } });
      expect(result.code).toBe(2); expect(result.stderr).toContain('가드[경계]: 판단대기');
      expect((await invoke('Bash', { command }, 'IMPLEMENT', { homeLayout, setup: custom })).code).toBe(0);
    }
    expect((await invoke('Bash', { command: 'rm docs/$F.md' }, 'IMPLEMENT', { homeLayout, setup: custom, env: { FODH_BRAIN: '1' } })).code).toBe(0);
  });
}
