from app.config import Settings
from app.dictionary import LocalDictionary
from app.manager import RoomManager, generate_code


def test_code_format():
    code = generate_code()
    assert len(code) == 6 and set(code) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")


async def noop_broadcast(msg):
    pass


async def noop_send(pid, msg):
    pass


def test_create_get_sweep():
    mgr = RoomManager(Settings(empty_room_ttl_seconds=600), LocalDictionary(set()))
    room = mgr.create(broadcast=noop_broadcast, send=noop_send)
    assert mgr.get(room.code.lower()) is room
    p = room.add_player("철수")
    room.disconnect(p.id)
    assert room.is_empty()
    mgr.sweep(now=room.empty_since + 10)
    assert mgr.get(room.code) is room
    mgr.sweep(now=room.empty_since + 601)
    assert mgr.get(room.code) is None
