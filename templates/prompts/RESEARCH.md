# RESEARCH

지금 할 일: 인터뷰에서 확인한 시장·경쟁·규제·기술 질문을 `docs/조사/<날짜>-질문.md`에 쓴다.
`fodh codex research --spec docs/조사/<날짜>-질문.md --title "<주제>"`로 위임한 뒤 마지막 상태 줄 앞에 `대기: 위임 3f2c…`를 적는다. 짧은 조사는 `--wait`를 쓴다.
재개 후 `fodh codex result <runId>`를 읽고 결과와 출처·미확인 사항을 `docs/조사/`에 저장한다. read-only 위임이므로 보고서 저장은 두뇌가 한다.
끝내는 조건: 요구된 조사와 근거 검토가 완료되었다.
다음 fodh 명령: 완료 시 `fodh state transition PRD_DRAFT`, 판단이 필요하면 `fodh state transition WAIT_JUDGMENT`.

`--wait`가 진행 중 오류, 시간 초과, 중단 등 어떤 이유로든 결과 없이 끝나면 stderr의 `{"runId"}` 줄 또는 `fodh codex status`의 `delegation.runId`로 `대기: 위임 3f2c…`를 쓰고 턴을 끝낸다. `3f2c…` 대신 실제 runId 전체를 쓰며, `--wait`를 다시 부르지 않는다.

위임 대기 표지의 `3f2c…`는 예시다. 실제 반환된 runId 전체를 꺾쇠 없이 쓰고, 표지는 마지막 비어 있지 않은 3줄 안에 둔다.
