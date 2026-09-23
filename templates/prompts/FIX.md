# FIX

지금 할 일: 작업 `{{taskId}}`의 실패 증거·검수 지적과 repair 횟수를 확인한다. P3 전까지는 수정 위임도 판단대기에 '위임 필요'로 등록하고 RECLAIM한다.
산출물: 수정 요구와 위임 판단. 실제 수정이 제공되면 해당 커밋과 검증 결과를 새로 확보한다.
끝내는 조건: 수정이 실제 반영되었으며 기존 검수의 커밋이 달라졌다면 통과를 재사용하지 않는다.
다음 fodh 명령: 위임이 필요하면 `fodh judgment add --title "위임 필요: {{taskId}} 수정" --background "P3 수정 위임 경로 미구현" --options "위임 준비 후 재개|범위 재검토" --recommend "위임 준비 후 재개" --blocks {{taskId}} --reclaim`; 실제 수정이 완료되면 `fodh state transition VERIFY --task {{taskId}}`. 반드시 VERIFY→REVIEW로 돌아간다.
