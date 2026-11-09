"""Pipeline tests against mock providers (no models, no network) + the WebSocket protocol."""
import asyncio
import shutil
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from voicelab.audio import FRAME_BYTES, f32_to_pcm16
from voicelab.config import SessionConfig
from voicelab.main import app
from voicelab.session import VoiceSession
from voicelab.vad import SileroVAD, find_silero_model


def mock_cfg(**over) -> SessionConfig:
    base = {"persona": "restaurant", "stt": {"provider": "mock"}, "llm": {"provider": "mock", "mock_profile": "fast-inference-70b"},
            "tts": {"provider": "mock"}, "vad": {"provider": "energy"}}
    base.update(over)
    return SessionConfig.model_validate(base)


async def collect_until(s: VoiceSession, stop_type: str, timeout: float = 20.0):
    """Drain the bus until `stop_type` shows up; returns (events, audio_bytes)."""
    evs, audio = [], 0
    end = time.perf_counter() + timeout
    while time.perf_counter() < end:
        item = await asyncio.wait_for(s.bus.get(), timeout=end - time.perf_counter())
        if isinstance(item, (bytes, bytearray)):
            audio += len(item)
            continue
        evs.append(item)
        if item["type"] == stop_type:
            return evs, audio
    raise AssertionError(f"timed out waiting for {stop_type}; saw {[e['type'] for e in evs][-8:]}")


async def test_text_turn_streams_llm_tools_and_audio_with_full_metrics():
    s = VoiceSession(mock_cfg())
    await s.start(greet=False)
    await s.on_text("Hi, I'd like to book a table for four people at 7pm.")
    evs, audio = await collect_until(s, "turn.metrics")
    types = [e["type"] for e in evs]
    assert "llm.first_token" in types and "llm.tool_call" in types and "llm.tool_result" in types
    assert types.index("chunker.first_sentence") < types.index("tts.first_byte") < types.index("response.audio_start") + 3
    assert audio > 10_000
    m = evs[-1]
    assert m["response_latency_ms"] > 0
    assert {"llm", "stt", "eou", "tts", "breakdown", "spans"} <= m.keys()
    assert m["llm"]["ttft_ms"] and m["tts"]["ttfb_ms"] and m["llm"]["rounds"] == 2
    # the critical path adds up to the headline number (±"other")
    assert sum(b["ms"] for b in m["breakdown"]) == pytest.approx(m["response_latency_ms"], abs=3)
    await s.close()


async def test_barge_in_flushes_pipeline_and_truncates_history_to_what_was_heard():
    s = VoiceSession(mock_cfg())
    await s.start(greet=False)
    await s.on_text("Tell me about your menu.")
    # wait for the first audio
    while True:
        item = await asyncio.wait_for(s.bus.get(), 10)
        if isinstance(item, dict) and item["type"] == "response.audio_start":
            rid = item["response_id"]
            break
    await asyncio.sleep(0.6)  # let several sentences get synthesised
    s.on_playback(rid, 1700)  # the "browser" says: 1.7 s of audio has actually played
    task = asyncio.create_task(s._interrupt("test"))

    async def flush_reply():  # emulate the browser answering the flush request
        while True:
            item = await asyncio.wait_for(s.bus.get(), 5)
            if isinstance(item, dict) and item["type"] == "flush":
                s.on_flushed(item["response_id"], 1700)
                return

    await asyncio.gather(task, flush_reply())
    ev = next(e for e in reversed(s.bus.history) if e["type"] == "interrupt")
    assert ev["played_ms"] == 1700 and ev["audio_sent_ms"] > 1700
    assert ev["heard_text"] and ev["unheard_text"]
    last = s.messages[-1]
    assert last["role"] == "assistant" and last.get("_interrupted") and last["content"] == ev["heard_text"]
    assert len(last["content"]) < len(" ".join(x["text"] for x in ev["sentences"]))  # truncated, not the full reply
    assert s.agent_state == "idle" and s._resp is None
    await s.close()


async def test_interruptions_can_be_disabled():
    s = VoiceSession(mock_cfg(interrupt={"enabled": False}))
    await s.start(greet=False)
    await s.on_text("Tell me about your menu.")
    await collect_until(s, "response.audio_start")
    s.tracker.speaking = True
    s._on_speech_start(0.0)
    assert s._suppressed and any(e["type"] == "interrupt.suppressed" for e in s.bus.history)
    await s.close()


async def test_guardrail_blocks_sensitive_input_before_any_llm_call():
    s = VoiceSession(mock_cfg(guardrails={"enabled": True, "blocked_terms": ["credit card number"]}))
    await s.start(greet=False)
    await s.on_text("My credit card number is 4111")
    evs, _ = await collect_until(s, "turn.metrics")
    assert any(e["type"] == "guardrail.block" and e["side"] == "input" for e in evs)
    assert not any(e["type"] == "llm.request" for e in evs)
    await s.close()


async def test_pronunciation_override_is_applied_before_tts_but_history_keeps_original():
    s = VoiceSession(mock_cfg(tts={"provider": "mock", "pronunciations": [{"match": "Bella Notte", "say": "Bella Not-tay"}]}))
    await s.start(greet=True)  # greeting mentions "Bella Notte"
    evs, _ = await collect_until(s, "response.audio_end")
    req = next(e for e in evs if e["type"] == "tts.request")
    assert "Not-tay" in req["spoken"] and "Bella Notte" in req["text"]
    await s.close()


async def test_live_reconfigure_changes_turn_policy_without_dropping_the_session():
    s = VoiceSession(mock_cfg())
    await s.start(greet=False)
    new = mock_cfg(turn={"mode": "vad", "silence_timer_ms": 900})
    await s.reconfigure(new)
    assert s.policy.mode == "vad" and s.policy.silence_timer_ms == 900
    await s.close()


# ----------------------------------------------------------------------------- real VAD on real speech
@pytest.mark.skipif(not shutil.which("say"), reason="needs macOS `say` to make speech")
async def test_silero_separates_speech_from_noise_and_silence():
    try:
        find_silero_model()
    except FileNotFoundError:
        pytest.skip("silero model not installed")
    from voicelab.scenarios import synth_user

    pcm = await synth_user("Hello, I would like to book a table for two please.", "Samantha")
    vad = SileroVAD()
    probs = [vad.prob(pcm[i:i + FRAME_BYTES]) for i in range(0, len(pcm) - FRAME_BYTES, FRAME_BYTES)]
    assert max(probs) > 0.9 and np.mean(np.array(probs) > 0.5) > 0.4
    vad.reset()
    noise = f32_to_pcm16(np.random.default_rng(1).normal(0, 0.01, 16000).astype(np.float32))
    nprobs = [vad.prob(noise[i:i + FRAME_BYTES]) for i in range(0, len(noise) - FRAME_BYTES, FRAME_BYTES)]
    assert max(nprobs) < 0.5


# ----------------------------------------------------------------------------- HTTP + WebSocket protocol
def test_http_endpoints():
    c = TestClient(app)
    assert c.get("/api/health").json()["ok"] is True
    p = c.get("/api/providers").json()
    assert {"vad", "stt", "llm", "tts", "realtime", "livekit", "keys"} <= p.keys()
    assert all(isinstance(v, bool) for v in p["keys"].values())  # never leaks secrets
    assert {s["id"] for s in c.get("/api/scenarios").json()} >= {"book_table", "thinking_pause", "barge_in"}
    r = c.post("/api/turn/simulate", json={"segments": [{"kind": "speech", "text": "table for", "ms": 800}, {"kind": "pause", "ms": 1000, "intent": "continue"},
                                                         {"kind": "speech", "text": "two people", "ms": 800}], "mode": "semantic"}).json()
    assert r["summary"]["saved_by_semantic"] == 1
    h = c.post("/api/interrupt/simulate", json={"sentences": [{"text": "a b c d", "dur_ms": 1000}, {"text": "e f", "dur_ms": 500}], "played_ms": 500}).json()
    assert h["heard"].startswith("a b") and "e f" in h["unheard"]


def test_websocket_session_streams_events_and_audio_and_handles_flush():
    c = TestClient(app)
    cfg = mock_cfg().model_dump()
    with c.websocket_connect("/ws/session") as ws:
        ws.send_json({"type": "start", "config": cfg, "greet": False})
        ws.send_json({"type": "ping", "ts": 123})
        seen, audio, rid = [], 0, None
        deadline = time.time() + 20
        sent_text = False
        while time.time() < deadline:
            m = ws.receive()
            if m.get("bytes") is not None:
                audio += len(m["bytes"])
                if audio > 40_000 and rid is not None:
                    break
                continue
            import json
            ev = json.loads(m["text"])
            seen.append(ev["type"])
            if ev["type"] == "session.ready" and not sent_text:
                ws.send_json({"type": "text", "text": "Tell me about your menu."})
                sent_text = True
            if ev["type"] == "response.audio_start":
                rid = ev["response_id"]
            if ev["type"] == "flush":
                ws.send_json({"type": "flushed", "response_id": ev["response_id"], "played_ms": 900})
        assert "pong" in seen and "session.ready" in seen and "response.audio_start" in seen and audio > 40_000
        # barge in by typing while the agent is talking → server asks the client to flush
        ws.send_json({"type": "text", "text": "Actually, what time do you close?"})
        got_flush = got_interrupt = False
        deadline = time.time() + 10
        while time.time() < deadline and not got_interrupt:
            m = ws.receive()
            if m.get("bytes") is not None:
                continue
            ev = json.loads(m["text"])
            if ev["type"] == "flush":
                got_flush = True
                ws.send_json({"type": "flushed", "response_id": ev["response_id"], "played_ms": 900})
            if ev["type"] == "interrupt":
                got_interrupt = True
                assert ev["played_ms"] == 900 and ev["heard_text"]
        assert got_flush and got_interrupt
