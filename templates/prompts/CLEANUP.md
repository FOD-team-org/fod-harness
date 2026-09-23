# CLEANUP

지금 할 일: 먼저 `fodh state get`의 pendingReclaim을 확인한다. 있으면 일반 완료 처리를 하지 않고 기록된 taskId·judgmentId로 `fodh reclaim --task <taskId> --judgment <judgmentId>`를 다시 실행한다. 성공하면 blocked와 PICK이므로 이 턴의 CLEANUP을 끝낸다. pendingReclaim이 없는 정상 완료 경로에서는 `fodh cleanup report`로 작업 프로세스 레지스트리 잔존을 확인한다. P4 전에는 정리 실행이 스텁이다. 보호된 실행 중 brain은 별도 표시하며 정리 대상에서 제외한다. 워크트리·검수 증거를 임의로 삭제하지 않는다.
산출물: 프로세스 잔존 보고와 실제 정리 증거.
끝내는 조건: report의 ok가 true이며 정리 대상인 non-brain 잔존이 0이다. 실패나 미확인을 성공으로 기록하지 않는다.
다음 fodh 명령: 확인되면 `fodh backlog set {{taskId}} --cleanup-ok`, DoD 전체 충족 시 `fodh backlog set {{taskId}} --status done`, `fodh state transition PICK`, `fodh pick`. 잔존이 있으면 `fodh state transition CLEANUP_FAILED`.
