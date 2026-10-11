"""방 생성·조회·정리를 담당한다."""
from __future__ import annotations

import secrets
import time
from typing import Awaitable, Callable

from .config import Settings
from .dictionary import Dictionary
from .room import Room, RoomError

# 혼동되는 문자(0 O 1 I)를 뺀 코드 문자 집합
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_code(length: int = 6) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


class RoomManager:
    def __init__(self, settings: Settings, dictionary: Dictionary):
        self._settings = settings
        self._dictionary = dictionary
        self.rooms: dict[str, Room] = {}

    def create(self, broadcast: Callable[[dict], Awaitable[None]], send: Callable[[str, dict], Awaitable[None]]) -> Room:
        if len(self.rooms) >= self._settings.max_rooms:
            raise RoomError("지금은 방을 더 만들 수 없습니다. 잠시 후 다시 시도해 주세요")
        code = generate_code()
        while code in self.rooms:
            code = generate_code()
        room = Room(code, self._dictionary, self._settings, broadcast=broadcast, send=send)
        self.rooms[code] = room
        return room

    def get(self, code: str) -> Room | None:
        return self.rooms.get(code.strip().upper())

    def remove(self, code: str) -> None:
        room = self.rooms.pop(code, None)
        if room is not None:
            room.close()

    def sweep(self, now: float | None = None) -> int:
        """전원 퇴장 후 TTL이 지난 방을 정리하고 정리된 개수를 돌려준다."""
        now = time.monotonic() if now is None else now
        ttl = self._settings.empty_room_ttl_seconds
        stale = [c for c, r in self.rooms.items() if r.is_empty() and r.empty_since is not None and now - r.empty_since > ttl]
        for code in stale:
            self.remove(code)
        return len(stale)
