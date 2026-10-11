"""WebSocket 연결 관리와 메시지 라우팅."""
from __future__ import annotations

import logging

from fastapi import WebSocket, WebSocketDisconnect

from .manager import RoomManager
from .room import Player, Room, RoomError

log = logging.getLogger(__name__)


class Hub:
    """방 코드 → (플레이어 id → 소켓) 매핑을 들고 방의 broadcast/send를 실제 전송으로 연결한다."""

    def __init__(self, manager: RoomManager):
        self.manager = manager
        self._sockets: dict[str, dict[str, WebSocket]] = {}

    # ── Room 콜백 ─────────────────────────────────────────────────

    def callbacks_for(self, code: str):
        async def broadcast(msg: dict) -> None:
            for pid, ws in list(self._sockets.get(code, {}).items()):
                await self._safe_send(code, pid, ws, msg)

        async def send(player_id: str, msg: dict) -> None:
            ws = self._sockets.get(code, {}).get(player_id)
            if ws is not None:
                await self._safe_send(code, player_id, ws, msg)

        return broadcast, send

    async def _safe_send(self, code: str, pid: str, ws: WebSocket, msg: dict) -> None:
        try:
            await ws.send_json(msg)
        except Exception:  # 끊어진 소켓은 조용히 제거한다
            self._sockets.get(code, {}).pop(pid, None)

    # ── 연결 수명 ─────────────────────────────────────────────────

    async def handle(self, ws: WebSocket) -> None:
        await ws.accept()
        room: Room | None = None
        player: Player | None = None
        try:
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                mtype = msg.get("type")
                try:
                    if mtype in ("create_room", "join_room"):
                        if room is not None:
                            raise RoomError("이미 방에 들어와 있습니다")
                        room, player = await self._enter(ws, msg)
                    elif room is None or player is None:
                        raise RoomError("먼저 방에 입장해 주세요")
                    elif mtype == "start_game":
                        await room.start(player.id)
                    elif mtype == "submit_word":
                        await room.submit(player.id, str(msg.get("word", "")))
                    elif mtype == "restart_game":
                        await room.restart(player.id)
                    elif mtype == "set_mode":
                        try:
                            length = int(msg.get("word_length", 0))
                        except (TypeError, ValueError):
                            raise RoomError("지원하지 않는 모드입니다")
                        await room.set_mode(player.id, length)
                    elif mtype == "ping":
                        await ws.send_json({"type": "pong"})
                    else:
                        raise RoomError("알 수 없는 요청입니다")
                except RoomError as exc:
                    await ws.send_json({"type": "error", "message": str(exc)})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("웹소켓 처리 오류")
        finally:
            if room is not None and player is not None:
                await self._leave(room, player)

    async def _enter(self, ws: WebSocket, msg: dict) -> tuple[Room, Player]:
        nickname = str(msg.get("nickname", ""))
        if msg["type"] == "create_room":
            room = self.manager.create(self.callbacks_for)
        else:
            room = self.manager.get(str(msg.get("code", "")))
            if room is None:
                raise RoomError("존재하지 않는 방 코드입니다")
        token = msg.get("token") or None
        player = room.add_player(nickname, token=token if isinstance(token, str) else None)
        self._sockets.setdefault(room.code, {})[player.id] = ws
        await ws.send_json({
            "type": "joined", "code": room.code, "player_id": player.id,
            "token": player.token, "is_host": room.host_id == player.id,
        })
        broadcast, _ = self.callbacks_for(room.code)
        await broadcast(room.state())
        return room, player

    async def _leave(self, room: Room, player: Player) -> None:
        sockets = self._sockets.get(room.code, {})
        if sockets.get(player.id) is not None:
            sockets.pop(player.id, None)
        room.disconnect(player.id)
        if room.is_empty():
            if room.phase == "lobby":  # 로비에서 전원 퇴장하면 바로 정리
                self.manager.remove(room.code)
                self._sockets.pop(room.code, None)
            return
        broadcast, _ = self.callbacks_for(room.code)
        await broadcast(room.state())
