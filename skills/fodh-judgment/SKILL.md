---
name: fodh-judgment
description: 유한 선택지나 승인 필수 동작 때문에 진행이 막혔을 때 판단대기 항목을 등록한다.
---

# 판단대기
서술형 인터뷰는 채팅으로 묻고 `대기: 사용자`로 멈춘다. 유한 선택지·승인·미결 사항은 판단대기에 등록한다.
인터뷰 문항은 `fodh interview defer <ID>`를 쓴다.
그 외는 `fodh judgment add --title <제목> --background <배경> --options "선택1|선택2" --recommend <추천과 이유> --blocks <T> --reclaim`.
작업이 없는 프로젝트 단계는 --reclaim 없이 `--blocks -`로 등록하고 `fodh state transition WAIT_JUDGMENT`.
답은 번호 하나 또는 자유 서술. 승인 동작은 번호나 승인/진행 토큰이 있어야 한다. 조건부 답은 조건을 함께 보존한다.
모호한 답이나 질문 rev 불일치는 재질문하며 임의 승인하지 않는다. `fodh judgment read --answered` 후 `fodh judgment apply`로 적용한다.
판단 파일을 직접 편집하여 항목을 만들거나 완료 처리하지 않는다.
