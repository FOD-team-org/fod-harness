# ARCH
## 지금 할 일
1. `fodh docs scaffold arch`로 만든다. 이미 있으면 기존 파일을 고친다.
2. `fodh claude-md generate`로 현재 규칙을 반영한다.
3. `fodh docs scaffold tools`로 도구·스킬·MCP 목록을 확정한다.
4. 아키텍처·문서 구조·저장소 구조와 설정을 문서화한다.
## 산출물
{{docsRoot}}/설계/아키텍처.md·도구-스킬-MCP.md와 .pi/harness.json 설정.
## 끝내는 조건
구조·공개 계약·도구 목록·권한·비용 근거를 검토했다.
## 다음 fodh 명령
- 완료 → `fodh state transition REVIEW`
- 미결 → `fodh state transition WAIT_JUDGMENT`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
MCP 설치·.mcp.json 생성은 이 단계에서 하지 않는다.
