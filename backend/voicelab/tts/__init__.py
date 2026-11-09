"""Text-to-Speech providers (Lesson 1/4/5).

Every provider yields raw mono PCM16 so the browser can play it without decoding, and so the
session can compute exact audio durations (needed to truncate history after a barge-in).

The metric that matters is **TTFB** – time from sending text to receiving the first playable byte;
total render time is secondary because playback duration acts as a natural buffer (Lesson 5).
"""
from __future__ import annotations

import asyncio
import math
import os
import re
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from collections.abc import AsyncIterator
from typing import Protocol

import httpx
import numpy as np

from ..audio import chunk, f32_to_pcm16, read_wav
from ..config import Pronunciation, settings


class TTSProvider(Protocol):
    name: str
    sample_rate: int
    streaming: bool

    def synthesize(self, text: str, *, voice_id: str, speed: float) -> AsyncIterator[bytes]: ...


def apply_pronunciations(text: str, rules: list[Pronunciation]) -> str:
    """Lesson 4: pronunciation overrides for brand names, acronyms, specialised phrases."""
    for r in rules:
        if not r.match:
            continue
        text = re.sub(rf"(?<!\w){re.escape(r.match)}(?!\w)", r.say, text, flags=re.I)
    return text


# --------------------------------------------------------------------------- #
# Piper – local neural TTS (ONNX). Fast enough to stream sentence-by-sentence on a laptop CPU.
# --------------------------------------------------------------------------- #
PIPER_DIR = Path(__file__).resolve().parents[2] / "models" / "piper"
_piper_voices: dict[str, object] = {}
_piper_lock = threading.Lock()
_piper_exec = ThreadPoolExecutor(max_workers=2, thread_name_prefix="piper")


def piper_voices() -> list[dict]:
    if not PIPER_DIR.exists():
        return []
    return [{"id": p.stem, "label": p.stem.replace("en_US-", "").replace("-medium", "").replace("-low", " (low)").title()}
            for p in sorted(PIPER_DIR.glob("*.onnx"))]


def load_piper(voice_id: str = ""):
    voices = piper_voices()
    if not voices:
        raise FileNotFoundError("No Piper voices found. Run: python scripts/download_models.py")
    vid = voice_id if any(v["id"] == voice_id for v in voices) else voices[0]["id"]
    with _piper_lock:
        if vid not in _piper_voices:
            from piper import PiperVoice, SynthesisConfig

            v = PiperVoice.load(str(PIPER_DIR / f"{vid}.onnx"))
            for _ in v.synthesize("Warm up.", syn_config=SynthesisConfig()):  # first call pays ONNX init
                pass
            _piper_voices[vid] = v
        return _piper_voices[vid]


class PiperTTS:
    name = "piper"
    sample_rate = 22050
    streaming = True

    async def synthesize(self, text: str, *, voice_id: str, speed: float) -> AsyncIterator[bytes]:
        from piper import SynthesisConfig

        loop = asyncio.get_running_loop()
        voice = await loop.run_in_executor(None, load_piper, voice_id)
        self.sample_rate = voice.config.sample_rate  # type: ignore[attr-defined]
        q: asyncio.Queue[bytes | None] = asyncio.Queue()
        stop = threading.Event()

        def work() -> None:
            try:
                cfg = SynthesisConfig(length_scale=1.0 / max(0.5, speed))
                for ch in voice.synthesize(text, syn_config=cfg):  # type: ignore[attr-defined]
                    if stop.is_set():
                        break
                    loop.call_soon_threadsafe(q.put_nowait, ch.audio_int16_bytes)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)

        loop.run_in_executor(_piper_exec, work)
        try:
            while (b := await q.get()) is not None:
                for c in chunk(b, int(self.sample_rate * 2 * 0.2)):
                    yield c
        finally:
            stop.set()


# --------------------------------------------------------------------------- #
# macOS `say` – free, local, offline (renders a whole sentence => streaming=False)
# --------------------------------------------------------------------------- #
def say_voices() -> list[dict]:
    if not shutil.which("say"):
        return []
    import subprocess

    out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = []
    for line in out.splitlines():
        m = re.match(r"^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})\s+#", line)
        if m and m.group(2).startswith("en"):
            voices.append({"id": m.group(1).strip(), "label": f"{m.group(1).strip()} ({m.group(2)})"})
    pref = ["Samantha", "Daniel", "Karen", "Moira", "Tessa", "Rishi", "Fred", "Alex"]
    voices.sort(key=lambda v: (pref.index(v["id"]) if v["id"] in pref else 99, v["id"]))
    return voices


class MacSayTTS:
    name = "macos-say"
    sample_rate = 22050
    streaming = False

    async def synthesize(self, text: str, *, voice_id: str, speed: float) -> AsyncIterator[bytes]:
        voice = voice_id or "Samantha"
        rate = int(max(90, min(360, 175 * speed)))
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            proc = await asyncio.create_subprocess_exec(
                "say", "-v", voice, "-r", str(rate), "-o", path, f"--data-format=LEI16@{self.sample_rate}", "-f", "-",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await proc.communicate(text.encode())
            except asyncio.CancelledError:
                proc.kill()
                raise
            with open(path, "rb") as f:
                pcm, sr = read_wav(f.read())
            self.sample_rate = sr
            for c in chunk(pcm, int(sr * 2 * 0.04)):  # 40 ms frames
                yield c
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# OpenAI TTS (HTTP streaming, raw 24 kHz PCM)
# --------------------------------------------------------------------------- #
class OpenAITTS:
    name = "openai"
    sample_rate = 24000
    streaming = True

    def __init__(self, model: str = "") -> None:
        self.model = model or "gpt-4o-mini-tts"

    async def synthesize(self, text: str, *, voice_id: str, speed: float) -> AsyncIterator[bytes]:
        body = {"model": self.model, "input": text, "voice": voice_id or "alloy", "response_format": "pcm", "speed": speed}
        carry = b""
        async with httpx.AsyncClient(timeout=30) as c:
            async with c.stream("POST", "https://api.openai.com/v1/audio/speech",
                                headers={"Authorization": f"Bearer {settings.openai_key}"}, json=body) as r:
                r.raise_for_status()
                async for b in r.aiter_bytes(4800):
                    b = carry + b
                    if len(b) % 2:
                        b, carry = b[:-1], b[-1:]
                    else:
                        carry = b""
                    if b:
                        yield b


# --------------------------------------------------------------------------- #
# ElevenLabs (HTTP streaming, raw 24 kHz PCM) – supports custom voice clones via voice_id
# --------------------------------------------------------------------------- #
ELEVEN_VOICES = [
    {"id": "CwhRBWXzGAHq8TQ4Fs17", "label": "Roger (the voice swapped in during Lesson 4)"},
    {"id": "EXAVITQu4vr4xnSDxMaL", "label": "Sarah"},
    {"id": "JBFqnCBsd6RMkjVDRZzb", "label": "George"},
]


class ElevenLabsTTS:
    name = "elevenlabs"
    sample_rate = 24000
    streaming = True

    def __init__(self, model: str = "") -> None:
        self.model = model or "eleven_flash_v2_5"

    async def synthesize(self, text: str, *, voice_id: str, speed: float) -> AsyncIterator[bytes]:
        vid = voice_id or ELEVEN_VOICES[0]["id"]
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}/stream?output_format=pcm_24000"
        body = {"text": text, "model_id": self.model, "voice_settings": {"speed": max(0.7, min(1.2, speed))}}
        carry = b""
        async with httpx.AsyncClient(timeout=30) as c:
            async with c.stream("POST", url, headers={"xi-api-key": settings.elevenlabs_key}, json=body) as r:
                r.raise_for_status()
                async for b in r.aiter_bytes(4800):
                    b = carry + b
                    if len(b) % 2:
                        b, carry = b[:-1], b[-1:]
                    else:
                        carry = b""
                    if b:
                        yield b


# --------------------------------------------------------------------------- #
# Mock – synthetic "voice" (formant-ish buzz modulated at syllable rate), streaming
# --------------------------------------------------------------------------- #
class MockTTS:
    name = "mock"
    sample_rate = 24000
    streaming = True
    TTFB_MS = 140

    async def synthesize(self, text: str, *, voice_id: str, speed: float) -> AsyncIterator[bytes]:
        await asyncio.sleep(self.TTFB_MS / 1000)
        words = max(1, len(text.split()))
        dur = max(0.4, words * 0.34 / speed)
        sr = self.sample_rate
        n = int(sr * dur)
        t = np.arange(n) / sr
        base = 110 + (sum(map(ord, voice_id or "x")) % 80)  # stable per voice_id
        f0 = base * (1 + 0.06 * np.sin(2 * math.pi * 0.7 * t))
        phase = 2 * math.pi * np.cumsum(f0) / sr
        wave = sum(np.sin(k * phase) / k for k in range(1, 7))
        env = 0.5 * (1 + np.sin(2 * math.pi * 3.2 * t - 1.2)) ** 0.7
        gaps = np.ones(n)
        for i in range(1, words):
            c = int(sr * (i * dur / words))
            gaps[max(0, c - int(sr * 0.03)) : c + int(sr * 0.03)] = 0.15
        y = (wave * env * gaps * 0.22).astype(np.float32)
        pcm = f32_to_pcm16(y)
        step = int(sr * 2 * 0.04)
        for c in chunk(pcm, step):
            yield c
            await asyncio.sleep(0.004)  # renders far faster than real time (like a good streaming TTS)


def create_tts(provider: str, model: str = "") -> TTSProvider:
    if provider == "piper" and piper_voices():
        return PiperTTS()
    if provider == "openai":
        return OpenAITTS(model)
    if provider == "elevenlabs":
        return ElevenLabsTTS(model)
    if provider == "macos-say" and shutil.which("say"):
        return MacSayTTS()
    return MockTTS()
