# WisePharm 하네스 이관 설계 v0.1 (2026-09-25)

- 근거: 판단 A18 "savit은 그대로 가고 wisepharm을 이관". 순서는 A14-b 보정 → 이 설계 확인(판단 A19~A22) → 이관.
- 사전 조사: 읽기 전용(파일·git 읽기만, 실행·쓰기 0). 세 레포 모두 작업 트리가 깨끗하고 main 위에 있다. 2026-09-16 뒤로 멈춰 있다.
- 이 문서를 쓰는 동안 WisePharm 레포는 건드리지 않았다. 레포 변경은 판단 답을 받은 뒤에만 한다.

## 1. 대상

| | web | backend | app |
|---|---|---|---|
| 경로 | `~/Desktop/chemical` | `~/Desktop/wisepharm-backend` | `~/Desktop/wisepharm-app` |
| 스택 | Next.js 16, Drizzle, Neon, Vercel | NestJS 11, Drizzle, Jest | Flutter 3.47.1, riverpod, OpenAPI 생성 패키지 |
| main push 결과 | **Vercel 운영 배포** | CI만 | CI만 |
| 검증 | test 러너 없음(`tsc --noEmit`, lint, PGlite `verify:*` 6종) | lint·build·test·test:infra·test:e2e·schema:check(모두 오프라인) | format·analyze·custom_lint·flutter test 1,703 |
| 루트 비밀 파일 | `.env`(운영 Neon URL 등), `.env.slack`, `neon_api.json` | 없음 | 없음 |
| 기존 원장 | DECISIONS 355KB·PROGRESS 193KB·WORKLOG 770KB·MINSEOK_TODO 87KB | PROGRESS 251줄·WORKLOG 111줄 | PROGRESS·WORKLOG |

세 레포 모두 repo-local 명의(FOD-team-org)와 이를 강제하는 pre-commit 훅이 있다. 하네스의 `fodh worktree commit` 은 레포 설정 명의를 쓰므로 그대로 맞는다. WisePharm 에서는 `git -c user.*`·`--author`·`--no-verify` 를 쓰지 않는다(각 레포 AGENTS 금지).

## 2. 레이아웃 — 레포마다 하네스 루트 1개, backend 부터

하네스는 루트 하나에 git 레포 하나를 전제로 한다. web 하나를 루트로 삼고 나머지 둘을 딸린 레포로 다루려면 하네스 코드를 크게 늘려야 한다. 그래서 레포마다 따로 루트를 두고, 한 번에 하나씩 옮긴다.

| 순서 | 레포 | 이유 |
|---|---|---|
| 1 파일럿 | backend | push 해도 배포가 없다. 운영 `.env` 가 없다. 검증이 완전 오프라인이고 CI와 1:1이다. 원장이 작고 원래 "백엔드 = Codex" 역할이라 하네스 흐름과 같다. |
| 2 | app | 배포는 없지만 flutter 가 무겁고, OpenAPI·web 스냅샷 의존과 Java·네트워크 codegen 이 있다. |
| 3 | web | main push = 운영 배포, 루트 `.env` = 운영 DB, 하네스 규칙에 안 걸리는 `db:migrate`·Slack 봇, 거대 원장, test 러너 없음. §6 하네스 보강과 web 판단이 끝난 뒤에 한다. |

- 워크트리: `worktrees.root` 는 기본값 `..` 로 둔다. 워크트리가 Desktop 형제가 되어야 `../chemical` 같은 상대경로가 풀린다. prefix 는 레포마다 다르게 한다(`wpb-wt-`·`wpa-wt-`·`wpw-wt-`). 같게 두면 세 루트가 모두 `Desktop/wt-T1` 을 만들려고 한다.
- 두뇌: Opus 5.5(`brain.model: "claude-opus-5-5"`, A14 추천). 하네스 기본값은 Fable 5.1 이므로 설정에 적는다.
- 한 번에 한 루트만 돌린다. 하네스 위임끼리는 Codex 1개 규칙을 전역 슬롯(`~/.pi/agent/fod-harness/slots.json`)이 루트를 넘어 지킨다. 하네스 밖 Codex(다른 Claude 세션·ChatGPT.app)는 슬롯이 모르므로, 하네스를 돌리는 동안에는 다른 곳에서 Codex 를 띄우지 않는다.

## 3. 레포를 넘나드는 작업

원본은 이렇게 정해져 있다: 스키마·디자인 토큰·규제 문구 = web, OpenAPI = backend.

1. web 에서 스키마·문구를 바꾼다. 운영 마이그레이션은 [승인] 판단을 거친다.
2. backend 에서 `schema:sync`·API 작업 후 `openapi:export` 를 한다.
3. app 에서 `sync_openapi`·`generate_api`·화면 작업을 한다.

각 스크립트는 다른 레포의 **main 체크아웃**을 읽는다. 진행 중인 워크트리는 읽지 않는다. `sync_openapi` 는 backend 작업 트리가 깨끗하기까지 요구한다. 그래서 규칙은 이렇다.

- 레포를 넘는 일은 레포별 task 로 나눈다. 앞 레포 task 가 MERGE 로 main 에 들어간 뒤에 다음 레포 task 를 시작한다.
- 다음 레포 task 가 앞 레포 변경을 기다리면, 그 레포 두뇌가 `fodh judgment add … --blocks <task>` 로 막아 둔다. 앞 레포가 끝났다는 확인은 사람이 답으로 준다(루트를 넘는 자동 알림은 없다).
- 레포를 넘는 백로그 항목은 사람이 레포별로 나눠 각 루트에 넣는다.

## 4. backend 파일럿

### 4-1. 준비(판단 A19~A22 답 뒤, 사용자 승인 범위 안)

1. backend 레포 main 에 넣을 변경(한 커밋, FOD-team-org 명의):
   - AGENTS.md 개정(A22): 역할 절(C1)·커밋 전 교차검수(C2)·Slack 게시(C3)·Co-Authored-By(C10)를 하네스 흐름으로 바꾼다. 규제·보안 규칙(C13)은 그대로 둔다. Codex 수행자가 워크트리에서 이 파일을 읽으므로 먼저 고쳐야 한다.
   - `docs/WORKLOG.md` 끝에 "2026-09-XX 부터 `docs/작업일지/`" 한 줄(A21).
   - `.gitignore` 에 하네스 항목(하네스가 첫 세션에 추가하는 것과 같은 줄).
   - `CLAUDE.md` 는 하네스가 관리 블록을 만든다(backend 에는 아직 없다).
2. `.pi/harness.json`(4-2), `docs/판단대기.md`(빈 틀), `docs/backlog.md`(4-3)를 만든다. IDLE → PLANNING 전이에는 `docs/backlog.md` 가 있어야 한다.
3. 사용자가 backend 루트에서 Pi 를 띄운다.

```sh
cd ~/Desktop/wisepharm-backend
export PI_SKIP_VERSION_CHECK=1
H=~/Desktop/fod-harness
pi -e $H/extensions/provider/index.ts -e $H/extensions/orchestrator/index.ts -e $H/extensions/watcher/index.ts --model claude-code/claude-opus-5-5
```

그다음 `/develop-start` 를 친다. 인터뷰·PRD 단계는 건너뛴다. 기존 `docs/ARCHITECTURE.md`·`docs/PROGRESS.md` 가 배경 문서다.

### 4-2. 설정 초안 `.pi/harness.json`

```json
{
  "brain": { "model": "claude-opus-5-5" },
  "delegate": { "codex": { "brainModel": "gpt-6-astra", "brainEffort": "high", "workerModel": "gpt-6-astra", "workerEffort": "high" } },
  "worktrees": { "root": "..", "prefix": "wpb-wt-", "links": ["node_modules"] },
  "verify": {
    "commands": ["npm run lint", "npm run build", "npm test", "npm run schema:check"],
    "heavy": ["npm run test:infra", "npm run test:e2e"],
    "timeoutMinutes": 40
  },
  "cleanup": {
    "rebuildablePaths": ["dist", "coverage"],
    "processes": { "killPatterns": ["jest", "flutter_tester", "GradleDaemon", "ts-node", "tsx", "pglite"] }
  },
  "approvalRules": [
    { "id": "db-migrate", "pattern": "^npm run db:migrate\\b|^drizzle-kit (?:migrate|push)\\b", "description": "DB 마이그레이션" },
    { "id": "maintenance", "pattern": "^npm run maintenance:", "description": "운영 DB 정리·파기" }
  ],
  "judgment": { "file": "docs/판단대기.md" },
  "claudeMd": { "targets": ["CLAUDE.md"] }
}
```

- Codex 모델: 현재 작업 규칙(gpt-6-astra high, fast 금지)에 맞춘다. 하네스 기본값은 수행자 gpt-6-sol xhigh 다. 바꾸려면 설정 한 줄만 고치면 된다.
- `worktrees.links`(H10)는 워크트리에 루트 `node_modules` 심볼릭 링크를 만든다. 워크트리에서 `npm install` 을 하면 링크가 바뀌므로 수행자 프롬프트에 금지 한 줄을 넣는다.
- `approvalRules`(H9)는 `requiresApproval` 기본 범주(운영 마이그레이션·스토어·결제·main push·env 삭제·외부 전송) 뒤에 덧붙는다.
- `schema:check` 는 `../chemical` main 을 읽는다. web main 이 스키마 변경 중이면 실패할 수 있으니 이것도 파일럿에서 확인한다.

### 4-3. 첫 백로그(추천)

| task | 내용 | 이유 |
|---|---|---|
| T1 | `format:check` 스크립트 추가(`prettier --check`) + verify 에 넣기 | 작고 안전하다. 하네스 전 흐름(SPEC→CLEANUP)을 실제 레포에서 한 번 도는 확인용 |
| T2 | web→backend 엔드포인트 동등화 잔여 1건 | 판단이 필요 없는 실제 작업. backend PROGRESS 의 남은 목록에서 두뇌가 SPEC 으로 고른다 |

M-3e `myReactions`(backend → app)는 app 이관 뒤 레포 넘기 첫 시험으로 둔다.

### 4-4. 파일럿에서 볼 것

- 워크트리의 `node_modules` 링크 상태에서 build·jest·nest 가 도는지, Codex 샌드박스(workspace-write)가 링크 너머(루트 `node_modules/.cache` 등)에 쓰려다 막히지 않는지.
- 검증 시간(lint+build+unit, heavy 포함), 40분 상한이 맞는지.
- FOD-team-org 명의로 MERGE 커밋이 pre-commit 훅을 통과하는지. push 는 [승인] 범주(push-main)라 사용자 확인 뒤에만 한다.
- 두뇌가 AGENTS.md(Codex 용)와 CLAUDE.md 관리 블록(두뇌 용)을 섞지 않는지.

## 5. 기존 규칙과의 충돌 처리

| # | 기존 규칙 | 처리 |
|---|---|---|
| C1 | 역할 분담(Claude·Codex 검수, 구현은 서브에이전트/Codex) | 하네스 route 로 대체: default→codex, design→claude(web 프론트 UI). AGENTS 역할 절 개정 |
| C2 | 커밋 전 Claude↔Codex 교차 검수 | 하네스 REVIEW 단계로 흡수 |
| C3 | Slack #와이즈팜-결정사항 게시 | 폐지. 결정은 판단대기에 올리고, Slack 공유는 사람 몫(A22) |
| C4 | web DECISIONS·MINSEOK_TODO 단일 원장 | 레포별 `docs/판단대기.md`. 기존 원장은 사람 기록으로 보존(A20) |
| C5 | MINSEOK_TODO.md 가 레포 루트(두뇌 쓰기 불가) | 새 사람 할 일은 판단대기로. 기존 파일은 사람이 관리(A20) |
| C6 | WORKLOG.md append-only | `docs/작업일지/` 로 전환, WORKLOG 는 포인터 한 줄로 동결(A21) |
| C7 | web: main push 전에 운영 DB `db:migrate` 선적용(두뇌가 실행) | web 단계에서 [승인] 판단 항목으로 바꾸고 approvalRules 로 막는다 |
| C8 | 프로세스 정리 수작업 | `fodh cleanup` + killPatterns |
| C9 | 이미지 = Codex imagegen, 브랜드 에셋 금지 | Codex 프롬프트 규칙으로 유지 |
| C10 | Co-Authored-By 트레일러(backend) | 폐지하거나 MERGE 커밋 형식에 넣는다(A22 에 포함) |
| C11 | 명의 고정·훅 | 호환. 그대로 |
| C12 | web CLAUDE.md "작업 전 PROGRESS·DECISIONS 읽기"(548KB) | web 단계에서 요약 인덱스로 바꾼다. 두뇌 컨텍스트 폭탄 방지 |
| C13 | 규제·보안(면책문구, AI 금기 생성 금지, DUR 표현, 비밀 파일 커밋 금지) | 그대로. REVIEW 체크리스트·Codex 프롬프트에 유지 |

## 6. web·app 전에 하네스에 더할 것

| # | 내용 | 필요한 곳 |
|---|---|---|
| H11 | 비밀 파일 읽기 차단: 두뇌의 Read·Grep·Bash(cat 등)가 `.env*`(`.env.example` 제외)·`neon_api.json`·설정 목록 경로를 읽지 못하게. 지금 훅은 비밀값 **쓰기**만 막는다 | web(루트에 운영 DB URL·API 키) |
| H12 | 워크트리 준비 명령(`worktrees.setup`): 생성 직후 한 번 실행(예: `flutter pub get --enforce-lockfile --offline`). `.dart_tool` 은 링크로 공유할 수 없다 | app |
| — | web approvalRules 풀세트: `^npm run (?:db:migrate|seed:|ingest:|backfill:|purge:|maintenance:|slack\b|smoke:prod)`, `^drizzle-kit (?:migrate|push)\b`, `^node .*scripts/(?:slack-bot|purge-|seed-|backfill-|ingest-|run-c003)` | web(설정만, H9 로 가능) |

H11·H12 는 backend 파일럿 결과와 함께 스펙으로 쓴다(A14-c).

## 7. 사용자 판단

지금 필요한 것(backend 파일럿 전) — `docs/판단대기.md` A19~A22.

| # | 질문 | 추천 |
|---|---|---|
| A19 | 이관 순서·레이아웃 | ① 레포별 루트, backend 파일럿 → app → web |
| A20 | 판단 원장 | ① 레포별 판단대기, 기존 DECISIONS·MINSEOK_TODO 는 사람 기록으로 보존 |
| A21 | WORKLOG | ① 작업일지로 전환, WORKLOG 동결 |
| A22 | backend AGENTS.md 개정 커밋·push(역할·교차검수·Slack·Co-Authored-By) | ① 개정 커밋 + push(backend push 는 CI 만) |

web 단계에서 물을 것: C7 운영 마이그레이션 선적용 규칙 → [승인] 전환, web 의 옛 브랜치 `claude/competent-hawking-33adf8`·`.claude/worktrees` 정리, web CLAUDE.md 요약 인덱스 교체, C003 LLM 배치 등 유료 실행 범위.

app 단계에서 물을 것: 골든·규제 스냅샷을 heavy 에 넣을지, OpenAPI codegen(Java 17·jar 내려받기) 허용 여부.
