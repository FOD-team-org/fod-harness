# FIX
## 지금 할 일
1. `fodh docs scaffold fix-spec --task {{taskId}}`로 만든다. 이미 있으면 기존 파일을 고친다.
2. `fodh backlog get {{taskId}}`로 실패 증거·repair·delegate를 확인한다.
3. scaffold 결과의 `path`를 `--spec`에 쓴다. Codex면 `fodh codex task --task {{taskId}} --spec <scaffold 결과의 path> --resume last`로 위임한다. codexThread가 없으면 --resume 없이 시작한다.
4. Claude면 설정의 Claude Agent로 등록 워크트리 안에서 수정 위임한다.
5. 실제 runId 전체로 `대기: 위임 <runId>`를 마지막 비어 있지 않은 3줄 안에 쓰고 재개 후 `fodh codex result <runId>`로 확인한다.
`codex 슬롯 사용 중` 오류면 다른 방법을 찾지 말고 `대기: 슬롯 codex`로 턴을 끝낸다(가짜 runId 금지).
## 산출물
실제 수정과 관련 검증 결과.
## 끝내는 조건
수정이 반영되었고 VERIFY→REVIEW로 복귀한다.
## 다음 fodh 명령
- 수정 완료 → `fodh state transition VERIFY --task {{taskId}}`
- repair 초과 → 판단 등록 후 `fodh reclaim --task {{taskId}} --judgment <A번호>`
- 같은 원인의 열린 판단이 있으면 `fodh judgment add --same-as A<n> --blocks {{taskId}} --reclaim` 으로 붙인다.
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
검증 interrupted는 코드 결함으로 보지 말고 재검증한다. 대상 SHA가 바뀌면 검수 통과 무효. 수행자 git·전체 테스트/빌드·비밀값 금지.

`--wait` 는 포그라운드로만 쓴다. Bash `run_in_background` 로 돌리지 않는다(턴 종료 시 프로세스 트리가 죽는다). 결과가 안 오면 `대기: 위임 <runId>` 로 턴을 끝낸다.
위임은 `fodh codex task` 또는 Claude Agent 로만 한다. `codex`·companion 스크립트·플러그인 도구 직접 호출 금지
`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim`
