from fastapi.testclient import TestClient

from app.config import Settings
from app.dictionary import LocalDictionary
from app.main import create_app


def make_client():
    settings = Settings(countdown_seconds=1, round_end_seconds=0, round_seconds=5, target_score=5)
    # 어떤 제시어가 나와도 맞출 수 있도록 제시어 음절 전부에 대한 단어를 만든다
    from app.prompts import PROMPT_SYLLABLES
    words = {s + "나" for s in PROMPT_SYLLABLES}
    app = create_app(settings=settings, dictionary=LocalDictionary(words))
    return TestClient(app)


def recv_until(ws, mtype, limit=30):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == mtype:
            return msg
    raise AssertionError(f"{mtype} not received")


def test_two_players_play_a_round():
    with make_client() as client:
        assert client.get("/healthz").json()["ok"] is True
        with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
            a.send_json({"type": "create_room", "nickname": "철수"})
            joined_a = a.receive_json()
            assert joined_a["type"] == "joined" and joined_a["is_host"]
            state = a.receive_json()
            assert state["type"] == "room_state" and len(state["players"]) == 1

            b.send_json({"type": "join_room", "code": joined_a["code"].lower(), "nickname": "영희"})
            joined_b = b.receive_json()
            assert joined_b["type"] == "joined" and not joined_b["is_host"]
            assert len(recv_until(b, "room_state")["players"]) == 2
            assert len(recv_until(a, "room_state")["players"]) == 2

            # 방장이 아닌 사람은 시작 불가
            b.send_json({"type": "start_game"})
            assert recv_until(b, "error")["message"] == "방장만 시작할 수 있습니다"

            a.send_json({"type": "start_game"})
            assert recv_until(a, "countdown")["value"] == 1
            start = recv_until(a, "round_start")
            prompt = start["prompt"]
            recv_until(b, "round_start")

            b.send_json({"type": "submit_word", "word": prompt + "나"})
            result = recv_until(b, "submit_result")
            assert result["accepted"] is True
            end = recv_until(a, "round_end")
            assert end["winner_id"] == joined_b["player_id"] and end["word"] == prompt + "나"


def test_join_unknown_room():
    with make_client() as client:
        with client.websocket_connect("/ws") as a:
            a.send_json({"type": "join_room", "code": "ZZZZZZ", "nickname": "철수"})
            assert a.receive_json()["message"] == "존재하지 않는 방 코드입니다"
