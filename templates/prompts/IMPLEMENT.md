# IMPLEMENT
## 지금 할 일
1. `fodh backlog get {{taskId}}`으로 작업을 확인한다.
2. `fodh config get delegate`로 라우팅을 확인한다.
3. git 프로젝트면 `fodh worktree create {{taskId}}` 가 **필수**다(없으면 `codex task` 가 거부된다). 비-git 만 루트 폴백.
4. design은 `fodh backlog set {{taskId}} --delegate claude` 후 Claude Agent(model: delegate.claude.subagentModel)로 등록 워크트리에 위임한다. Agent에게 "하네스 두뇌 세션 전용. 위임 수행자(Codex·Claude Agent)는 위임 프롬프트를 따르고 이 흐름표의 fodh 명령을 치지 않는다"를 명시한다.
5. 그 외는 `fodh codex task --task {{taskId}} --spec <위임스펙 파일> --title "<제목>"`로 위임한다.
6. 실제 runId 전체로 `대기: 위임 <runId>`를 마지막 비어 있지 않은 3줄 안에 쓰고 턴을 끝낸다.
7. 재개 후 `fodh codex result <runId>`로 성공·수용 기준·미완을 확인한다.
`codex 슬롯 사용 중` 오류면 다른 방법을 찾지 말고 `대기: 슬롯 codex`로 턴을 끝낸다(가짜 runId 금지).
## 산출물
구현 결과·변경 파일·검증 수치·미완.
## 끝내는 조건
실제 구현과 수용 기준을 확인했다.
## 다음 fodh 명령
- 완료 → `fodh state transition VERIFY --task {{taskId}}`
- 보완 → `fodh docs scaffold fix-spec --task {{taskId}}` 후 `fodh codex task --task {{taskId}} --spec <수정 파일> --resume last`
- 판단 필요({{judgmentFile}}) → `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks {{taskId}} --reclaim`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
Claude Agent에도 워크트리 범위·git·전체 테스트/빌드·비밀값·산출물 금지와 동시 자식 한도를 명시한다. 두뇌는 루트 cwd 유지.

`--wait` 는 포그라운드로만 쓴다. Bash `run_in_background` 로 돌리지 않는다(턴 종료 시 프로세스 트리가 죽는다). 결과가 안 오면 `대기: 위임 <runId>` 로 턴을 끝낸다.
위임은 `fodh codex task` 또는 Claude Agent 로만 한다. `codex`·companion 스크립트·플러그인 도구 직접 호출 금지
`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add`
