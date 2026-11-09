"""The cascaded voice-agent pipeline (Lessons 1, 3, 4, 5) as one inspectable asyncio program.

    mic PCM ─► VAD ─► STT (streaming) ─► turn detection ─► LLM (token stream) ─► sentence chunker
                 │                           ▲ silence timer + semantic extension          │
                 └── barge-in ─ cancel LLM + TTS, flush playout, truncate history ◄──────────┤
                                                                                           ▼
                                        browser playout ◄── PCM bytes ◄── TTS (byte stream)

Every stage emits events on the bus; every turn ends with a `turn.metrics` event that carries the
course's four metric families (LLM, STT, EOU, TTS) plus a Gantt-style span list for the waterfall.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .audio import FRAME_BYTES, FRAME_MS, MIC_RATE, duration_ms, rms
from .config import SessionConfig
from .events import Clock, EventBus
from .interrupt import SpokenSegment, split_heard
from .llm import LLMProvider, ToolCall, create_llm, ollama_models
from .personas import PERSONAS, stt_prompt, system_prompt
from .stt import STTSession, create_stt, load_whisper, warm_whisper, whisper_is_warm
from .tools import ToolBox
from .tts import TTSProvider, apply_pronunciations, create_tts
from .turn import HeuristicSemanticDetector, TurnPolicy
from .vad import VADTracker, create_vad

BUSY = ("thinking", "speaking")


# --------------------------------------------------------------------------- #
# Sentence chunker – "organises tokens into complete sentences" before TTS (Lesson 3)
# --------------------------------------------------------------------------- #
_ABBREV = re.compile(r"\b(mr|mrs|ms|dr|st|vs|etc|p\.m|a\.m|e\.g|i\.e|no)\.$", re.I)


class SentenceChunker:
    def __init__(self, strategy: str = "sentence", min_chars: int = 18) -> None:
        self.strategy, self.min_chars = strategy, min_chars
        self.buf = ""
        self.emitted = 0

    def feed(self, text: str) -> list[str]:
        self.buf += text
        out: list[str] = []
        while (cut := self._find_cut()) is not None:
            piece, self.buf = self.buf[:cut].strip(), self.buf[cut:].lstrip()
            if piece:
                out.append(piece)
                self.emitted += 1
        return out

    def _find_cut(self) -> int | None:
        s = self.buf
        for m in re.finditer(r"[.!?…]+[\"')\]]*(?=\s)|\n", s):
            end = m.end()
            cand = s[:end].strip()
            if len(cand) < self.min_chars or _ABBREV.search(cand):
                continue
            return end
        if self.strategy == "eager" and self.emitted == 0:
            m = re.search(r"[,;:—–](?=\s)", s)
            if m and m.end() >= self.min_chars:
                return m.end()
            if len(s.split()) >= 9:
                idx = s.rstrip().rfind(" ")
                if idx > self.min_chars:
                    return idx
        return None

    def flush(self) -> str | None:
        rest, self.buf = self.buf.strip(), ""
        return rest or None


# --------------------------------------------------------------------------- #
# Per-turn / per-response bookkeeping
# --------------------------------------------------------------------------- #
@dataclass
class Sentence:
    idx: int
    text: str
    audio_ms: float = 0.0
    start_ms: float = 0.0
    synthesized: bool = False


@dataclass
class Turn:
    id: int
    kind: str = "voice"  # voice | text | greeting
    speech_start_t: float = 0.0
    speech_end_t: float = 0.0
    eot_t: float = 0.0
    stt_done_t: float = 0.0
    stt: STTSession | None = None
    interim: str = ""
    hint: str | None = None
    stt_info: dict[str, Any] = field(default_factory=dict)
    timer: dict[str, Any] = field(default_factory=dict)
    user_text: str = ""
    # response-side timestamps
    llm_req_t: float | None = None
    llm_first_token_t: float | None = None
    llm_done_t: float | None = None
    first_sentence_t: float | None = None
    tts_req_t: float | None = None
    tts_first_byte_t: float | None = None
    first_audio_t: float | None = None
    tts_done_t: float | None = None
    llm_rounds: list[dict[str, Any]] = field(default_factory=list)
    tool_spans: list[tuple[float, float, str]] = field(default_factory=list)
    tts_info: dict[str, Any] = field(default_factory=dict)
    guardrail: str = ""
    first_sentence_round: int = 0
    metrics_emitted: bool = False


@dataclass
class Response:
    id: int
    turn: Turn
    q: asyncio.Queue = field(default_factory=asyncio.Queue)
    sentences: list[Sentence] = field(default_factory=list)
    audio_ms_sent: float = 0.0
    sample_rate: int = 0
    audio_started: bool = False
    played_ms: float = 0.0
    last_report_t: float = 0.0
    playout_done: asyncio.Event = field(default_factory=asyncio.Event)
    flushed: asyncio.Future | None = None
    gen_task: asyncio.Task | None = None
    tts_task: asyncio.Task | None = None
    assistant_msgs: list[dict] = field(default_factory=list)
    inflight_start: int = 0
    done: bool = False


class VoiceSession:
    def __init__(self, cfg: SessionConfig) -> None:
        self.cfg = cfg
        self.clock = Clock()
        self.bus = EventBus(self.clock)
        self.toolbox = ToolBox()
        self.detector = HeuristicSemanticDetector()
        self.stt_hint: str | None = None  # (kept for compatibility) – see stt_feed()
        self._stt_pending = ""  # scripted words spoken but not yet claimed by a turn (oracle STT only)

        self.user_speaking = False
        self.agent_state = "idle"
        self._suppressed = False
        self._inbuf = bytearray()
        self._fidx = 0
        self._last_pushed = 0
        self._prefix: deque[tuple[int, bytes]] = deque()
        self.audio_total_ms = 0.0
        self.audio_sent_ms = 0.0

        self._turn: Turn | None = None
        self._turn_seq = 0
        self._resp_seq = 0
        self._resp: Response | None = None
        self._timer_task: asyncio.Task | None = None
        self._eot_task: asyncio.Task | None = None
        self._intr_task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()
        self._closed = False

        self.messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt(cfg.persona, cfg.system_prompt)}]
        self.llm: LLMProvider | None = None
        self.tts: TTSProvider | None = None
        self._build_light()

    # ------------------------------------------------------------------ setup -------------
    def _build_light(self) -> None:
        c = self.cfg
        self.vad = create_vad(c.vad.provider)
        self.tracker = VADTracker(c.vad.threshold, c.vad.min_speech_ms, c.vad.min_silence_ms)
        self.policy = TurnPolicy(c.turn.mode, c.turn.silence_timer_ms, c.turn.max_delay_ms, c.turn.threshold)
        self.stt = create_stt(c.stt.provider, c.stt.model, c.stt.language, stt_prompt(c.persona, c.stt.prompt))
        self._prefix = deque(maxlen=max(1, c.vad.prefix_padding_ms // FRAME_MS + 1))

    async def start(self, greet: bool = True) -> None:
        loop = asyncio.get_running_loop()
        c = self.cfg
        self.bus.emit("session.starting", config=c.model_dump(), vad_impl=getattr(self.vad, "name", "?"))

        async def load(label: str, fn, *args):
            self.bus.emit("provider.loading", component=label)
            t0 = time.perf_counter()
            try:
                res = await loop.run_in_executor(None, fn, *args)
                self.bus.emit("provider.ready", component=label, ms=round((time.perf_counter() - t0) * 1000))
                return res
            except Exception as e:  # surface config problems in the UI, don't crash the session
                self.bus.emit("error", where=label, message=str(e)[:300])
                return None

        self.tts = await load("tts", create_tts, c.tts.provider, c.tts.model)
        self.llm = await load("llm", create_llm, c.llm.provider, c.llm.model, c.llm.mock_profile, c.persona)
        if getattr(self.tts, "name", "") == "piper":
            from .tts import load_piper

            await load("tts-voice", load_piper, c.tts.voice_id)
        if c.stt.provider == "whisper-local":
            name = c.stt.model or self.stt.model  # type: ignore[attr-defined]
            if not whisper_is_warm(name):
                await load("stt", warm_whisper, name)
        self.bus.emit(
            "session.ready",
            llm_model=getattr(self.llm, "model", ""),
            tts_rate=getattr(self.tts, "sample_rate", 0),
            vad_impl=getattr(self.vad, "name", "?"),
            persona=c.persona,
        )
        self._spawn(self._warm_llm())
        if greet:
            self._begin_static(PERSONAS.get(c.persona, PERSONAS["support"])["greeting"], kind="greeting")

    async def _warm_llm(self) -> None:
        if not self.llm:
            return
        t0 = time.perf_counter()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.llm.complete([{"role": "user", "content": "hi"}], max_tokens=1), 60)
        self.bus.emit("provider.ready", component="llm-warm", ms=round((time.perf_counter() - t0) * 1000))

    async def reconfigure(self, new: SessionConfig) -> None:
        """Apply a config change mid-call (thresholds, turn mode, voice… without dropping the session)."""
        old, self.cfg = self.cfg, new
        loop = asyncio.get_running_loop()
        self.tracker.threshold = new.vad.threshold
        self.tracker.neg_threshold = max(0.05, new.vad.threshold - 0.15)
        self.tracker.min_speech_ms = new.vad.min_speech_ms
        self.tracker.min_silence_ms = new.vad.min_silence_ms
        self._prefix = deque(self._prefix, maxlen=max(1, new.vad.prefix_padding_ms // FRAME_MS + 1))
        self.policy = TurnPolicy(new.turn.mode, new.turn.silence_timer_ms, new.turn.max_delay_ms, new.turn.threshold)
        if new.stt != old.stt or new.persona != old.persona:
            self.stt = create_stt(new.stt.provider, new.stt.model, new.stt.language, stt_prompt(new.persona, new.stt.prompt))
            if new.stt.provider == "whisper-local":
                nm = new.stt.model or self.stt.model  # type: ignore[attr-defined]
                if not whisper_is_warm(nm):
                    self.bus.emit("provider.loading", component="stt")
                    await loop.run_in_executor(None, warm_whisper, nm)
                    self.bus.emit("provider.ready", component="stt", ms=0)
        if new.llm != old.llm or new.persona != old.persona:
            if self.llm:
                await self.llm.aclose()
            self.llm = await loop.run_in_executor(None, create_llm, new.llm.provider, new.llm.model, new.llm.mock_profile, new.persona)
            self._spawn(self._warm_llm())
        if new.tts.provider != old.tts.provider or new.tts.model != old.tts.model:
            self.tts = await loop.run_in_executor(None, create_tts, new.tts.provider, new.tts.model)
        if new.persona != old.persona or new.system_prompt != old.system_prompt:
            self.messages[0] = {"role": "system", "content": system_prompt(new.persona, new.system_prompt)}
        self.bus.emit("config.applied", llm_model=getattr(self.llm, "model", ""), config=new.model_dump())

    async def close(self) -> None:
        self._closed = True
        for t in [self._timer_task, self._eot_task, self._intr_task, *self._bg]:
            if t and not t.done():
                t.cancel()
        if self._resp and self._resp.gen_task:
            self._resp.gen_task.cancel()
        if self._turn and self._turn.stt:
            with contextlib.suppress(Exception):
                await self._turn.stt.cancel()
        if self.llm:
            with contextlib.suppress(Exception):
                await self.llm.aclose()
        self.bus.close()

    def _spawn(self, coro) -> asyncio.Task:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)
        return t

    # ------------------------------------------------------------------ audio in ----------
    def feed_audio(self, pcm: bytes) -> None:
        if self._closed:
            return
        self._inbuf += pcm
        while len(self._inbuf) >= FRAME_BYTES:
            frame = bytes(self._inbuf[:FRAME_BYTES])
            del self._inbuf[:FRAME_BYTES]
            self._on_frame(frame)

    def _on_frame(self, frame: bytes) -> None:
        now = self.clock.now_ms()
        t = now - FRAME_MS
        self._fidx += 1
        self.audio_total_ms += FRAME_MS
        t0 = time.perf_counter()
        p = self.vad.prob(frame)
        infer_ms = (time.perf_counter() - t0) * 1000
        self._prefix.append((self._fidx, frame))
        tr = self.tracker.update(p, t)
        self.bus.emit("vad", p=round(p, 3), rms=round(rms(frame), 4), speaking=self.tracker.speaking, infer_ms=round(infer_ms, 2))
        if self._fidx % 31 == 0:
            self.bus.emit("vad.gate", total_ms=round(self.audio_total_ms), sent_ms=round(self.audio_sent_ms))

        if tr and tr.kind == "speech_start":
            self._on_speech_start(tr.t_ms)
        elif self.tracker.speaking and self._turn and not self._suppressed:
            self._push_stt(self._fidx, frame)
        if tr and tr.kind == "speech_end":
            self._on_speech_end(tr.t_ms)

    def stt_feed(self, text: str) -> None:
        """Scenario hook for the scripted ("oracle") STT: announce what the caller is about to say.

        Words go to the currently open turn if there is one (the caller resumed mid-turn), otherwise they wait
        for the next turn. This keeps the oracle honest: it only ever knows what has been *spoken so far*."""
        t = self._turn
        if t is not None and t.stt is not None and hasattr(t.stt, "hint"):
            t.stt.hint = (t.stt.hint + " " + text).strip()
        else:
            self._stt_pending = (self._stt_pending + " " + text).strip()

    def _push_stt(self, idx: int, frame: bytes) -> None:
        if self._turn and self._turn.stt and idx > self._last_pushed:
            self._turn.stt.push(frame)
            self._last_pushed = idx
            self.audio_sent_ms += FRAME_MS

    # ------------------------------------------------------------------ VAD edges ---------
    def _on_speech_start(self, t_start: float) -> None:
        self.user_speaking = True
        busy = self.agent_state in BUSY
        self.bus.emit("vad.speech_start", at=round(t_start, 1), blocking_ms=self.cfg.vad.min_speech_ms)
        self.bus.emit("user_state", state="speaking")

        if busy and not self.cfg.interrupt.enabled:
            self._suppressed = True
            self.bus.emit("interrupt.suppressed", reason="interruptions disabled – user speech ignored while agent talks")
            return

        if self._timer_task and not self._timer_task.done():  # user resumed during the silence timer
            self._timer_task.cancel()
            tm = self._turn.timer if self._turn else {}
            self.bus.emit("turn.timer", phase="resumed", turn_id=self._turn.id if self._turn else None,
                          saved=bool(tm.get("extended")), delay_ms=tm.get("delay_ms"))
        self._timer_task = None

        if self._turn is None:
            self._turn_seq += 1
            pending, self._stt_pending = self._stt_pending or self.stt_hint, ""
            turn = Turn(id=self._turn_seq, speech_start_t=t_start, hint=pending)
            turn.stt = self.stt.open(lambda text, tn=turn: self._on_interim(tn, text), pending)
            self._turn = turn
            self.bus.emit("turn.start", turn_id=turn.id)
        # flush the prefix padding (audio from just before detection) into STT
        for idx, fr in self._prefix:
            self._push_stt(idx, fr)

        if busy:
            self._arm_interrupt_watch()

    def _on_interim(self, turn: Turn, text: str) -> None:
        turn.interim = text
        self.bus.emit("stt.interim", turn_id=turn.id, text=text)

    def _on_speech_end(self, t_last: float) -> None:
        self.user_speaking = False
        self.bus.emit("vad.speech_end", at=round(t_last, 1))
        self.bus.emit("user_state", state="listening")
        if self._intr_task and not self._intr_task.done():
            self._intr_task.cancel()
        if self._suppressed:
            self._suppressed = False
            return
        if self._turn is None:
            return
        self._turn.speech_end_t = t_last
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
        self._timer_task = asyncio.create_task(self._turn_timer(self._turn))

    # ------------------------------------------------------------------ turn detection ----
    async def _predict_eot(self, text: str) -> tuple[float | None, list[str]]:
        mode = self.cfg.turn.mode
        hist = [m for m in self.messages if m["role"] in ("user", "assistant")][-8:]
        if mode == "semantic":
            v = self.detector.explain(text, hist)
            return v.p_eot, v.reasons
        if mode == "llm" and self.llm:
            prompt = [
                {"role": "system", "content": "You judge whether a caller has finished their turn. Answer only YES if the utterance is a complete thought that expects a reply, or NO if they are probably going to continue."},
                {"role": "user", "content": f'Previous agent line: "{self._last_agent_text()}"\nCaller said so far: "{text}"\nFinished?'},
            ]
            try:
                ans = await asyncio.wait_for(self.llm.complete(prompt, max_tokens=3), 2.5)
                yes = ans.strip().upper().startswith("Y")
                return (0.92 if yes else 0.1), [f"LLM judged: {ans.strip() or '?'}"]
            except Exception as e:
                return None, [f"LLM turn judge failed ({type(e).__name__}) – fell back to the silence timer"]
        return None, []

    def _last_agent_text(self) -> str:
        for m in reversed(self.messages):
            if m["role"] == "assistant" and m.get("content"):
                return m["content"]
        return ""

    async def _turn_timer(self, turn: Turn) -> None:
        cfg = self.cfg.turn
        t_last = turn.speech_end_t
        try:
            flush = None
            if turn.stt is not None and hasattr(turn.stt, "flush_interim"):
                flush = asyncio.create_task(turn.stt.flush_interim())  # type: ignore[attr-defined]
            text = turn.interim
            stale = False
            stt_wait = 0.0
            if cfg.mode != "vad" and flush is not None:
                # The semantic judge must read FRESH text, otherwise "…a table for" looks complete.
                # Waiting costs nothing extra: the same transcription would otherwise be paid as
                # post-turn STT finalisation. (Capped so a stuck STT cannot freeze the call.)
                tw = self.clock.now_ms()
                try:
                    text = await asyncio.wait_for(asyncio.shield(flush), 2.0) or turn.interim
                except asyncio.TimeoutError:
                    stale = True
                except Exception:
                    pass
                stt_wait = self.clock.now_ms() - tw
            p, reasons = await self._predict_eot(text)
            if stale:
                reasons = [*reasons, "transcript was still being updated (STT lag) – judged on older text"]
            delay = self.policy.delay_ms(p)
            deadline = t_last + delay
            turn.timer = {"delay_ms": delay, "extended": delay > cfg.silence_timer_ms, "p_eot": p}
            self.bus.emit(
                "turn.timer", phase="started", turn_id=turn.id, mode=cfg.mode, base_ms=cfg.silence_timer_ms, delay_ms=delay,
                p_eot=None if p is None else round(p, 3), reasons=reasons, extended=turn.timer["extended"],
                deadline_t=round(deadline, 1), text=text, stale=stale, stt_wait_ms=round(stt_wait, 1),
            )
            while self.clock.now_ms() < deadline:
                await asyncio.sleep(min(0.02, max(0.0, (deadline - self.clock.now_ms()) / 1000)))
                if cfg.mode == "semantic" and turn.interim and turn.interim != text:  # STT caught up
                    text = turn.interim
                    p, reasons = await self._predict_eot(text)
                    delay = self.policy.delay_ms(p)
                    deadline = t_last + delay
                    turn.timer.update(delay_ms=delay, extended=delay > cfg.silence_timer_ms, p_eot=p)
                    self.bus.emit("turn.timer", phase="updated", turn_id=turn.id, mode=cfg.mode, delay_ms=delay,
                                  p_eot=None if p is None else round(p, 3), reasons=reasons, extended=turn.timer["extended"],
                                  deadline_t=round(deadline, 1), text=text)
            self._timer_task = None
            self._eot_task = asyncio.create_task(self._end_of_turn(turn))
        except asyncio.CancelledError:
            raise

    async def _end_of_turn(self, turn: Turn) -> None:
        self._turn = None
        self._last_pushed = self._fidx
        turn.eot_t = self.clock.now_ms()
        eou = turn.eot_t - turn.speech_end_t
        self.bus.emit("turn.end", turn_id=turn.id, eou_delay_ms=round(eou, 1), extended=turn.timer.get("extended", False))
        if self.agent_state == "idle":
            self._set_agent("thinking")
        try:
            res = await turn.stt.finish()  # type: ignore[union-attr]
        except Exception as e:
            self.bus.emit("error", where="stt", message=str(e)[:300])
            if self.agent_state == "thinking" and not self._resp:
                self._set_agent("idle")
            return
        turn.stt_done_t = self.clock.now_ms()
        turn.stt_info = {"audio_ms": round(res.audio_ms), "streamed": res.streamed, "finalize_ms": round(res.finalize_ms, 1),
                         "provider": self.cfg.stt.provider}
        self.bus.emit("stt.final", turn_id=turn.id, text=res.text, note=res.note,
                      transcription_delay_ms=round(turn.stt_done_t - turn.speech_end_t, 1), **turn.stt_info)
        text = res.text.strip()
        if not text:
            self.bus.emit("turn.discarded", turn_id=turn.id, reason="empty transcript (noise?)")
            if not self._resp and self.agent_state == "thinking":
                self._set_agent("idle")
            return
        if self._resp and not self._resp.done and self.agent_state == "speaking":
            self.bus.emit("turn.discarded", turn_id=turn.id, reason=f"backchannel “{text}” – shorter than the interruption threshold")
            return
        turn.user_text = text
        self._add_user_message(text)
        self.bus.emit("transcript", role="user", text=text, turn_id=turn.id)
        if self.user_speaking or self._turn is not None:
            # The user started talking again while we were finalising => we cut them off. Merge, don't answer yet.
            self.bus.emit("turn.cut_off", turn_id=turn.id, text=text)
            return
        self._begin_response(turn)

    # ------------------------------------------------------------------ text input --------
    async def on_text(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if self.agent_state in BUSY:
            await self._interrupt("typed message")
        self._turn_seq += 1
        now = self.clock.now_ms()
        turn = Turn(id=self._turn_seq, kind="text", speech_start_t=now, speech_end_t=now, eot_t=now, stt_done_t=now, user_text=text)
        self.bus.emit("turn.start", turn_id=turn.id, kind="text")
        self._add_user_message(text)
        self.bus.emit("transcript", role="user", text=text, turn_id=turn.id)
        self._set_agent("thinking")
        self._begin_response(turn)

    def _add_user_message(self, text: str) -> None:
        if self.messages and self.messages[-1]["role"] == "user":
            self.messages[-1]["content"] += " " + text  # consecutive user turns merge
        else:
            self.messages.append({"role": "user", "content": text})

    # ------------------------------------------------------------------ response ----------
    def _set_agent(self, state: str) -> None:
        if state != self.agent_state:
            prev, self.agent_state = self.agent_state, state
            self.bus.emit("agent_state", state=state, prev=prev)

    def _begin_static(self, text: str, kind: str = "greeting") -> None:
        self._turn_seq += 1
        turn = Turn(id=self._turn_seq, kind=kind)
        self._set_agent("thinking")
        self.messages.append({"role": "assistant", "content": text})

        async def producer(resp: Response) -> None:
            for s in self._chunker().feed(text + " "):
                self._queue_sentence(resp, s)

        self._launch(turn, producer)

    def _begin_response(self, turn: Turn) -> None:
        self._set_agent("thinking")
        blocked = self._blocked(turn.user_text) if self.cfg.guardrails.enabled else None
        if blocked:
            turn.guardrail = f"input blocked: “{blocked}”"
            self.bus.emit("guardrail.block", side="input", term=blocked)
            safe = "For your security, please don't share sensitive details like that on this call. How else can I help?"
            self.messages.append({"role": "assistant", "content": safe})

            async def canned(resp: Response) -> None:
                for s in self._chunker().feed(safe + " "):
                    self._queue_sentence(resp, s)

            self._launch(turn, canned)
            return
        self._launch(turn, self._llm_producer)

    def _chunker(self) -> SentenceChunker:
        return SentenceChunker(self.cfg.tts.chunking.strategy, self.cfg.tts.chunking.min_chars)

    def _blocked(self, text: str) -> str | None:
        low = text.lower()
        return next((t for t in self.cfg.guardrails.blocked_terms if t and t.lower() in low), None)

    def _launch(self, turn: Turn, producer) -> None:
        self._resp_seq += 1
        resp = Response(self._resp_seq, turn)
        self._resp = resp
        resp.gen_task = asyncio.create_task(self._run_response(resp, producer))

    async def _run_response(self, resp: Response, producer) -> None:
        resp.tts_task = asyncio.create_task(self._tts_worker(resp))
        try:
            await producer(resp)
            await resp.q.put(None)
            await resp.tts_task
            resp.done = True
            self._emit_metrics(resp, interrupted=False)
            await self._await_playout(resp)
        except asyncio.CancelledError:
            resp.tts_task.cancel()
            raise
        except Exception as e:
            self.bus.emit("error", where="response", message=f"{type(e).__name__}: {e}"[:300])
            resp.tts_task.cancel()
            resp.done = True
        finally:
            if self._resp is resp and (resp.done or resp.gen_task is asyncio.current_task()):
                if self.agent_state != "idle" and not self._interrupting:
                    self._set_agent("idle")
                if resp.done:
                    self._resp = None

    def _queue_sentence(self, resp: Response, text: str) -> None:
        t = resp.turn
        if self.cfg.guardrails.enabled and (term := self._blocked(text)):
            self.bus.emit("guardrail.block", side="output", term=term, original=text)
            text = "Sorry, I can't share that."
        s = Sentence(len(resp.sentences), text)
        resp.sentences.append(s)
        if s.idx == 0:
            t.first_sentence_t = self.clock.now_ms()
            t.first_sentence_round = len(t.llm_rounds)  # the round still streaming right now
            wait = t.first_sentence_t - (t.llm_first_token_t or t.first_sentence_t)
            self.bus.emit("chunker.first_sentence", turn_id=t.id, idx=0, text=text, wait_ms=round(wait, 1))
        self.bus.emit("chunker.sentence", turn_id=t.id, idx=s.idx, text=text, strategy=self.cfg.tts.chunking.strategy)
        resp.q.put_nowait(s)

    async def _llm_producer(self, resp: Response) -> None:
        t = resp.turn
        cfg = self.cfg
        chunker = self._chunker()
        tools = self.toolbox.schemas(cfg.persona) or None
        for rnd in range(4):
            msgs = self._chat_messages()
            t_req = self.clock.now_ms()
            if t.llm_req_t is None:
                t.llm_req_t = t_req
            self.bus.emit("llm.request", turn_id=t.id, round=rnd, model=getattr(self.llm, "model", ""), messages=len(msgs), tools=len(tools or []))
            text_parts: list[str] = []
            calls = []
            usage: dict[str, int] = {}
            first_t: float | None = None
            resp.inflight_start = len(resp.sentences)
            tok_buf, last_flush = "", 0.0
            n_events = 0
            known = {t["function"]["name"] for t in (tools or [])}
            head, json_mode, json_buf = "", False, ""
            async for ev in self.llm.stream(msgs, tools, temperature=cfg.llm.temperature, max_tokens=cfg.llm.max_tokens):  # type: ignore[union-attr]
                if ev.kind == "text":
                    now = self.clock.now_ms()
                    if first_t is None:
                        first_t = now
                        if t.llm_first_token_t is None:
                            t.llm_first_token_t = now
                        self.bus.emit("llm.first_token", turn_id=t.id, round=rnd, ttft_ms=round(now - t_req, 1))
                    n_events += 1
                    text_parts.append(ev.text)
                    if len(head.strip()) == 0:
                        head += ev.text
                        json_mode = head.lstrip()[:1] in ("{", "[")
                    if json_mode:  # small models sometimes print a tool call as text – never speak it
                        json_buf += ev.text
                        continue
                    tok_buf += ev.text
                    if now - last_flush > 60:
                        self.bus.emit("llm.token", turn_id=t.id, text=tok_buf)
                        tok_buf, last_flush = "", now
                    for s in chunker.feed(ev.text):
                        self._queue_sentence(resp, s)
                elif ev.kind == "tool_call":
                    calls.append(ev.tool)
                elif ev.kind == "usage":
                    usage = ev.usage
            if json_mode:
                try:
                    obj = json.loads(json_buf)
                    obj = obj[0] if isinstance(obj, list) and obj else obj
                    name = obj.get("name")
                    args = obj.get("parameters") or obj.get("arguments") or {}
                    if name in known and isinstance(args, dict):
                        calls.append(ToolCall(f"call_txt{rnd}", name, args))
                        self.bus.emit("llm.recovered_tool_call", turn_id=t.id, name=name)
                    else:
                        raise ValueError("unknown tool")
                except Exception:
                    self.bus.emit("llm.malformed_output", turn_id=t.id, text=json_buf[:160])
                    for sent in chunker.feed("Sorry, I didn't quite catch that. Could you say it again? "):
                        self._queue_sentence(resp, sent)
            if tok_buf:
                self.bus.emit("llm.token", turn_id=t.id, text=tok_buf)
            if tail := chunker.flush():
                self._queue_sentence(resp, tail)
            done_t = self.clock.now_ms()
            t.llm_done_t = done_t
            full = "".join(text_parts)
            comp = usage.get("completion_tokens") or max(1, int(len(full.split()) * 1.3))
            gen_s = max(0.001, (done_t - (first_t or done_t)) / 1000)
            rd = {
                "round": rnd, "request_t": t_req, "first_token_t": first_t, "done_t": done_t,
                "ttft_ms": round((first_t - t_req) if first_t else (done_t - t_req), 1),
                "tokens_per_second": round(comp / gen_s, 1) if first_t else 0.0,
                "prompt_tokens": usage.get("prompt_tokens", 0), "completion_tokens": comp,
                "usage_estimated": not usage,
            }
            t.llm_rounds.append(rd)
            self.bus.emit("llm.done", turn_id=t.id, **rd)
            content = " ".join(s.text for s in resp.sentences[resp.inflight_start:]) or None
            assistant: dict[str, Any] = {"role": "assistant", "content": content, "_sent": (resp.inflight_start, len(resp.sentences))}
            if not calls:
                self.messages.append(assistant)
                resp.assistant_msgs.append(assistant)
                resp.inflight_start = len(resp.sentences)
                return
            assistant["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.arguments)}} for c in calls
            ]
            results = []
            for c in calls:
                self.bus.emit("llm.tool_call", turn_id=t.id, name=c.name, args=c.arguments)
                ts = self.clock.now_ms()
                res = await self.toolbox.call(c.name, c.arguments)
                te = self.clock.now_ms()
                t.tool_spans.append((ts, te, c.name))
                self.bus.emit("llm.tool_result", turn_id=t.id, name=c.name, result=res, ms=round(te - ts, 1))
                results.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(res)})
            self.messages.append(assistant)
            self.messages.extend(results)
            resp.assistant_msgs.append(assistant)
            resp.inflight_start = len(resp.sentences)

    def _chat_messages(self) -> list[dict]:
        out = []
        for m in self.messages:
            out.append({k: v for k, v in m.items() if not k.startswith("_")})
        return out

    # ------------------------------------------------------------------ TTS ---------------
    async def _tts_worker(self, resp: Response) -> None:
        t = resp.turn
        tts = self.tts
        cfg = self.cfg.tts
        if tts is None:
            return
        while True:
            s = await resp.q.get()
            if s is None:
                break
            spoken = apply_pronunciations(s.text, cfg.pronunciations)
            t_req = self.clock.now_ms()
            if t.tts_req_t is None:
                t.tts_req_t = t_req
            self.bus.emit("tts.request", turn_id=t.id, idx=s.idx, text=s.text, spoken=spoken if spoken != s.text else None)
            first = True
            n_bytes = 0
            try:
                async for pcm in tts.synthesize(spoken, voice_id=cfg.voice_id, speed=cfg.speed):
                    now = self.clock.now_ms()
                    if first:
                        first = False
                        ttfb = now - t_req
                        if t.tts_first_byte_t is None:
                            t.tts_first_byte_t = now
                        if not resp.audio_started:
                            resp.audio_started = True
                            resp.sample_rate = tts.sample_rate
                            self.bus.emit("response.audio_start", response_id=resp.id, sample_rate=tts.sample_rate)
                            t.first_audio_t = now
                            self._set_agent("speaking")
                        self.bus.emit("tts.first_byte", turn_id=t.id, idx=s.idx, ttfb_ms=round(ttfb, 1), streamed=tts.streaming)
                    if n_bytes == 0:
                        s.start_ms = resp.audio_ms_sent  # position of this sentence on the playout timeline
                    chunk_ms = duration_ms(len(pcm), resp.sample_rate)
                    s.audio_ms += chunk_ms  # grows while synthesising, so a mid-sentence barge-in still knows how much exists
                    resp.audio_ms_sent += chunk_ms
                    n_bytes += len(pcm)
                    self.bus.put_audio(pcm)
                    await asyncio.sleep(0)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.bus.emit("error", where="tts", message=f"{type(e).__name__}: {e}"[:300])
                continue
            end = self.clock.now_ms()
            s.synthesized = True
            t.tts_done_t = end
            t.tts_info = {
                "provider": self.cfg.tts.provider, "streamed": tts.streaming,
                "audio_ms": round(resp.audio_ms_sent),
                "ttfb_ms": round((t.tts_first_byte_t or end) - (t.tts_req_t or end), 1),
                "render_ms": round(end - (t.tts_req_t or end), 1),
            }
            self.bus.emit("tts.done", turn_id=t.id, idx=s.idx, render_ms=round(end - t_req, 1), audio_ms=round(s.audio_ms))
        if resp.audio_started:
            self.bus.emit("response.audio_end", response_id=resp.id, total_ms=round(resp.audio_ms_sent))

    async def _await_playout(self, resp: Response) -> None:
        if not resp.audio_started:
            return
        remaining = max(0.0, resp.audio_ms_sent - resp.played_ms)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(resp.playout_done.wait(), timeout=remaining / 1000 + 2.5)

    # ------------------------------------------------------------------ client reports -----
    def on_playback(self, response_id: int, played_ms: float) -> None:
        r = self._resp
        if r and r.id == response_id:
            r.played_ms = max(r.played_ms, played_ms)
            r.last_report_t = self.clock.now_ms()

    def on_playout_done(self, response_id: int) -> None:
        r = self._resp
        if r and r.id == response_id:
            r.played_ms = r.audio_ms_sent
            r.playout_done.set()
            if r.done and self.agent_state != "idle":
                self._set_agent("idle")

    def on_flushed(self, response_id: int, played_ms: float) -> None:
        r = self._resp
        if r and r.id == response_id and r.flushed and not r.flushed.done():
            r.flushed.set_result(played_ms)

    # ------------------------------------------------------------------ interruption ------
    _interrupting = False

    def _arm_interrupt_watch(self) -> None:
        if self._intr_task and not self._intr_task.done():
            self._intr_task.cancel()

        async def watch() -> None:
            await asyncio.sleep(self.cfg.interrupt.min_duration_ms / 1000)
            if self.tracker.speaking and self.agent_state in BUSY:
                # Run the interrupt as its own task: a later speech_end cancels *this* watcher, and must not be
                # able to abort a barge-in that is already flushing playout and truncating history.
                self._spawn(self._interrupt("barge-in"))

        self._intr_task = asyncio.create_task(watch())

    async def _interrupt(self, reason: str) -> None:
        if self._interrupting:
            return
        self._interrupting = True
        try:
            resp = self._resp
            self.bus.emit("interrupt.start", reason=reason, agent_state=self.agent_state)
            if resp is None:
                self._set_agent("idle")
                return
            # 1) cancel LLM inference + TTS synthesis (flush every downstream process)
            if resp.gen_task and not resp.gen_task.done() and resp.gen_task is not asyncio.current_task():
                resp.gen_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await resp.gen_task
            if resp.tts_task and not resp.tts_task.done():
                resp.tts_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await resp.tts_task
            dropped = self.bus.drop_audio()
            # 2) ask the client what it actually played
            played = resp.played_ms
            if resp.audio_started:
                resp.flushed = asyncio.get_running_loop().create_future()
                self.bus.emit("flush", response_id=resp.id)
                try:
                    played = await asyncio.wait_for(resp.flushed, 0.35)
                except asyncio.TimeoutError:
                    elapsed = self.clock.now_ms() - (resp.last_report_t or self.clock.now_ms())
                    played = min(resp.audio_ms_sent, resp.played_ms + max(0.0, elapsed))
            # 3) truncate the LLM's history to what the user actually heard
            done = [x for x in resp.sentences if x.synthesized]
            words_done = sum(len(x.text.split()) for x in done)
            ms_per_word = (sum(x.audio_ms for x in done) / words_done) if words_done else 330.0
            used: list[Sentence] = []
            segs: list[SpokenSegment] = []
            for x in resp.sentences:
                if x.synthesized:
                    segs.append(SpokenSegment(x.text, x.start_ms, x.audio_ms))
                    used.append(x)
                elif x.audio_ms > 0:  # cut off mid-synthesis: estimate its full length from the speaking rate so far
                    segs.append(SpokenSegment(x.text, x.start_ms, max(x.audio_ms, len(x.text.split()) * ms_per_word)))
                    used.append(x)
            parts = split_heard(segs, played)
            heard_by_idx = {x.idx: p for x, p in zip(used, parts)}
            self._truncate_history(resp, heard_by_idx)
            heard = " ".join(h for h, _ in parts if h).strip()
            unheard = " ".join(
                [u for _, u in parts if u] + [x.text for x in resp.sentences if x not in used]
            ).strip()
            self.bus.emit(
                "interrupt", response_id=resp.id, played_ms=round(played), audio_sent_ms=round(resp.audio_ms_sent),
                heard_text=heard, unheard_text=unheard, dropped_bytes=dropped,
                sentences=[{"text": x.text, "start_ms": round(x.start_ms), "dur_ms": round(x.audio_ms), "synth": x in used} for x in resp.sentences],
                reason=reason,
            )
            resp.done = True
            self._emit_metrics(resp, interrupted=True)
            self._resp = None
            self._set_agent("idle")
        finally:
            self._interrupting = False

    def _truncate_history(self, resp: Response, heard_by_idx: dict[int, tuple[str, str]]) -> None:
        """Patch assistant messages of this response so history == what the user heard."""
        for m in list(resp.assistant_msgs):
            a, b = m.get("_sent", (0, 0))
            heard = " ".join(heard_by_idx.get(i, ("", ""))[0] for i in range(a, b)).strip()
            m["content"] = heard or None
            if not heard and not m.get("tool_calls"):
                with contextlib.suppress(ValueError):
                    self.messages.remove(m)
        # text of the round that was still streaming when we were cancelled
        a = resp.inflight_start
        heard = " ".join(heard_by_idx.get(i, ("", ""))[0] for i in range(a, len(resp.sentences))).strip()
        if heard:
            self.messages.append({"role": "assistant", "content": heard, "_interrupted": True})
        elif resp.assistant_msgs:
            last = resp.assistant_msgs[-1]
            last["_interrupted"] = True

    # ------------------------------------------------------------------ metrics -----------
    def _emit_metrics(self, resp: Response, interrupted: bool) -> None:
        t = resp.turn
        if t.metrics_emitted or t.kind == "greeting":
            t.metrics_emitted = True
            return
        t.metrics_emitted = True
        origin = t.speech_end_t
        rel = lambda x: None if x is None else round(x - origin, 1)  # noqa: E731
        r0 = t.llm_rounds[0] if t.llm_rounds else {}
        total = (t.first_audio_t - origin) if t.first_audio_t else None
        breakdown = []
        if total is not None:
            eou = t.eot_t - origin
            stt_fin = max(0.0, t.stt_done_t - t.eot_t)
            r = min(t.first_sentence_round, max(0, len(t.llm_rounds) - 1))
            rd = t.llm_rounds[r] if t.llm_rounds else {}
            req = rd.get("request_t") or t.stt_done_t
            ftok = rd.get("first_token_t") or req
            # rounds (and their tool calls) that had to finish before the first spoken sentence existed
            pre_llm = sum(x["done_t"] - x["request_t"] for x in t.llm_rounds[:r])
            pre_tool = sum(e - s_ for s_, e, _ in t.tool_spans if e <= req + 1)
            gap = max(0.0, req - t.stt_done_t - pre_llm - pre_tool)
            ttft = max(0.0, ftok - req)
            chunk_wait = (t.first_sentence_t - ftok) if t.first_sentence_t else 0.0
            tts_ttfb = (t.tts_first_byte_t - t.tts_req_t) if (t.tts_first_byte_t and t.tts_req_t) else 0.0
            known = eou + stt_fin + gap + pre_llm + pre_tool + ttft + chunk_wait + tts_ttfb
            breakdown = [
                {"stage": "endpointing", "ms": round(eou, 1)},
                {"stage": "stt_final", "ms": round(stt_fin, 1)},
                {"stage": "llm_ttft", "ms": round(ttft + pre_llm + gap, 1)},
                {"stage": "tool", "ms": round(pre_tool, 1)},
                {"stage": "chunking", "ms": round(max(0.0, chunk_wait), 1)},
                {"stage": "tts_ttfb", "ms": round(tts_ttfb, 1)},
                {"stage": "other", "ms": round(max(0.0, total - known), 1)},
            ]
        spans = []
        if t.kind == "voice":
            spans.append({"stage": "user_speech", "start": rel(t.speech_start_t), "end": 0.0})
            spans.append({"stage": "stt", "start": rel(t.speech_start_t), "end": rel(t.stt_done_t), "label": "streaming STT"})
        spans.append({"stage": "endpointing", "start": 0.0, "end": rel(t.eot_t), "label": "silence timer + turn detection"})
        if t.stt_done_t > t.eot_t:
            spans.append({"stage": "stt_final", "start": rel(t.eot_t), "end": rel(t.stt_done_t)})
        for rd in t.llm_rounds:
            if rd["first_token_t"]:
                spans.append({"stage": "llm_ttft", "start": rel(rd["request_t"]), "end": rel(rd["first_token_t"]), "label": f"TTFT r{rd['round']}"})
                spans.append({"stage": "llm_stream", "start": rel(rd["first_token_t"]), "end": rel(rd["done_t"])})
        for s, e, name in t.tool_spans:
            spans.append({"stage": "tool", "start": rel(s), "end": rel(e), "label": name})
        if t.tts_req_t and t.tts_first_byte_t:
            spans.append({"stage": "tts_ttfb", "start": rel(t.tts_req_t), "end": rel(t.tts_first_byte_t), "label": "TTS TTFB"})
            spans.append({"stage": "tts_render", "start": rel(t.tts_first_byte_t), "end": rel(t.tts_done_t or t.tts_first_byte_t)})
            spans.append({"stage": "playout", "start": rel(t.tts_first_byte_t), "end": round(rel(t.tts_first_byte_t) + resp.audio_ms_sent, 1)})
        gen_s = max(0.001, ((t.llm_done_t or 0) - (t.llm_first_token_t or 0)) / 1000)
        self.bus.emit(
            "turn.metrics",
            turn_id=t.id, kind=t.kind, user_text=t.user_text, interrupted=interrupted,
            agent_text=" ".join(s.text for s in resp.sentences),
            response_latency_ms=None if total is None else round(total, 1),
            breakdown=breakdown, spans=spans,
            llm={"model": getattr(self.llm, "model", ""), "provider": self.cfg.llm.provider,
                 "ttft_ms": r0.get("ttft_ms"), "tokens_per_second": r0.get("tokens_per_second"),
                 "prompt_tokens": sum(r["prompt_tokens"] for r in t.llm_rounds),
                 "completion_tokens": sum(r["completion_tokens"] for r in t.llm_rounds),
                 "rounds": len(t.llm_rounds), "estimated_usage": any(r.get("usage_estimated") for r in t.llm_rounds)},
            stt={**t.stt_info},
            eou={"end_of_utterance_delay_ms": round(t.eot_t - origin, 1),
                 "transcription_delay_ms": round(t.stt_done_t - origin, 1),
                 "mode": self.cfg.turn.mode, "extended": t.timer.get("extended", False), "p_eot": t.timer.get("p_eot")},
            tts={**t.tts_info},
            guardrail=t.guardrail,
            vad={"min_speech_ms": self.cfg.vad.min_speech_ms, "audio_total_ms": round(self.audio_total_ms),
                 "audio_sent_to_stt_ms": round(self.audio_sent_ms)},
        )
