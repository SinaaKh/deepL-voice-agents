"""Session event bus + ordered outbound queue.

Every interesting thing that happens inside the pipeline is emitted as a small JSON event
stamped with `t` (milliseconds since the session started, monotonic clock). The dashboard
renders these live – VAD trace, stage activity, waterfall spans, transcripts – and the headless
tests assert on them.

JSON events and synthesized audio share ONE ordered queue so `response.audio_start` always
precedes its PCM bytes, and so a barge-in can drop audio that was queued but not yet sent
(the "downstream pipeline flush" from Lesson 3).
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any


class Clock:
    def __init__(self) -> None:
        self._t0 = time.perf_counter()

    def now_ms(self) -> float:
        return (time.perf_counter() - self._t0) * 1000.0

    def reset(self) -> None:
        self._t0 = time.perf_counter()


class EventBus:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self._q: deque[dict[str, Any] | bytes] = deque()
        self._wake = asyncio.Event()
        self.history: list[dict[str, Any]] = []
        self.closed = False

    # -- producers -------------------------------------------------------------------------
    def emit(self, type_: str, **data: Any) -> dict[str, Any]:
        ev = {"type": type_, "t": round(self.clock.now_ms(), 1), **data}
        if type_ not in ("vad", "llm.token", "stt.interim"):
            self.history.append(ev)
            if len(self.history) > 4000:
                del self.history[:1000]
        self._q.append(ev)
        self._wake.set()
        return ev

    def put_audio(self, pcm: bytes) -> None:
        self._q.append(pcm)
        self._wake.set()

    def drop_audio(self) -> int:
        """Discard queued-but-unsent audio. Returns the number of bytes dropped."""
        dropped = sum(len(x) for x in self._q if isinstance(x, (bytes, bytearray)))
        self._q = deque(x for x in self._q if not isinstance(x, (bytes, bytearray)))
        return dropped

    def close(self) -> None:
        self.closed = True
        self._wake.set()

    # -- consumer --------------------------------------------------------------------------
    async def get(self) -> dict[str, Any] | bytes | None:
        while not self._q:
            if self.closed:
                return None
            self._wake.clear()
            await self._wake.wait()
        return self._q.popleft()
