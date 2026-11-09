"""Speech-to-speech ("Real-Time API") architecture (Lesson 1/4).

One model takes audio in and returns audio out – simple, natural, but a black box: there is no
separate STT / LLM / TTS stage to inspect, swap or budget. This bridge speaks the OpenAI Realtime
protocol so the *same dashboard* can show both architectures side by side.

NOTE: written against the OpenAI Realtime API docs; it needs OPENAI_API_KEY and has not been
exercised against the live service in this repository's test-suite (no key available).
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
from typing import Any

from ..audio import resample
from ..config import SessionConfig, settings
from ..events import Clock, EventBus
from ..personas import PERSONAS, system_prompt

URL = "wss://api.openai.com/v1/realtime?model={model}"
OUT_RATE = 24000


class RealtimeSession:
    """Mirrors the public surface of `VoiceSession` used by the WebSocket endpoint."""

    def __init__(self, cfg: SessionConfig) -> None:
        self.cfg = cfg
        self.clock = Clock()
        self.bus = EventBus(self.clock)
        self.stt_hint = None
        self.agent_state = "idle"
        self._ws = None
        self._reader: asyncio.Task | None = None
        self._resp_id = 0
        self._item_id: str | None = None
        self._played_ms = 0.0
        self._audio_ms = 0.0
        self._flush_fut: asyncio.Future | None = None
        self._t_speech_stopped: float | None = None
        self._t_first_audio: float | None = None
        self._agent_text = ""
        self._user_text = ""
        self._turn = 0
        self._ready = asyncio.Event()

    async def start(self, greet: bool = True) -> None:
        self.bus.emit("session.starting", config=self.cfg.model_dump(), vad_impl="server-side (opaque)")
        if not settings.openai_key:
            self.bus.emit("error", where="realtime", message="OPENAI_API_KEY is not set – the speech-to-speech architecture needs it.")
            return
        import websockets

        try:
            self._ws = await websockets.connect(
                URL.format(model=self.cfg.realtime_model),
                additional_headers={"Authorization": f"Bearer {settings.openai_key}"},
                max_size=None,
            )
        except Exception as e:
            self.bus.emit("error", where="realtime", message=f"connect failed: {type(e).__name__}: {e}"[:300])
            return
        t = self.cfg.turn
        await self._send(
            {
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": system_prompt(self.cfg.persona, self.cfg.system_prompt),
                    "output_modalities": ["audio"],
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcm", "rate": 24000},
                            "transcription": {"model": "gpt-4o-mini-transcribe"},
                            "turn_detection": {
                                "type": "server_vad",
                                "threshold": self.cfg.vad.threshold,
                                "prefix_padding_ms": self.cfg.vad.prefix_padding_ms,
                                "silence_duration_ms": t.silence_timer_ms,
                                "create_response": True,
                                "interrupt_response": self.cfg.interrupt.enabled,
                            },
                        },
                        "output": {"format": {"type": "audio/pcm", "rate": OUT_RATE}, "voice": self.cfg.realtime_voice},
                    },
                },
            }
        )
        self._reader = asyncio.create_task(self._read())
        self.bus.emit("session.ready", llm_model=self.cfg.realtime_model, tts_rate=OUT_RATE, vad_impl="server_vad (opaque)", persona=self.cfg.persona)
        if greet:
            await self._send({"type": "response.create", "response": {"instructions": "Greet the caller with: " + PERSONAS.get(self.cfg.persona, PERSONAS["support"])["greeting"]}})

    async def _send(self, obj: dict[str, Any]) -> None:
        if self._ws:
            await self._ws.send(json.dumps(obj))

    def feed_audio(self, pcm: bytes) -> None:
        if not self._ws:
            return
        b64 = base64.b64encode(resample(pcm, 16000, 24000)).decode()
        asyncio.get_running_loop().create_task(self._send({"type": "input_audio_buffer.append", "audio": b64}))

    async def on_text(self, text: str) -> None:
        await self._send({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}})
        self._user_text = text
        self.bus.emit("transcript", role="user", text=text, turn_id=self._turn + 1)
        self._t_speech_stopped = self.clock.now_ms()
        await self._send({"type": "response.create"})

    async def reconfigure(self, new: SessionConfig) -> None:
        self.cfg = new

    # -- client playback reports ------------------------------------------------------------
    def on_playback(self, response_id: int, played_ms: float) -> None:
        self._played_ms = max(self._played_ms, played_ms)

    def on_playout_done(self, response_id: int) -> None:
        if self.agent_state != "idle":
            self._set_agent("idle")

    def on_flushed(self, response_id: int, played_ms: float) -> None:
        if self._flush_fut and not self._flush_fut.done():
            self._flush_fut.set_result(played_ms)

    def _set_agent(self, s: str) -> None:
        if s != self.agent_state:
            prev, self.agent_state = self.agent_state, s
            self.bus.emit("agent_state", state=s, prev=prev)

    # -- server events ----------------------------------------------------------------------
    async def _read(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                ev = json.loads(raw)
                await self._handle(ev)
        except Exception as e:  # connection dropped
            self.bus.emit("error", where="realtime", message=f"{type(e).__name__}: {e}"[:300])

    async def _handle(self, ev: dict[str, Any]) -> None:
        t = ev.get("type", "")
        if t == "input_audio_buffer.speech_started":
            self.bus.emit("vad.speech_start", at=round(self.clock.now_ms(), 1), blocking_ms=0)
            self.bus.emit("user_state", state="speaking")
            if self.agent_state == "speaking" and self.cfg.interrupt.enabled:
                await self._barge_in()
        elif t == "input_audio_buffer.speech_stopped":
            self._t_speech_stopped = self.clock.now_ms()
            self.bus.emit("vad.speech_end", at=round(self._t_speech_stopped, 1))
            self.bus.emit("user_state", state="listening")
            self._set_agent("thinking")
        elif t == "conversation.item.input_audio_transcription.completed":
            self._user_text = ev.get("transcript", "").strip()
            self.bus.emit("stt.final", turn_id=self._turn + 1, text=self._user_text, audio_ms=0, streamed=True,
                          finalize_ms=0, provider="gpt-4o-mini-transcribe (side-channel)", transcription_delay_ms=None)
            self.bus.emit("transcript", role="user", text=self._user_text, turn_id=self._turn + 1)
        elif t == "response.created":
            self._resp_id += 1
            self._played_ms = self._audio_ms = 0.0
            self._agent_text = ""
            self._t_first_audio = None
        elif t.endswith("audio.delta") or t.endswith("output_audio.delta"):
            self._item_id = ev.get("item_id", self._item_id)
            pcm = base64.b64decode(ev["delta"])
            if self._t_first_audio is None:
                self._t_first_audio = self.clock.now_ms()
                self.bus.emit("response.audio_start", response_id=self._resp_id, sample_rate=OUT_RATE)
                self._set_agent("speaking")
            self._audio_ms += len(pcm) / 2 / OUT_RATE * 1000
            self.bus.put_audio(pcm)
        elif t.endswith("audio_transcript.delta") or t.endswith("output_audio_transcript.delta"):
            self._agent_text += ev.get("delta", "")
            self.bus.emit("llm.token", turn_id=self._turn + 1, text=ev.get("delta", ""))
        elif t.endswith("audio.done") or t.endswith("output_audio.done"):
            self.bus.emit("response.audio_end", response_id=self._resp_id, total_ms=round(self._audio_ms))
        elif t == "response.done":
            self._turn += 1
            lat = None if (self._t_first_audio is None or self._t_speech_stopped is None) else self._t_first_audio - self._t_speech_stopped
            u = (ev.get("response", {}).get("usage") or {})
            self.bus.emit(
                "turn.metrics", turn_id=self._turn, kind="voice", user_text=self._user_text, interrupted=False,
                agent_text=self._agent_text, response_latency_ms=None if lat is None else round(lat, 1),
                breakdown=[{"stage": "speech_to_speech (opaque)", "ms": round(lat or 0, 1)}], spans=[],
                llm={"model": self.cfg.realtime_model, "provider": "openai-realtime", "ttft_ms": None, "tokens_per_second": None,
                     "prompt_tokens": u.get("input_tokens", 0), "completion_tokens": u.get("output_tokens", 0), "rounds": 1, "estimated_usage": False},
                stt={}, eou={"end_of_utterance_delay_ms": None, "transcription_delay_ms": None, "mode": "server_vad", "extended": False, "p_eot": None},
                tts={}, guardrail="", vad={},
            )
        elif t == "error":
            self.bus.emit("error", where="realtime", message=json.dumps(ev.get("error", ev))[:300])

    async def _barge_in(self) -> None:
        """Server VAD cancels generation; *we* must tell it how much audio the user actually heard."""
        self.bus.emit("interrupt.start", reason="barge-in", agent_state="speaking")
        played = self._played_ms
        self._flush_fut = asyncio.get_running_loop().create_future()
        self.bus.drop_audio()
        self.bus.emit("flush", response_id=self._resp_id)
        with contextlib.suppress(asyncio.TimeoutError):
            played = await asyncio.wait_for(self._flush_fut, 0.35)
        if self._item_id:
            await self._send({"type": "conversation.item.truncate", "item_id": self._item_id, "content_index": 0, "audio_end_ms": int(played)})
        self.bus.emit("interrupt", response_id=self._resp_id, played_ms=round(played), audio_sent_ms=round(self._audio_ms),
                      heard_text="", unheard_text="(opaque – the server truncates its own transcript)", dropped_bytes=0, sentences=[], reason="barge-in")
        self._set_agent("idle")

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._ws:
            with contextlib.suppress(Exception):
                await self._ws.close()
        self.bus.close()
