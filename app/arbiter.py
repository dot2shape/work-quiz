"""선착순 판정기.

제출마다 서버 도착 순번(seq)을 부여하고 검증을 동시에 진행하되,
앞 순번의 결과가 모두 나오기 전에는 뒤 순번을 승자로 확정하지 않는다.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .dictionary import Verdict

log = logging.getLogger(__name__)

WinnerHandler = Callable[["Submission"], Awaitable[None]]
ResultHandler = Callable[["Submission"], Awaitable[None]]


@dataclass
class Submission:
    seq: int
    player_id: str
    word: str
    verdict: Verdict | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


class Arbiter:
    def __init__(self, on_winner: WinnerHandler, on_result: ResultHandler | None = None):
        self._on_winner = on_winner
        self._on_result = on_result
        self._queue: list[Submission] = []
        self._seq = 0
        self._closed = False

    def submit(self, player_id: str, word: str, check: Awaitable[Verdict]) -> Submission:
        self._seq += 1
        sub = Submission(seq=self._seq, player_id=player_id, word=word)
        self._queue.append(sub)
        # 검증 코루틴을 즉시 태스크로 감싸 close() 시 안전하게 취소할 수 있게 한다
        sub.task = asyncio.ensure_future(check)
        asyncio.ensure_future(self._run(sub))
        return sub

    async def _run(self, sub: Submission) -> None:
        try:
            sub.verdict = await sub.task
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # 검증 코드 자체의 예외도 "판정 불가"로 다룬다
            log.exception("검증 중 예외 seq=%s word=%s", sub.seq, sub.word)
            sub.verdict = Verdict(valid=False, reason="판정 중 오류가 발생했습니다", error=True)
        if self._closed:
            return
        if self._on_result is not None and not sub.verdict.valid:
            await self._on_result(sub)
        await self._drain()

    async def _drain(self) -> None:
        """큐 머리부터 확정 가능한 제출을 처리한다."""
        while self._queue and not self._closed:
            head = self._queue[0]
            if head.verdict is None:
                return  # 앞 순번 미해결 → 보류
            self._queue.pop(0)
            if head.verdict.valid:
                self.close()
                await self._on_winner(head)
                return

    def close(self) -> None:
        self._closed = True
        for sub in self._queue:
            if sub.task is not None and not sub.task.done():
                sub.task.cancel()
        self._queue.clear()
