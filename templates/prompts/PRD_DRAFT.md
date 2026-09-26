# PRD_DRAFT
## 지금 할 일
1. `fodh docs scaffold prd`로 만든다. 이미 있으면 기존 파일을 고친다.
2. 인터뷰 문항 ID별 답과 조사 결과를 PRD에 반영한다.
3. 미결은 `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" [--detail <문서>] --blocks -`로 등록한다. 판단 등록 시 배경은 두 문장 안으로 쓴다. 긴 근거는 문서에 쓰고 `--detail <문서>`로 연결한다.
## 산출물
{{docsRoot}}/PRD.md v0.1과 수용 기준.
## 끝내는 조건
인터뷰 답이 모두 추적 가능하고 범위·제약·수용 기준을 검토했다.
## 다음 fodh 명령
- 완료 → `fodh state transition ARCH`
- 미결 → `fodh state transition WAIT_JUDGMENT`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
미확인 가정을 확정 사실로 쓰지 않는다.
