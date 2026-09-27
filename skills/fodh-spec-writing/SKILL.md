---
name: fodh-spec-writing
description: 구현 또는 수정 위임스펙을 쓸 때 범위와 수용 기준을 문서화한다.
---

# 위임스펙 작성
`fodh backlog get <T>` 후 `fodh docs scaffold spec --task <T>`로 시작한다. 이미 있으면 기존 문서를 수정한다.
수정 위임은 `fodh docs scaffold fix-spec --task <T>`를 쓴다.
기준·담당·제약, 범위 표, 수용 기준, 검증 명령, 금지, 결과 보고 형식을 채운다.
워크스페이스 모드면 스펙 머리에 대상 레포(`fodh backlog get <T>` 의 `repo`)와 그 레포의 검증 명령을 적는다. task 하나 = 레포 하나다. 다른 레포도 고쳐야 하면 이 스펙은 한 레포로 줄이고, 나머지는 `fodh backlog add --title <제목> --category <분류> --repo <이름> --depends <T>` 로 쪼갠다.
수용 기준은 입력·상황과 관측 가능한 결과를 함께 적는다. 파일 범위와 기존 동작 보존 조건을 적는다.
검증은 바뀐 테스트만 지정하고 전체 스위트는 VERIFY의 heavy 경로로 남긴다.
워크트리 경로, git·비밀값·외부 발송 금지, 자식 한도를 명시한다.
개정할 때만 `fodh backlog set <T> --spec-rev <n>`으로 개정 번호를 올린다.
