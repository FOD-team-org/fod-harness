# MERGE
## 지금 할 일
1. `fodh backlog get {{taskId}}`으로 실제 커밋·검수 커밋 일치와 높음 0을 확인한다.
2. 승인 필수 동작은 {{judgmentFile}}에 등록한다.
3. 허용된 병합의 실제 커밋과 사전·사후 원장을 기록한다.
## 산출물
실제 병합 커밋과 증거.
## 끝내는 조건
허용된 병합 완료·검수 대상과 실제 작업 SHA 일치.
## 다음 fodh 명령
- 완료 → `fodh backlog set {{taskId}} --merge-commit <실제병합sha>` 후 `fodh state transition DOCS --task {{taskId}} --commit <검수한작업sha>`
- 승인 필요 → `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks {{taskId}} --reclaim`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
승인 미결 동작을 실행하지 않는다.
