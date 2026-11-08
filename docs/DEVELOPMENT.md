# 개발 안내 — 첫글자 배틀 (Word Rush)

게임 소개는 [README](../README.md)에 있습니다. 이 문서는 실행·배포·구조 등 개발자용 정보입니다.

- 서버: Cloudflare Workers + Durable Objects (방 1개 = 객체 1개, WebSocket, 점수는 메모리)
- 클라이언트: 빌드 없는 `public/index.html` 한 장 (Workers Static Assets)
- 판정: 국립국어원 표준국어대사전 오픈 API + KV 캐시. 승자는 **서버 도착 순서**로 결정합니다.
- 운영: https://quiz.ooo.codes — Cloudflare 에서 상시 운영됩니다(개인 PC 불필요).

## 구조

```
src/index.ts        Worker 진입점: /healthz, /ws → 방 Durable Object, 그 외 정적 자산
src/room-object.ts  RoomObject (Durable Object): 소켓 관리, 메시지 라우팅, 빈 방 정리(alarm)
src/room.ts         방 상태 머신 (lobby → countdown → playing → round_end → game_over)
src/arbiter.ts      선착순 판정기 (앞 순번 미해결이면 뒤 순번 보류)
src/dictionary.ts   StdictClient / CachedDictionary(메모리+KV) / LocalDictionary(시드)
src/prompts.ts      제시어 음절 목록과 추출기
src/hangul.ts       한글 형식 검증
data/seed_words.txt API 키가 없을 때 쓰는 로컬 사전
public/index.html   클라이언트
test/               vitest 단위 테스트
docs/screenshots/   README 플레이 캡처
```

## 개발

```bash
npm install
npm run dev          # http://localhost:8787 — 두 탭을 열어 바로 대전
npm test             # vitest
npm run typecheck
```

로컬에서 실제 사전 판정을 쓰려면 `.dev.vars` 파일에 `STDICT_API_KEY=...` 를 넣습니다(gitignore 됨).

## 배포

```bash
npm run deploy                              # wrangler deploy → quiz.ooo.codes/* 라우트
npx wrangler secret put STDICT_API_KEY      # 사전 API 키 (1회, 값은 프롬프트에 입력)
npm run tail                                # 실시간 로그
```

- 계정·라우트·바인딩은 `wrangler.toml` 에 있습니다. `wrangler login` 된 상태여야 합니다.
- 공개 호스트 `quiz.ooo.codes` 의 DNS 는 기존 cloudflared 터널 CNAME 을 그대로 두고 **Workers 라우트**가 먼저 가로챕니다. 터널·pm2 는 더 이상 이 서비스에 관여하지 않습니다.
- 키가 비어 있으면 `data/seed_words.txt` 로 판정하는 **로컬 사전 모드**로 동작하며 로비에 배지가 표시됩니다. 키를 넣는 즉시(재배포 없이) 표준국어대사전 판정으로 바뀝니다.

### 사전 API 키

1. https://stdict.korean.go.kr/openapi/openApiInfo.do 에서 회원가입 후 오픈 API 키를 신청합니다(즉시 발급).
2. `npx wrangler secret put STDICT_API_KEY` 를 실행하고 프롬프트에 키를 붙여 넣습니다. 키는 채팅·커밋·파일에 절대 넣지 않습니다.

## 규칙 상세

| 항목 | 값 |
|---|---|
| 인정 조건 | 한글 2글자 이상, 제시어로 시작, 사전에 명사로 등재 |
| 중복 | 한 판에서 득점한 단어는 재사용 불가 |
| 오답 | 제출자에게만 사유 표시, 1초 쿨다운 |
| 라운드 | 3초 카운트다운 → 최대 20초 → 3초 결과 표시 |
| 승리 | 5점 선취 |
| 단어 길이 모드 | 자유(2글자 이상) / 두글자 / 세글자 — 방장이 로비에서 선택 |

`wrangler.toml` 의 `[vars]` `TARGET_SCORE`, `ROUND_SECONDS` 로 조정합니다.

## 운영 특성 (Durable Objects)

- 방 코드는 Durable Object 이름입니다. 만들어진 방만 `created` 플래그가 있어 임의 코드 접속은 거부됩니다.
- 전원 퇴장 시 로비면 즉시 삭제, 게임 중이면 10분 뒤 alarm 으로 삭제됩니다.
- 플레이어·점수는 메모리에만 있습니다. 재배포 시 진행 중인 게임은 끊기고, 클라이언트는 토큰으로 재접속하지만 새 플레이어로 들어옵니다.

## README 캡처 갱신

`docs/screenshots/` 는 운영 UI(`quiz.ooo.codes`)를 `ego-browser` 로 두 탭(가상 닉네임) 대전하며 찍습니다. Playwright 등 다른 브라우저 도구는 쓰지 않습니다. 실명·개인정보가 보이지 않게 합니다.

## 문서

- 설계 스펙: `docs/superpowers/specs/2026-10-11-word-rush-design.md`
- Cloudflare 이전 설계: `docs/superpowers/specs/2026-10-15-cloudflare-migration-design.md`
- 구현 계획(초판): `docs/superpowers/plans/2026-10-11-word-rush.md`
