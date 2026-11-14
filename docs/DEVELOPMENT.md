# 개발 안내 — 첫글자 배틀 (Word Rush)

게임 소개는 [README](../README.md)에 있습니다. 이 문서는 실행·배포·구조 등 개발자용 정보입니다.

- 서버: Cloudflare Workers + Durable Objects (방 1개 = 객체 1개, WebSocket, 점수는 메모리)
- 클라이언트: 빌드 없는 `public/index.html` 한 장 (Workers Static Assets)
- 판정: 자체 단어 DB(Cloudflare D1) → 없으면 국립국어원 표준국어대사전 오픈 API + KV 캐시 → 시드 목록. 승자는 **서버 도착 순서**로 결정합니다.
- 운영: https://quiz.ooo.codes — Cloudflare 에서 상시 운영됩니다(개인 PC 불필요).

## 구조

```
src/index.ts        Worker 진입점: /healthz, /ws → 방 Durable Object, 그 외 정적 자산
src/room-object.ts  RoomObject (Durable Object): 소켓 관리, 메시지 라우팅, 빈 방 정리(alarm)
src/room.ts         방 상태 머신 (lobby → countdown → playing → round_end → game_over)
src/arbiter.ts      선착순 판정기 (앞 순번 미해결이면 뒤 순번 보류)
src/dictionary.ts   StdictClient / CachedDictionary(메모리+KV) / LocalDictionary(시드) / FallbackDictionary(조회 실패 폴백)
                    / TieredDictionary(D1 → 기존 경로) / BlocklistDictionary(차단 층)
src/d1-dictionary.ts  D1Dictionary, DO 초기화 때 읽는 스냅숏(loadD1Snapshot), /healthz 용 D1Health
src/dictionary-build.ts  방 하나가 쓸 사전 조립 (buildDictionary)
migrations/         D1 스키마 (words, prompt_syllables, dict_stats)
scripts/dict/       load.mjs(단어 목록 → D1 적재), smoke.mjs(실행 중인 서버 판정 확인)
src/prompts.ts      제시어 음절 목록과 추출기
src/hangul.ts       한글 형식 검증
data/seed_words.txt API 키가 없을 때 쓰는 로컬 사전
data/dict/          유행어 허용 목록(slang.txt)·비속어 차단 목록(banned.txt) 원본과 선정 기준(README.md)
public/index.html   클라이언트
test/               vitest 테스트 (D1 은 miniflare 의 실제 D1 로 돌린다. fixture: test/fixtures/dict-words.csv)
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

로컬 D1 은 `.wrangler/state` 에 생깁니다. 비워 두면 시드 사전으로 동작하고, 아래처럼 채우면 D1 판정을 확인할 수 있습니다.

```bash
npx wrangler d1 migrations apply word-rush-dict --local          # 스키마
node scripts/dict/load.mjs test/fixtures/dict-words.csv --local  # 테스트용 34행
npx wrangler dev --var TARGET_SCORE:1000                          # 다른 터미널
node scripts/dict/smoke.mjs --expect d1                           # 차단·유행어·시드 폴백 판정 확인 (빈 D1 은 --expect seed)
```

## 배포

```bash
npx wrangler d1 migrations apply word-rush-dict --remote   # 새 마이그레이션이 있으면 deploy 보다 먼저
npm run deploy                              # wrangler deploy → quiz.ooo.codes/* 라우트
npx wrangler secret put STDICT_API_KEY      # 사전 API 키 (1회, 값은 프롬프트에 입력)
npm run tail                                # 실시간 로그
```

- 계정·라우트·바인딩은 `wrangler.toml` 에 있습니다. `wrangler login` 된 상태여야 합니다.
- 공개 호스트 `quiz.ooo.codes` 의 DNS 는 기존 cloudflared 터널 CNAME 을 그대로 두고 **Workers 라우트**가 먼저 가로챕니다. 터널·pm2 는 더 이상 이 서비스에 관여하지 않습니다.
- 키가 비어 있으면 `data/seed_words.txt` 로 판정하는 **로컬 사전 모드**로 동작하며 로비에 배지가 표시됩니다. 키를 넣는 즉시(재배포 없이) 표준국어대사전 판정으로 바뀝니다.
- 키가 있어도 stdict 조회가 실패하면(HTTP 오류·빈 본문·timeout 등) 거절하지 않고 로컬 사전으로 판정합니다. 2회 연속 실패하면 60초 동안 stdict 호출을 건너뜁니다(방별). 폴백 판정은 KV 에 캐시하지 않습니다. 키가 틀리면 stdict 는 HTTP 200 + 빈 본문을 돌려주므로 Workers Logs 의 `stdict 조회 실패` 로그 `kind:"empty"` 로 구분됩니다.
- stdict 차단 상태는 KV 플래그(`breaker:stdict`, TTL 60초)로 방 간에 공유합니다. 새 방은 같은 실패를 다시 겪지 않고, 차단 중에도 KV 에 캐시된 예전 stdict 판정은 먼저 씁니다.
- `/healthz` 의 `dictionary`: `d1`(자체 DB 판정) / `local`(키 없음) / `stdict`(정상) / `stdict-degraded`(조회 실패, 로컬 사전 폴백 중 — 탐침 결과 60초 캐시). `d1` 일 때 `fallback` 에 뒤의 세 값 중 하나가 따로 나옵니다.
- `/healthz` 의 `d1`: `{status, standard, slang, banned}`. `status` 는 `unbound`(바인딩 없음) / `error`(조회 실패·마이그레이션 전) / `empty`(인정 단어 0 → 기존 경로) / `ready`(D1 판정 사용). 60초 캐시.

### 단어 DB (D1 `word-rush-dict`)

판정 순서는 **차단 목록 → D1 → (D1 에 없으면) stdict → 시드** 입니다.

| kind | 뜻 | 판정 |
|---|---|---|
| `standard` | 사전 명사 | 인정 |
| `slang` | 유행어(허용 목록) | 인정 |
| `banned` | 비속어(차단 목록) | "사용할 수 없는 단어입니다" 로 거절(쿨다운). stdict·시드가 인정하는 단어여도 거절 |

- 스키마: `migrations/0001_words.sql`. `words` 의 기본 키는 `(kind, word)` 라서 한 단어가 사전 행과 차단 행을 함께 가질 수 있고, 차단 목록을 갈아 끼워도 사전 행은 남습니다.
- 방(DO)이 만들어질 때 `blockConcurrencyWhile` 로 단어 수(`dict_stats`)·차단 목록·제시어 음절(`prompt_syllables`)을 한 번 읽어 메모리에 둡니다. 그래서 적재 결과는 **새로 만들어지는 방부터** 반영됩니다.
- **폴백**: 바인딩이 없거나, 마이그레이션 전이거나, 인정 단어가 0 이거나, 초기화가 2초 안에 끝나지 않으면 그 방은 기존 경로(stdict → 시드)로만 판정합니다. 게임 중 D1 조회가 실패하면 그 제출은 기존 경로로 판정하고, 2회 연속 실패하면 60초 동안 D1 을 건너뜁니다. 오류 판정은 캐시하지 않습니다. 읽어 둔 차단 목록은 D1 이 죽어도 계속 적용됩니다.
- 제시어: D1 과 기존 경로의 제시어 집합을 합칩니다(D1 이 일부만 적재된 동안 제시어가 좁아지지 않게).

적재는 `scripts/dict/load.mjs` 로만 합니다(`--help` 참고). 텍스트(한 줄에 한 단어 이상. 종류는 파일 안의 `# kind: <종류>` 줄 또는 `--kind`) 또는 CSV(`word,kind,source,pos`)를 SQL 배치 파일로 바꿔 `wrangler d1 execute --file` 로 넣고, `prompt_syllables`·`dict_stats` 를 다시 계산합니다.

유행어 허용 목록과 비속어 차단 목록의 원본은 `data/dict/slang.txt`·`data/dict/banned.txt` 입니다(선정 기준은 `data/dict/README.md`). 두 파일은 **항상 함께** 적재합니다. 같은 단어가 양쪽에 있으면 스크립트가 경고하고, 판정은 차단이 우선합니다.

```bash
node scripts/dict/load.mjs data/dict/slang.txt data/dict/banned.txt --replace --dry-run   # SQL 만 만들어 건수·경고 확인 (.wrangler/dict-load/)
node scripts/dict/load.mjs data/dict/slang.txt data/dict/banned.txt --replace --local     # 로컬 D1
node scripts/dict/load.mjs data/dict/slang.txt data/dict/banned.txt --replace --remote    # 운영 적재
node scripts/dict/load.mjs --recalc-only --remote                                          # 집계만 다시
```

- `--replace` 는 이번에 넣는 `(kind, source)` 의 기존 행을 먼저 지웁니다(삭제와 첫 삽입은 같은 SQL 파일). 목록 파일을 원본으로 삼을 때 씁니다. 같은 kind 의 두 출처에 모두 있는 단어는 나중에 적재한 출처로 표시됩니다.
- D1 무료 플랜은 하루에 쓸 수 있는 행 수에 한도가 있습니다. 수십만 행을 넣기 전에 계정 플랜과 한도를 확인합니다.
- 운영 적재 중에는 D1 이 잠시 응답하지 않을 수 있습니다. 그동안은 위 폴백으로 판정합니다.
- 종료 코드: 0 성공 / 1 입력 오류 / 2 사용법 오류 / 3 wrangler 실행 실패.

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
