# CLAUDE.md — 첫글자 배틀 (Word Rush)

제시어 한 음절로 시작하는 표준국어대사전 명사를 가장 먼저 제출하면 득점하는 실시간 멀티플레이 웹 게임.

- 스택: TypeScript · Cloudflare Workers(`src/index.ts`) + Durable Objects(`RoomObject`, 방 1개 = DO 1개, WebSocket) + KV(`DICT_CACHE`, 사전 판정 캐시)
- 클라이언트: 빌드 없는 `public/index.html` 단일 페이지 (Workers Assets)
- 판정: 국립국어원 표준국어대사전 오픈 API(`STDICT_API_KEY` — 운영은 `wrangler secret`, 로컬은 `.dev.vars`) / 키 없으면 `data/seed_words.txt` 로컬 사전 모드
- 설정: `wrangler.toml` (라우트 `quiz.ooo.codes/*`, 바인딩, `[vars]` 게임 규칙)
- 실행: `npm ci` → `npm run dev`(localhost:8787) · `npm test`(vitest) · `npm run typecheck` · 배포 `npx wrangler deploy`
- 실행·규칙 상세는 `README.md`, 이전 설계는 `docs/superpowers/specs/2026-10-15-cloudflare-migration-design.md`

## 세션 구조 (PO → 워커)

전역 `po` 스킬(`~/.claude/skills/po/`)로 운영한다. **작업의 단일 원본(SoT)은 GitHub Issues**(`dot2shape/work-quiz`)다.

| 층 | 누가 | 하는 일 | 하지 않는 일 |
|---|---|---|---|
| **PO** | 메인 worktree(`main`)의 첫 세션 | 목표 설정, Intake PRD 확정·소규모 후속 발행, Orca 워커 배정, 검수, merge·close | 제품 코드 직접 수정, 이슈를 백그라운드 서브에이전트로 구현 |
| **Intake** | 메인 worktree의 형제 터미널 `INTAKE` (`~/.claude/skills/po-intake/`), 상시 대기 | 새 아이디어 접수, 중복 확인, PRD·작업 이슈 초안(`status:draft`) → 사용자 합의 후 `status:ready`로 PO에 넘김 | 우선순위·모듈 라벨 확정, 배정, merge·close |
| **워커(PM)** | 이슈별 Orca 워크트리의 에이전트 세션 (Provider는 프로젝트 지침을 따름) (`~/.claude/skills/po/worker.md`) | 착수, 구현·검증, PR, 처리 보고 댓글, `status:review` | 이슈 생성, 범위 확장, merge, close |

- 라벨: `type:task`/`type:prd`, 우선순위 `P1`/`P2`/`P3`, 모듈 `module:*`(PO가 생성), 상태 `status:draft`(Intake 초안)/`status:ready`(PO 확정 대기)/`status:in_progress`/`status:review`/`status:verified` (상태 라벨 없음 = 확정된 미착수).
- 새 기능·방향 변경 아이디어를 PO가 받으면 PRD를 쓰지 않고 원문을 `INTAKE` 터미널에 직접 전달한다. 사용자에게 옮기라고 하지 않는다.
- 배정: `po` 스킬 3단계에 따라 프로젝트가 지정한 명령으로 워커를 기동하고 `orca terminal show`의 `agentIdentity`를 확인한 뒤 작업을 전달한다. 워커도 PO Provider를 따라야 하는지는 프로젝트 AGENTS.md와 사용자 지정을 따른다.
- 워크트리·브랜치 이름은 `issue-N`. PR 본문에 `Closes #N`.

### 이 프로젝트 전용 규칙 (사용자 지정, 2026-11-08)
- **사람 승인 없이 바로 `main`**: PR에 `## 사용자 확인`을 두지 않는다. Monitor가 `status:verified`를 붙이면 PO가 즉시 병합하고 운영(`npx wrangler deploy`)에 반영한 뒤 결과만 보고한다. 사용자 PR Approve를 기다리지 않는다.
- 운영은 Cloudflare Workers(`quiz.ooo.codes`). 브라우저 검증은 `ego-browser`만 사용한다.
