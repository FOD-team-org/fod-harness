# CLEANUP
## 지금 할 일
1. `fodh state get`의 pendingReclaim을 확인하고 있으면 `fodh reclaim --task <T> --judgment <A>`로 재시도하고 반환 상태를 따른 뒤 턴을 끝낸다.
2. pendingReclaim이 없으면 `fodh cleanup run --task {{taskId}} --scope all`로 정리한다.
3. 프로세스·저장공간·워크트리 결과와 residual을 확인한다.
4. 실패 원인과 각 범위 결과를 보존한다.
## 산출물
.pi/cleanup-last.json과 잔존 수·보호·stale 기록.
## 끝내는 조건
전체 정리 성공과 DoD 6항을 확인했다.
## 다음 fodh 명령
- 성공 → `fodh backlog set {{taskId}} --cleanup-ok` 후 `fodh backlog set {{taskId}} --status done` 후 `fodh state transition PICK`
- 첫 실패 → `fodh state transition CLEANUP_FAILED` → `fodh state transition CLEANUP --task {{taskId}}` 후 `fodh cleanup run --task {{taskId}} --scope processes` 1회 재시도
- 재실패 → `fodh state transition CLEANUP_FAILED`(paused(cleanup)); 원인 판단 등록
- 첫 실패가 storage·worktrees였으면 processes 성공만으로 끝내지 말고 원인을 `fodh judgment add --title "<정리 실패>" --background "<원인>" --options "재시도|보류" --recommend "<추천>" --blocks {{taskId}}`로 등록하고 `대기: 사용자`.
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
sharedCaches는 보고만. 저장공간·워크트리 실패를 processes 성공으로 덮지 않는다. 연속 실패는 paused(cleanup)+알림에 맡긴다.
