# PLANNING
## 지금 할 일
1. `fodh docs scaffold backlog-draft`로 만든다. 이미 있으면 기존 파일을 고친다.
2. `fodh claude-md generate`로 현재 규칙을 반영한다.
3. PRD를 반나절 이내 작업으로 나누고 분류·의존·수용 기준을 적는다.
4. `fodh backlog add --title <제목> --category <분류> --depends <ID목록>`으로 순서대로 등록한다.
## 산출물
{{backlogFile}} 백로그와 scaffold 결과의 `path`에 쓴 백로그 초안. 위임할 때도 반환된 path를 `--spec`에 쓴다.
## 끝내는 조건
범위 누락·의존 순환·누락 ID가 없다.
## 다음 fodh 명령
- 등록 완료 → `fodh state transition PICK` 후 `fodh pick`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
백로그 뷰를 직접 편집하지 않는다. 한 작업은 한 브랜치·워크트리.
