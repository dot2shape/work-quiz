# 첫글자 배틀 (Word Rush) — 설계 스펙

작성일: 2026-10-11 · 상태: 승인됨(브레인스토밍 결과 반영)

## 1. 한 줄 정의

서버가 제시어(한 음절, 예: "부")를 공개하면 그 음절로 시작하는 **표준국어대사전 등재 명사**를
가장 먼저 제출한 사람이 1점을 얻고, 5점을 먼저 얻는 사람이 승리하는 2~8인 실시간 웹 게임.

## 2. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 단어 판정 | 사전 자동 판정 | 사람 판정은 분쟁·지연 |
| 사전 데이터 | 국립국어원 표준국어대사전 오픈 API + 서버 캐시 | 정확성, 캐시로 지연·한도 완화 |
| 접속 환경 | 인터넷 공개 | 친구들이 외부에서 접속 |
| 스택 | FastAPI + WebSocket, 빌드 없는 단일 HTML/JS | 주력 스택, 파일 적음 |
| 공정성 | 서버 도착 순서로 승자 결정, 클라이언트 시계 불신 | 조작 불가 |
| 저장 | 메모리만, DB 없음 | 규모 작음 |
| 배포 | pm2 + 기존 cloudflared 터널(ooo.codes) | 기존 인프라 재사용 |

## 3. 게임 흐름

1. 첫 화면에서 닉네임(1~12자)을 입력하고 **방 만들기** 또는 **코드로 입장**.
2. 방 생성 시 6자리 영숫자 코드(혼동 문자 `0 O 1 I` 제외)와 공유 링크(`/?room=CODE`)를 발급.
3. 로비: 2~8명. 방장(최초 생성자, 퇴장 시 다음 입장자)에게만 **시작** 버튼.
4. 라운드:
   - `countdown`(3초, 서버가 3-2-1 브로드캐스트) — 입력 잠금.
   - `playing` — 제시어 공개. 유효 단어 선착순 1명이 1점. 제한 시간 20초 내 정답자가 없으면 무득점으로 종료.
   - `round_end`(3초) — 승자/단어/점수판 표시 후 다음 라운드.
5. 누군가 5점 도달 → `game_over`. 방장이 **다시 시작**하면 점수·사용 단어 초기화 후 로비로.

## 4. 규칙

- 인정 조건: 완성형 한글만, 2글자 이상, 제시어로 시작, 표준국어대사전 `type1=word` 결과 중 품사가 `명사`인 항목 존재.
- 동일 게임 내 이미 득점한 단어는 재사용 불가(`이미 나온 단어`).
- 오답은 제출자에게만 사유를 전달하고 **1초 쿨다운**(쿨다운 중 제출은 무시하고 사유 전달).
- 제시어는 명사가 풍부한 음절만 모은 선별 목록(`app/prompts.py`)에서 무작위, 같은 게임 내 중복 없음(소진 시 재사용).

## 5. 선착순 판정(Arbiter)

- 제출마다 서버가 단조 증가 `seq`를 부여하고, 검증(형식 → 중복 → 사전)을 즉시 비동기로 시작.
- 승자 확정 규칙: `seq`가 더 작은 미해결 제출이 하나도 없고, 자신이 유효하면 승자.
  즉 뒤 순번은 앞 순번 결과가 모두 나오기 전에는 확정되지 않는다.
- 라운드가 끝나면(승자 확정·타임아웃) 남은 제출은 모두 폐기.

## 6. 사전 계층

```
Dictionary(Protocol): async is_noun(word) -> Verdict(valid: bool, reason: str|None, error: bool)
StdictClient      : 오픈 API 호출(httpx, 3초 타임아웃). 응답 word의 '-', '^' 제거 후 비교, pos == '명사'.
CachedDictionary  : 메모리 LRU(최대 50,000) + JSON 파일 영속(data/dict_cache.json). 오류 결과는 캐시하지 않음.
LocalDictionary   : data/seed_words.txt 기반. API 키가 없을 때만 사용(개발·테스트용). UI에 "로컬 사전 모드" 배지.
```

- API 실패(타임아웃, 5xx, 네트워크) → `Verdict(error=True)` → 제출자에게 "판정 불가, 다시 제출" 안내. 라운드는 계속.

## 7. 메시지 프로토콜(JSON over WebSocket `/ws`)

클라이언트 → 서버

| type | payload |
|---|---|
| `create_room` | `{nickname}` |
| `join_room` | `{code, nickname, token?}` (token: 재접속용) |
| `start_game` | — (방장만) |
| `submit_word` | `{word}` |
| `restart_game` | — (방장만, game_over에서) |

서버 → 클라이언트

| type | payload |
|---|---|
| `joined` | `{code, player_id, token, is_host}` |
| `room_state` | `{code, phase, host_id, players:[{id,nickname,score,connected}], round, prompt?, countdown?, used_words, dictionary_mode}` |
| `countdown` | `{value}` |
| `round_start` | `{round, prompt, ends_at_ms}` |
| `round_end` | `{round, winner_id?, word?, players}` |
| `game_over` | `{winner_id, players}` |
| `submit_result` | `{accepted: bool, reason?, cooldown_ms?}` (제출자에게만) |
| `error` | `{message}` |

## 8. 보안·운영

- API 키는 `STDICT_API_KEY` 환경변수(.env)로만 읽는다. `.env.example`만 커밋, `.gitignore`에 `.env*`, `!.env.example`.
- 메시지 크기 제한(단어 20자), 닉네임 길이 제한, 방 인원 8명, 서버 전체 방 수 상한 200.
- 플레이어 전원 연결 해제 후 10분 지나면 방 삭제. 연결 끊긴 플레이어는 `connected=false`로 유지, 같은 token으로 재입장 가능.
- 포트 5020. pm2 프로세스명 `word-rush`. 공개 호스트 `quiz.ooo.codes` (기존 dev-dashboard 터널 ingress에 추가).

## 9. 테스트

- 단위: 한글 검증, 방 상태 머신, Arbiter 순서 보존, 캐시, Stdict 응답 파싱(목킹).
- 통합: FastAPI TestClient WebSocket으로 2인 방 생성 → 시작 → 제출 → 득점 → 승리.
- 수동: 브라우저 두 탭 대전.
