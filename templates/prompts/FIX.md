# FIX

지금 할 일: `fodh backlog get {{taskId}}`로 실패 증거·검수 지적과 repair 횟수·delegate를 확인하고 `docs/위임스펙/<날짜>-{{taskId}}-수정.md`에 수정 요구를 쓴다.
Codex 구현 task는 `fodh codex task --task {{taskId}} --spec docs/위임스펙/<날짜>-{{taskId}}-수정.md --resume last`로 수정 위임한다. `task.codexThread`가 없으면 `--resume` 없이 새 스레드로 위임한다. 마지막 상태 줄 앞에 `대기: 위임 3f2c…`를 적고, 재개되면 `fodh codex result <runId>`를 확인한다.
Claude 구현 task는 Claude Agent(`model: delegate.claude.subagentModel`)로 등록 워크트리 안에서 수정한다. 작업 경로·git/전체 테스트/전체 빌드/비밀값/산출물 금지와 동시 자식 한도를 프롬프트에 명시한다.
검증 결과에 `interrupted`가 있으면 코드 결함으로 보지 말고 검증을 다시 실행한다.
산출물: 실제 수정과 관련 검증 결과. 대상 커밋이 달라지면 기존 검수 통과를 재사용하지 않는다.
끝내는 조건: 수정이 실제 반영되었다. `fodh state transition VERIFY --task {{taskId}}`로 반드시 VERIFY→REVIEW에 복귀한다. repair 초과면 판단 등록 후 `fodh reclaim --task {{taskId}} --judgment <A번호>`.

위임 대기 표지의 `3f2c…`는 예시다. 실제 반환된 runId 전체를 꺾쇠 없이 쓰고, 표지는 마지막 비어 있지 않은 3줄 안에 둔다.
