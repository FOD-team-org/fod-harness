# VERIFY
## 지금 할 일
1. git 프로젝트는 먼저 `fodh worktree commit {{taskId}} -m "{{taskId}} 구현"`을 실행한다(`-m` 은 반드시 붙인다. 실패하면 출력의 `error` 를 그대로 읽는다). "커밋할 변경이 없습니다"는 무시하고 진행한다(비-git은 생략).
2. 프로젝트 루트를 유지하고 `fodh verify run`으로 verify.commands를 실행한다. cwd는 현재 task 워크트리(없으면 루트), 증거의 realpath가 해당 경로와 정확히 일치해야 REVIEW로 전이한다.
3. 전체 테스트·전체 빌드는 verify.heavy에 설정하고 `fodh verify run --heavy`로만 실행한다. Codex 슬롯과 머신 전체 배타다.
4. 설정이 비면 `fodh judgment add --title "<검증 판단>" --background "<설정 또는 실패 증거>" --options "설정·범위 결정|보류" --recommend "<추천>" [--detail <문서>] --blocks {{taskId}}`로 사용자에게 verify.commands 설정을 요청하고 기다린다. 판단 등록 시 배경은 두 문장 안으로 쓴다. 긴 근거는 문서에 쓰고 `--detail <문서>`로 연결한다.
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
