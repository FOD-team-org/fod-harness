# RESEARCH
## 지금 할 일
조사 주제는 인터뷰 핵심 결정에서 스스로 정한다(사용자에게 묻지 않는다). `fodh docs scaffold research-q --topic <슬러그>` 의 `--topic` 은 필수이고, `fodh codex research --spec <질문 파일> --wait` 의 `--spec` 도 필수다.
1. `fodh docs scaffold research-q --topic <주제>`로 질문을 만든다. 이미 있으면 기존 파일을 고친다.
2. scaffold 결과의 `path`를 `--spec`에 쓴다: `fodh codex research --spec <scaffold 결과의 path> --title "<주제>"`로 읽기 전용 조사 위임한다.
3. 반환 runId 전체로 `대기: 위임 <runId>`를 마지막 비어 있지 않은 3줄 안에 쓰고 턴을 끝낸다.
4. 재개 후 `fodh codex result <runId>`를 확인한다.
5. `fodh docs scaffold research-r --topic <주제>`에 근거·출처·미확인을 기록하고 검수한다.
## 산출물
{{docsRoot}}/조사/ 질문과 결과. read-only 위임이므로 보고서 저장은 두뇌가 한다.
## 끝내는 조건
시장·경쟁·규제·기술 질문의 조사와 근거 검토가 완료됐다.
## 다음 fodh 명령
- 완료 → `fodh state transition PRD_DRAFT`
- 판단 필요 → `fodh state transition WAIT_JUDGMENT`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
`--wait`가 결과 없이 끝나면 stderr runId 또는 `fodh codex status`로 대기하며 --wait를 재호출하지 않는다.
