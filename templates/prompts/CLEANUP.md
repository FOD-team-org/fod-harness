# CLEANUP

지금 할 일: 먼저 `fodh state get`의 pendingReclaim을 확인한다. 있으면 기록된 taskId·judgmentId로 `fodh reclaim --task <taskId> --judgment <judgmentId>`를 재시도한다. 성공하면 blocked와 PICK이므로 이 턴을 끝낸다.
정상 완료 경로에서는 `fodh cleanup run --task {{taskId}} --scope all`을 실행하고 `.pi/cleanup-last.json`을 확인한다. 활성 위임·두뇌·neverKill은 보호하며 워크트리는 done이거나 현재 CLEANUP 작업을 --task로 지정했고 clean이면 함께 제거한다. 제거 실패·더러운 워크트리는 kept에 이유를 기록하고 나머지 정리를 계속한다. stale은 죽거나 재사용된 프로세스의 기록만 제거한 수이며 잔존 수에 포함하지 않는다. protected는 활성 verify·위임·두뇌 등 보호된 기록이다.
산출물: 프로세스·저장공간·워크트리 정리 보고서와 원장.
끝내는 조건: 결과 ok가 true이다. 실패·미확인을 성공으로 기록하지 않는다.
다음 fodh 명령: 성공하면 `fodh backlog set {{taskId}} --cleanup-ok`, DoD 전체 충족 시 `fodh backlog set {{taskId}} --status done`, `fodh state transition PICK`, `fodh pick`.
실패하면 `fodh state transition CLEANUP_FAILED`, `fodh state transition CLEANUP --task {{taskId}}` 후 `fodh cleanup run --task {{taskId}} --scope processes`를 딱 1회 재시도한다. 재실패하면 `fodh state transition CLEANUP_FAILED`로 paused(cleanup)+알림에 맡긴다. 최초 실패가 저장공간·워크트리였으면 processes 성공만으로 전체 성공을 기록하지 말고 원인을 판단대기에 등록한다.
