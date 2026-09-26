# DOCS
## 지금 할 일
1. `fodh docs scaffold worklog`로 오늘 파일을 열거나 만들고 작업 {{taskId}}의 변경·검증·검수·병합 증거를 작업일지와 관련 문서에 반영한다.
2. 작업일지·backlog 문서 커밋과 실제 커밋 증거를 기록한다.
3. `fodh judgment write-status <상태설명>`으로 판단대기 상태를 갱신한다.
## 산출물
{{docsRoot}}/작업일지/YYYY-MM-DD.md(KST 오늘 또는 어제, {{taskId}} 포함)와 JSON에 동기화된 {{backlogFile}} 증거.
## 끝내는 조건
실제 결과·미실행·실패를 구분해 문서화했다.
## 다음 fodh 명령
- 완료 → `fodh state transition CLEANUP`(하네스가 작업일지·백로그를 검사하고 docs.ok를 기록한다)
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
검증·커밋 증거를 추정하지 않는다.
`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim` 판단 등록 시 배경은 두 문장 안으로 쓴다. 긴 근거는 문서에 쓰고 `--detail <문서>`로 연결한다.
