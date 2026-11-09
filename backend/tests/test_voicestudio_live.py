"""The VoiceStudio integration against a REAL, running VoiceStudio (the fake-based tests live in test_voicestudio.py).

Opt-in because it needs the models installed + their licences accepted and a few seconds of GPU time per sentence:

    make studio-up && make studio-test        # = VOICESTUDIO_LIVE=1 pytest tests/test_voicestudio_live.py
"""
import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from voicelab import voicestudio as vs
from voicelab.audio import MIC_RATE, resample, silence
from voicelab.config import SessionConfig
from voicelab.main import app
from voicelab.session import VoiceSession
from voicelab.tts import VoiceStudioTTS

pytestmark = pytest.mark.skipif(os.getenv("VOICESTUDIO_LIVE") != "1", reason="set VOICESTUDIO_LIVE=1 (or run `make studio-test`) with VoiceStudio running")


@pytest.fixture(scope="module")
def snap():
    s = vs.probe(force=True, timeout=60)
    if not s["reachable"]:
        pytest.skip(f"VoiceStudio is not reachable: {s['error'] or s['hint']}")
    if not vs.tts_engine_ids(s):
        pytest.skip("VoiceStudio reports no available TTS engine")
    return s


def _skip_if_unlicensed(exc: Exception):
    if "licence" in str(exc).lower():
        pytest.skip(str(exc))
    raise exc


async def synth(tts: VoiceStudioTTS, text: str) -> bytes:
    try:
        return b"".join([c async for c in tts.synthesize(text, voice_id="", speed=1.0)])
    except vs.VoiceStudioError as e:
        _skip_if_unlicensed(e)


async def test_real_tts_streams_pcm_and_reports_server_stats(snap):
    tts = VoiceStudioTTS(model=vs.tts_engine_ids(snap)[0])
    pcm = await synth(tts, "Thanks for calling. How can I help?")
    assert len(pcm) > 24_000 and len(pcm) % 2 == 0  # > 0.5 s of 24 kHz PCM16
    st = tts.last_stats
    assert st["transport"] == "ws" and st["engine"] and st["ttfa_ms"] > 0 and st["rtf"] > 0
    assert tts.sample_rate == 24_000
    await tts.aclose()


async def test_real_socket_is_discarded_on_barge_in_and_the_next_sentence_is_clean(snap):
    tts = VoiceStudioTTS(model=vs.tts_engine_ids(snap)[0])
    await synth(tts, "Warm up.")
    agen = tts.synthesize("This sentence is going to be cut off by the caller before it ever finishes playing.", voice_id="", speed=1.0)
    task = asyncio.create_task(agen.__anext__())
    await asyncio.sleep(0.4)
    task.cancel()
    with pytest.raises((asyncio.CancelledError, StopAsyncIteration)):
        await task
    await agen.aclose()
    assert not tts._pool  # a socket that was mid-synthesis is never reused
    pcm = await synth(tts, "Fresh start.")
    assert len(pcm) > 12_000
    await tts.aclose()


def test_real_round_trip_hears_what_it_said(snap):
    r = TestClient(app).post("/api/voicestudio/selftest", json={})
    body = r.json()
    if not body.get("ok"):
        _skip_if_unlicensed(RuntimeError(body.get("error", "")))
    assert body["match"], body["heard"]
    assert body["tts"]["transport"] == "ws" and body["tts"]["server_ttfa_ms"] > 0


async def test_real_live_turn_speaks_with_voicestudio(snap):
    cfg = SessionConfig.model_validate({
        "persona": "restaurant", "stt": {"provider": "voicestudio"}, "llm": {"provider": "mock", "mock_profile": "fast-inference-70b"},
        "tts": {"provider": "voicestudio", "model": vs.tts_engine_ids(snap)[0]}, "vad": {"provider": "energy"}})
    s = VoiceSession(cfg)
    await s.start(greet=False)
    await s.on_text("Hi, I'd like to book a table for four people at seven.")
    audio, metrics, errors = 0, None, []
    end = asyncio.get_running_loop().time() + 240
    while asyncio.get_running_loop().time() < end and metrics is None:
        item = await asyncio.wait_for(s.bus.get(), timeout=end - asyncio.get_running_loop().time())
        if isinstance(item, (bytes, bytearray)):
            audio += len(item)
        elif item["type"] == "error":
            errors.append(item)
        elif item["type"] == "turn.metrics":
            metrics = item
    await s.close()
    if errors and "licence" in str(errors[0]).lower():
        pytest.skip(str(errors[0]))
    assert not errors, errors
    assert audio > 24_000 and metrics["tts"]["provider"] == "voicestudio"
    assert metrics["tts"]["server"]["ttfa_ms"] > 0


async def test_real_caller_speech_is_transcribed_by_voicestudio_inside_a_session(snap):
    """The caller's audio (made by VoiceStudio's own TTS, resampled to the 16 kHz the pipeline hears) goes mic -> VAD ->
    VoiceStudio ASR, and the final transcript comes back as the turn's `stt.final`."""
    engine = vs.tts_engine_ids(snap)[0]
    tts = VoiceStudioTTS(model=engine)
    pcm24 = await synth(tts, "I would like to book a table for four people.")
    await tts.aclose()
    mic = resample(pcm24, 24_000, MIC_RATE) + silence(1800)
    cfg = SessionConfig.model_validate({
        "persona": "restaurant", "stt": {"provider": "voicestudio"}, "llm": {"provider": "mock", "mock_profile": "fast-inference-70b"},
        "tts": {"provider": "voicestudio", "model": engine}, "vad": {"provider": "energy"}, "turn": {"mode": "vad", "silence_timer_ms": 400}})
    s = VoiceSession(cfg)
    await s.start(greet=False)
    step = 1024  # 512 samples = 32 ms
    for i in range(0, len(mic), step):
        s.feed_audio(mic[i:i + step])
        await asyncio.sleep(0.03)
    final, end = None, asyncio.get_running_loop().time() + 90
    while final is None and asyncio.get_running_loop().time() < end:
        item = await asyncio.wait_for(s.bus.get(), timeout=end - asyncio.get_running_loop().time())
        if isinstance(item, dict) and item["type"] == "stt.final":
            final = item
    await s.close()
    assert final is not None, "no stt.final arrived"
    assert "table" in final["text"].lower() and "four" in final["text"].lower().replace("4", "four")
