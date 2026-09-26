# 하네스 템플릿

| 경로 | 역할 |
|---|---|
| prompts/*.md | 상태별 두뇌의 다음 행동 |
| docs/** | fodh docs scaffold의 문서 뼈대 |
| interview/bank.md | 18 영역 필수·선택 질문 은행 |
| brain-rules.md | Claude 두뇌 공통 규칙 |
| codex-header.md | 수행자 프롬프트 앞의 범위·검증·금지 |
| claude-settings.json | 기존 Claude 훅 설정 원본 |

| 파일 종류 | 허용 치환 키 |
|---|---|
| prompts/*.md | taskId, judgmentFile, backlogFile, docsRoot, today, interviewSummary |
| docs/** | date, taskId, taskTitle, specRev, topic, subject, projectName, judgmentFile |
| codex-header.md | kind, runId, taskId, cwd, sandbox, readOnly, maxChildAgents, workerModel, workerEffort, kindFormat, spec |
| interview/bank.md 추천 | config:<점 표기 설정 키> |
| brain-rules.md, claude-settings.json | 치환 없음 |

프롬프트는 제목 뒤 `지금 할 일`, `산출물`, `끝내는 조건`, `다음 fodh 명령`, `금지`의 5절을 정확한 순서로 쓴다. 25줄 이하, 지금 할 일은 번호 목록으로 한 줄 한 동작이다. 다음 명령은 `- 조건 → 명령`이며 금지 첫 줄은 모든 상태에서 같다. INTERVIEW 요약은 지금 할 일 첫 항목에 표시한다. 나머지 상태에서는 interviewSummary가 빈 문자열이다.

은행 머리는 `## NN 이름`이며 설계의 01~18 영역 이름을 그대로 쓴다. 문항은 다음 둘 중 하나다.

```text
- [필수] Q03-01 | free | 질문 문장 | 추천: 기본값
- [선택] Q03-02 | choice: 선택1/선택2 | 질문 문장 | 추천: 선택1
```

추천에는 config 토큰만 허용한다. 기본 은행의 영역마다 필수 2~4개·선택 1~3개를 둔다. `.pi/interview-bank.md`는 같은 ID를 덮어쓰고 새 ID를 추가한다. 추가 은행은 필요한 영역만 쓸 수 있다. `fodh interview add`의 Qnn-xNN은 상태 파일에만 저장한다.

문서 재정의는 `.pi/templates/docs/` 아래 같은 상대 경로로 둔다. 알 수 없는 키나 필요한 빈 값은 파일을 쓰기 전에 실패한다. 기존 파일을 덮어쓰지 않는다. 기본 날짜는 KST이고 topic은 한글·영문·숫자·밑줄·하이픈 1~40자다. backlog는 docs/backlog.md 고정이다. 판단대기-항목.md는 참고용이며 항목 등록은 `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks -`만 사용한다.

새 템플릿을 추가하면 관련 테스트에서 5절·줄 수·금지 문장·허용 키·명령 표 일치를 확인한다. scaffold kind는 대상 경로·필수 인자·덮어쓰기 거부·재정의를 검사하고, 은행은 영역 수·문항 수·추천·파서 줄 번호·라운드/한도·판단 이관을 검사한다. CLI 명령을 늘릴 때 src/cli/commands.ts와 분기를 함께 바꾼다. src/cli/index.ts가 commandTable을 공개한다.

스킬은 package.json의 pi.skills로 Pi에 노출하고 `fodh skills install`로 프로젝트 .claude/skills에 복사한다. Pi 스킬 목록은 latestMessage만 보내는 Claude 두뇌에 전달되지 않는다. Claude의 실제 로드는 Fable 실기에서 system.init.skills·memory_paths로 확인한다.

인터뷰 next는 처리 전 라운드를 그대로 반환한다. choice는 next 안에서 판단대기로 넘겨 deferred로 반환하며 openRound에는 free만 남긴다. repeated:true면 횟수를 늘리지 않고 질문을 그대로 다시 보여 준 뒤 사용자 답을 기다린다. mustDefer는 필수, skipDue는 선택 한도이며 선택 한도는 skip으로 정리한다. 검수 scaffold는 프로젝트에 --subject, task에 --task를 쓰고, 반환 path를 그대로 사용한다. backlog/worklog는 명령이 채우므로 채울 것 안내문을 넣지 않는다.

## Claude 훅 설치

`claude-settings.json`을 프로젝트 `.claude/settings.json`에 설치한다(다른 사용자 설정은 보존). 기존 프로젝트는 `.claude/settings.json`을 새 템플릿으로 바꿔야 소음이 사라진다. doctor의 `claudeSettingsStale`는 옛 명령 경고다. 새 명령:

```sh
if [ -n "${FODH_PACKAGE_ROOT:-}" ]; then exec "$FODH_PACKAGE_ROOT/hooks/pretooluse.sh"; elif [ "${FODH_BRAIN:-}" = 1 ]; then echo "하네스 가드[보호]: FODH_PACKAGE_ROOT 없음" >&2; exit 2; else exit 0; fi
```

패키지 경로가 있으면 stdin을 그대로 훅에 전달한다. 경로 없는 두뇌는 exit 2, 일반 세션은 exit 0이다.
