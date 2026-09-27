# VERIFY
## 지금 할 일
1. git 프로젝트는 먼저 `fodh worktree commit {{taskId}} -m "{{taskId}} 구현"`을 실행한다(`-m` 은 반드시 붙인다. 실패하면 출력의 `error` 를 그대로 읽는다). "커밋할 변경이 없습니다"는 무시하고 진행한다(비-git은 생략).
2. 프로젝트 루트를 유지하고 `fodh verify run`으로 verify.commands를 실행한다. cwd는 현재 task 워크트리(없으면 루트), 증거의 realpath가 해당 경로와 정확히 일치해야 REVIEW로 전이한다.
3. 전체 테스트·전체 빌드는 verify.heavy에 설정하고 `fodh verify run --heavy`로만 실행한다. 같은 프로젝트의 Codex 슬롯과 배타다.
4. `fodh verify run` 은 verify.commands 가 비어 있으면 스택을 감지해 설정을 채우고 이어서 실행한다(원장 `verify:auto-config`). 검증 설정 때문에 판단을 올리지 않는다. 오류가 `자동 감지된 스택이 없습니다` 또는 `검증 명령 감지 실패` 일 때만 `fodh judgment add --title "<검증 판단>" --background "<감지 실패 증거>" --options "설정·범위 결정|보류" --recommend "<추천>" --blocks {{taskId}}` 로 설정을 요청한다. heavy 가 비어 있다는 건너뜀 응답은 판단 사유가 아니다.
명령은 셸(`/bin/sh -c`)로 task 워크트리 루트에서 실행된다. 하위 폴더 명령은 설정에 `cd <폴더> && …` 로 들어 있다.
Git 자동 설정은 커밋된 내용 기준이다. 새 테스트·스크립트는 커밋 뒤 다음 일반 검증에서 자동 추가된다. `등록 워크트리에서 git 정보를 읽을 수 없습니다` 오류면 .git 과 HEAD 및 원래 저장소의 공통 Git 디렉터리 연결을 확인한다. skip-worktree 항목은 파일이 없어도 dirty이며 sparse checkout은 지원하지 않는다. 새로 고침 감지·쓰기 오류는 원장 경고로 남기고 기존 설정으로 실행한다. 사용자 `--approve`도 HEAD를 읽으므로 미커밋 내용으로 설정하려면 먼저 커밋한다.
자동 설정(표지 있음)의 명령이 도구·환경 문제로 실패하고 감지 결과가 달라질 여지가 있으면 `fodh verify detect --apply` 를 먼저 쓴다. `--cwd` 를 붙이지 않는다. 사용자 설정이면 지금처럼 판단을 요청한다. `깨끗한 작업 트리` 오류면 커밋 뒤 다시 실행한다. `현재 검증 명령을 줄입니다` 오류면 `fodh judgment add --title "<검증 명령 축소>" --background "<빠진 명령·감지 증거>" --options "축소 승인|현재 설정 유지" --recommend "사용자가 fodh verify detect --apply --approve 로 반영" --blocks {{taskId}}` 로 사용자 판단을 요청한다.
5. interrupted가 있으면 코드 결함으로 보지 말고 검증을 다시 실행한다.
## 산출물
명령·결과·실패 증거·.pi/verify 로그·peak RSS·스왑·실제 작업 커밋.
## 끝내는 조건
필수 검증이 모두 통과하거나 실패 원인이 명확하다.
## 다음 fodh 명령
- 통과 → `fodh state transition REVIEW --task {{taskId}}`(하네스가 cwd·clean 증거를 검사한다). 검수 커밋은 verify.head와 같아야 한다(비-git은 none).
- 실패 → `fodh state transition FIX --task {{taskId}}`; repair 초과면 판단 등록 후 `fodh reclaim --task {{taskId}} --judgment <A번호>`
- 같은 원인의 열린 판단이 있으면 `fodh judgment add --same-as A<n> --blocks {{taskId}}` 으로 붙인다(repair 초과로 회수할 때만 `--reclaim`).
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
실패한 검사를 범위 밖으로 제외하려면 `fodh judgment add --title "<검증 판단>" --background "<설정 또는 실패 증거>" --options "설정·범위 결정|보류" --recommend "<추천>" [--detail <문서>] --blocks {{taskId}}`로 사용자 판단을 받는다(두뇌가 면제하지 않는다). 미실행 검사를 통과로 쓰지 않는다. 전체 스위트는 예외 없이 heavy 경로.
`대기: 사용자` 는 쓰지 않는다. 사용자 결정은 `fodh judgment add … --blocks {{taskId}} --reclaim`
