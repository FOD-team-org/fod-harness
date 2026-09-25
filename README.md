# fod-harness

Pi 기반 개인 하네스 터미널. 설계: docs/설계/, 판단: docs/판단대기.md


## Pi 컴팩션 설정

Pi 0.87.1(`@earendil-works/pi-coding-agent`) 기준입니다. 다음 명령으로 설치합니다.

```sh
npm install -g @earendil-works/pi-coding-agent@0.87.1
```

Claude Code가 자신의 문맥을 관리하므로 전역 `~/.pi/agent/settings.json`에 다음을 설정하는 것을 권장합니다.
`PI_CODING_AGENT_DIR`가 있으면 그 디렉터리의 `settings.json`을 사용합니다.
프로젝트 `.pi/settings.json`도 지원하지만, Pi 0.79부터는 프로젝트를 신뢰하기 전까지 무시됩니다.

```json
{ "compaction": { "enabled": false } }
```

전역 설정 또는 신뢰된 프로젝트 설정의 실효값이 false 이면 경고하지 않습니다. 신뢰된 프로젝트 설정이 전역 설정보다 우선하며, 확인하지 못하면 세션 시작 시 설정을 안내합니다.
저장소 루트에서 실행하는 예시입니다. `PI_SKIP_VERSION_CHECK=1`은 자동 업데이트 조회를 끕니다.

```sh
export PI_SKIP_VERSION_CHECK=1
pi -e ./extensions/provider/index.ts -e ./extensions/orchestrator/index.ts -e ./extensions/watcher/index.ts --model claude-code/claude-fable-5-1
```

`brain.doctorTtlHours`는 `.pi/harness.json`에서 설정하며 기본 12시간입니다.
`fodh state transition IMPLEMENT|MERGE`는 별도로 최근 12시간 doctor 성공 기록을 요구합니다.
Pi가 잠금을 보유한 동안 `fodh doctor`는 즉시 오류를 반환합니다.


## 모델 배치와 교체

두뇌는 `brain.allowedModels` 허용 목록 안에서만 고릅니다. 기본 목록은 Opus 5.5(`claude-opus-5-5`)·Fable 5.1(`claude-fable-5-1`)이고, 기본 두뇌는 **Fable 5.1**입니다. `brain.allowPlugins=false`(기본값)이면 `--setting-sources project,local`로 사용자 전역 설정(플러그인·enabledPlugins 포함)을 제외하고 `--strict-mcp-config` + 빈 `--mcp-config`로 MCP를 제한한다. 하네스 스킬·훅은 프로젝트 `.claude/settings.json`과 `--settings`로 들어온다. 사용자 전역 스킬(`~/.claude/skills`)도 함께 제외된다. true이면 위 세 옵션을 생략하며 위임 훅은 유지된다. doctor는 비builtin plugin source 또는 codex: 접두 agent·command·skill이 남으면 `pluginsLeaked`와 경고를 반환한다.
doctor 는 훅 시험용 haiku 로 돌며 두뇌 규칙과 무관합니다. 결과에 `brainModel`과 `allowedModels`를 함께 표시합니다.

새 모델이 나오면 사용자 터미널에서 추가 → 전환 → (선택) 제거 순서로 바꿉니다.

```sh
fodh config set brain.allowedModels '["claude-opus-5-5","claude-fable-5-1","claude-opus-6"]' --approve
fodh config set brain.model claude-opus-6
# 선택: 이전 모델 제거
fodh config set brain.allowedModels '["claude-opus-6","claude-fable-5-1"]' --approve
```

이후 Pi 를 다시 시작합니다. Pi `/model` 목록은 시작할 때 만들어집니다.
Pi 가 저장한 예전 기본 모델(`claude-code/fable` 등)이 목록에 없으면 Pi `/model` 에서 `claude-code/claude-fable-5-1` 을 한 번 고른다.

토이·시험에서 haiku 를 쓰려면 허용 목록에 `"haiku"`를 넣습니다. `fable`·`opus` 별칭은 해당 전체 ID가 허용 목록에 있을 때 읽기 결과에서 해석하며 설정 파일은 다시 쓰지 않습니다.

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

`/hold`는 다음 두뇌 턴의 `대기: 사용자`를 수락합니다. 직접 입력에 `멈춰|멈추|기다려|잠깐|보류|확인할게|확인하고|stop|hold|wait|pause`가 단어 경계·한글 어절 시작에 있으면 같은 효과이며 대소문자를 구분하지 않습니다. `진행|계속|해줘|go|continue`만으로는 멈추지 않고, 두 부류가 섞이면 멈춤이 우선합니다. 수락 원장은 `turn:user-wait-accepted`에 `hold: command|input`을 기록합니다. 표지는 턴 종료(대기 없는 정상 진행·오류 포함) 또는 다음 입력에서 지웁니다. `/hold` 직후 extension 재개 입력은 명령 표지를 유지합니다.

번호·승인 토큰 답은 기본 10초 안정화 후 자동 적용하고, 자유 서술 답은 `watch.freeTextStableSeconds`(기본 60초) 이상 안정된 뒤 적용합니다. 대기 중 문서를 다시 편집하면 안정화 시간을 다시 셉니다. `/judged`는 수동 즉시 적용 경로입니다. 두뇌·doctor 턴 시작 직전의 `id → raw 답 줄` 스냅숏과 종료 시 내용을 비교하여 바뀌거나 새로 생긴 비어 있지 않은 답은 held로 보류합니다. 진행 중 인박스는 적용을 지연하며, 재시작·recovering 때 잔존 스냅숏도 처리합니다. held가 있으면 인자 없는 `/judged`는 목록만 표시하고, `/judged A5`처럼 번호를 명시해야 그 답을 해제·적용합니다.

두뇌가 판단을 등록한 바로 그 턴 안에 답을 쓰면 안전을 위해 held 가 된다. 알림을 보고 /judged A<n> 로 확인하면 적용된다.

- `fodh codex task|review|research --spec <파일> [--task T01] [--resume last] [--wait]`: 비동기 위임. `status [runId]`, `result <runId>`, `cancel <runId>`로 조회·회수한다. 완료는 `codex-done` 인박스로 전달된다.
- `fodh worktree create <T> [--base <ref>]`, `remove <T> [--force]`, `list`: 하네스 등록 워크트리를 관리한다.
- `fodh slots status`: 머신 전역 Codex 슬롯과 생존 여부를 확인한다.
- 프로젝트 `.gitignore`에 `.pi/codex/`를 추가한다(위임 프롬프트·실행 로그·결과 파일).

P3 위임 복구: 감독이 죽어도 그룹 구성원 중 기록된 Codex 자식의 PID·시작 시각이 일치하면 슬롯을 유지하고, 워처는 60초 후 별도 그룹의 도구 자손까지 회수한 뒤 lost로 마감한다. 감독 그룹이 없고 기록된 도구 그룹도 회수했으며 `turn.completed`가 있으면 `ok` 및 `supervisorLost:true`로 기록한다. meta 없는 위임도 대기 교착 없이 취소·복구한다. 런처는 15초 안에 감독 준비가 확인되지 않으면 타임아웃 오류를 반환한다. 감독 stderr는 결과 디렉터리의 `supervisor.log`(0600)에 남는다. review·research는 task의 구현 재개 스레드를 덮어쓰지 않는다.

`--wait` 상한은 `min(timeoutMinutes + 1, max(1, brain.maxTurnMinutes - 5), delegate.codex.waitMinutes)`분이다. 시작 runId는 stderr에 즉시 출력되며, 상한 오류 뒤에도 감독은 계속 실행된다. 두뇌는 반환된 runId로 `대기: 위임 3f2c…`(예시 대신 실제 runId 전체)를 마지막 비어 있지 않은 3줄 안에 적고 턴을 끝낸다.

`fodh`는 `FODH_PROJECT_ROOT`가 있으면 그 경로, 없으면 cwd에서 가장 가까운 상위 `.pi/harness-state.json` 디렉터리, 없으면 cwd를 루트로 쓴다. 등록 워크트리 안에서는 실행을 거부한다(명시적 `FODH_PROJECT_ROOT`는 우선). 두뇌는 프로젝트 루트를 유지하고 검증만 `(cd <워크트리> && <명령>)`으로 실행한다. 워크트리 생성 전에는 stale 등록을 `git worktree prune`으로 정리한다.

| 설정 | 기본값 | 의미 |
|---|---:|---|
| `approvalRules` | `[]` | 프로젝트 승인 규칙. 아래 예시처럼 목록에 넣으면 항상 적용 |
| `worktrees.links` | `[]` | root 의 의존성을 워크트리에 링크. 예: `["node_modules"]`. 무시되지 않는 링크는 공통 Git info/exclude 에 추가 |
| `delegate.codex.waitMinutes` | 8 | CLI 대기 상한(양의 정수, 분) |

사용자 승인 규칙은 `^` 로 명령 시작을 앵커한다. 앵커가 없으면 `git log --grep=db:migrate` 같은 읽기 명령도 걸린다. 패턴은 200자 이하만 허용하며 역참조와 중첩 수량자는 거부한다. 정적 검사가 모든 정규식의 실행 비용을 보장하지는 않으므로 복잡한 패턴을 피한다.

`approvalRules` 항목 예시:

```json
{"id":"db-migrate","pattern":"^npm run db:(?:migrate|push)\\b|^drizzle-kit (?:migrate|push)\\b"}
```

npm 별칭·옵션 형태(`npm run-script db:migrate`, `npm --prefix . run db:migrate`, `npm run db:migrate --`)도 막으려면 `^npm\b.*\brun(?:-script)?\s+db:migrate\b`처럼 규칙을 넓게 쓴다.

두뇌 Bash timeout 기본·최대는 각각 600000ms로 주입하며 사용자가 준 환경값은 유지한다. `--wait`가 어떤 이유로든 결과 없이 끝나면 stderr runId 또는 `fodh codex status`의 delegation.runId로 위임 대기를 표시하고, `--wait`를 다시 호출하지 않는다.

감독 PID 재사용은 신호 없이 위임을 마감하고 `pid-reused`, 자식 신원이 맞지 않는 생존 그룹은 `group-unverified`를 원장에 남긴다. 도구 그룹은 30초 표본 때 meta.toolGroups에 누적해 정상 종료·cancel·lost·reclaim에서 함께 회수한다. 회수 실패 원장은 runId별 첫 1건과 10분마다 1건만 기록한다. `supervisorLost`는 결과·인박스에 전달하며 추정 성공 경고를 표시한다. 사용자 대기 표지는 본문 어느 줄이든, 위임 표지는 마지막 비어 있지 않은 3줄에서 인정한다. Codex 자식은 프로젝트 루트 env를 받지 않으며 `FODH_CODEX_CHILD=1`로 fodh 실행이 거부된다.

- `fodh cleanup run [--scope processes|storage|worktrees|all] [--task T] [--dry-run]`: 등록 프로세스·프로젝트 재생성 경로·완료 또는 현재 CLEANUP 작업의 워크트리 정리, `.pi/cleanup-last.json` 보고서. 공유 캐시는 보고만 한다.
- `fodh verify run [--heavy] [--cwd <dir>]`: VERIFY/FIX에서 설정된 명령을 순차 실행한다. heavy 슬롯과 Codex 슬롯은 상호 배타다.
- `fodh notify send --title … --body … [--level info|warning|error]`: TUI/macOS/원장 알림. 같은 키 60초 제한, Slack은 skip 기록만 남긴다.
- `fodh memory status`: 현재 메모리 표본과 60초 워치독 상태. 스왑 초과 5분은 paused(memory), 경고치−2 GB 미만 5분은 자동 재개다.

P4: `/cleanup`은 전체 정리, `/cleanup dry`는 삭제 없는 계획을 표시한다. 세션 종료는 자기 세션 레코드만 회수하며 활성 위임과 두뇌는 보호한다. `budget.dailyTurns/dailyHours`는 값만 검증하며 제한을 강제하지 않는다. `BASH_DEFAULT_TIMEOUT_MS`가 waitMinutes보다 짧으면 doctor가 경고하고 실제 대기 상한을 해당 timeout의 90%로 낮춘다.

P4 정리 보고서의 `stale`은 신호 없이 제거한 죽거나 PID가 재사용된 기록이며 잔존 수에서 제외한다. `protected`는 실행 중 verify·활성 위임·시작 후 60초 이내 위임 등 보호된 기록이다.
verify 결과의 `interrupted: "signal"`은 외부 SIGTERM/SIGINT 중단이므로 코드 결함으로 판단하지 않고 검증을 다시 실행한다.
`cleanup.swapWarnGB`는 최소 3이며 메모리 pressure 표본도 이 설정값으로 판정한다.
알림은 프로세스 메모리와 원장 마지막 200줄의 동일 키 성공 기록으로 60초 중복을 제한한다. `/cleanup` 결과는 실행별 키로 항상 표시한다.

verify 프로세스는 검증 자식과 소유 CLI의 신원이 모두 owned일 때만 보호한다. 소유 CLI가 죽은 검증 자식은 일반 정리 대상이며 heavy 슬롯 생존도 CLI 기준이다.

P5 인터뷰·문서·스킬:

- `fodh interview start|next|record|defer|skip|add|status`: 18영역 진행을 `.pi/harness-interview.json`과 `docs/결정기록/` 뷰로 추적한다. 기본 6문항·질문당 총 2회다. 답 없는 next 재호출은 같은 openRound를 repeated:true로 반환하며 횟수를 늘리지 않는다. mustDefer는 필수 한도, skipDue는 선택 한도이고 선택은 skip으로 처리한다. 필수 답 또는 판단 이관이 끝나고 skipDue가 비어야 RESEARCH로 전이한다.
- `fodh docs scaffold <kind> [--task T01] [--topic 주제|--subject 검수주제] [--date YYYY-MM-DD]`: PRD·설계·스펙·검수·조사 문서를 만든다. 기존 파일은 덮어쓰지 않고 exit 1로 안내한다.
- `fodh claude-md generate [--check]`: CLAUDE.md의 관리 블록만 갱신한다. 블록 밖 사용자 내용은 보존하며 check는 낡았으면 exit 1이다. 기본 AGENTS.md 생성은 없다.
- `fodh skills install|status`: 하네스 스킬 4종을 프로젝트 `.claude/skills`에 설치·조회한다. 사용자 동명 스킬은 보존하고 충돌을 알린다.

질문 재정의는 `.pi/interview-bank.md`(같은 ID 교체), 문서 재정의는 `.pi/templates/docs/`(같은 상대 경로)로 한다. 설정의 interview·docs·skills·claudeMd 블록으로 조정하며 자세한 문법은 [템플릿 안내](templates/README.md)를 참고한다. 백로그는 `docs/backlog.md` 고정이다. 인터뷰 답의 `--source default`는 사용자가 “추천대로”라고 답했을 때만 쓴다.

`/project-start`는 은행·판단대기 사전 검증 실패 시 error와 실패 원장을 남기고 IDLE을 유지한다. 검증 후 인터뷰를 시작하며, 두 시작 명령은 스킬 설치·CLAUDE.md 생성을 수행한다(이 준비 실패는 warning). doctor의 `skillsMissing`·`claudeMdLoaded`는 훅 성공 여부와 별도로 알린다. 프로젝트 스킬 로드는 [Fable 1차 실기](docs/검수/2026-09-24-P5-Fable-실기.md)에서 관측됐다. 2차 doctor 표식 프로토콜은 별도 실기 확인이 필요하다.

P5 2차: 두뇌·doctor 자식은 `FODH_BRAIN=1`을 받는다. P6부터 두뇌의 config set은 `delegate.*`·`verify.*`를 포함한 모든 키를 거부하고 판단대기로 안내한다. `.pi/interview-bank.md`·`.pi/templates/`와 설정에서 계산한 `FODH_PROTECTED_EXTRA` 경로는 편집 훅으로 보호한다. 사용자 CLI는 아래 승인 전용 키에 `--approve`가 필요하다.

doctor는 memory_paths를 CLAUDE.md 목록으로 해석하지 않는다. 배열·객체 원형은 원장에 안전하게 보존하고, 결과는 문자열 배열로 정규화한다. 관리 블록의 `FODH-DOC-<해시8자>`에 대해 두뇌가 `문서 확인 <표식>`으로 답하면 claudeMdLoaded=true, 다른 해시면 claudeMdStale=true다. 기대값은 claudeMdMarker로 반환하며, 스킬 누락·문서 확인 실패·낡은 표식은 경고만 낸다. 다른 해시도 문서 로드는 true이며 낡음(재생성 필요)으로 구분한다. 해시는 실제 표시하는 설정으로만 계산하고, develop-start에서 문서가 바뀌면 “커밋 필요”를 알린다.

반환 객체의 error 필드만으로 exit 1을 정하는 규칙은 P5 그룹(docs·claude-md·interview·skills)에만 적용한다. 예를 들어 실패 실행의 meta.error를 반환하는 codex status 조회는 exit 0을 유지한다. 기존 예외·ok:false 처리 규칙은 그대로다.

인터뷰 record는 비밀 패턴 답을 거부하고 기록 뷰·검증 명령 문서는 redact한다. free 문항의 “직접 답하기” 판단은 실제 답이 아니므로 다시 open으로 묻는다. 완료·skip 문항은 defer할 수 없다. 프로젝트 검수는 --subject, task 검수는 --task를 사용하며 위임 경로는 scaffold가 반환한 path를 그대로 사용한다.

P5 3차: next는 choice를 판단대기로 즉시 등록해 deferred로 반환하고 free만 열린 라운드로 유지한다. Bash의 FODH_ 환경변수 대입·unset·env 제거는 차단하며, 공용 redact와 훅은 OpenAI·Stripe·Google·Slack·GitHub·AWS·Anthropic 키 및 개인키·Bearer 패턴을 같은 정규식으로 검사한다. docs.overrideDir·interview.extraBankFile은 프로젝트 내부에서 docs.root와 겹치거나 그 조상이 되는 경로·프로젝트 루트를 거부한다.


## P6 가드레일

`hooks/pretooluse.mjs`는 Node 내장 모듈만 사용하는 단일 훅이다. 두뇌·doctor는 `FODH_BRAIN=1`과 설정의 `FODH_DOCS_ROOT`를 받는다. 등록 워크트리는 상태의 `worktrees[].path`를 따른다. 미초기화도 `FODH_BRAIN=1` 이면 규칙 2·4 적용(등록 워크트리 없음). 상태 손상은 두뇌·편집 도구·Bash에서 거부하며 사용자 Read·Grep은 허용한다. 초기화된 두뇌 세션의 설정 읽기 실패는 거부한다.

| 규칙 | 동작 |
|---|---|
| 1. 비밀값 | Write/Edit/MultiEdit/NotebookEdit 및 Bash 입력의 비밀 패턴 거부 |
| 2. 삭제 경계 | 두뇌의 루트 밖·루트 자체·문서 트리 자체·.git·.pi 대상 rm -r/-f, find -delete, 등록 워크트리 밖 git clean 거부. 등록 워크트리와 .pi/scratch/** 삭제, git clean dry-run 허용 |
| 3. 승인 필수 | requiresApproval 패턴을 [승인]으로 거부하고 판단대기 안내. 승인 거부만 판단·작업 회수로 연결 |
| 4. 쓰기 경계 | 두뇌는 docs.root·.pi(보호 파일 제외)·CLAUDE.md·AGENTS.md·README.md와 등록 워크트리만 쓰기 허용. Write/Edit 루트 밖은 .pi/scratch 안내. .claude/skills는 fodh skills install 전용. Bash는 루트 안 소스 쓰기를 검사하며 디바이스·외부 리다이렉트·인터프리터 실행 인자는 제외. heredoc 본문은 명령으로 해석하지 않음. git apply/patch 실제 적용은 대상 워크트리에서만 허용 |
| 5. 상태·직접 실행 | commit의 기존 문서 상태 예외 유지, push/merge는 MERGE·DOCS만. 직접 codex 금지. 두뇌의 claude/cswap 직접 실행·codex-companion 인자·openai-codex 플러그인 경로·mcp__*codex* 도구·codex:* Agent/Task도 거부하며 위임은 fodh codex task 또는 Claude Agent로만 허용. 두뇌의 git worktree add/remove/prune는 fodh worktree 안내, branch -D/reset --hard/force push는 승인 설정과 무관하게 거부 |
| 6. 자기수정 | Claude settings·패키지 hooks·.pi/harness*.json/jsonl·은행·템플릿 보호. FODH_ 대입/제거와 sh/bash/zsh -c 및 -lc/-ec/-xc, node -e/--eval, python -c, perl -e, eval/source/. 내부 FODH_ 참조 거부. 경로는 가장 가까운 기존 조상을 realpath로 풀고 darwin 비교는 대소문자 무시 |
| 7. 판단 답 보호 | 판단 파일 직접 쓰기와 인라인 인터프리터의 판단 파일 참조 쓰기를 거부. cp/mv/rsync의 판단 디렉터리 목적지는 원본 basename 일치 또는 재귀일 때 거부. 재귀는 긴 옵션 `--recursive/--archive`와 -r/-R/-a를 인식하되 원본이 존재하는 비디렉터리라고 확인될 때만 비재귀로 본다. 조회 실패(ENOENT·EACCES)나 같은 체인의 cd는 재귀로 간주한다. tar/bsdtar/gtar(대시 없는 xf 포함)·unzip 추출의 목적지·cwd·판단 파일 basename을 검사하고 .pi 아래 추출을 거부하며 일반 파일 복사·tar 생성은 허용. sh/bash/zsh -c·eval 문자열을 재파싱하고 nohup/timeout/nice/time/xargs/stdbuf/env/exec/builtin/command/script/caffeinate/arch 래퍼를 해제하며 --wait 백그라운드 실행도 거부 |

`approvalRules`, `worktrees.links`, `requiresApproval`도 사용자 CLI에서 `--approve`가 필요한 승인 전용 키다.

`fodh config set`의 승인 전용 키는 `delegate.codex.command`, `brain.command`, `brain.switchCommand`, `delegate.codex.sandbox`, `brain.allowedModels`다. 사용자 터미널에서 `fodh config set <키> <값> --approve`로 변경한다. 이 키를 담는 상위 객체 교체에도 승인이 필요하다. 두뇌는 `--approve`로도 어떤 설정을 변경할 수 없다. docs.root는 루트 자체·외부·.pi/.git/.claude의 조상이나 그 자체로 설정할 수 없다. 환경 표지가 없어도 Pi 잠금 소유자의 자손이면 차단하며, 살아 있는 잠금의 부모 체인을 ps로 확인할 수 없으면 보수적으로 거부한다. 잠금 소유 Pi 자체의 모델 선택과 잠금 없는 사용자 설정은 유지한다.

`fodh memory reset`은 사용자 터미널 전용이다. 두뇌 env·부모 체인 판정과 훅에서 거부하며 두뇌용 CLAUDE.md 명령 목록에서도 제외한다. 이 명령은 메모리 경보·5분 타이머와 이전 미처리 pressure/critical 이벤트를 해제하고 `memory:reset` 원장을 남긴다. paused(memory) 또는 WAIT_RESOURCE(lastPaused=memory)이면 memory-recovered 인박스를 통해 기존 PICK 회복 경로를 탄다. 실제 스왑을 줄이는 명령은 아니며 초과 표본이 계속되면 다시 5분 뒤 중단된다.

훅은 `[승인]`·`[경계]`·`[보호]` 접두로 이유를 분류한다. 경계 거부는 판단 없이 위임으로 바꾸고, 보호 거부는 그 동작을 포기한다. 분류 없는 거부는 원장과 `hook:unclassified` 경고만 남긴다. 경계·보호·미분류 때문에 활성 위임을 회수하지 않는다.

턴 종료 시 tool_use의 Write 경로와 Bash의 쓰기 문맥만 사후 검사한다. 누락 의심은 경로별 `audit:path-boundary warn` 원장과 턴당 TUI 알림 1건(최대 3경로)으로 남긴다. 같은 root·경로는 프로세스 수명 동안 한 번만 알리고 원장은 계속 남긴다. 이미 거부된 도구는 제외하고, 감사만으로 판단대기를 생성하거나 실행을 되돌리지는 않는다. doctor는 Bash 표식과 `src/FODH_DOCTOR_MARKER.ts` Write의 서로 다른 차단 증거 2건을 요구한다. doctor의 --max-turns는 3이며 표식 파일이 실제 생성되면 삭제하고 실패한다. 실패하면 기존 IMPLEMENT·MERGE 게이트가 계속 차단한다.

## 알려진 한계

이 훅은 협조적인 두뇌의 실수를 막는 가드레일이며, 적대적 우회를 막는 샌드박스가 아니다. 두뇌에게는 인식하지 못한 셸 구조를 거부한다. 스크립트 파일 내부·문자 코드 조립·셸 밖 경로(별칭 파일 등)는 한계로 남는다. OS 수준 샌드박스는 후속 후보다.

검수 수렴 기준: 높음·중간은 협조적인 두뇌가 평소 작업에서 쓸 법한 형태로 보호 대상이 깨지거나, 흔한 문법을 파서가 잘못 읽는 경우에 매긴다. 일부러 만든 난해한 변형은 낮음·참고로 분류해 아래 한계 표에 남기며 APPROVE를 막지 않는다.


프로젝트 REVIEW→PROJECT_READY는 `.pi/codex/*/meta.json`의 `kind: review`, `status: ok`, `startedAt >= reviewSince` 증거를 요구한다. 업그레이드 전 상태에 `reviewSince`가 없으면 `enteredAt`을 사용하며 둘 다 없으면 검수 시각 증거를 인정하지 않는다. task의 REVIEW→MERGE도 같은 taskId의 검수 증거가 필요하지만, 그 taskId의 `kind: task`, `status: ok` 구현 meta가 있으면 면제한다. delegate 표기는 판정에 쓰지 않는다. 이 면제 경로의 Claude Agent 검수 증거는 여전히 수집하지 못한다. `reviewSince`는 새 REVIEW 진입 때 설정하고, REVIEW를 떠날 때 지운다. 판단 대기·일시 중단 시에는 `resumeReviewSince`에 보관해 WAIT_JUDGMENT 복귀 또는 PICK의 resume 경로에서 복원한다.

PROJECT_READY→PLANNING, DONE_ALL→PLANNING·IDLE 및 CLI `state transition --system`은 사용자 전용이며 `assertNotBrain`의 환경변수·잠금 소유자 자손 체인 검사로 두뇌를 거부한다. 오케스트레이터·워처·프로바이더의 내부 전이는 그대로다. 코어 전이가 PROJECT_READY·DONE_ALL·WAIT_*·CLEANUP_FAILED를 떠나면 `awaitingUser`를 해제한다.

git 프로젝트의 `codex task`는 해당 task의 `task.worktree`와 `state.worktrees` 등록이 모두 필요하고 `--cwd`도 그 워크트리 안이어야 한다. 비-git 프로젝트만 루트 폴백을 허용한다. 프로젝트 초기화와 첫 세션은 git 프로젝트의 `.gitignore`에 `.pi/harness.lock`, `.pi/*.lock`, `.pi/harness-*.json`, `.pi/harness-*.jsonl`, `.pi/scratch/`, `.pi/codex/`, `.pi/verify/`, `.pi/cleanup-last.json`, `.pi/harness-config-warned.json` 중 빠진 줄을 추가하며 기존 내용은 보존한다. 디렉터리·심링크인 `.gitignore`는 변경하지 않는다. 비정규 파일은 초기화를 계속하며 skipped 원장과 프로젝트당 1회 경고를 남긴다. 그 밖의 세션 시작 시 갱신 오류는 실패 원장과 알림만 남기고 세션 시작을 계속한다.

| 경우 | 현재 범위와 남은 한계 |
|---|---|
| 작업일지 규약 이행 | 기존 `docs/작업일지.md`는 읽거나 변경·삭제하지 않고 날짜별 새 규약만 사용한다. `fodh claude-md generate` 또는 session_start의 옛 작업일지 문구 감지 시 관리 블록만 재생성하며 사용자 영역은 보존한다. |
| task 검수 면제(L4) | REVIEW→MERGE는 해당 task의 `kind: task, status: ok` meta 존재만으로 검수를 면제하며 시간 경계가 없다. 사소한 `codex task` 한 번으로도 면제될 수 있다. 라이브 T02에서는 Codex 구현 meta로 면제되어 haiku 두뇌가 직접 쓴 검수도 통과했다. Claude Agent 검수 경로에서는 하네스가 검수 증거를 만들 수 없기 때문이다. 후속 P8 후보는 `fodh review record`(검수 문서 경로·대상 커밋·모델 증거)로 Claude Agent 검수도 증거화하는 것이며 현재 제공되는 명령은 아니다 |
| 커밋 비밀값 검사(P5) | 1 MB 초과·바이너리 untracked 파일은 내용의 비밀값 검사 없이 커밋되며 이름만 원장에 남는다 |
| 검증 산출물(P6) | 검증 뒤 새로 더러워진 경로는 result.json·state.verify.dirtyAfter에 남는다. 검수 커밋의 clean 검사에서 거부되면 검증 산출물인지 확인하고 프로젝트 .gitignore 추가를 위임한다 |
| git 프로젝트 판정(L5) | F8은 프로젝트 루트의 `.git`만 확인한다. git 저장소의 하위 디렉터리를 프로젝트 루트로 쓰면 비-git으로 판정되어 루트 폴백이 적용된다 |
| 서브셸·명령 치환·셸 문자열 | 묶음·제어문 앞뒤를 벗기고 `sh -c`·eval 문자열을 재파싱한다. `$()`·백틱 안은 깊이 3까지 검사하며 짝/깊이나 남은 구조를 해석하지 못하면 두뇌에게 경계 거부한다. 함수·case·coproc·프로세스 치환도 두뇌 검사에 포함한다. 두뇌의 표준입력 셸(파이프·heredoc·here-string 포함)은 거부하며 `bash -c`를 사용한다. 표준입력 인터프리터는 원문 전체의 보호·판단 파일 언급을 검사한다. 별도 스크립트 파일 내부는 전부 해석하지 못한다 |
| 스크립트 내부 쓰기 | 훅은 명령 토큰 기반이다. 사후 감사가 인라인 코드·heredoc의 리터럴 경로를 추가 탐지하지만, 별도 스크립트·patch 내용과 동적으로 만든 경로는 모두 해석하지 못한다. 인라인 보호 경로를 문자 코드로 조립하는 형태는 탐지하지 못한다. 의심 경고는 실제 파일 변경의 증명이 아니며 오탐도 가능하다. 사후 감사에서 괄호에 붙은 fd(`)2>&1`) 앞 경로가 `unresolved` 목록에 잡음으로 남을 수 있다(판정에는 영향 없음) |
| MCP 도구 쓰기 | 기본 MCP 제한 옵션과 Codex MCP 도구 차단이 있지만 그 외 MCP 고유 입력 형식은 경로 가드와 감사의 일반 Write/Bash 판정 밖이다. brain.allowPlugins=true도 위임 훅을 해제하지 않는다. 변수 경유(`P=codex; $P …`)·`$(which codex)`·python subprocess 호출은 리터럴 명령 검사로 차단하지 못한다 |
| 판단 답 보류 | mtime을 사용하지 않는다. 사용자가 두뇌 턴 중 쓴 답도 held가 되므로 /judged <번호>로 확인한다. 턴 종료 후 분리된 자식이 늦게 쓴 답은 종료 스냅숏 비교로 잡지 못한다. 비정상 종료 뒤 잔존 스냅숏은 다음 begin/recover에서 먼저 정산된다. finish 실패는 진행 표지를 지우고 recover를 한 번 재시도하며, 재실패해도 brainTurn.endedAt을 기록해 활성 턴을 끝낸다. 복구는 pid와 processStartedAt 시작 시각을 대조하므로 재사용 pid는 종료된 것으로 보고, EPERM은 생존으로 취급한다. 살아 있는 다른 Pi 인스턴스의 스냅숏은 건드리지 않는다. 턴 중 무인자 적용은 스냅숏과 달라진 답을 미적용으로 남기며 번호 명시 적용은 유지한다 |
| 임시 변수 삭제 | 임시 변수 치환 경로와 빈 변수 해석이 모두 기존 가드를 통과해야 한다. 임시 변수 아래 개별 파일 삭제 대신 `rm -rf "$T"` 를 사용한다. 대입 실패·미실행을 안전한 임시 경로로 가정하지 않는다. 복사·추출과 삭제는 명령을 나눠 쓴다. 같은 호출에서 대입한 변수에 임시 예외를 줄 수 없으면 전용 안내를 낸다. HOME·PWD·OLDPWD·TMPDIR과 대입하지 않은 이름은 기존 경계 안내를 낸다. 삭제는 다음 호출에서 mktemp가 출력한 리터럴 경로로 한다(셸 변수는 호출 사이에 남지 않는다) |
| 추출·재귀 복사 | 두뇌는 보호 디렉터리의 상위 목적지와 cwd를 알 수 없는 추출·재귀 복사를 거부한다. `.pi/scratch`, 확인한 임시 디렉터리, 보호 경로를 제외한 워크트리에 추출할 수 있다. 사용자 세션의 상위 디렉터리 추출은 검사하지 않는다. |
| 셸 밖 실행 환경 | 별칭 파일·별도 스크립트가 명령 해석이나 경로를 바꾸는 효과는 전부 추적하지 못한다. 원문에 보이는 alias·PATH 변경은 임시 경로 예외를 끈다. |
| 한 명령에서 만든 링크 | ln·mv·git 또는 여러 복사·추출이 섞이면 임시 목적지 예외를 주지 않는다. 확인한 단일 복사·추출의 목적지에만 예외를 주며 다른 쓰기에는 이어주지 않는다. `ln -s "$PWD" /tmp/l && echo x > /tmp/l/src/a.ts` 같은 새 링크 경유 쓰기는 훅 시점 realpath만으로 확인할 수 없는 기존 한계다 |
| 의존성 링크 | 자격 증명이 든 파일은 링크하지 않는다. 필요하면 판단으로 요청한다. `.env`·`.env.*`·`.envrc`·`.dev.vars`·`.dev.vars.*`·`.npmrc`·`.netrc`·`.pypirc`·`neon_api.json`·`key.properties`와 인증서·키 확장자는 링크에서 거부한다. 의존성 추가·변경은 루트 `node_modules` 를 바꾸므로 워크트리 task 로 하지 않고 판단을 거친다. Codex 샌드박스는 링크 너머에 쓰지 못한다 |
| 셸 시작 파일 | 두뇌는 HOME·ZDOTDIR의 셸 시작 파일과 CLAUDE_ENV_FILE을 변경할 수 없다. |
| 변수·인용·경로 확장 | 토큰을 cwd 기준으로 resolve하며 셸 변수·glob·치환·cd 효과는 실행/추적하지 않는다. 훅은 기존 조상과 symlink를 realpath로 확인하지만 사후 감사는 리터럴 경로 기준이다. 인용된 인라인 코드는 일부만 감사한다. 패턴은 `*?[`만 보고, 사용자는 보호 경로와만 대조하며 두뇌는 판단·시작 파일도 대조한다. 두뇌의 쓰기 목적지 zsh 한정자는 거부하고 사용자 세션의 zsh 한정자 쓰기는 검사하지 않는다. 임시 변수로 치환되지 않은 쓰기 목적지의 동적 조각은 각각 한 경로 조각 와일드카드 `[^/]*`로 바꾼다. 붙은 확장의 연속 와일드카드는 하나로 합친다. 마지막 조각에서 와일드카드 바로 뒤의 끝 확장자와 와일드카드를 뺀 뒤 글자·숫자가 남거나, 전용 디렉터리 `.pi`·`.claude` 또는 루트 기준 가드 경로 전체가 정적 조각으로 연속해서 적혔을 때만 같은 보호 대상들과 대조한다. 루트 밖 가드 디렉터리는 이름 단서로 쓰지 않는다. 두뇌의 시작 파일은 해당 파일의 비-HOME·비-ZDOTDIR 전용 디렉터리만 단서로 쓰고 루트와 그 조상은 제외한다. 모든 조각이 동적인 목적지는 대조하지 않는다. 조건을 만족하지 않거나 일치하지 않으면 기존 경계 판정을 따른다. zsh 글롭 플래그(`(#i)` 등, extended_glob)는 검사하지 않는다. 확인된 임시 변수 뒤에 동적 조각이 붙은 목적지(`"$T/$f"`)는 임시 경로로 치환하지 않으며 두뇌는 거부한다 |
| 동적 복사·절대 경로 변수 | 사용자도 `"$X/.pi"`·`"$X/.claude"` 복사 목적지는 `$X`가 `.`일 수 있어 거부한다. 백업은 리터럴 경로나 mktemp로 한다. 앞머리 변수가 절대 경로(`$PWD`·`$ROOT`·`$(git rev-parse --show-toplevel)`)이면 사용자 세션은 보호 대상과 대조하지 못한다. 두뇌는 거부한다. 마지막 조각이 가드 디렉터리 이름과 같은 일반 이름(`"$D/templates"`, `.pi/templates` 가 있을 때)이면 사용자도 거부될 수 있다. 두뇌가 상대 경로(`../../.config/fish/$F`)로 쓰는 시작 파일 디렉터리는 대조하지 못한다(`~`·절대 경로 형태는 거부한다) |
| 셸 주석 | 공백 없이 `)` 뒤에 붙은 `#`(`(npm test)# …`)는 주석으로 보지 않는다 |
| Codex 자식 | Codex는 Claude 훅 밖이다. FODH_CODEX_CHILD=1의 훅 거부는 보조이며 실제 방어는 CLI 진입 거부다 |
| 100개 이상 삭제 | 훅은 삭제 개수를 세지 않는다. 대량 삭제 판정은 사후 검수 몫이며 자동 100개 임계 감사는 구현하지 않는다 |
| 사용자 대화형 세션 | FODH_BRAIN이 없으면 규칙 2·4와 두뇌 전용 git 제한을 적용하지 않는다. 비밀·승인·기존 상태 가드·자기수정 보호는 유지한다. 프로세스 치환 본문은 검사하지 않는다(두뇌는 검사한다) |
| 부모 프로세스 확인 | 살아 있는 Pi 잠금 중 ps 조회가 막히면 사용자 CLI의 설정 변경·memory reset도 거부될 수 있다. 이중 fork로 부모 체인에서 벗어난 자식은 이 판정만으로 막지 못한다. 실제 부모 체인 실기는 별도 확인이 필요하다 |
| Pi 종료와 고아 두뇌 | Pi가 SIGHUP·SIGTERM으로 죽으면 두뇌 그룹을 동기 TERM→KILL로 회수하고 orphan 파일을 다음 session_start 원장으로 옮긴다. SIGINT 도 같은 방식으로 회수한다(Pi 가 Ctrl+Z 로 멈춘 동안은 제외). session_start에서 처리기를 재설치하고 두뇌 턴 직전에 순서를 자가 교정해 Pi의 즉시 종료 처리기보다 먼저 회수한다. SIGKILL로 죽은 Pi의 두뇌는 다음 session_start가 회수하며, 그 사이 FODH_BRAIN=1인 두뇌의 fodh 쓰기는 잠금 소유자 부재·사망·읽기 실패로 코드 2 거부된다. 읽기 조회는 허용한다. 다음 세션 전까지 프로세스 자체가 남는 지연은 있다 |
| 위임 감독 신호 | 취소 표지 없는 `kill <감독 pid>`(SIGTERM)는 무시된다 — `fodh codex cancel <runId>`를 쓴다. SIGKILL은 막을 수 없다. 감독은 CLI→런처→감독의 2단 분리로 시작한다 |
| 복사·이동 잔여 문법 | GNU 묶음 `-t`(`cp -vt DIR x`, `install -Dt DIR x`)는 마지막 인자를 목적지로 본다. macOS cp에는 `-t`가 없다. 디렉터리째 원본 삭제(`rsync -a --remove-source-files DIR/ …`)와 사용자 세션의 보호 디렉터리 이름 바꾸기(`mv .claude .claude.bak`)는 검사하지 않는다. |
| 아카이브 생성 | `tar -cf`·`zip`의 출력 파일은 쓰기 경로로 보지 않는다. |
| Git 잔여 문법 | git stash pop/apply와 git checkout <ref> <path>(-- 없음)의 효과를 완전히 해석하지 않는다. cd 추적(L10)도 구현하지 않는다. 예: `(cd wt && cp x ../.pi/harness.json)`의 복사 목적지는 바뀐 cwd로 추적하지 않는다 |


### task 완료 증거 흐름

| 전이·명령 | 하네스가 확인·기록하는 증거 |
|---|---|
| Pi 수명 → 두뇌 수명 | 살아 있는 잠금 소유자가 두뇌 쓰기의 조건. 새 잠금 획득 뒤 열린 brainTurn과 일치하는 등록 brain pgid를 회수하고 recovering으로 전이. cleanup은 살아 있는 소유자와 현재 runId가 일치하는 두뇌만 보호 |
| 판단 변경 → 적용 | 턴 밖 안정화된 비held 답 자동 적용. 턴 중에는 지연 후 내용 스냅숏 비교로 held 처리, /judged <번호>로만 해제 |
| PICK | `fodh pick --dry`로 후보를 보고 `fodh pick`으로 outcome을 확정. 자동 턴에서 후보가 있으면 사용자 대기를 거부하며, 명시적 멈춤(/hold·멈춤 어휘)·후보 없는 DONE_ALL/WAIT_*·EMPTY는 대기 유지 |
| task 진행 중 사용자 대기 | SPEC·IMPLEMENT·VERIFY·FIX·REVIEW·MERGE·DOCS·CLEANUP에서 현재 task를 막는 열린 판단이 없으면 자동 턴의 대기를 거부·재개. 사용자 입력만으로는 수락하지 않으며 /hold 또는 멈춤 어휘가 있을 때만 대기를 수락한다(PICK도 동일). 사용자 결정은 `fodh judgment add … --blocks <taskId> --reclaim`으로 등록하고 RECLAIM→PICK 경로를 따른다. `fodh state await-user`는 사용자 전용이다. 위임·슬롯 대기가 우선하며 재개 3회 후 정체 판단으로 중단 |
| 위임 | `fodh codex task` 또는 Claude Agent만 사용. 직접 codex/claude/cswap·companion·Codex 플러그인 도구·Skill은 훅 거부. npx/bunx/pnpm dlx/yarn dlx의 Codex 패키지는 거부. glob은 실행 파일·인터프리터의 첫 스크립트 인자·find -exec/-execdir/-ok의 명령과 첫 인자에 plugins/cache 또는 codex-companion이 있을 때만 거부. 제목·grep·find 이름의 codex 패턴과 일반 find -exec node는 허용 |
| VERIFY → REVIEW | `fodh verify run`의 마지막 성공, 현재 task 및 VERIFY 진입 이후 시각, 등록 워크트리(없으면 루트)와 일치하는 realpath cwd, git worktree의 검증 당시 clean=true. `.pi/verify/<runId>/result.json`과 상태를 저장하고 task.verify를 기록 |
| DOCS → CLEANUP | `${docs.root}/작업일지/YYYY-MM-DD.md`의 오늘 또는 어제(KST) 날짜 파일에 taskId 포함, `docs/backlog.md`와 JSON 동기화. task.docs.ok 자동 기록 |
| `cleanup run --task T` | 현재 CLEANUP 진입 이후 해당 task의 scope all 성공 보고서(processes·storage·worktrees 성공, 잔존 0). task.cleanup.ok 자동 기록(dry-run 제외) |
| CLEANUP → PICK | `backlog set T --status done`의 DoD 충족 및 현재 task 완료, 마지막 정리 보고서와 프로세스 레지스트리 잔존 없음 |

`--verify-ok`, `--docs-ok`, `--cleanup-ok` 자기 보고 옵션은 지원하지 않는다. 실패한 검사는 두뇌가 면제할 수 없으며 `fodh judgment add`로 사용자 판단을 받는다.

검수 커밋은 등록 브랜치의 워크트리 HEAD이며 생성 base 이후 커밋이 1개 이상이고 미커밋 변경이 없어야 한다. 병합 커밋은 검수 커밋을 포함하고 루트 HEAD의 조상이어야 한다. REVIEW→MERGE 때 기록한 루트 HEAD(mergeBase)도 병합 커밋의 조상이어야 한다(구형 mergeBase 누락은 경고 원장). 비-FF 병합은 부모 중 하나가 검수 커밋이어야 하며, FF는 병합 SHA와 검수 SHA가 같아야 한다. 루트 clean 검사는 요구하지 않는다. 검수 커밋 자체를 쓰는 경우에는 루트 HEAD도 같아야 한다(fast-forward). 루트는 생성 시 기록한 baseBranch 위에 있어야 하며, 업그레이드 전 등록에 baseBranch가 없으면 이 검사만 생략하고 경고 원장을 남긴다. 같은 task의 성공한 VERIFY 진입 이후 검증 증거와 verify.head는 필수이며 검수 커밋은 그 HEAD와 같아야 한다(짧은 SHA는 전체 SHA로 정규화). 비-git 프로젝트만 `none`을 쓴다. `fodh worktree commit T -m "메시지"`는 등록 브랜치에서 diff 추가 줄과 1 MB 이하 텍스트 새 파일의 비밀 패턴을 검사한다. 큰 파일·바이너리는 이름만 원장에 남기고, `.pi/`를 add에서 제외하며 변경이 없으면 안내 결과를 반환한다.

Codex 슬롯 거부는 `awaitingSlot`과 `wait: slot`을 남긴다. 위임을 시작하지 못한 정상 턴은 `paused(slot)`으로 멈추고, 워처가 60초 간격으로 소유자의 생존을 확인한다. 슬롯 해제 인박스 뒤 PICK의 RESUME으로 원래 task 또는 프로젝트 RESEARCH·REVIEW에 복귀한다. 두뇌는 `대기: 슬롯 codex`로 턴을 끝낸다.

두뇌 훅은 모든 상태에서 `branch -f/-D/-M/-C`, `branch --move --force/--copy --force`, `checkout -B`, `switch -C/--force-create`, `update-ref`, 인자 있는 `reset`, `rebase`, `filter-branch`, `reflog expire`, `fetch/push`의 `+` refspec, `merge -s ours/-X ours`(긴 옵션 포함)를 `[보호]`로 차단한다. 부모 검사는 내용을 버리는 ours 병합을 구분하지 못하므로 해당 훅 차단이 1차 방어다.
