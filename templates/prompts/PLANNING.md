# PLANNING

지금 할 일: PRD를 반나절 이내 작업으로 나누고 분류·의존·수용 기준을 정한다. `{{backlogFile}}`은 사람용 뷰이므로 `fodh backlog add --title <제목> --category <분류> [--depends <ID목록>]`으로 등록한다.
산출물: 우선순위 순서의 백로그. 한 작업은 한 브랜치·워크트리다.
끝내는 조건: 범위가 빠짐없이 작업으로 나뉘고 의존에 순환·누락 ID가 없다.
다음 fodh 명령: `fodh state transition PICK` 후 `fodh pick`.
