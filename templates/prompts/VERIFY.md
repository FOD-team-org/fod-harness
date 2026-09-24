# VERIFY
## 지금 할 일
1. 프로젝트 루트를 유지하고 `fodh verify run`으로 verify.commands를 실행한다. cwd는 현재 task 워크트리(없으면 루트), 필요하면 --cwd를 쓴다.
2. 전체 테스트·전체 빌드는 verify.heavy에 설정하고 `fodh verify run --heavy`로만 실행한다. Codex 슬롯과 머신 전체 배타다.
3. 설정이 비면 스펙의 관련 검증만 `(cd <워크트리> && <명령>)`으로 실행한다.
4. interrupted가 있으면 코드 결함으로 보지 말고 검증을 다시 실행한다.
## 산출물
명령·결과·실패 증거·.pi/verify 로그·peak RSS·스왑·실제 작업 커밋.
## 끝내는 조건
필수 검증이 모두 통과하거나 실패 원인이 명확하다.
## 다음 fodh 명령
- 통과 → `fodh backlog set {{taskId}} --verify-ok` 후 `fodh state transition REVIEW --task {{taskId}}`
- 실패 → `fodh state transition FIX --task {{taskId}}`; repair 초과면 판단 등록 후 `fodh reclaim --task {{taskId}} --judgment <A번호>`
## 금지
두뇌는 소스 파일을 쓰지 않는다. Write/Edit 는 docs/·CLAUDE.md 에만, 구현은 위임한다.
미실행 검사를 통과로 쓰지 않는다. 전체 스위트는 예외 없이 heavy 경로.
