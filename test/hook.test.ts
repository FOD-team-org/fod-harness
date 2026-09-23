import { it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const roots: string[] = [];
async function invoke(tool_name: string, tool_input: unknown, state = 'IMPLEMENT') {
  const root = await mkdtemp('/private/tmp/fodh-hook-'); roots.push(root); await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi/harness-state.json'), JSON.stringify({ state }));
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult, reject) => {
    const child = spawn(resolve('hooks/pretooluse.sh'), [], { cwd: root, stdio: ['pipe','pipe','pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject); child.once('close', code => resolveResult({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify({ cwd: root, tool_name, tool_input }));
  });
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(['codex exec task', '/usr/local/bin/codex exec task', 'env FOO=x codex exec task'])('codex 직접 실행 차단: %s', async command => {
  expect(await invoke('Bash', { command })).toMatchObject({ code: 2, stderr: expect.stringContaining('fodh codex'), stdout: '' });
});
it.each(['.claude/settings.json','hooks/pretooluse.sh','.pi/harness-state.json','.pi/harness-ledger.jsonl'])('가드 편집 차단: %s', async file_path => {
  expect((await invoke('Edit', { file_path, old_string: '', new_string: '변경' })).code).toBe(2);
});
it.each(['echo changed > .claude/settings.json', 'tee .pi/harness-state.json', 'cp other hooks/pretooluse.sh', 'sed -i x .claude/settings.json'])('Bash 자기 수정 차단: %s', async command => {
  expect((await invoke('Bash', { command })).code).toBe(2);
});
it.each(['sk-ant-', 'AKIA', '-----BEGIN RSA PRIVATE KEY-----'])('실제 자격증명 없는 비밀값 접두 패턴 차단', async content => {
  const result = await invoke('Write', { file_path: 'docs/test.md', content });
  expect(result.code).toBe(2); expect(result.stderr).not.toContain(content);
});
it.each(['commit -m test','push origin feature','merge feature'])('IMPLEMENT git %s 거부, MERGE 허용', async command => {
  expect((await invoke('Bash', { command: `git ${command}` })).code).toBe(2);
  expect((await invoke('Bash', { command: `git ${command}` }, 'MERGE')).code).toBe(0);
});
it.each(['git push origin main','git push --force origin branch','echo FODH_DOCTOR_MARKER','fastlane pilot upload'])('MERGE에서도 승인 필수 차단: %s', async command => {
  expect(await invoke('Bash', { command }, 'MERGE')).toMatchObject({ code: 2, stderr: expect.stringContaining('판단대기') });
});
it.each(['ls','fodh codex task T01','cat .claude/settings.json'])('일반·fodh·읽기 명령 허용: %s', async command => {
  expect((await invoke('Bash', { command })).code).toBe(0);
});
