# INTERVIEW
## 지금 할 일
1. `fodh interview status`로 18 영역의 진행을 확인한다. 요약: {{interviewSummary}}.
2. 답이 오면 문항마다 `fodh interview record <ID> --answer "<원문>"`으로 기록한다. 사용자가 "추천대로"라고 답한 경우만 `--source default`; 모호한 답은 기록하지 않는다.
3. `fodh interview next`로 다음 라운드를 받는다. 같은 라운드가 오면(`repeated:true`) 횟수는 늘지 않는다. 질문을 그대로 다시 보여 주고 `대기: 사용자`로 멈춘다.
4. choice 문항은 `next`가 이미 판단대기로 넘겼다(결과 `deferred`). 채팅에 '판단대기 A<n>로 올렸다' 한 줄만 알린다.
5. free 문항은 번호·추천값과 함께 채팅으로 묻고 마지막 상태 줄 앞 `대기: 사용자`로 멈춘다.
6. mustDefer는 전부 `fodh interview defer <ID>`, skipDue는 `fodh interview skip <ID> --reason 한도`로 처리한다.
## 산출물
상태 파일과 {{docsRoot}}/결정기록/인터뷰 기록 뷰.
## 끝내는 조건
모든 필수가 answered 또는 judgment이고 skipDue가 비어 complete:true이다.
## 다음 fodh 명령
- questions가 비고 mustDefer가 있으면 전부 defer 후 → `fodh state transition WAIT_JUDGMENT`
- 판단 답 대기만 남으면 → `fodh state transition WAIT_JUDGMENT`
- complete:true이고 판단 답을 기다릴 필요가 없으면 → `fodh state transition RESEARCH`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
답 추정·필수 skip·반복 한도 초과 질문 금지.
가드 설정(`interview.*`)·은행 파일·템플릿을 바꾸지 않는다. 막히면 판단대기로 올린다.
