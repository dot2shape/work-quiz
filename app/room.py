"""방(Room)과 라운드 상태 머신.

phase: lobby → countdown → playing → round_end → (playing ... | game_over) → lobby(restart)
모든 시간 판단은 서버에서만 이루어진다.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Literal

from .arbiter import Arbiter, Submission
from .config import Settings
from .dictionary import Dictionary
from .hangul import is_hangul_word, normalize
from .prompts import PromptPicker

log = logging.getLogger(__name__)

Phase = Literal["lobby", "countdown", "playing", "round_end", "game_over"]
Broadcast = Callable[[dict], Awaitable[None]]
Send = Callable[[str, dict], Awaitable[None]]
Sleep = Callable[[float], Awaitable[None]]

MAX_WORD_LEN = 20
MAX_NICKNAME_LEN = 12


class RoomError(Exception):
    """플레이어에게 그대로 보여 줄 수 있는 오류 메시지."""


@dataclass
class Player:
    id: str
    token: str
    nickname: str
    score: int = 0
    connected: bool = True
    cooldown_until: float = 0.0

    def public(self) -> dict:
        return {"id": self.id, "nickname": self.nickname, "score": self.score, "connected": self.connected}


@dataclass
class RoundResult:
    winner_id: str | None = None
    word: str | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)


class Room:
    def __init__(
        self,
        code: str,
        dictionary: Dictionary,
        settings: Settings,
        broadcast: Broadcast,
        send: Send,
        picker: PromptPicker | None = None,
        sleep: Sleep = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.code = code
        self.players: dict[str, Player] = {}
        self.host_id: str | None = None
        self.phase: Phase = "lobby"
        self.round_no = 0
        self.prompt: str | None = None
        self.used_words: set[str] = set()
        self.used_prompts: set[str] = set()
        self.empty_since: float | None = None
        self.round_ends_at: float | None = None

        self._dictionary = dictionary
        self._settings = settings
        self._broadcast = broadcast
        self._send = send
        self._picker = picker or PromptPicker()
        self._sleep = sleep
        self._clock = clock
        self._arbiter: Arbiter | None = None
        self._round: RoundResult | None = None
        self._loop_task: asyncio.Task | None = None

    # ── 플레이어 관리 ──────────────────────────────────────────────

    def add_player(self, nickname: str, token: str | None = None) -> Player:
        if token:
            for p in self.players.values():
                if p.token == token:
                    p.connected = True
                    self.empty_since = None
                    if self.host_id is None or not self.players[self.host_id].connected:
                        self.host_id = p.id
                    return p
        nickname = nickname.strip()[:MAX_NICKNAME_LEN]
        if not nickname:
            raise RoomError("닉네임을 입력해 주세요")
        if len(self.players) >= self._settings.max_players:
            raise RoomError(f"방이 가득 찼습니다 (최대 {self._settings.max_players}명)")
        player = Player(id=uuid.uuid4().hex[:8], token=secrets.token_urlsafe(16), nickname=nickname)
        self.players[player.id] = player
        self.empty_since = None
        if self.host_id is None:
            self.host_id = player.id
        return player

    def disconnect(self, player_id: str) -> None:
        player = self.players.get(player_id)
        if player is None:
            return
        player.connected = False
        if self.phase == "lobby":
            del self.players[player_id]
        if self.host_id == player_id:
            self.host_id = next((p.id for p in self.players.values() if p.connected), None)
        if self.is_empty():
            self.empty_since = self._clock()

    def is_empty(self) -> bool:
        return not any(p.connected for p in self.players.values())

    def connected_count(self) -> int:
        return sum(1 for p in self.players.values() if p.connected)

    # ── 상태 조회 ──────────────────────────────────────────────────

    def state(self) -> dict:
        return {
            "type": "room_state",
            "code": self.code,
            "phase": self.phase,
            "host_id": self.host_id,
            "players": [p.public() for p in self.players.values()],
            "round": self.round_no,
            "prompt": self.prompt if self.phase in ("playing", "round_end") else None,
            "used_words": sorted(self.used_words),
            "target_score": self._settings.target_score,
            "round_seconds": self._settings.round_seconds,
            "dictionary_mode": self._dictionary.name,
            "remaining_ms": self._remaining_ms(),
        }

    def _remaining_ms(self) -> int | None:
        if self.phase != "playing" or self.round_ends_at is None:
            return None
        return max(0, int((self.round_ends_at - self._clock()) * 1000))

    # ── 게임 제어 ──────────────────────────────────────────────────

    async def start(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise RoomError("방장만 시작할 수 있습니다")
        if self.phase != "lobby":
            raise RoomError("이미 게임이 진행 중입니다")
        if self.connected_count() < self._settings.min_players:
            raise RoomError(f"{self._settings.min_players}명 이상 모여야 시작할 수 있습니다")
        self.phase = "countdown"
        self._loop_task = asyncio.ensure_future(self._game_loop())

    async def restart(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise RoomError("방장만 다시 시작할 수 있습니다")
        if self.phase != "game_over":
            raise RoomError("게임이 끝난 뒤에 다시 시작할 수 있습니다")
        self._reset()
        # 연결이 끊긴 플레이어는 로비에서 정리한다
        for pid in [p.id for p in self.players.values() if not p.connected]:
            del self.players[pid]
        await self._broadcast(self.state())

    def _reset(self) -> None:
        self.phase = "lobby"
        self.round_no = 0
        self.prompt = None
        self.used_words.clear()
        self.used_prompts.clear()
        self.round_ends_at = None
        for p in self.players.values():
            p.score = 0
            p.cooldown_until = 0.0

    def close(self) -> None:
        if self._arbiter is not None:
            self._arbiter.close()
        if self._loop_task is not None and not self._loop_task.done():
            self._loop_task.cancel()

    async def _game_loop(self) -> None:
        try:
            while True:
                await self._run_round()
                if self.phase == "game_over":
                    return
                await self._sleep(self._settings.round_end_seconds)
                self.phase = "countdown"
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("게임 루프 오류 room=%s", self.code)
            self._reset()
            await self._broadcast({"type": "error", "message": "서버 오류로 게임이 중단되었습니다"})
            await self._broadcast(self.state())

    async def _run_round(self) -> None:
        # 카운트다운: 입력 잠금
        self.phase = "countdown"
        self.prompt = None
        await self._broadcast(self.state())
        for value in range(self._settings.countdown_seconds, 0, -1):
            await self._broadcast({"type": "countdown", "value": value})
            await self._sleep(1)

        # 제시어 공개
        self.round_no += 1
        self.prompt = self._picker.next(self.used_prompts)
        self.used_prompts.add(self.prompt)
        self.phase = "playing"
        self.round_ends_at = self._clock() + self._settings.round_seconds
        self._round = RoundResult()
        self._arbiter = Arbiter(self._on_winner, on_result=self._on_rejected)
        await self._broadcast({
            "type": "round_start",
            "round": self.round_no,
            "prompt": self.prompt,
            "round_seconds": self._settings.round_seconds,
        })

        # 승자 확정 또는 제한 시간 경과까지 대기
        timer = asyncio.ensure_future(self._sleep(self._settings.round_seconds))
        waiter = asyncio.ensure_future(self._round.done.wait())
        try:
            await asyncio.wait({timer, waiter}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (timer, waiter):
                t.cancel()
        self._arbiter.close()
        self.round_ends_at = None

        # 라운드 종료
        result = self._round
        self.phase = "round_end"
        await self._broadcast({
            "type": "round_end",
            "round": self.round_no,
            "prompt": self.prompt,
            "winner_id": result.winner_id,
            "word": result.word,
            "players": [p.public() for p in self.players.values()],
        })

        if result.winner_id and self.players[result.winner_id].score >= self._settings.target_score:
            self.phase = "game_over"
            await self._broadcast({
                "type": "game_over",
                "winner_id": result.winner_id,
                "players": [p.public() for p in self.players.values()],
            })

    # ── 제출 처리 ──────────────────────────────────────────────────

    async def submit(self, player_id: str, raw_word: str) -> None:
        player = self.players.get(player_id)
        if player is None:
            return
        if self.phase != "playing" or self._arbiter is None:
            await self._reject(player, "지금은 제출할 수 없습니다", cooldown=False)
            return
        now = self._clock()
        if now < player.cooldown_until:
            await self._reject(player, "잠시 후 다시 시도하세요", cooldown=False,
                               cooldown_ms=int((player.cooldown_until - now) * 1000))
            return

        word = normalize(str(raw_word)[:MAX_WORD_LEN])
        if not is_hangul_word(word):
            await self._reject(player, "한글 2글자 이상의 단어만 인정됩니다")
            return
        if not word.startswith(self.prompt or ""):
            await self._reject(player, f"'{self.prompt}'(으)로 시작해야 합니다")
            return
        if word in self.used_words:
            await self._reject(player, "이미 나온 단어입니다")
            return

        self._arbiter.submit(player.id, word, self._dictionary.is_noun(word))

    async def _reject(self, player: Player, reason: str, cooldown: bool = True, cooldown_ms: int | None = None) -> None:
        if cooldown:
            player.cooldown_until = self._clock() + self._settings.cooldown_seconds
            cooldown_ms = int(self._settings.cooldown_seconds * 1000)
        await self._send(player.id, {
            "type": "submit_result", "accepted": False, "reason": reason, "cooldown_ms": cooldown_ms or 0,
        })

    async def _on_rejected(self, sub: Submission) -> None:
        player = self.players.get(sub.player_id)
        if player is None or sub.verdict is None:
            return
        # 사전 오류는 제출자 잘못이 아니므로 쿨다운을 주지 않는다
        await self._reject(player, sub.verdict.reason or "인정되지 않는 단어입니다", cooldown=not sub.verdict.error)

    async def _on_winner(self, sub: Submission) -> None:
        if self._round is None or self._round.done.is_set() or self.phase != "playing":
            return
        player = self.players.get(sub.player_id)
        if player is None:
            return
        player.score += 1
        self.used_words.add(sub.word)
        self._round.winner_id = player.id
        self._round.word = sub.word
        await self._send(player.id, {"type": "submit_result", "accepted": True, "word": sub.word})
        self._round.done.set()
