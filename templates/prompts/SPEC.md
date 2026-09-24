# SPEC
## 지금 할 일
1. `fodh docs scaffold spec --task {{taskId}}`로 만든다. 이미 있으면 기존 파일을 고친다.
2. `fodh backlog get {{taskId}}`으로 범위·수용 기준·수정 파일·검증·금지를 명시한다.
3. 스펙을 개정했을 때만 `fodh backlog set {{taskId}} --spec-rev <n>`으로 올린다.
## 산출물
scaffold 결과의 `path`에 위임스펙을 채우고 구현 위임의 `--spec`에 같은 path를 쓴다.
## 끝내는 조건
위임 범위와 검증이 구체적이고 승인 미결이 없다.
## 다음 fodh 명령
- 완료 → `fodh state transition IMPLEMENT --task {{taskId}}`
- 판단 필요 → `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks {{taskId}} --reclaim`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
수행자에게 git·전체 테스트/빌드·비밀값·범위 밖 쓰기를 금지한다.

`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim`
