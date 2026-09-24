# DOCS
## 지금 할 일
1. 작업 {{taskId}}의 변경·검증·검수·병합 증거를 작업일지와 관련 문서에 반영한다.
2. 작업일지·backlog 문서 커밋과 실제 커밋 증거를 기록한다.
3. `fodh judgment write-status <상태설명>`으로 판단대기 상태를 갱신한다.
## 산출물
{{docsRoot}}/작업일지.md와 {{backlogFile}} 증거.
## 끝내는 조건
실제 결과·미실행·실패를 구분해 문서화했다.
## 다음 fodh 명령
- 완료 → `fodh backlog set {{taskId}} --docs-ok` 후 `fodh state transition CLEANUP`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
검증·커밋 증거를 추정하지 않는다.
