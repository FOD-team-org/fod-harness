# PICK

지금 할 일: 먼저 `fodh state get`을 읽는다. WAIT_JUDGMENT이면 `fodh judgment apply`로 답을 적용해야 복귀할 수 있다. 프로젝트 단계로 복귀한 경우 그 단계 작업을 이어가고 task 선택을 실행하지 않는다. task 루프이면 PICK으로 전이한 뒤 `fodh pick`을 실행한다. RESUME 결과면 저장된 단계에서 작업을 이어간다. 고아 작업은 하네스가 판단을 등록해 차단하며 판단 답으로만 재개한다.
산출물: `{{backlogFile}}`의 의존을 만족하는 최상위 ready 작업 또는 대기·완료 판정.
끝내는 조건: `fodh pick`의 결과를 확인했다. WAIT_*·DONE_ALL이면 자동으로 진행하지 않는다.
다음 fodh 명령: PICK 상태에서 `fodh pick`; 선택된 작업은 `fodh backlog get {{taskId}}`와 SPEC 지시를 따른다. 선택·대기 판정을 직접 우회하지 않는다.

WAIT_RESOURCE에서 메모리·예산이 회복됐다는 외부 증거를 확인한 경우에만 `fodh state transition PICK`으로 대기 원인을 해제하고 `fodh pick`을 실행한다. P4 전에는 자동 자원 측정을 하지 않는다.
