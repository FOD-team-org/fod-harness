---
name: fodh-review-checklist
description: 산출물을 교차검수할 때 대상 SHA와 결함 근거 및 판정을 기록한다.
---

# 교차검수
`fodh docs scaffold review-request --task <T>`와 `fodh docs scaffold review --task <T>`를 만든다. 프로젝트 문서는 --task 대신 --topic을 쓴다.
Claude 산출물은 `fodh codex review --spec <요청파일>`로 읽기 전용 검수한다.
Codex 산출물은 설정의 Claude 검수 Agent로 읽기 전용 검수한다.
머리에 대상 커밋 SHA·모델·effort·서브에이전트 모델을 기록한다.
높음: 핵심 동작 실패·데이터 손실. 중간: 제한된 조건의 기능 결함. 낮음: 사용성·유지보수 문제.
각 결함에 파일:줄, 재현 입력·순서, 실제 결과와 기대 결과, 수정안을 쓴다.
판정은 APPROVE 또는 REQUEST_CHANGES. 미실행 검증을 명시한다.
대상 SHA가 바뀌면 통과를 재사용하지 않는다. 높음 0 증거가 있어야 다음 단계로 간다.
