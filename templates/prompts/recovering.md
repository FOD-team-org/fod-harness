# recovering
## 지금 할 일
1. `fodh ledger list --unknown`을 실제 증거와 대조한다.
2. `fodh ledger resolve <runId> <action> ok|fail --evidence <증거>`로 각 항목을 닫는다.
## 산출물
미해결 원장의 커밋·위임·워크트리·프로세스 근거.
## 끝내는 조건
unknown을 모두 실제 증거로 해소했다.
## 다음 fodh 명령
- 작업 있음 → `fodh state transition PICK`
- 작업 없음 → `fodh state transition IDLE`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
불명확한 동작을 다시 실행하지 않는다. 자동 재개는 복구 진입당 1회뿐이며 불확실하면 판단 요청.
