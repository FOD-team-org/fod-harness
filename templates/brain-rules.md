하네스 상태·판단대기·인박스·원장 변경은 `fodh` CLI 로만 한다. 파일을 직접 편집하지 않는다.
프롬프트 맨 앞 `[인박스 <id>]` 항목은 모두 읽고 반영한 뒤, 턴을 끝내기 전에 반드시 `fodh inbox ack <id> [<id>…]` 를 실행한다. 상태 조회는 `fodh state get`
승인이 필요한 동작(훅 차단 포함)은 `fodh judgment add --title "<제목>" --background "<배경>" --options "선택1|선택2" --recommend "<추천>" --blocks <taskId> --reclaim` 로 등록하고(task 루프일 때), 프로젝트 단계면 `--blocks -` 로 등록한 뒤 `fodh state transition WAIT_JUDGMENT` 한다. 그 동작을 시도하지 않는다.
복구 모드 프롬프트가 오면 증거를 대조하고 `fodh ledger resolve <runId> <action> ok|fail --evidence …` 로 각 항목을 닫는다.
`codex` 를 직접 실행하지 않는다. `fodh codex …` 만 사용한다. 워크트리도 `fodh worktree create <T>` 로만 만든다. 위임 결과를 기다릴 때는 마지막 줄 앞에 `대기: 위임 3f2c…` 를 적는다.
비밀값을 출력·기록하지 않는다. 승인 필수 동작을 임의로 진행하지 않는다.
개인정보·약관·결제 정책 문서를 바꿀 때는 판단대기에 먼저 올린다.
턴 마지막 줄에 `상태: <현재 fodh state>` 를 적는다. 사용자의 채팅 답을 기다려야 하면 그 앞 줄에 `대기: 사용자` 를 적는다.

위임 대기 표지의 `3f2c…`는 예시다. 실제 반환된 runId 전체를 꺾쇠 없이 쓰고, 표지는 마지막 비어 있지 않은 3줄 안에 둔다.
`--wait`가 진행 중 오류, 시간 초과, 중단 등 어떤 이유로든 결과 없이 끝나면 stderr의 `{"runId"}` 줄 또는 `fodh codex status`의 `delegation.runId`로 `대기: 위임 3f2c…`를 쓰고 턴을 끝낸다. `3f2c…` 대신 실제 runId 전체를 쓰며, `--wait`를 다시 부르지 않는다.

사용자 표지 `대기: 사용자`는 본문 어느 줄이든 인정한다. 위임 표지는 마지막 비어 있지 않은 3줄 안에 쓴다.

정리는 `fodh cleanup run`, 검증은 `fodh verify run`을 사용한다. 전체 테스트·전체 빌드는 VERIFY의 `fodh verify run --heavy`만 허용한다. 메모리 중단 중에는 새 위임을 시작하지 않는다. 로컬 알림은 `fodh notify send --title … --body …`로 보낸다.

하네스 스킬(fodh-workflow 등)이 있으면 막힐 때 먼저 읽는다.
