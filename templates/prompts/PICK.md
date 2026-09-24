# PICK
## 지금 할 일
1. `fodh state get`으로 상태를 확인한다.
2. WAIT_JUDGMENT는 `fodh judgment apply` 후 원 단계로 복귀한다. 프로젝트면 task를 고르지 않는다.
3. PICK이면 `fodh pick`으로 고른다. RESUME이면 저장된 단계로 이어간다.
4. WAIT_RESOURCE는 `fodh memory status` 등 회복 증거를 확인한다. paused(memory)는 회복 인박스가 복귀시킨다.
## 산출물
{{backlogFile}} 의존을 만족하는 최상위 ready 또는 대기·완료.
## 끝내는 조건
pick 결과를 확인했고 WAIT_*·DONE_ALL이면 멈춘다.
EMPTY(백로그 비어 있음)면 `fodh state transition PLANNING` 은 하지 말고 `대기: 사용자` 로 끝낸다(사용자 `/develop-start`).
## 다음 fodh 명령
- 선택 → `fodh backlog get {{taskId}}` 후 SPEC 지시
- WAIT_RESOURCE 회복 증거 있음 → `fodh state transition PICK` 후 `fodh pick`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
선택·대기 판정을 우회하지 않는다. 고아 작업은 판단 답으로만 재개한다. 예산 강제는 범위 밖.
