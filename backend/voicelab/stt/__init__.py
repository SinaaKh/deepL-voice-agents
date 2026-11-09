"""Speech-to-Text providers (Lesson 1/4/5).

Interface mirrors what the course measures in `STTMetrics`:
  * `audio_ms`   – total input audio duration
  * `streamed`   – whether the provider transcribed incrementally while the user talked
  * `finalize_ms`– how long finishing took *after* the turn ended (this sits on the critical path
                   for buffered providers, and is ~0 for true streaming ones)
"""
from __future__ import annotations

import asyncio
import io
import json
import threading
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

import httpx

from ..audio import MIC_RATE, duration_ms, to_wav
from ..config import settings

InterimCb = Callable[[str], Awaitable[None] | None]


@dataclass
class STTResult:
    text: str
    audio_ms: float
    streamed: bool
    finalize_ms: float
    note: str = ""


class STTSession(Protocol):
    def push(self, pcm: bytes) -> None: ...
    async def finish(self) -> STTResult: ...
    async def cancel(self) -> None: ...


class STTProvider(Protocol):
    name: str
    streaming: bool

    def open(self, on_interim: InterimCb, hint: str | None = None) -> STTSession: ...


async def _maybe_await(r):
    if asyncio.iscoroutine(r):
        await r


# --------------------------------------------------------------------------- #
# Local Whisper (faster-whisper) – chunk-streamed
# --------------------------------------------------------------------------- #
_whisper_lock = threading.Lock()
_whisper_models: dict[str, object] = {}
_whisper_exec = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")


def load_whisper(name: str):
    with _whisper_lock:
        if name not in _whisper_models:
            from faster_whisper import WhisperModel

            _whisper_models[name] = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=4)
        return _whisper_models[name]


def whisper_loaded(name: str) -> bool:
    return name in _whisper_models


def _whisper_transcribe(model_name: str, pcm: bytes, language: str, prompt: str | None) -> str:
    import numpy as np

    model = load_whisper(model_name)
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    segments, _ = model.transcribe(  # type: ignore[attr-defined]
        audio,
        language=None if model_name.endswith(".en") and language == "en" else language,
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=False,  # we already gate with Silero – no double VAD
        initial_prompt=prompt,
    )
    return " ".join(s.text.strip() for s in segments).strip()


class WhisperSession:
    INTERIM_EVERY_MS = 700
    MIN_INTERIM_MS = 450

    def __init__(self, model: str, language: str, on_interim: InterimCb, prompt: str | None) -> None:
        self.model, self.language, self.on_interim, self.prompt = model, language, on_interim, prompt
        self.buf = bytearray()
        self._inflight: asyncio.Future | None = None
        self._last_interim_audio = 0
        self._last_text = ""
        self._last_at = 0.0
        self._cancelled = False
        self._final_len = -1
        self._final_text = ""
        self._pending: tuple[int, asyncio.Future] | None = None
        self._loop = asyncio.get_running_loop()

    def push(self, pcm: bytes) -> None:
        if self._cancelled:
            return
        self.buf += pcm
        ms = duration_ms(len(self.buf), MIC_RATE)
        now = time.perf_counter() * 1000
        if (
            self._inflight is None
            and ms >= self.MIN_INTERIM_MS
            and now - self._last_at >= self.INTERIM_EVERY_MS
        ):
            self._last_at = now
            snap = bytes(self.buf)
            self._last_interim_audio = len(snap)
            self._inflight = self._loop.run_in_executor(
                _whisper_exec, _whisper_transcribe, self.model, snap, self.language, self.prompt
            )
            self._inflight.add_done_callback(lambda f: self._loop.create_task(self._on_interim_done(f)))

    async def _on_interim_done(self, fut: asyncio.Future) -> None:
        self._inflight = None
        if self._cancelled or fut.cancelled() or fut.exception():
            return
        text = fut.result()
        if text and text != self._last_text:
            self._last_text = text
            await _maybe_await(self.on_interim(text))

    async def _run_now(self) -> str:
        """Transcribe the whole buffer; concurrent callers share one job (no double work)."""
        n = len(self.buf)
        if self._pending is not None and self._pending[0] == n:
            return await asyncio.shield(self._pending[1])
        snap = bytes(self.buf)
        fut = self._loop.run_in_executor(
            _whisper_exec, _whisper_transcribe, self.model, snap, self.language, self.prompt
        )
        self._pending = (n, fut)
        try:
            return await asyncio.shield(fut)
        finally:
            if self._pending and self._pending[1] is fut and fut.done():
                self._final_len, self._final_text = n, fut.result() if not fut.cancelled() and not fut.exception() else ""

    async def flush_interim(self) -> str:
        """Transcribe everything heard so far *now* (speculative final). The turn timer calls this
        the moment VAD reports silence so the semantic detector sees up-to-date text, and so
        `finish()` is free if no more audio arrives."""
        if self._inflight is not None:
            try:
                await asyncio.shield(self._inflight)
            except Exception:
                pass
        if duration_ms(len(self.buf), MIC_RATE) < 120:
            return ""
        text = await self._run_now()
        if text and text != self._last_text:
            self._last_text = text
            await _maybe_await(self.on_interim(text))
        return text

    async def finish(self) -> STTResult:
        t0 = time.perf_counter()
        if self._inflight is not None:
            try:
                await asyncio.shield(self._inflight)
            except Exception:
                pass
        audio_ms = duration_ms(len(self.buf), MIC_RATE)
        text = ""
        if audio_ms >= 120:
            if self._final_len == len(self.buf):
                text = self._final_text  # nothing new since the speculative final
            else:
                text = await self._run_now()  # joins the speculative job if it covers the same audio
        return STTResult(text, audio_ms, True, (time.perf_counter() - t0) * 1000)

    async def cancel(self) -> None:
        self._cancelled = True


class WhisperLocal:
    name = "whisper-local"
    streaming = True

    def __init__(self, model: str = "", language: str = "en", prompt: str = "") -> None:
        self.model = model or settings.whisper_model
        self.language = language
        self.prompt = prompt or None

    def open(self, on_interim: InterimCb, hint: str | None = None) -> STTSession:
        return WhisperSession(self.model, self.language, on_interim, self.prompt)


# --------------------------------------------------------------------------- #
# OpenAI transcription (REST, buffered => streamed=False)
# --------------------------------------------------------------------------- #
class _OpenAISession:
    def __init__(self, model: str, language: str, prompt: str = "") -> None:
        self.model, self.language, self.prompt = model, language, prompt
        self.buf = bytearray()

    def push(self, pcm: bytes) -> None:
        self.buf += pcm

    async def finish(self) -> STTResult:
        t0 = time.perf_counter()
        wav = to_wav(bytes(self.buf), MIC_RATE)
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {settings.openai_key}"},
                files={"file": ("audio.wav", io.BytesIO(wav), "audio/wav")},
                data={"model": self.model, "language": self.language, "response_format": "json", **({"prompt": self.prompt} if self.prompt else {})},
            )
        r.raise_for_status()
        return STTResult(r.json().get("text", "").strip(), duration_ms(len(self.buf), MIC_RATE), False,
                         (time.perf_counter() - t0) * 1000)

    async def cancel(self) -> None:
        pass


class OpenAISTT:
    name = "openai"
    streaming = False

    def __init__(self, model: str = "", language: str = "en", prompt: str = "") -> None:
        self.model = model or "gpt-4o-mini-transcribe"
        self.language = language
        self.prompt = prompt

    def open(self, on_interim: InterimCb, hint: str | None = None) -> STTSession:
        return _OpenAISession(self.model, self.language, self.prompt)


# --------------------------------------------------------------------------- #
# Deepgram (WebSocket, truly streaming)
# --------------------------------------------------------------------------- #
class _DeepgramSession:
    def __init__(self, model: str, language: str, on_interim: InterimCb) -> None:
        self.model, self.language, self.on_interim = model, language, on_interim
        self.buf_ms = 0.0
        self._q: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._finals: list[str] = []
        self._partial = ""
        self._ws = None
        self._task = asyncio.create_task(self._run())
        self._closed = asyncio.Event()

    async def _run(self) -> None:
        import websockets

        url = (
            "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1"
            f"&model={self.model}&language={self.language}&interim_results=true&punctuate=true&smart_format=true"
        )
        try:
            async with websockets.connect(url, additional_headers={"Authorization": f"Token {settings.deepgram_key}"}) as ws:
                self._ws = ws

                async def sender():
                    while True:
                        item = await self._q.get()
                        if item is None:
                            await ws.send(json.dumps({"type": "Finalize"}))
                            await ws.send(json.dumps({"type": "CloseStream"}))
                            return
                        await ws.send(item)

                send_task = asyncio.create_task(sender())
                async for msg in ws:
                    data = json.loads(msg)
                    if data.get("type") != "Results":
                        continue
                    alt = (data.get("channel", {}).get("alternatives") or [{}])[0]
                    text = alt.get("transcript", "")
                    if data.get("is_final"):
                        if text:
                            self._finals.append(text)
                        self._partial = ""
                    else:
                        self._partial = text
                    joined = " ".join([*self._finals, self._partial]).strip()
                    if joined:
                        await _maybe_await(self.on_interim(joined))
                await send_task
        finally:
            self._closed.set()

    def push(self, pcm: bytes) -> None:
        self.buf_ms += duration_ms(len(pcm), MIC_RATE)
        self._q.put_nowait(pcm)

    async def finish(self) -> STTResult:
        t0 = time.perf_counter()
        self._q.put_nowait(None)
        try:
            await asyncio.wait_for(self._closed.wait(), timeout=4)
        except asyncio.TimeoutError:
            pass
        text = " ".join(self._finals).strip() or self._partial
        return STTResult(text, self.buf_ms, True, (time.perf_counter() - t0) * 1000)

    async def cancel(self) -> None:
        self._task.cancel()


class DeepgramSTT:
    name = "deepgram"
    streaming = True

    def __init__(self, model: str = "", language: str = "en") -> None:
        self.model = model or "nova-3"
        self.language = language

    def open(self, on_interim: InterimCb, hint: str | None = None) -> STTSession:
        return _DeepgramSession(self.model, self.language, on_interim)


# --------------------------------------------------------------------------- #
# Mock "oracle" STT – knows what the scripted user said (zero-dependency demos)
# --------------------------------------------------------------------------- #
class _MockSession:
    def __init__(self, on_interim: InterimCb, hint: str | None) -> None:
        self.on_interim, self.hint = on_interim, hint or ""
        self.ms = 0.0
        self._shown = 0
        self._loop = asyncio.get_running_loop()

    def push(self, pcm: bytes) -> None:
        self.ms += duration_ms(len(pcm), MIC_RATE)
        words = self.hint.split()
        if not words:
            return
        expected = len(words) * 290
        n = min(len(words), int(len(words) * min(1.0, self.ms / expected)))
        if n > self._shown:
            self._shown = n
            self._loop.create_task(_maybe_await(self.on_interim(" ".join(words[:n]))))

    async def flush_interim(self) -> str:
        await asyncio.sleep(0.03)
        if self.hint:
            await _maybe_await(self.on_interim(self.hint))
        return self.hint

    async def finish(self) -> STTResult:
        await asyncio.sleep(0.03)
        note = "" if self.hint else "mock STT cannot hear live audio – use a scenario or whisper-local"
        return STTResult(self.hint, self.ms, True, 60.0, note)

    async def cancel(self) -> None:
        pass


class MockSTT:
    name = "mock"
    streaming = True

    def open(self, on_interim: InterimCb, hint: str | None = None) -> STTSession:
        return _MockSession(on_interim, hint)


def create_stt(provider: str, model: str, language: str, prompt: str = "") -> STTProvider:
    if provider == "whisper-local":
        return WhisperLocal(model, language, prompt)
    if provider == "openai":
        return OpenAISTT(model, language, prompt)
    if provider == "deepgram":
        return DeepgramSTT(model, language)
    return MockSTT()
