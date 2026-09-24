# IMPLEMENT

두뇌는 소스 파일을 쓰지 않는다. Write/Edit 로 `src/`·`test/` 등 프로젝트 소스를 만들면 안 되고, 오직 `fodh` 명령과 위임스펙·판단 문서만 쓴다.

지금 할 일: `fodh backlog get {{taskId}}`로 분류·위임스펙을 확인한다. `fodh config get delegate`의 라우팅을 참고한다. 기본 design은 Claude Agent(`model: delegate.claude.subagentModel`), 그 외는 Codex다. 두뇌가 직접 구현하지 않는다.
1. `fodh worktree create {{taskId}}`로 작업 폴더를 만든다. git 저장소가 아니면 그대로 `fodh codex task`를 진행한다(루트 폴백, 결과 worktree:null).
2. 워크트리를 만들었고 design이면 `fodh backlog set {{taskId}} --delegate claude` 후 Claude Agent로 워크트리 안에서 구현한다. Agent 프롬프트에 워크트리 경로·범위 밖 쓰기 금지·git 금지·전체 테스트/빌드 금지·비밀값 및 산출물 금지, 설정의 동시 자식 한도를 명시한다. design 구현이 완료되면 `fodh state transition VERIFY --task {{taskId}}`로 전이한다.
3. 그 외(비-git 포함)는 `fodh codex task --task {{taskId}} --spec <위임스펙 파일> --title "<제목>"`로 위임한다. 반환된 runId를 사용하여 마지막 상태 줄 앞에 `대기: 위임 3f2c…`를 적고 턴을 끝낸다.
4. `codex-done` 인박스로 재개되면 `fodh codex result <runId>`를 읽는다. 실행 성공과 수용 기준을 확인하고 미완이 없으면 `fodh state transition VERIFY --task {{taskId}}`. 보완 요구는 `docs/위임스펙/<날짜>-{{taskId}}-수정.md`에 쓰고 `fodh codex task --task {{taskId}} --spec docs/위임스펙/<날짜>-{{taskId}}-수정.md --resume last`로 같은 스레드에 위임하고 다시 대기한다.
산출물: 실제 구현 결과·변경 파일·검증 수치·미완 항목. 구현 완료나 검증 증거를 추정하여 기록하지 않는다.
판단이 필요하면 `{{judgmentFile}}`에 `fodh judgment add … --blocks {{taskId}} --reclaim`으로 등록한다.

위임 대기 표지의 `3f2c…`는 예시다. 실제 반환된 runId 전체를 꺾쇠 없이 쓰고, 표지는 마지막 비어 있지 않은 3줄 안에 둔다.
