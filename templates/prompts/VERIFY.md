# VERIFY

지금 할 일: 작업 `{{taskId}}` 스펙의 빌드·테스트·lint를 실행하고 실제 결과를 확인한다. 실행하지 않은 검사를 통과로 기록하지 않는다.
산출물: 실행 명령·결과·실패 증거와 실제 작업 커밋.
끝내는 조건: 필수 검증이 모두 통과하거나 실패 원인이 명확하다.
다음 fodh 명령: 통과하면 `fodh backlog set {{taskId}} --verify-ok` 후 `fodh state transition REVIEW --task {{taskId}}`; 실패하면 `fodh state transition FIX --task {{taskId}}`. repair 초과 반환이면 판단 등록 후 `fodh reclaim --task {{taskId}} --judgment <A번호>`.
