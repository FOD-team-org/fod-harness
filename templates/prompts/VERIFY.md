# VERIFY

지금 할 일: 프로젝트 루트를 유지한 채 `fodh verify run`으로 verify.commands를 실행한다. 실행 위치는 현재 task 워크트리(없으면 루트), 필요하면 `--cwd <등록된 경로>`를 쓴다. 전체 테스트·전체 빌드는 verify.heavy에 설정하고 반드시 `fodh verify run --heavy`로 실행한다. 이 경로는 Codex 위임과 머신 전체 배타 슬롯을 사용한다.
설정이 비어 있으면 스펙의 관련 검증 명령을 `(cd <워크트리> && <명령>)`으로 직접 실행할 수 있다. 전체 스위트는 예외 없이 --heavy 경로만 사용한다. 실행하지 않은 검사를 통과로 기록하지 않는다.
검증 결과에 `interrupted`가 있으면 코드 결함으로 보지 말고 검증을 다시 실행한다.
산출물: 실행 명령·결과·실패 증거·로그(.pi/verify)·peak RSS·스왑 표본과 실제 작업 커밋.
끝내는 조건: 필수 검증이 모두 통과하거나 실패 원인이 명확하다.
다음 fodh 명령: 통과하면 `fodh backlog set {{taskId}} --verify-ok` 후 `fodh state transition REVIEW --task {{taskId}}`; 실패하면 `fodh state transition FIX --task {{taskId}}`. repair 초과 반환이면 판단 등록 후 `fodh reclaim --task {{taskId}} --judgment <A번호>`.
