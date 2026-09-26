import { redact } from '../provider/privacy.ts';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { commandTable } from '../cli/commands.ts';
import { loadConfig, type HarnessConfig } from './config.ts';
import { readState } from './state.ts';
import { skillsStatus } from './skills.ts';
import { atomicWrite, harnessPath, readText, withFileLock } from './storage.ts';
import { projectPath } from './template-values.ts';
const begin = '<!-- fodh:managed:begin v1 -->', end = '<!-- fodh:managed:end -->';
const approvals = [
  '프로덕션 DB 마이그레이션', '프로덕션 데이터 삭제·이관', '스토어 업로드·심사 제출·답변', '결제·광고·구독 설정 변경',
  'main 직접 push', 'push --force·브랜치·태그 삭제', '환경변수 삭제·비밀값 생성·회전', '프로젝트 밖 파일 삭제·대량 삭제(100+)',
  '유료 결제·플랜 변경·유료 리소스 생성', '도메인·DNS·인증서', '외부 발송(이메일·Slack 게시·SNS·고객 답변)',
  '프로덕션 배포(프로젝트별 해제 가능)', '사용자 계정 생성·삭제·권한', '약관 문안', '개인정보 문안', '시스템 설정(launchd·키체인·셸 프로필)',
];
function replaceBlock(text: string, block: string) {
  const starts = [...text.matchAll(/<!-- fodh:managed:begin\b[^>]*-->/gu)], ends = [...text.matchAll(/<!-- fodh:managed:end -->/gu)];
  if (starts.length !== ends.length || starts.length > 1 || starts.length === 1 && (starts[0][0] !== begin || starts[0].index! > ends[0].index!)) {
    throw new Error(`관리 블록 표지가 올바르지 않습니다(시작 ${starts.length}개, 끝 ${ends.length}개). 직접 고친 뒤 다시 실행하세요`);
  }
  if (!starts.length) return text + (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
  return text.slice(0, starts[0].index) + block + text.slice(ends[0].index! + end.length);
}
// Hash only configuration rendered by this block; operational timeouts are excluded.
export function claudeMdHash(config: HarnessConfig): string {
  const visible = { verify: { commands: config.verify.commands.map(redact), heavy: config.verify.heavy.map(redact) },
    requiresApproval: config.requiresApproval, docsRoot: config.docs.root, judgmentFile: config.judgment.file, judgmentArchive: config.judgment.archive,
    route: config.delegate.route, claudeModel: config.delegate.claude.subagentModel,
    workerModel: config.delegate.codex.workerModel, enforce: config.interview.enforce };
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 8);
}
export const claudeMdMarker = (config: HarnessConfig): string => `FODH-DOC-${claudeMdHash(config)}`;
export async function generateClaudeMd(root: string, options: { check?: boolean; legacyWorklogOnly?: boolean } = {}) {
  const generate = async () => {
    const config = await loadConfig(root), state = await readState(root), status = await skillsStatus(root);
    const installed = [...status.updated, ...status.unchanged].sort();
    const digest = claudeMdHash(config);
    const verification = `## 검증\n일반 명령: ${JSON.stringify(config.verify.commands.map(redact))}\nheavy 명령: ${JSON.stringify(config.verify.heavy.map(redact))} — VERIFY의 \`fodh verify run --heavy\` 로만 실행.\n`;
    const restrictions = `## 금지·승인 필수\n설정 requiresApproval: ${config.requiresApproval.join(', ')}\n${approvals.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n전체 테스트는 VERIFY만. codex·git worktree 직접 실행 금지. 비밀값 출력·기록 금지.\n`;
    const docs = `## 문서 위치\n| 폴더 | 내용 |\n|---|---|\n| ${config.judgment.file} | 판단대기: 열린 판단, 사용자만 답 |\n| ${config.judgment.archive}/ | 판단기록: 지난 판단, 하네스만 씀 |\n${['설계', '위임스펙', '검수', '조사', '결정기록'].map(v => `| ${config.docs.root}/${v}/ | ${v} 문서 |`).join('\n')}\nPRD: ${config.docs.root}/PRD.md, 작업일지: ${config.docs.root}/작업일지/YYYY-MM-DD.md\n백로그: docs/backlog.md (고정), 판단대기: ${config.judgment.file}\n`;
    const sections = [
      '하네스 두뇌 세션 전용. 위임 수행자(Codex·Claude Agent)는 위임 프롬프트를 따르고 이 흐름표의 fodh 명령을 치지 않는다.',
      `- doctor 표식: ${claudeMdMarker(config)}`,
      '이 블록은 `fodh claude-md generate` 가 관리합니다. 직접 고치지 마세요. 설정 해시: '+digest,
      `## 역할\n두뇌는 소스 파일을 쓰지 않는다. design → Claude Agent(${config.delegate.claude.subagentModel}), 그 외 → \`fodh codex task\`(${config.delegate.codex.workerModel}). 인터뷰 가드: ${config.interview.enforce}.\n| 분류 | 수행자 |\n|---|---|\n${Object.entries(config.delegate.route).map(([k,v]) => `| ${k} | ${v} |`).join('\n')}`,
      '## 하네스 흐름\n| 상태 | 다음 fodh 명령 |\n|---|---|\n| INTERVIEW | fodh interview next |\n| RESEARCH | fodh docs scaffold research-q |\n| PRD_DRAFT | fodh docs scaffold prd |\n| ARCH | fodh docs scaffold arch |\n| PLANNING | fodh docs scaffold backlog-draft |\n| PICK | fodh pick |\n| SPEC | fodh docs scaffold spec |\n| IMPLEMENT·FIX | fodh codex task |\n| VERIFY | fodh verify run |\n| REVIEW | fodh docs scaffold review |\n| MERGE·DOCS | fodh backlog set |\n| CLEANUP | fodh cleanup run |\n| RECLAIM | fodh reclaim |\n| WAIT_JUDGMENT | fodh judgment apply |\n| recovering | fodh ledger list |\n턴 끝: `대기: 사용자`, `대기: 위임 <runId>`(마지막 비어 있지 않은 3줄 안), 마지막 줄 `상태: …`. 멈춤 상태에서는 조건 해소 전 새 작업을 시작하지 않는다.',
      '## 쓸 수 있는 fodh 명령\n'+commandTable.filter(c => !(c.group === 'config' && c.action === 'set' || c.group === 'memory' && c.action === 'reset' || c.group === 'judgment' && c.action === 'migrate')).map(c => `- fodh ${c.group}${c.action ? ' '+c.action : ''}`).join('\n'),
      '## 백로그\n분류: design, non-design, docs, research. 상태: ready, doing, verify, review, fix, merge, done, blocked(A번호).\nDoD 6항: verify.ok, review.high=0, review.commit, merge.commit, docs.ok, cleanup.ok. 상태·증거는 CLI로만 쓴다.',
      verification, restrictions, docs,
      '## 설치된 하네스 스킬\n'+(installed.join(', ') || '없음'),
    ];
    const planned = [];
    for (const name of config.claudeMd.targets) {
      const path = await projectPath(root, name), old = await readText(path, '\0missing');
      if (options.legacyWorklogOnly && !old.match(/<!-- fodh:managed:begin\b[^>]*-->[\s\S]*?<!-- fodh:managed:end -->/u)?.[0].includes('작업일지.md')) continue;
      const body = name === 'AGENTS.md' ? [verification, restrictions, docs, '`fodh` 를 실행하지 않는다, git 을 쓰지 않는다.'].join('\n') : sections.join('\n\n');
      const block = begin+'\n'+body+'\n'+end;
      const projectName = typeof state.projectName === 'string' && state.projectName ? state.projectName : basename(root);
      const next = old === '\0missing' ? `# ${projectName}\n\n${block}\n` : replaceBlock(old, block);
      planned.push({ path: name, absolute: path, changed: old !== next, next });
    }
    // Validate every target before writing any target.
    if (options.check) return { upToDate: planned.every(p => !p.changed) };
    for (const p of planned) if (p.changed) await atomicWrite(p.absolute, p.next);
    return { files: planned.map(({ path, changed }) => ({ path, changed })) };
  };
  if (options.check) return generate();
  return withFileLock(harnessPath(root, 'harness-claude-md'), generate);
}
