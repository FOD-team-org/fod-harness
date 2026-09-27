# MERGE
## 지금 할 일
1. `fodh backlog get {{taskId}}`으로 `review.commit`과 `review.high = 0`을 확인한다.
2. `fodh worktree merge {{taskId}}`로 병합한다. 하네스가 task 레포의 기준 브랜치에 병합 커밋을 만들고 `merge.commit`을 기록한다. `git merge` 를 직접 치지 않는다. 비-git 프로젝트는 병합 없이 `fodh backlog set {{taskId}} --merge-commit none` 이다.
3. 출력에 `warnings`(추적 안 된 파일 등)가 있으면 DOCS 작업일지에 옮겨 적는다. 출력에 `error` 가 있으면 그 문구가 원인이다.
4. `fodh state transition DOCS --task {{taskId}} --commit <review.commit>`으로 전이한다.
병합 실패(충돌·기준 브랜치·미커밋 변경·커밋 훅 거부)는 재시도하거나 git 으로 정리하지 않고 아래 판단 등록·회수 명령으로 회수한다.
## 산출물
하네스가 만든 병합 커밋과 `merge.commit` 기록.
## 끝내는 조건
`fodh backlog get {{taskId}}` 에 `merge.commit` 이 있고, 검수 대상과 실제 작업 SHA 가 일치한다.
## 다음 fodh 명령
- 완료 → `fodh state transition DOCS --task {{taskId}} --commit <검수한작업sha>`
- 병합 실패·승인 필요 → `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" [--detail <문서>] --blocks {{taskId}} --reclaim` 판단 등록 시 배경은 두 문장 안으로 쓴다. 긴 근거는 문서에 쓰고 `--detail <문서>`로 연결한다.
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
승인 미결 동작을 실행하지 않는다.
review.commit 을 바꾸는 판단을 만들지 않는다.
`git merge`·`git merge --abort`·`git reset` 으로 병합하거나 실패한 병합을 정리하지 않는다.
`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim`
