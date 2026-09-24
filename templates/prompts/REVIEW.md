# REVIEW
## 지금 할 일
1. `fodh state get`으로 프로젝트 또는 task 검수를 구분한다.
2. task면 `fodh docs scaffold review-request --task {{taskId}}`와 `fodh docs scaffold review --task {{taskId}}`, 프로젝트면 `fodh docs scaffold review-request --subject 프로젝트`와 `fodh docs scaffold review --subject 프로젝트`를 만든다. 이미 있으면 기존 파일을 고친다.
3. task는 `fodh backlog get {{taskId}}`로 delegate·워크트리·SHA를 확인한다.
4. codex 산출물(delegate 없으면 codex)은 설정의 Claude Agent로 읽기 전용 검수한다.
5. claude 산출물 또는 프로젝트 문서는 `fodh codex review --spec <검수 요청 파일> --wait`로 읽기 전용 위임한다. task면 --task와 등록 워크트리 --cwd를 명시한다.
6. codex review 결과의 lastMessage를 {{docsRoot}}/검수/…-검수.md(scaffold 결과 path)에 저장한다.
`codex 슬롯 사용 중` 오류면 다른 방법을 찾지 말고 `대기: 슬롯 codex`로 턴을 끝낸다(가짜 runId 금지).
## 산출물
{{docsRoot}}/검수/: 대상 SHA·모델·effort·서브에이전트 모델·심각도·파일:줄·재현·수정안·APPROVE 또는 REQUEST_CHANGES.
## 끝내는 조건
실제 교차검수 완료·높음 0·대상 SHA 일치.
## 다음 fodh 명령
- task 통과 → `fodh backlog set {{taskId}} --review-commit <sha> --review-high 0` 후 `fodh state transition MERGE --task {{taskId}}`
- task 반려 → `fodh state transition FIX --task {{taskId}}`; 승인 필요 → `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks {{taskId}} --reclaim`
- 프로젝트 통과 → `fodh state transition PROJECT_READY` 이후 `대기: 사용자` 로 턴을 끝낸다; 질문 추가 → `fodh interview add --area NN --text "<질문>" --must` 후 `fodh state transition INTERVIEW`
- 프로젝트 미결 → `fodh state transition WAIT_JUDGMENT`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
검수자 소스 수정·git·전체 테스트/빌드·비밀값·외부 발송 금지. --wait 무결과면 stderr runId 또는 `fodh codex status`로 `대기: 위임 <runId>` 후 종료하고 재호출하지 않는다.
