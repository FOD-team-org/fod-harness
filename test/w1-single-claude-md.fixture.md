# W1 single repository

<!-- fodh:managed:begin v1 -->
하네스 두뇌 세션 전용. 위임 수행자(Codex·Claude Agent)는 위임 프롬프트를 따르고 이 흐름표의 fodh 명령을 치지 않는다.

- doctor 표식: FODH-DOC-3dd4e61e

이 블록은 `fodh claude-md generate` 가 관리합니다. 직접 고치지 마세요. 설정 해시: 3dd4e61e

## 역할
두뇌는 소스 파일을 쓰지 않는다. design → Claude Agent(opus), 그 외 → `fodh codex task`(gpt-6-sol). 인터뷰 가드: true.
| 분류 | 수행자 |
|---|---|
| design | claude |
| default | codex |

## 하네스 흐름
| 상태 | 다음 fodh 명령 |
|---|---|
| INTERVIEW | fodh interview next |
| RESEARCH | fodh docs scaffold research-q |
| PRD_DRAFT | fodh docs scaffold prd |
| ARCH | fodh docs scaffold arch |
| PLANNING | fodh docs scaffold backlog-draft |
| PICK | fodh pick |
| SPEC | fodh docs scaffold spec |
| IMPLEMENT·FIX | fodh codex task |
| VERIFY | fodh verify run · fodh verify detect |
| REVIEW | fodh docs scaffold review |
| MERGE | fodh worktree merge |
| DOCS | fodh backlog set |
| CLEANUP | fodh cleanup run |
| RECLAIM | fodh reclaim |
| WAIT_JUDGMENT | fodh judgment apply |
| recovering | fodh ledger list |
턴 끝: `대기: 사용자`, `대기: 위임 <runId>`(마지막 비어 있지 않은 3줄 안), 마지막 줄 `상태: …`. 멈춤 상태에서는 조건 해소 전 새 작업을 시작하지 않는다.

## 쓸 수 있는 fodh 명령
- fodh start
- fodh cleanup run
- fodh verify run
- fodh verify detect
- fodh memory status
- fodh notify send
- fodh codex status
- fodh codex result
- fodh codex cancel
- fodh slots status
- fodh worktree create
- fodh worktree commit
- fodh worktree merge
- fodh worktree remove
- fodh worktree list
- fodh config get
- fodh watch tick
- fodh watch status
- fodh state get
- fodh state await-user
- fodh state transition
- fodh backlog list
- fodh backlog sync
- fodh backlog get
- fodh backlog add
- fodh backlog set
- fodh cleanup report
- fodh judgment apply
- fodh judgment read
- fodh judgment add
- fodh judgment answer
- fodh judgment write-status
- fodh inbox list
- fodh inbox ack
- fodh ledger list
- fodh ledger resolve
- fodh proc list
- fodh codex task
- fodh codex review
- fodh codex research
- fodh doctor
- fodh pick
- fodh reclaim
- fodh interview start
- fodh interview next
- fodh interview record
- fodh interview defer
- fodh interview skip
- fodh interview add
- fodh interview status
- fodh docs scaffold
- fodh claude-md generate
- fodh skills install
- fodh skills status

## 백로그
분류: design, non-design, docs, research. 상태: ready, doing, verify, review, fix, merge, done, blocked(A번호).
DoD 6항: verify.ok, review.high=0, review.commit, merge.commit, docs.ok, cleanup.ok. 상태·증거는 CLI로만 쓴다.

## 검증
일반 명령: []
heavy 명령: [] — VERIFY의 `fodh verify run --heavy` 로만 실행.


## 금지·승인 필수
설정 requiresApproval: prod-migration, store-upload, payment, push-main, env-delete, external-send
1. 프로덕션 DB 마이그레이션
2. 프로덕션 데이터 삭제·이관
3. 스토어 업로드·심사 제출·답변
4. 결제·광고·구독 설정 변경
5. main 직접 push
6. push --force·브랜치·태그 삭제
7. 환경변수 삭제·비밀값 생성·회전
8. 프로젝트 밖 파일 삭제·대량 삭제(100+)
9. 유료 결제·플랜 변경·유료 리소스 생성
10. 도메인·DNS·인증서
11. 외부 발송(이메일·Slack 게시·SNS·고객 답변)
12. 프로덕션 배포(프로젝트별 해제 가능)
13. 사용자 계정 생성·삭제·권한
14. 약관 문안
15. 개인정보 문안
16. 시스템 설정(launchd·키체인·셸 프로필)
전체 테스트는 VERIFY만. codex·git worktree 직접 실행 금지. 비밀값 출력·기록 금지.


## 문서 위치
| 폴더 | 내용 |
|---|---|
| docs/판단대기.md | 판단대기: 열린 판단, 사용자만 답 |
| docs/판단기록/ | 판단기록: 지난 판단, 하네스만 씀 |
| docs/설계/ | 설계 문서 |
| docs/위임스펙/ | 위임스펙 문서 |
| docs/검수/ | 검수 문서 |
| docs/조사/ | 조사 문서 |
| docs/결정기록/ | 결정기록 문서 |
PRD: docs/PRD.md, 작업일지: docs/작업일지/YYYY-MM-DD.md
백로그: docs/backlog.md (고정), 판단대기: docs/판단대기.md


## 설치된 하네스 스킬
없음
<!-- fodh:managed:end -->
