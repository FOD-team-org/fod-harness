# DOCS

지금 할 일: 작업 `{{taskId}}`의 변경·검증·검수·병합 증거를 작업일지와 관련 문서에 반영한다. 판단대기 상태는 CLI로 갱신한다.
산출물: `docs/작업일지.md` 및 관련 문서, `{{backlogFile}}`의 증거.
끝내는 조건: 실제 결과가 문서에 반영되었고 미실행·실패를 구분했다.
다음 fodh 명령: `fodh judgment write-status <상태설명>`, `fodh backlog set {{taskId}} --docs-ok`, `fodh state transition CLEANUP`.
