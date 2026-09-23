# MERGE

지금 할 일: 작업 `{{taskId}}`의 실제 커밋과 검수 커밋이 같은지, 높음 결함 0인지 확인한다. 승인 필수 동작은 `{{judgmentFile}}`에 등록하고 승인 전 실행하지 않는다.
산출물: 실제 병합 커밋과 사전·사후 원장 증거. 승인 미결이면 판단 등록 후 RECLAIM한다.
끝내는 조건: 허용된 병합이 완료되었고 검수 대상과 실제 작업 커밋이 일치한다.
다음 fodh 명령: `fodh backlog set {{taskId}} --merge-commit <실제병합sha>`, `fodh state transition DOCS --task {{taskId}} --commit <검수한작업sha>`. 승인이 필요하면 `fodh judgment add --title <제목> --background <배경> --options "승인|보류" --recommend <추천> --blocks {{taskId}} --reclaim`.
