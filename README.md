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
위임 설정은 현재 로드·검증·조회까지만 지원하며 실제 `fodh codex` 실행은 P2 범위입니다.

Claude Code autocompact는 사용자 `~/.claude/settings.json` 설정을 따릅니다
(설계 기준 `autoCompactWindow: 250000`). 하네스는 압축 인자·프로젝트 settings 키를 추가하지 않고,
관련 환경변수도 추가·삭제하지 않습니다. Pi 자동 컴팩션 설정과는 별개입니다.
하네스 보조 회전 임계값 `brain.rotateAtTokens`의 기본값은 0(회전 끔)이며, 이번 단계는 설정 로드·검증까지만 제공합니다.

Codex 수행자 기본값 `gpt-6-sol`은 판단 A11 로 확정되었습니다.

`/status`는 워처의 마지막 tick·판단 해시/안정 시간·정체 시작·초과 자식 수를 표시합니다. `fodh watch tick`은 한 번 감지하고, `fodh watch status`는 저장된 워처 요약을 조회합니다.
