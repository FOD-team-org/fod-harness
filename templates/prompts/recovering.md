# recovering

지금 할 일: `fodh ledger list --unknown`과 실제 증거를 대조한다. 성공 여부가 불명확한 동작을 다시 실행하지 않는다.
산출물: 각 미해결 원장의 커밋·위임 결과·워크트리·프로세스 근거.
끝내는 조건: unknown을 모두 증거로 해소했다. 자동 재개는 복구 진입당 1회뿐이므로 불확실하면 판단을 요청한다.
다음 fodh 명령: `fodh ledger resolve <runId> <action> ok|fail --evidence <증거>`; 모두 해소하면 `fodh state transition PICK` 또는 작업이 없으면 `fodh state transition IDLE`.
