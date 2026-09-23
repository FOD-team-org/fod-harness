# REVIEW

지금 할 일: 먼저 `fodh state get`으로 프로젝트 검수인지 작업 `{{taskId}}`의 교차검수인지 확인한다. P3 전까지는 독립 검수 위임이 필요하면 판단대기에 '위임 필요' 항목을 만든다. 작업 검수는 `--blocks {{taskId}} --reclaim`으로 RECLAIM하고, 프로젝트 검수는 WAIT_JUDGMENT로 전이한다. 검수 증거를 만들었다고 추정하지 않는다.
산출물: `docs/검수/`의 실제 검수 결과와 대상 커밋 SHA, 높음 결함 수.
끝내는 조건: 실제 검수가 완료되고 높음 결함이 0이다.
다음 fodh 명령: 작업은 `fodh backlog set {{taskId}} --review-commit <sha> --review-high 0` 후 `fodh state transition MERGE --task {{taskId}}`; 반려 시 `fodh state transition FIX --task {{taskId}}`. 프로젝트는 `fodh state transition PROJECT_READY` 또는 추가 인터뷰를 위해 `fodh state transition INTERVIEW`. 미결이면 `fodh state transition WAIT_JUDGMENT`.
