# SPEC

지금 할 일: `fodh backlog get {{taskId}}`으로 작업을 확인하고 무엇·왜·수용 기준·수정 파일·검증법·금지 사항을 명시한다.
산출물: `docs/위임스펙/`의 작업 `{{taskId}}` 스펙. 재개 시 기존 스펙과 검수 증거를 먼저 확인한다.
끝내는 조건: 위임 범위와 검증이 구체적이고 승인 미결이 없다. 스펙을 개정했으면 spec.rev를 올리고 repair를 0으로 기록한다.
다음 fodh 명령: `fodh backlog set {{taskId}} --spec-rev <개정번호> --repair 0`, `fodh state transition IMPLEMENT --task {{taskId}}`. 판단이 필요하면 `fodh judgment add --title <제목> --background <배경> --options "선택1|선택2" --recommend <추천> --blocks {{taskId}} --reclaim`.
