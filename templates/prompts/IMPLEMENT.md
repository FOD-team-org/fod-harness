# IMPLEMENT

지금 할 일: 작업 `{{taskId}}`의 위임스펙과 분류를 확인한다. P3 전까지는 판단대기에 '위임 필요' 항목을 만들고 RECLAIM한다. `fodh codex`는 아직 없으므로 실행하지 않는다. 구현 완료나 검증 증거를 추정하여 기록하지 않는다.
산출물: `{{judgmentFile}}`의 위임 필요 항목과 보존된 작업 스펙.
끝내는 조건: 판단 등록과 소유 프로세스 회수, blocked 상태를 확인했다.
다음 fodh 명령: `fodh judgment add --title "위임 필요: {{taskId}}" --background "P3 구현 위임 경로 미구현" --options "위임 경로 준비 후 재개|작업 범위 재검토" --recommend "위임 경로 준비 후 재개" --blocks {{taskId}} --reclaim`.
