# fod-harness

Pi 기반 개인 하네스 터미널. 설계: docs/설계/, 판단: docs/판단대기.md


## Pi 컴팩션 설정

Pi 0.73.1 설치본 README와 확장 타입으로 확인한 설정 위치는 전역
`~/.pi/agent/settings.json`, 프로젝트 `.pi/settings.json`입니다. 프로젝트 설정이 우선합니다.
Claude Code가 자신의 문맥을 관리하므로 Pi 세션을 시작하기 전에 다음을 설정하세요.

```json
{ "compaction": { "enabled": false } }
```

공개 확장 API에는 자동 컴팩션 설정을 바꾸는 메서드가 없어 세션 시작 시 경고를 표시합니다.
`brain.doctorTtlHours`는 `.pi/harness.json`에서 설정하며 기본 12시간입니다.
`fodh state transition IMPLEMENT|MERGE`는 별도로 최근 12시간 doctor 성공 기록을 요구합니다.
Pi가 잠금을 보유한 동안 `fodh doctor`는 즉시 오류를 반환합니다.


## 모델 배치와 교체

기본 두뇌는 Claude Code **fable**(`claude-fable-5-1`)입니다.
프로바이더 모델 목록은 `fable`, `opus`, `sonnet`, `haiku` 순서이며 doctor는 항상 `haiku`를 사용합니다.

두뇌 모델은 다음 세 가지 방법으로 바꿀 수 있습니다.

1. Pi `/model`에서 `claude-code` 모델을 선택합니다. 선택값은 `brain.model` 설정과 상태에 기록됩니다.
2. `fodh config set brain.model opus`처럼 설정 CLI를 사용합니다.
3. `.pi/harness.json`의 `brain.model`을 직접 편집합니다.

다음 턴에 설정을 다시 읽어 `--model`에 반영하며, 기존 Claude 세션은 `--resume`으로 유지합니다.
`fodh config get`은 기본값을 포함한 설정 전체, `fodh config get brain.model`은 해당 값을 보여줍니다.
`config set`은 값을 JSON으로 파싱하고, JSON이 아니면 문자열로 취급합니다. 검증에 실패하면 저장하지 않습니다.

수행자는 Claude **Opus 5.5**(`delegate.claude.subagentModel=opus`)와 **gpt-6-sol xhigh**(A11 확정),
GPT 두뇌는 **gpt-6-astra xhigh**입니다. Codex 자식 에이전트 기본 상한은 1입니다.
위임 실행과 조회는 아래 P3 `fodh codex` 브리지를 사용합니다.

Claude Code autocompact는 사용자 `~/.claude/settings.json` 설정을 따릅니다
(설계 기준 `autoCompactWindow: 250000`). 하네스는 압축 인자·프로젝트 settings 키를 추가하지 않고,
관련 환경변수도 추가·삭제하지 않습니다. Pi 자동 컴팩션 설정과는 별개입니다.
하네스 보조 회전 임계값 `brain.rotateAtTokens`의 기본값은 0(회전 끔)이며, 이번 단계는 설정 로드·검증까지만 제공합니다.

Codex 수행자 기본값 `gpt-6-sol`은 판단 A11 로 확정되었습니다.

`/status`는 워처의 마지막 tick·판단 해시/안정 시간·정체 시작·초과 자식 수를 표시합니다. `fodh watch tick`은 감지·인박스 기록만 하며 결정하지 않습니다. Pi 워처가 시작 시와 매 tick에 미결정 항목을 재처리합니다. `fodh watch status`는 워처 요약을 조회하며 같은 프로세스의 최신 tick 시각은 메모리 값을 우선합니다.

번호·승인 토큰 답은 기본 10초 안정화 후 자동 적용하고, 자유 서술 답은 `watch.freeTextStableSeconds`(기본 60초) 이상 안정된 뒤 적용합니다. 대기 중 문서를 다시 편집하면 안정화 시간을 다시 셉니다. `/judged`는 수동 즉시 적용 경로입니다.

- `fodh codex task|review|research --spec <파일> [--task T01] [--resume last] [--wait]`: 비동기 위임. `status [runId]`, `result <runId>`, `cancel <runId>`로 조회·회수한다. 완료는 `codex-done` 인박스로 전달된다.
- `fodh worktree create <T> [--base <ref>]`, `remove <T> [--force]`, `list`: 하네스 등록 워크트리를 관리한다.
- `fodh slots status`: 머신 전역 Codex 슬롯과 생존 여부를 확인한다.
- 프로젝트 `.gitignore`에 `.pi/codex/`를 추가한다(위임 프롬프트·실행 로그·결과 파일).

P3 위임 복구: 감독이 죽어도 그룹 구성원 중 기록된 Codex 자식의 PID·시작 시각이 일치하면 슬롯을 유지하고, 워처는 60초 후 별도 그룹의 도구 자손까지 회수한 뒤 lost로 마감한다. 감독 그룹이 없고 기록된 도구 그룹도 회수했으며 `turn.completed`가 있으면 `ok` 및 `supervisorLost:true`로 기록한다. meta 없는 위임도 대기 교착 없이 취소·복구한다. 감독 stderr는 결과 디렉터리의 `supervisor.log`(0600)에 남는다. review·research는 task의 구현 재개 스레드를 덮어쓰지 않는다.

`--wait` 상한은 `min(timeoutMinutes + 1, max(1, brain.maxTurnMinutes - 5), delegate.codex.waitMinutes)`분이다. 시작 runId는 stderr에 즉시 출력되며, 상한 오류 뒤에도 감독은 계속 실행된다. 두뇌는 반환된 runId로 `대기: 위임 3f2c…`(예시 대신 실제 runId 전체)를 마지막 비어 있지 않은 3줄 안에 적고 턴을 끝낸다.

`fodh`는 `FODH_PROJECT_ROOT`가 있으면 그 경로, 없으면 cwd에서 가장 가까운 상위 `.pi/harness-state.json` 디렉터리, 없으면 cwd를 루트로 쓴다. 등록 워크트리 안에서는 실행을 거부한다(명시적 `FODH_PROJECT_ROOT`는 우선). 두뇌는 프로젝트 루트를 유지하고 검증만 `(cd <워크트리> && <명령>)`으로 실행한다. 워크트리 생성 전에는 stale 등록을 `git worktree prune`으로 정리한다.

| 설정 | 기본값 | 의미 |
|---|---:|---|
| `delegate.codex.waitMinutes` | 8 | CLI 대기 상한(양의 정수, 분) |

두뇌 Bash timeout 기본·최대는 각각 600000ms로 주입하며 사용자가 준 환경값은 유지한다. `--wait`가 어떤 이유로든 결과 없이 끝나면 stderr runId 또는 `fodh codex status`의 delegation.runId로 위임 대기를 표시하고, `--wait`를 다시 호출하지 않는다.

감독 PID 재사용은 신호 없이 위임을 마감하고 `pid-reused`, 자식 신원이 맞지 않는 생존 그룹은 `group-unverified`를 원장에 남긴다. 도구 그룹은 30초 표본 때 meta.toolGroups에 누적해 정상 종료·cancel·lost·reclaim에서 함께 회수한다. 회수 실패 원장은 runId별 첫 1건과 10분마다 1건만 기록한다. `supervisorLost`는 결과·인박스에 전달하며 추정 성공 경고를 표시한다. 사용자 대기 표지는 본문 어느 줄이든, 위임 표지는 마지막 비어 있지 않은 3줄에서 인정한다. Codex 자식은 프로젝트 루트 env를 받지 않으며 `FODH_CODEX_CHILD=1`로 fodh 실행이 거부된다.
