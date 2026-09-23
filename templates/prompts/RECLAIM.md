# RECLAIM

지금 할 일: 작업 `{{taskId}}`를 막는 `{{judgmentFile}}`의 A번호를 확인하고 작업 소유 프로세스를 회수한다. 워크트리·검수 증거를 보존한다.
산출물: non-brain 소유 프로세스 잔존 0, blocked(A번호) 상태.
끝내는 조건: 회수 결과가 확인되었다. 실패면 CLEANUP_FAILED를 보존하고 후속 작업을 시작하지 않는다.
다음 fodh 명령: `fodh reclaim --task {{taskId}} --judgment <A번호>`; 성공하여 PICK이면 `fodh pick`.
