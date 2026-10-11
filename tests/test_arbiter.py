import asyncio

from app.arbiter import Arbiter
from app.dictionary import Verdict


async def delayed(verdict: Verdict, delay: float) -> Verdict:
    await asyncio.sleep(delay)
    return verdict


async def test_later_valid_waits_for_earlier_slow_invalid():
    events: list[tuple[str, int]] = []
    winners = []

    async def on_winner(sub):
        winners.append(sub)
        events.append(("winner", sub.seq))

    arb = Arbiter(on_winner)
    first = arb.submit("p1", "부끄끄", delayed(Verdict(valid=False, reason="x"), 0.05))
    second = arb.submit("p2", "부산", delayed(Verdict(valid=True), 0.0))
    await asyncio.sleep(0.01)
    assert winners == []  # 앞 순번이 아직 미해결이면 보류
    await asyncio.sleep(0.1)
    assert [w.player_id for w in winners] == ["p2"]
    assert first.seq < second.seq


async def test_earlier_valid_wins_even_if_slower():
    winners = []

    async def on_winner(sub):
        winners.append(sub)

    arb = Arbiter(on_winner)
    arb.submit("p1", "부산", delayed(Verdict(valid=True), 0.05))
    arb.submit("p2", "부모", delayed(Verdict(valid=True), 0.0))
    await asyncio.sleep(0.1)
    assert [w.player_id for w in winners] == ["p1"]


async def test_close_cancels_pending():
    winners = []

    async def on_winner(sub):
        winners.append(sub)

    arb = Arbiter(on_winner)
    arb.submit("p1", "부산", delayed(Verdict(valid=True), 0.05))
    arb.close()
    await asyncio.sleep(0.1)
    assert winners == []


async def test_error_verdict_reported_but_not_winner():
    winners = []
    results = []

    async def on_winner(sub):
        winners.append(sub)

    async def on_result(sub):
        results.append(sub)

    arb = Arbiter(on_winner, on_result=on_result)
    arb.submit("p1", "부산", delayed(Verdict(valid=False, error=True, reason="판정 불가"), 0.0))
    await asyncio.sleep(0.02)
    assert winners == [] and [r.player_id for r in results] == ["p1"]
