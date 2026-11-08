# 첫글자 배틀 — Cloudflare 이전 설계

작성일: 2026-10-15 · 상태: 구현·배포 완료

## 1. 목표

랩탑(pm2 + cloudflared 터널)이 켜져 있어야만 접속되던 `quiz.ooo.codes` 를 Cloudflare 에서 상시 운영한다.
게임 규칙·메시지 프로토콜·클라이언트는 그대로 두고 서버만 옮긴다.

## 2. 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 런타임 | Cloudflare Workers (TypeScript) | 상시 가동, 서버 관리 없음 |
| 방 상태 | Durable Objects, 방 1개 = 객체 1개, `idFromName(code)` | WebSocket 다중 접속을 한 곳에서 직렬 처리. SQLite 백엔드로 무료 플랜 가능 |
| 소켓 | 비(非)하이버네이션 `accept()` + 메모리 상태 | 원본과 동일한 의미. 라운드 타이머가 돌아 하이버네이션 이득이 없음 |
| 사전 캐시 | KV `DICT_CACHE` + 객체 메모리 LRU, 오류 결과는 미저장 | 파일 캐시 대체. KV 장애는 무시하고 판정 지속 |
| 로컬 사전 | `data/seed_words.txt` 를 Text 모듈로 import | 키가 없을 때 동작 유지 |
| 정적 파일 | Workers Static Assets (`public/`) | 별도 호스팅 불필요 |
| 도메인 | 기존 터널 CNAME 유지 + **Workers 라우트** `quiz.ooo.codes/*` | DNS 변경 권한 없이 무중단 전환. 라우트가 터널보다 먼저 처리 |
| 비밀 | `STDICT_API_KEY` 는 `wrangler secret` 로만 | 파일·커밋 금지 원칙 |
| 레거시 | Python/FastAPI, pm2, uv 파일 제거 (git 히스토리 보존) | 중복 운영 방지 |

## 3. 접속 흐름의 유일한 변경

원본은 `/ws` 로 접속한 뒤 첫 메시지(`create_room`/`join_room`)로 방을 정했다. Worker 는 소켓을 받기 전에
어느 Durable Object 로 보낼지 알아야 하므로:

- 새 방: `/ws` → Worker 가 코드를 발급(`/probe` 로 미사용 확인)하고 `mode=create` 로 전달
- 기존 방: `/ws?code=ABC234` → `mode=join` 으로 전달

클라이언트는 `connect()` 에서 `join_room` 일 때만 `?code=` 를 붙인다(한 줄 수정). 첫 메시지 프로토콜은 그대로다.
객체는 `created` 플래그로 실제 생성된 방만 입장을 허용하고, `mode` 와 메시지 종류가 어긋나면 거부한다.

## 4. 방 수명

- 전원 퇴장 + 로비 → 즉시 `deleteAll()` (코드 무효화)
- 전원 퇴장 + 게임 중 → `setAlarm(now + 600s)`; alarm 시점에도 비어 있으면 삭제, 누군가 돌아오면 `deleteAlarm()`
- 재배포로 객체가 재시작되면 메모리의 플레이어는 사라진다. 클라이언트는 토큰 재접속을 시도하지만 새 플레이어로 입장한다(허용된 한계).

## 5. 검증

- 단위: vitest 34건 (hangul, prompts, arbiter, dictionary, room) — 원본 pytest 를 1:1 이식
- 통합: `wrangler dev` 와 프로덕션 `https://quiz.ooo.codes` 양쪽에서 Node WebSocket 스모크
  (방 생성 → 유령 코드 거부 → 입장 → 비방장 모드 변경 거부 → 시작 → 오답 쿨다운 → 정답 득점 → 끊김 후 토큰 재접속 → 정적 페이지)
- `/healthz` 가 `runtime: "cloudflare"` 를 돌려주어 터널이 아닌 Worker 가 응답함을 확인

## 6. 남은 수동 항목

- `npx wrangler secret put STDICT_API_KEY` — 키를 넣기 전까지 로컬 사전 모드
- (선택) 터널 CNAME 을 Workers 커스텀 도메인으로 바꾸면 라우트·터널 의존이 완전히 끊긴다. 현재는 라우트만으로 정상 동작한다.
