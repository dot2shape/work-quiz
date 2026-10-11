# 첫글자 배틀 (Word Rush)

제시어 한 음절(예: **부**)이 공개되면, 그 글자로 시작하는 **표준국어대사전 명사**를 가장 먼저 제출한 사람이 1점을 얻습니다. 5점을 먼저 얻으면 승리. 2~8명이 한 방에서 실시간으로 겨루는 웹 게임입니다.

- 서버: FastAPI + WebSocket (방·점수는 메모리에만 보관)
- 클라이언트: 빌드 없는 `static/index.html` 한 장
- 판정: 국립국어원 표준국어대사전 오픈 API + 서버 캐시. 승자는 **서버 도착 순서**로 결정합니다.

## 실행

```bash
uv sync
cp .env.example .env        # STDICT_API_KEY 입력
uv run uvicorn app.main:app --host 127.0.0.1 --port 5020
```

브라우저에서 `http://127.0.0.1:5020` 을 두 탭 열어 바로 대전할 수 있습니다.

### 사전 API 키

1. https://stdict.korean.go.kr/openapi/openApiInfo.do 에서 회원가입 후 오픈 API 키를 신청합니다(즉시 발급).
2. 발급된 32자리 키를 `.env`의 `STDICT_API_KEY=`에 넣습니다. 키는 채팅·커밋에 절대 넣지 않습니다.
3. 키가 비어 있으면 `data/seed_words.txt`의 로컬 단어 목록으로 판정하는 **로컬 사전 모드**로 동작하며 로비에 배지가 표시됩니다.

## 규칙

| 항목 | 값 |
|---|---|
| 인정 조건 | 한글 2글자 이상, 제시어로 시작, 사전에 명사로 등재 |
| 중복 | 한 판에서 득점한 단어는 재사용 불가 |
| 오답 | 제출자에게만 사유 표시, 1초 쿨다운 |
| 라운드 | 3초 카운트다운 → 최대 20초 → 3초 결과 표시 |
| 승리 | 5점 선취 |
| 단어 길이 모드 | 자유(2글자 이상) / 두글자 / 세글자 — 방장이 로비에서 선택 |

`.env`의 `TARGET_SCORE`, `ROUND_SECONDS`로 조정할 수 있습니다.

## 테스트

```bash
uv run pytest
```

## 배포 (이 맥에서 pm2 + cloudflared)

```bash
pm2 start ecosystem.config.cjs && pm2 save
```

`~/.cloudflared/config.yml` ingress에 `quiz.ooo.codes → http://localhost:5020`을 추가하고 (현재 `dev-dashboard` 터널에 등록됨, launchd `com.cloudflared.dev-dashboard` 재시작 필요)
`cloudflared tunnel route dns <tunnel> quiz.ooo.codes`로 DNS를 연결합니다.

## 문서

- 설계 스펙: `docs/superpowers/specs/2026-10-11-word-rush-design.md`
- 구현 계획: `docs/superpowers/plans/2026-10-11-word-rush.md`
