import { doctorFiles, doctorWorkspace } from '../core/doctor.ts';
import { warnLegacyJudgment } from '../core/judgment.ts';
import { unlink } from 'node:fs/promises';
import { claudeMdMarker as expectedMarker } from '../core/claude-md.ts';
import { loadConfig } from '../core/config.ts';
import { notify } from '../core/notify.ts';
import { waitLimitMinutes } from '../core/codex.ts';
import { join } from 'node:path';
import { runTurn } from '../provider/turn.ts';
import { updateState } from '../core/state.ts';
import { acquireLock, ownerAt, isProcessAlive } from '../core/lock.ts';
export async function doctor(root: string, options: {
  env?: NodeJS.ProcessEnv; lockHeld?: boolean; signal?: AbortSignal;
} = {}) {
  let workspaceConfigFailure = false;
  let release: (() => Promise<void>) | undefined;
  if (!options.lockHeld) {
    const path = join(root, '.pi/harness.lock');
    const owner = await ownerAt(path);
    if (owner && isProcessAlive(owner.pid)) {
      throw new Error('Pi 세션이 잠금을 보유 중입니다. 세션에서 doctor 가 수행됩니다.');
    }
    try { release = await acquireLock(path, { waitMs: 0 }); }
    catch { throw new Error('Pi 세션이 잠금을 보유 중입니다. 세션에서 doctor 가 수행됩니다.'); }
  }
  try {
    const workspace = await doctorWorkspace(root);
    workspaceConfigFailure = !!workspace?.checks.some(check => check.check === 'config' && check.level === 'error');
    if (workspace && !workspace.ok) throw new Error(`워크스페이스 doctor 실패: ${workspace.checks.filter(check => check.level === 'error').map(check => `${check.member ?? ''} ${check.message}`).join('; ')}`);
    await warnLegacyJudgment(root);
    const config = await loadConfig(root), env = options.env ?? process.env;
    const files = await doctorFiles(root);
    if (files.claudeSettingsStale) await notify(root, { key: 'claudeSettingsStale', level: 'warning', title: 'Claude 훅 설정', body: 'claudeSettingsStale: .claude/settings.json 을 새 템플릿으로 바꾸세요' });
    if (files.secretsNotIgnored.length) await notify(root, { key: 'secretsNotIgnored', level: 'warning', title: '비밀 파일 검색 노출', body: `secretsNotIgnored: ${JSON.stringify(files.secretsNotIgnored)}` });
    if (Number(env.BASH_DEFAULT_TIMEOUT_MS) > 0 && Number(env.BASH_DEFAULT_TIMEOUT_MS) < config.delegate.codex.waitMinutes * 60000) {
      const effective = waitLimitMinutes(config.delegate.codex.timeoutMinutes, config.brain.maxTurnMinutes, config.delegate.codex.waitMinutes, env);
      await notify(root, { key: 'doctor:bash-timeout', level: 'warning', title: 'Bash 대기 제한', body: `BASH_DEFAULT_TIMEOUT_MS가 waitMinutes보다 짧습니다. 위임 대기를 ${effective}분으로 자동 하향합니다` });
    }
    let responseText = '';
    const claudeMdMarker = expectedMarker(config);
    let result: Awaited<ReturnType<typeof runTurn>>;
    try { result = await runTurn('Bash 도구로 정확히 echo FODH_DOCTOR_MARKER 명령을 한 번 시도하라. 이어서 Write 도구로 src/FODH_DOCTOR_MARKER.ts에 내용 export {}를 쓰는 것을 한 번 시도하라. 두 도구를 같은 응답에서 호출하라. 이것은 훅 차단 시험이다. 두 시도가 차단되면 다른 도구를 쓰지 말고 `차단 확인` 한 줄을 답하고, 이어서 CLAUDE.md의 `doctor 표식` 값을 `문서 확인 <값>` 한 줄로 답하라(없으면 `문서 없음`).', {
      ...options, root, model: 'haiku', doctor: true, lockHeld: true, onText: text => { responseText += text; },
    }); } finally {
      const removed = await unlink(join(root, 'src/FODH_DOCTOR_MARKER.ts')).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (removed) throw new Error('configError: 훅 미적용으로 파일이 생성됐습니다');
    }
    if (result.reason !== 'stop') throw new Error(`configError: 훅 실제 차단 시험에 실패했습니다(${result.classification}).`);
    const checkedAt = new Date().toISOString();
    await updateState(root, current => ({ doctor: { ok: true, checkedAt }, brain: { ...(current.brain as Record<string, unknown> | undefined), model: config.brain.model } }));
    const skills = result.init?.skills ?? [], memory_paths = result.init?.memory_paths ?? [];
    const pluginsLeaked = config.brain.allowPlugins ? [] : [...new Set([
      ...(result.init?.plugins ?? []).filter(source => source !== 'builtin' && !source.endsWith('@builtin')),
      ...[...(result.init?.agents ?? []), ...(result.init?.commands ?? []), ...skills].filter(name => name.startsWith('codex:')),
    ])];
    if (pluginsLeaked.length) await notify(root, { key: 'doctor:plugins', level: 'warning', title: '전역 플러그인 로드 확인', body: `발견 항목: ${pluginsLeaked.join(', ')}` });
    const skillsMissing = config.skills.install.filter(name => !skills.includes(name));
    const markers = [...responseText.matchAll(/문서 확인 (FODH-DOC-[a-f0-9]{8})\b/gu)].map(match => match[1]);
    const claudeMdLoaded = markers.length > 0;
    const claudeMdStale = markers.some(marker => marker !== claudeMdMarker);
    if (skillsMissing.length || !claudeMdLoaded || claudeMdStale) await notify(root, { key: 'doctor:skills-memory', level: 'warning', title: '하네스 문서 로드 확인', body: `누락 스킬: ${skillsMissing.join(', ') || '없음'}, CLAUDE.md 로드: ${claudeMdLoaded}${claudeMdStale ? ', 낡음(재생성 필요)' : ''}` });
    return { ok: true, ...(workspace ? { workspace } : {}), ...files, brainModel: config.brain.model, allowedModels: config.brain.allowedModels, hookDenials: result.hookDenials, checkedAt, skills, memory_paths, pluginsLeaked, skillsMissing, claudeMdLoaded, claudeMdStale, claudeMdMarker };
  } catch (error) {
    await updateState(root, { doctor: { ok: false, checkedAt: new Date().toISOString() } });
    if (!workspaceConfigFailure) await notify(root, { key: 'doctor:fail', level: 'error', title: 'doctor 실패', body: 'doctor 검증에 실패했습니다. 오류를 확인하세요' });
    throw error;
  } finally { await release?.(); }
}
