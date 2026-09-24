# MERGE
## 지금 할 일
1. `fodh backlog get {{taskId}}`으로 `review.commit`과 `review.high = 0`을 확인한다.
2. worktree/branch를 확인하고(`fodh worktree list`로 등록 브랜치 확인), 프로젝트 루트(워크트리 아님)에서 `git merge --no-ff <task 브랜치>`를 실행한다.
3. `fodh backlog set {{taskId}} --merge-commit $(git rev-parse HEAD)`로 병합 증거를 기록한다.
4. `fodh state transition DOCS --task {{taskId}} --commit <review.commit>`으로 전이한다.
충돌·거부는 아래 판단 등록·회수 명령으로 회수한다.
## 산출물
실제 병합 커밋과 증거.
## 끝내는 조건
허용된 병합 완료·검수 대상과 실제 작업 SHA 일치.
## 다음 fodh 명령
- 완료 → `fodh backlog set {{taskId}} --merge-commit <실제병합sha>` 후 `fodh state transition DOCS --task {{taskId}} --commit <검수한작업sha>`
- 승인 필요 → `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks {{taskId}} --reclaim`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
승인 미결 동작을 실행하지 않는다.
review.commit 을 바꾸는 판단을 만들지 않는다.
`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim`
