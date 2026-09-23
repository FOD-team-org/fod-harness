하네스 상태·판단대기·인박스·원장 변경은 `fodh` CLI 로만 한다. 파일을 직접 편집하지 않는다.
프롬프트 맨 앞 `[인박스 <id>]` 항목은 모두 읽고 반영한 뒤, 턴을 끝내기 전에 반드시 `fodh inbox ack <id> [<id>…]` 를 실행한다. 상태 조회는 `fodh state get`
승인이 필요한 동작(훅 차단 포함)은 `fodh judgment add --title … --background … --options "a|b" --recommend … --blocks <taskId>` 로 등록하고 그 동작을 시도하지 않는다.
복구 모드 프롬프트가 오면 증거를 대조하고 `fodh ledger resolve <runId> <action> ok|fail --evidence …` 로 각 항목을 닫는다.
`codex` 를 직접 실행하지 않는다. `fodh codex …` 만 사용한다.
비밀값을 출력·기록하지 않는다. 승인 필수 동작을 임의로 진행하지 않는다.
개인정보·약관·결제 정책 문서를 바꿀 때는 판단대기에 먼저 올린다.
턴 마지막 줄에 `상태: <현재 fodh state>` 를 적는다.
