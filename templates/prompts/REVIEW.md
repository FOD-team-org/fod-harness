# REVIEW

지금 할 일: `fodh state get`으로 프로젝트 문서 검수인지 작업 `{{taskId}}`의 교차검수인지 확인하고, task면 `fodh backlog get {{taskId}}`로 delegate·워크트리·대상 커밋 SHA를 확인한다.
- task.delegate가 비어 있으면 codex로 간주한다. task.delegate가 codex면 Claude Agent(`model: opus`)가 읽기 전용으로 검수하여 `docs/검수/<날짜>-{{taskId}}-검수.md`를 쓴다. 워크트리 소스는 수정하지 않고 git·전체 테스트/빌드·비밀값·산출물·외부 발송을 금지한다.
- task.delegate가 claude이거나 프로젝트 문서 검수면 `fodh codex review --spec <검수 요청 파일> [--task {{taskId}}] --wait`를 쓴다. 작업 소스가 워크트리에 있으면 `--cwd <등록 워크트리>`를 명시한다. 결과의 lastMessage를 검수 문서로 저장한다.
산출물: `docs/검수/`에 대상 커밋 SHA·모델·effort·높음/중간/낮음 지적(파일:줄·재현·수정안)·APPROVE 또는 REQUEST_CHANGES. 검수 증거를 추정하지 않는다.
끝내는 조건: 실제 검수가 완료되고 높음 결함이 0이다.
다음 fodh 명령: 작업은 `fodh backlog set {{taskId}} --review-commit <sha> --review-high 0` 후 `fodh state transition MERGE --task {{taskId}}`; 반려 시 `fodh state transition FIX --task {{taskId}}`. 프로젝트는 `fodh state transition PROJECT_READY` 또는 추가 인터뷰를 위해 `fodh state transition INTERVIEW`. 프로젝트 미결이면 `fodh state transition WAIT_JUDGMENT`, task 판단은 `fodh judgment add … --blocks {{taskId}} --reclaim`.

`--wait`가 진행 중 오류, 시간 초과, 중단 등 어떤 이유로든 결과 없이 끝나면 stderr의 `{"runId"}` 줄 또는 `fodh codex status`의 `delegation.runId`로 `대기: 위임 3f2c…`를 쓰고 턴을 끝낸다. `3f2c…` 대신 실제 runId 전체를 쓰며, `--wait`를 다시 부르지 않는다.
