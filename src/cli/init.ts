import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { claudeHookStatus, hookMergeGuidance } from '../core/claude-settings.ts';
import { globalProjectLocation, projectFolderHint, assertMainWorktree } from './project-root.ts';
import { assertNotBrain } from '../core/brain-guard.ts';
import { brainModels, loadConfig } from '../core/config.ts';
import { installSkills } from '../core/skills.ts';
import { generateClaudeMd } from '../core/claude-md.ts';
import { readJudgment } from '../core/judgment.ts';
import { harnessIgnores } from '../core/project-init.ts';
import { projectPath } from '../core/template-values.ts';

const execute = promisify(execFile);
const exists = (path: string) => lstat(path).then(() => true, () => false);
async function git(root: string, args: string[]) {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
}
export async function initProject(options: { cwd?: string; brain?: string; dryRun?: boolean } = {}) {
  const cwd = await realpath(options.cwd ?? process.cwd());
  if (await globalProjectLocation(cwd)) throw new Error(projectFolderHint);
  if (process.env.FODH_CODEX_CHILD) throw new Error('Codex 위임 안에서는 fodh 를 실행할 수 없습니다');
  await assertNotBrain(cwd, 'fodh init');
  let root = cwd, newRepository = false;
  try { root = await realpath(await git(cwd, ['rev-parse', '--show-toplevel'])); }
  catch (error) {
    // Do not turn arbitrary git failures (missing binary, broken metadata) into initialization.
    if (!/not a git repository/iu.test(String((error as { stderr?: string }).stderr))) throw new Error('Git 저장소를 확인하지 못했습니다. git 설치·저장소 접근 권한을 확인하세요');
    newRepository = true;
  }
  if (await globalProjectLocation(root)) throw new Error(projectFolderHint);
  await assertMainWorktree(root);
  await assertNotBrain(root, 'fodh init');
  const config = await loadConfig(root, undefined, { dryRun: true });
  if (options.brain !== undefined && !['opus', 'fable'].includes(options.brain)) throw new Error('--brain 은 opus 또는 fable 이어야 합니다 (brain.allowedModels 검사)');
  const { model } = brainModels({ brain: { ...config.brain, model: options.brain ?? config.brain.model } });
  const created: string[] = [], existed: string[] = [], skipped: { path: string; reason: string }[] = [];
  const existingCode = (await readdir(root)).some(name => !['.git', '.pi', '.claude', '.DS_Store', 'CLAUDE.md', 'AGENTS.md', 'docs'].includes(name));
  const nextSteps = [existingCode ? 'docs/backlog.md 를 채운 뒤 /develop-start 를 실행하세요' : '/project-start 를 실행하세요'];
  const result = { root, dryRun: !!options.dryRun, created, existed, skipped, settingsNeedsHook: false,
    gitInitialized: false, committed: false, nextSteps };
  if (newRepository) {
    if (!options.dryRun) {
      try { await git(root, ['init']); result.gitInitialized = true; }
      catch { throw new Error('git init 실패: git 설치·디렉터리 권한을 확인하세요'); }
    }
    created.push('.git');
  }
  async function create(name: string, action: (path: string) => Promise<unknown>) {
    const path = await projectPath(root, name);
    if (await exists(path)) { existed.push(name); return false; }
    created.push(name);
    if (!options.dryRun) { await mkdir(dirname(path), { recursive: true }); await action(path); }
    return true;
  }
  await create('.pi/harness.json', path => writeFile(path, JSON.stringify({ brain: { model: options.brain ?? model } }, null, 2) + '\n', { flag: 'wx' }));
  const settingsCreated = await create('.claude/settings.json', async path =>
    writeFile(path, await readFile(new URL('../../templates/claude-settings.json', import.meta.url)), { flag: 'wx' }));
  if (!settingsCreated) {
    result.settingsNeedsHook = (await claudeHookStatus(root)).settingsNeedsHook;
    if (result.settingsNeedsHook) nextSteps.push((await hookMergeGuidance()).reason);
  }
  for (const name of config.skills.install) {
    const path = join(config.skills.target, name);
    (await exists(await projectPath(root, path)) ? existed : created).push(path);
  }
  if (!options.dryRun) {
    const skills = await installSkills(root, { onlyMissing: true });
    for (const name of skills.conflicts) skipped.push({ path: join(config.skills.target, name), reason: '기존 스킬 경로를 보존했습니다' });
  }
  for (const name of config.claudeMd.targets) (await exists(await projectPath(root, name)) ? existed : created).push(name);
  if (!options.dryRun) await generateClaudeMd(root, { onlyMissing: true });
  await create(config.judgment.file, () => readJudgment(root));

  const excludeName = '.git/info/exclude';
  const patterns = [...harnessIgnores, ...(settingsCreated ? ['.claude/settings.json'] : []),
    ...config.skills.install.map(name => `${config.skills.target}/${name}/`)];
  if (newRepository && options.dryRun) created.push(excludeName);
  else {
    const path = resolve(root, await git(root, ['rev-parse', '--git-path', 'info/exclude']));
    const old = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const lines = new Set(old.split(/\r?\n/u)), missing = patterns.filter(line => !lines.has(line));
    if (missing.length) {
      created.push(excludeName);
      if (!options.dryRun) {
        await mkdir(dirname(path), { recursive: true });
        const newline = old.includes('\r\n') ? '\r\n' : '\n';
        await writeFile(path, old + (old && !old.endsWith('\n') ? newline : '') + missing.join(newline) + newline);
      }
    } else existed.push(excludeName);
  }
  // Check all refs: an unborn branch in a repository with history is not a new repository.
  const hasCommits = !newRepository && !!(await git(root, ['rev-list', '--all', '--max-count=1']));
  if (hasCommits) skipped.push({ path: 'commit', reason: '커밋이 있는 저장소이므로 자동 커밋하지 않습니다' });
  else if (options.dryRun) nextSteps.push('커밋이 없는 저장소: 하네스 설정 3개 파일로 첫 커밋 예정 (저장소 신원·훅 사용)');
  else {
    const files = ['.pi/harness.json', config.judgment.file, 'CLAUDE.md'];
    try {
      await git(root, ['add', '--', ...files]);
      // --only keeps unrelated user-staged paths out of the initial commit.
      await git(root, ['commit', '--only', '-m', 'chore(harness): fod-harness 설정', '--', ...files]);
      result.committed = true;
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      const reason = /identity unknown|unable to auto-detect|empty ident|no email|no name/iu.test(stderr)
        ? 'Git 신원이 없어 첫 커밋을 건너뛰었습니다. 저장소 user.name·user.email 을 설정하고 fodh init 을 다시 실행하세요'
        : '첫 커밋 실패: Git 훅·서명·ignore 규칙·저장소 권한을 확인하고 fodh init 을 다시 실행하세요';
      // Never relay arbitrary hook output: it can contain secret values.
      skipped.push({ path: 'commit', reason }); nextSteps.push('생성한 파일은 보존했습니다. 첫 커밋이 있어야 워크트리·병합을 사용할 수 있습니다');
    }
  }
  return result;
}
