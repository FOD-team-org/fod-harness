---
name: fodh-workflow
description: 하네스 상태 진행이 막혔을 때 다음 명령과 대기·인박스 처리 규칙을 확인한다.
---

# 하네스 흐름
먼저 `fodh state get`으로 현재 상태를 확인한다.
| 상태 | 다음 명령 |
|---|---|
| INTERVIEW | `fodh interview next` |
| RESEARCH·PRD_DRAFT·ARCH·PLANNING·SPEC | `fodh docs scaffold <kind>` |
| IMPLEMENT·FIX | `fodh codex task --spec <파일>` 또는 design의 Claude Agent |
| VERIFY | `fodh verify run` |
| REVIEW | 만든 쪽과 다른 수행자에게 검수 위임 |
| MERGE | `fodh worktree merge <T>`(비-git 은 `fodh backlog set <T> --merge-commit none`) 뒤 `fodh state transition DOCS`, 실패 → `fodh judgment add … --blocks <T> --reclaim` |
| DOCS | 실제 증거를 `fodh backlog set <T>`에 기록 |
| CLEANUP | `fodh cleanup run` |
| PICK | `fodh pick` |
| recovering | `fodh ledger list --unknown` |
인박스는 반영 후 `fodh inbox ack <id>`로 확인한다.
TransitionError의 action과 가능한 전이를 읽고 누락 증거를 보충한다. interview면 `fodh interview next`, reclaim이면 판단 등록 후 `fodh reclaim --task <T> --judgment <A>`를 쓴다.
마지막 줄은 `상태: <현재 상태>`. 사용자 답을 기다리면 앞 줄에 `대기: 사용자`.
위임 대기는 마지막 비어 있지 않은 3줄 안에 `대기: 위임 <실제 runId 전체>`.
`--wait`가 결과 없이 끝나면 stderr runId 또는 `fodh codex status`로 확인하고 대기한다. 재호출하지 않는다.
두뇌는 구현하지 않는다. 소스는 등록 워크트리의 수행자에게 위임한다.

## 오토파일럿
추천은 실제로 고를 안의 번호로 시작한다(예: `① …`). 고를 수 없으면 `추천 없음 — 이유`로 쓴다. 승인 필수이거나 되돌리기 어렵거나 밖으로 나가는 동작은 `fodh judgment add … --requires-approval`로 등록한다. 승인 필수를 피하려고 낱말을 바꾸지 않고, 같은 질문을 제목만 바꿔 다시 올리지 않는다. 켜고 끄기는 사용자만 하며 두뇌가 직접 답하거나 적용하지 않는다.
