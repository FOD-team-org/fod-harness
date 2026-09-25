# RECLAIM
## 지금 할 일
1. 작업 {{taskId}}를 막는 {{judgmentFile}}의 A번호를 확인한다. pendingReclaim이 있으면 같은 판단 번호를 쓴다.
2. `fodh reclaim --task {{taskId}} --judgment <A번호>`로 회수한다. 내부 공용 cleanup은 task 위임을 먼저 cancel하고 워크트리·검수 증거를 보존한다.
3. 판단이 없으면 `fodh judgment add --title "<판단 제목>" --background "<근거>" --options "진행|보류" --recommend "<추천>" --blocks {{taskId}} --reclaim` 한 번으로 등록·회수한다.
## 산출물
non-brain 소유 프로세스 잔존 0·blocked(A번호).
## 끝내는 조건
회수 결과가 확인됐다.
## 다음 fodh 명령
- 성공하여 PICK → `fodh pick`
- 실패 → `fodh cleanup report`로 잔존 확인
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
실패면 CLEANUP_FAILED를 보존하고 후속 작업을 시작하지 않는다.
`state transition RECLAIM` 은 쓰지 않는다. RECLAIM 에서는 기다리지 않는다. 사용자 입력이나 `/hold`로 명시적으로 멈춘 경우만 대기를 따른다.
