import asyncio
import pytest

from app.config import Settings
from app.dictionary import LocalDictionary
from app.room import Room, RoomError

SCALE = 0.01  # 테스트에서는 모든 대기 시간을 1/100로 줄인다


async def fast_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds * SCALE)


class SequentialPicker:
    """테스트용: 제시어를 '부' → '신' → '가' 순서로 고정한다."""

    def __init__(self, order):
        self._order = list(order)
        self._i = 0

    def next(self, used, pool=None):
        s = self._order[self._i % len(self._order)]
        self._i += 1
        return s


class Harness:
    def __init__(self, target_score=5, round_seconds=20):
        self.broadcasts: list[dict] = []
        self.sent: list[tuple[str, dict]] = []
        settings = Settings(target_score=target_score, round_seconds=round_seconds)
        dictionary = LocalDictionary({"부산", "부모", "신발", "신문", "가방", "가족"})
        picker = SequentialPicker(["부", "신", "가"])
        self.room = Room(
            "ABCDEF", dictionary, settings,
            broadcast=self._broadcast, send=self._send, picker=picker, sleep=fast_sleep,
        )

    async def _broadcast(self, msg):
        self.broadcasts.append(msg)

    async def _send(self, player_id, msg):
        self.sent.append((player_id, msg))

    def results_for(self, player_id):
        return [m for pid, m in self.sent if pid == player_id and m["type"] == "submit_result"]

    def of_type(self, t):
        return [m for m in self.broadcasts if m["type"] == t]


async def wait_phase(room, phase, timeout=1.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while room.phase != phase:
        if asyncio.get_event_loop().time() > deadline:
            raise AssertionError(f"phase {room.phase!r} never became {phase!r}")
        await asyncio.sleep(0.002)


async def test_full_game_to_victory():
    h = Harness(target_score=2)
    a = h.room.add_player("철수")
    b = h.room.add_player("영희")
    assert h.room.host_id == a.id and h.room.phase == "lobby"

    await h.room.start(a.id)
    assert h.room.phase == "countdown"
    # 카운트다운 중 제출은 거부되고 점수에 반영되지 않는다
    await h.room.submit(a.id, "부산")
    assert h.results_for(a.id)[-1]["accepted"] is False
    assert a.score == 0

    await wait_phase(h.room, "playing")
    assert h.room.prompt == "부"
    await h.room.submit(b.id, "부끄끄")  # 사전에 없음
    await asyncio.sleep(0.01)
    assert h.results_for(b.id)[-1]["accepted"] is False
    assert "사전" in h.results_for(b.id)[-1]["reason"]
    assert h.results_for(b.id)[-1]["cooldown_ms"] > 0

    await h.room.submit(a.id, "부산")
    await wait_phase(h.room, "round_end")
    assert a.score == 1 and "부산" in h.room.used_words
    assert h.of_type("round_end")[-1]["winner_id"] == a.id
    assert h.of_type("round_end")[-1]["word"] == "부산"

    await wait_phase(h.room, "playing")
    assert h.room.prompt in ("신", "가")
    word = "신발" if h.room.prompt == "신" else "가방"
    b.cooldown_until = 0.0  # 앞 라운드 오답 쿨다운(실시간 1초)을 테스트에서는 해제
    await h.room.submit(b.id, word)
    await wait_phase(h.room, "round_end")
    assert b.score == 1

    await wait_phase(h.room, "playing")
    # 남은 제시어 하나. '부'가 다시 나오지는 않으므로 사용 단어 중복은 다음 테스트에서 검증
    prompt = h.room.prompt
    word = {"신": "신문", "가": "가족", "부": "부모"}[prompt]
    await h.room.submit(a.id, word)
    await wait_phase(h.room, "game_over")
    assert a.score == 2
    assert h.of_type("game_over")[-1]["winner_id"] == a.id

    # 다시 시작 → 로비, 점수 초기화
    await h.room.restart(a.id)
    assert h.room.phase == "lobby" and a.score == 0 and not h.room.used_words


async def test_used_word_rejected_and_wrong_prefix_rejected():
    h = Harness()
    a = h.room.add_player("철수")
    b = h.room.add_player("영희")
    h.room.used_words.add("부산")
    await h.room.start(a.id)
    await wait_phase(h.room, "playing")
    assert h.room.prompt == "부"
    await h.room.submit(a.id, "부산")
    await asyncio.sleep(0.01)
    assert h.results_for(a.id)[-1]["reason"] == "이미 나온 단어입니다"
    await h.room.submit(b.id, "신발")
    assert "부" in h.results_for(b.id)[-1]["reason"]
    await h.room.submit(b.id, "부")
    # 쿨다운 중이므로 쿨다운 안내가 온다
    assert h.results_for(b.id)[-1]["accepted"] is False
    h.room.close()


async def test_second_valid_after_winner_does_not_score():
    h = Harness()
    a = h.room.add_player("철수")
    b = h.room.add_player("영희")
    await h.room.start(a.id)
    await wait_phase(h.room, "playing")
    await h.room.submit(a.id, "부산")
    await h.room.submit(b.id, "부모")
    await wait_phase(h.room, "round_end")
    await asyncio.sleep(0.02)
    assert a.score == 1 and b.score == 0
    h.room.close()


async def test_round_timeout_without_winner():
    h = Harness(round_seconds=1)
    a = h.room.add_player("철수")
    h.room.add_player("영희")
    await h.room.start(a.id)
    await wait_phase(h.room, "playing")
    await wait_phase(h.room, "round_end")
    assert h.of_type("round_end")[-1]["winner_id"] is None
    h.room.close()


async def test_host_succession_and_reconnect():
    h = Harness()
    a = h.room.add_player("철수")
    b = h.room.add_player("영희")
    await h.room.start(a.id)
    await wait_phase(h.room, "playing")
    h.room.disconnect(a.id)
    assert h.room.host_id == b.id
    assert not a.connected and a.id in h.room.players  # 게임 중에는 자리를 유지
    again = h.room.add_player("철수", token=a.token)
    assert again is a and a.connected
    h.room.disconnect(a.id)
    h.room.disconnect(b.id)
    assert h.room.is_empty()
    h.room.close()


async def test_lobby_disconnect_removes_player():
    h = Harness()
    a = h.room.add_player("철수")
    b = h.room.add_player("영희")
    h.room.disconnect(b.id)
    assert b.id not in h.room.players
    with pytest.raises(RoomError):
        await h.room.start(a.id)  # 2명 미만
    c = h.room.add_player("민수")
    with pytest.raises(RoomError):
        await h.room.start(c.id)  # 방장이 아님


async def test_room_full():
    h = Harness()
    for i in range(8):
        h.room.add_player(f"p{i}")
    with pytest.raises(RoomError):
        h.room.add_player("p9")


async def test_word_length_mode_rejects_other_lengths():
    h = Harness()
    a = h.room.add_player("철수")
    b = h.room.add_player("영희")
    with pytest.raises(RoomError):
        await h.room.set_mode(b.id, 2)  # 방장이 아님
    with pytest.raises(RoomError):
        await h.room.set_mode(a.id, 4)  # 지원하지 않는 길이
    await h.room.set_mode(a.id, 3)
    assert h.room.state()["word_length"] == 3 and h.room.state()["mode_label"] == "세글자"
    await h.room.start(a.id)
    with pytest.raises(RoomError):
        await h.room.set_mode(a.id, 2)  # 로비가 아님
    await wait_phase(h.room, "playing")
    assert h.room.prompt == "부"
    await h.room.submit(b.id, "부산")
    assert h.results_for(b.id)[-1]["reason"] == "세글자 단어만 인정됩니다"
    h.room.close()


async def test_restart_keeps_mode():
    h = Harness(target_score=1)
    a = h.room.add_player("철수")
    h.room.add_player("영희")
    await h.room.set_mode(a.id, 2)
    await h.room.start(a.id)
    await wait_phase(h.room, "playing")
    await h.room.submit(a.id, "부산")
    await wait_phase(h.room, "game_over")
    await h.room.restart(a.id)
    assert h.room.word_length == 2
