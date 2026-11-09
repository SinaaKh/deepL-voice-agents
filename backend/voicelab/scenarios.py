"""Scripted "virtual callers".

A scenario is a list of steps. User speech is synthesised once (macOS `say`, cached) and then
streamed into the pipeline *in real time* – exactly like a microphone – including deliberate
mid-sentence pauses and barge-ins. That makes turn-detection and interruption experiments
repeatable: change one knob, replay the same caller, compare the metrics.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import tempfile
import time
from typing import Any

from .audio import MIC_RATE, chunk, read_wav, resample, silence
from .session import VoiceSession

SCENARIOS: dict[str, dict[str, Any]] = {
    "book_table": {
        "name": "Clean booking",
        "lesson": "Lesson 1 · 3 · 5",
        "persona": "restaurant",
        "blurb": "A cooperative caller. Baseline for latency: watch the waterfall for each turn.",
        "suggest": {},
        "steps": [
            {"op": "user", "text": "Hi, I'd like to book a table for four people at seven PM."},
            {"op": "wait_response"},
            {"op": "user", "text": "The name is Johnson."},
            {"op": "wait_response"},
        ],
    },
    "thinking_pause": {
        "name": "Mid-thought pause",
        "lesson": "Lesson 3 · turn detection",
        "persona": "restaurant",
        "blurb": "Caller trails off on “…for” and pauses 1.1 s. A pure VAD timer answers too early; the semantic detector waits.",
        "suggest": {"turn": {"mode": "semantic", "silence_timer_ms": 500, "max_delay_ms": 2500}},
        "steps": [
            {"op": "user", "text": "Hi, I'd like to book a table for"},
            {"op": "pause", "ms": 1100},
            {"op": "user", "text": "four people at seven thirty."},
            {"op": "wait_response"},
        ],
    },
    "disfluent": {
        "name": "Disfluent caller",
        "lesson": "Lesson 1 · speech disfluencies",
        "persona": "restaurant",
        "blurb": "Fillers and long hesitations (“um… uh…”) confuse end-of-turn detectors and the LLM input.",
        "suggest": {"turn": {"mode": "semantic"}},
        "steps": [
            {"op": "user", "text": "Um, uh, so I was wondering,"},
            {"op": "pause", "ms": 700},
            {"op": "user", "text": "like, if I could book a table"},
            {"op": "pause", "ms": 800},
            {"op": "user", "text": "for two people at eight PM."},
            {"op": "wait_response"},
        ],
    },
    "barge_in": {
        "name": "Barge-in",
        "lesson": "Lesson 3 · interruptions",
        "persona": "restaurant",
        "blurb": "The agent starts a long menu answer; 2.2 s in, the caller cuts in. Watch the flush and the history truncation.",
        "suggest": {"interrupt": {"enabled": True, "min_duration_ms": 320}},
        "steps": [
            {"op": "user", "text": "Tell me about your menu."},
            {"op": "wait_speaking", "timeout": 20},
            {"op": "wait", "ms": 2200},
            {"op": "user", "text": "Sorry, I actually meant the vegetarian options."},
            {"op": "wait_response", "timeout": 25},
        ],
    },
    "medical": {
        "name": "Clinical vocabulary",
        "lesson": "Lesson 4 · modular trade-offs",
        "persona": "medical",
        "blurb": "Specialised terms stress the STT layer – compare a tiny and a larger Whisper model.",
        "suggest": {"persona": "medical"},
        "steps": [
            {"op": "user", "text": "I've had tachycardia and a persistent migraine with photophobia since Tuesday."},
            {"op": "wait_response"},
            {"op": "user", "text": "About a seven out of ten."},
            {"op": "wait_response"},
        ],
    },
    "guardrail": {
        "name": "Sensitive data",
        "lesson": "Lesson 4 · LLM guardrails",
        "persona": "restaurant",
        "blurb": "Caller reads out a card number. With guardrails on, the LLM layer blocks it before any model sees it.",
        "suggest": {"guardrails": {"enabled": True}},
        "steps": [
            {"op": "user", "text": "Sure, my credit card number is four one one one one one one one."},
            {"op": "wait_response"},
        ],
    },
}


def list_scenarios() -> list[dict]:
    out = []
    for sid, s in SCENARIOS.items():
        n_users = sum(1 for st in s["steps"] if st["op"] == "user")
        out.append({"id": sid, **{k: v for k, v in s.items() if k != "steps"}, "turns": n_users,
                    "script": [st.get("text") or f"[{st['op']} {st.get('ms', '')}]" for st in s["steps"]]})
    return out


# --------------------------------------------------------------------------- #
_CACHE = os.path.join(tempfile.gettempdir(), "voicelab_scenarios")
USER_VOICE = "Daniel"


async def synth_user(text: str, voice: str = USER_VOICE) -> bytes:
    """16 kHz mono PCM16 of the caller saying `text`."""
    os.makedirs(_CACHE, exist_ok=True)
    key = hashlib.sha1(f"{voice}|{text}".encode()).hexdigest()[:16]
    path = os.path.join(_CACHE, key + ".wav")
    if not os.path.exists(path):
        if shutil.which("say"):
            proc = await asyncio.create_subprocess_exec(
                "say", "-v", voice, "-r", "170", "-o", path, "--data-format=LEI16@22050", "-f", "-",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate(text.encode())
            if proc.returncode != 0 and voice != "Samantha":
                return await synth_user(text, "Samantha")
        else:
            from .tts import MockTTS

            pcm = b"".join([c async for c in MockTTS().synthesize(text, voice_id=voice, speed=1.0)])
            from .audio import to_wav

            with open(path, "wb") as f:
                f.write(to_wav(pcm, MockTTS.sample_rate))
    with open(path, "rb") as f:
        pcm, sr = read_wav(f.read())
    return resample(pcm, sr, MIC_RATE)


class _Pacer:
    """Feed audio into the session at wall-clock speed, with drift correction."""

    def __init__(self, session: VoiceSession) -> None:
        self.s = session
        self.t0 = time.perf_counter()
        self.sent_ms = 0.0

    async def play(self, pcm: bytes) -> None:
        for c in chunk(pcm, 640):  # 20 ms
            self.s.feed_audio(c)
            self.sent_ms += 20
            delay = self.t0 + self.sent_ms / 1000 - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)

    async def quiet(self, ms: float) -> None:
        await self.play(silence(ms))


async def run_scenario(session: VoiceSession, scenario_id: str, voice: str = USER_VOICE) -> None:
    sc = SCENARIOS[scenario_id]
    steps = sc["steps"]
    bus = session.bus
    bus.emit("scenario.start", id=scenario_id, name=sc["name"], steps=len(steps))

    # Pre-synthesise caller audio so playback is gap-free and timing is exact.
    audio: dict[int, bytes] = {}
    for i, st in enumerate(steps):
        if st["op"] == "user":
            audio[i] = await synth_user(st["text"], voice)

    # The mock STT needs to know what was said (it cannot hear): group consecutive user steps.
    hints: dict[int, str] = {}
    i = 0
    while i < len(steps):
        if steps[i]["op"] == "user":
            j, parts = i, []
            while j < len(steps) and steps[j]["op"] in ("user", "pause"):
                if steps[j]["op"] == "user":
                    parts.append(steps[j]["text"])
                j += 1
            hints[i] = " ".join(parts)
            i = j
        else:
            i += 1

    pacer = _Pacer(session)
    # let the greeting finish before the caller speaks
    await _until(pacer, lambda: session.agent_state == "idle" and session._resp is None, 25)
    await pacer.quiet(400)
    in_group = False
    try:
        for i, st in enumerate(steps):
            op = st["op"]
            bus.emit("scenario.step", i=i, op=op, text=st.get("text"), ms=st.get("ms"))
            if op == "user":
                if not in_group:
                    session.stt_hint = hints.get(i)
                    in_group = True
                pcm = audio[i]
                await pacer.play(silence(120) + pcm)
            elif op == "pause":
                await pacer.quiet(st["ms"])
            elif op == "wait":
                await pacer.quiet(st["ms"])
            elif op == "wait_speaking":
                in_group = False
                await _until(pacer, lambda: session.agent_state == "speaking", st.get("timeout", 15))
            elif op == "wait_response":
                in_group = False
                seq0 = session._resp_seq
                await _until(pacer, lambda: session._resp_seq > seq0 or session.agent_state != "idle", st.get("timeout", 12))
                await _until(pacer, lambda: session.agent_state == "idle" and session._resp is None, st.get("timeout", 40))
                await pacer.quiet(300)
    finally:
        session.stt_hint = None
        bus.emit("scenario.done", id=scenario_id)


async def _until(pacer: _Pacer, cond, timeout: float) -> bool:
    end = time.perf_counter() + timeout
    while time.perf_counter() < end:
        if cond():
            return True
        await pacer.quiet(100)
    return False
