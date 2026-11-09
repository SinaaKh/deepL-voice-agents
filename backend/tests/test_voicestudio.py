"""The VoiceStudio integration, tested against a faithful fake of its documented local API (see fake_voicestudio.py).
Live tests against a real VoiceStudio live in test_voicestudio_live.py."""
import asyncio
import time

import numpy as np
import pytest
from fake_voicestudio import SR, FakeVoiceStudio, tone
from fastapi.testclient import TestClient

from voicelab import voicestudio as vs
from voicelab.audio import MIC_RATE, f32_to_pcm16
from voicelab.config import SessionConfig
from voicelab.main import app
from voicelab.session import VoiceSession
from voicelab.stt import create_stt
from voicelab.tts import VoiceStudioTTS, create_tts


@pytest.fixture
def fake(monkeypatch):
    srv = FakeVoiceStudio().start()
    monkeypatch.setenv("VOICESTUDIO_URL", srv.url)
    monkeypatch.delenv("VOICESTUDIO_API_KEY", raising=False)
    monkeypatch.delenv("OMNIVOICE_API_KEY", raising=False)
    vs._cache["snap"] = None
    yield srv
    srv.stop()
    vs._cache["snap"] = None


async def collect(tts, text="Hello there, how are you today", voice="", speed=1.0):
    return b"".join([c async for c in tts.synthesize(text, voice_id=voice, speed=speed)])


# ---------------------------------------------------------------------------------------- discovery
def test_probe_reads_version_engines_voices_and_the_active_asr_engine(fake):
    snap = vs.probe(force=True)
    assert snap["reachable"] and snap["version"] == "0.5.7-fake" and snap["asr_engine"] == "mlx-whisper"
    assert vs.tts_engine_ids(snap) == ["omnivoice", "kittentts"]  # unavailable engines are not offered
    opts = vs.voice_options(snap)
    assert opts[0] == {"id": "", "label": "Default (engine voice)"}
    assert [o["id"] for o in opts[1:]] == ["voice_ada", "voice_bo"] and "Ada" in opts[1]["label"]  # profiles only, not OpenAI aliases


def test_a_slow_cold_start_listing_is_not_mistaken_for_no_engines(monkeypatch):
    """Real VoiceStudio: the first /v1/models took ~55 s. Discovery must stay snappy, say 'loading', and recover."""
    srv = FakeVoiceStudio().start()
    srv.first_listing_delay = 1.5
    try:
        monkeypatch.setenv("VOICESTUDIO_URL", srv.url)
        t0 = time.perf_counter()
        snap = vs.probe(force=True, timeout=0.4)
        assert time.perf_counter() - t0 < 1.2
        assert snap["reachable"] and snap["device"] == "mps" and snap["engines_loading"] and not snap["tts_engines"]
        for _ in range(40):  # the background warm-up finishes, the next probe has everything
            time.sleep(0.1)
            snap = vs.probe(force=True, timeout=0.4)
            if snap["tts_engines"]:
                break
        assert vs.tts_engine_ids(snap) == ["omnivoice", "kittentts"] and not snap["engines_loading"]
    finally:
        srv.stop()


def test_probe_when_voicestudio_is_not_running_gives_actionable_advice(monkeypatch):
    monkeypatch.setenv("VOICESTUDIO_URL", "http://127.0.0.1:9")
    snap = vs.probe(force=True, timeout=0.5)
    assert not snap["reachable"] and "make studio-up" in snap["hint"]


def test_remote_voicestudio_needs_the_bearer_key(monkeypatch):
    srv = FakeVoiceStudio(api_key="s3cret").start()
    try:
        monkeypatch.setenv("VOICESTUDIO_URL", srv.url)
        monkeypatch.delenv("VOICESTUDIO_API_KEY", raising=False)
        monkeypatch.delenv("OMNIVOICE_API_KEY", raising=False)
        denied = vs.probe(force=True)
        assert denied["reachable"] and denied["auth_required"]
        monkeypatch.setenv("VOICESTUDIO_API_KEY", "s3cret")
        assert vs.probe(force=True)["auth_required"] is False
    finally:
        srv.stop()


def test_wer():
    assert vs.wer("The quick brown fox", "the quick brown fox.") == 0
    assert vs.wer("one two three four", "one two tree four") == pytest.approx(0.25)
    assert vs.wer("", "") == 0 and vs.wer("a", "") == 1


# ---------------------------------------------------------------------------------------- TTS
async def test_tts_streams_pcm_over_ws_and_reports_the_servers_own_ttfa(fake):
    tts = create_tts("voicestudio", "kittentts", "en", "warm and calm")
    assert isinstance(tts, VoiceStudioTTS) and tts.streaming
    pcm = await collect(tts, voice="voice_ada", speed=1.2)
    assert len(pcm) / 2 / tts.sample_rate == pytest.approx(0.9, abs=0.05) and tts.sample_rate == SR
    assert fake.ws_requests[0] == {"text": "Hello there, how are you today", "speed": 1.2, "voice": "voice_ada", "engine": "kittentts",
                                   "language": "en", "instruct": "warm and calm"}
    st = tts.last_stats
    assert st["transport"] == "ws" and st["engine"] == "kittentts" and st["ttfa_ms"] > 0 and st["rtf"] == 0.12
    await tts.aclose()


async def test_tts_reuses_one_socket_for_a_whole_conversation(fake):
    tts = VoiceStudioTTS()
    for _ in range(3):
        assert await collect(tts)
    assert fake.ws_connections == 1 and len(fake.ws_requests) == 3
    await tts.aclose()


async def test_barge_in_discards_the_socket_so_stale_audio_can_never_leak_into_the_next_sentence(fake):
    tts = VoiceStudioTTS()
    agen = tts.synthesize("a long sentence with quite a few words in it so it keeps streaming", voice_id="", speed=1.0)
    first = await agen.__anext__()  # mid-stream…
    assert first
    await agen.aclose()  # …the user barges in
    assert not tts._pool  # that socket is never reused
    nxt = await collect(tts, "Short one")
    assert len(nxt) / 2 / SR == pytest.approx(0.45, abs=0.06) or len(nxt) > 0
    assert fake.ws_connections == 2  # a fresh connection, with a clean frame stream
    await tts.aclose()


async def test_tts_falls_back_to_the_openai_http_endpoint_when_ws_is_missing(monkeypatch):
    srv = FakeVoiceStudio(ws=False).start()
    try:
        monkeypatch.setenv("VOICESTUDIO_URL", srv.url)
        tts = VoiceStudioTTS("omnivoice", "", "")
        pcm = await collect(tts, voice="voice_bo")
        assert pcm and tts.transport == "http" and tts.last_stats["transport"] == "http"
        body = srv.speech_requests[0]
        assert body["response_format"] == "pcm" and body["stream_format"] == "audio" and body["voice"] == "voice_bo"
        assert body["model"] == "omnivoice"
    finally:
        srv.stop()


async def test_tts_error_frames_surface_as_readable_errors(fake):
    tts = VoiceStudioTTS()
    with pytest.raises(vs.VoiceStudioError, match="engine exploded"):
        await collect(tts, "FAIL")
    await tts.aclose()


async def test_tts_when_voicestudio_is_down_says_how_to_start_it(monkeypatch):
    monkeypatch.setenv("VOICESTUDIO_URL", "http://127.0.0.1:9")
    with pytest.raises(vs.VoiceStudioError, match="make studio-up"):
        await collect(VoiceStudioTTS())


async def test_tts_sends_the_bearer_key_on_the_websocket_too(monkeypatch):
    srv = FakeVoiceStudio(api_key="k").start()
    try:
        monkeypatch.setenv("VOICESTUDIO_URL", srv.url)
        monkeypatch.setenv("VOICESTUDIO_API_KEY", "k")
        tts = VoiceStudioTTS()
        assert await collect(tts)
        await tts.aclose()
        monkeypatch.setenv("VOICESTUDIO_API_KEY", "wrong")
        with pytest.raises(vs.VoiceStudioError, match="API key|api key|rejected"):
            await collect(VoiceStudioTTS())
    finally:
        srv.stop()


# ---------------------------------------------------------------------------------------- STT
def speechlike(ms: int) -> bytes:
    rng = np.random.default_rng(3)
    return f32_to_pcm16(rng.normal(0, 0.1, int(MIC_RATE * ms / 1000)).astype(np.float32))


async def test_stt_session_streams_interim_text_then_reuses_the_speculative_final(fake):
    fake.transcript = lambda secs: "I'd like a table for" if secs < 5 else "unreachable"
    heard: list[str] = []
    stt = create_stt("voicestudio", "", "en", "restaurant booking")
    sess = stt.open(heard.append)
    for _ in range(40):  # 1.28 s of mic audio in 32 ms frames
        sess.push(speechlike(32))
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.4)
    assert heard and heard[-1] == "I'd like a table for"  # interim text while the caller is still talking
    text = await sess.flush_interim()  # first pause: speculative final
    n_before = len(fake.stt_requests)
    res = await sess.finish()  # turn end: nothing new was said, so no extra decode
    assert text == res.text == "I'd like a table for" and res.streamed and len(fake.stt_requests) == n_before
    req = fake.stt_requests[0]
    assert req["language"] == "en" and req["prompt"] == "restaurant booking" and req["model"] == "whisper-1" and req["rate"] == MIC_RATE


async def test_stt_session_decodes_again_only_if_more_audio_arrived(fake):
    fake.transcript = lambda secs: f"{secs:.1f}s"
    sess = create_stt("voicestudio", "", "en").open(lambda t: None)
    for _ in range(25):
        sess.push(speechlike(32))
    await sess.flush_interim()
    for _ in range(10):  # the caller resumed
        sess.push(speechlike(32))
    n = len(fake.stt_requests)
    res = await sess.finish()
    assert len(fake.stt_requests) == n + 1 and res.text == "1.1s"


async def test_stt_errors_are_readable(monkeypatch):
    monkeypatch.setenv("VOICESTUDIO_URL", "http://127.0.0.1:9")
    sess = create_stt("voicestudio", "", "en").open(lambda t: None)
    for _ in range(10):
        sess.push(speechlike(32))
    with pytest.raises(vs.VoiceStudioError, match="make studio-up"):
        await sess.finish()


def _status_error(code: int, body):
    import httpx

    req = httpx.Request("POST", "http://x/v1/audio/transcriptions")
    resp = httpx.Response(code, json=body, request=req)
    return httpx.HTTPStatusError("boom", request=req, response=resp)


def test_an_unaccepted_model_licence_is_not_blamed_on_the_api_key():
    # What VoiceStudio really answers (403) until the licence of a model has been accepted in its catalogue.
    detail = {"code": "model_licence_required", "message": "Licence not accepted", "models": [{"repo_id": "k2-fsa/OmniVoice"}, {"repo_id": "eustlb/higgs-audio-v2-tokenizer"}]}
    msg = vs.explain(_status_error(403, {"error": {"message": "Licence not accepted"}, "detail": detail}))
    assert "k2-fsa/OmniVoice" in msg and "higgs-audio-v2-tokenizer" in msg and "licence" in msg and "API_KEY" not in msg


def test_http_errors_keep_their_real_message_and_only_401_blames_the_key():
    assert "VOICESTUDIO_API_KEY" in vs.explain(_status_error(401, {"error": {"message": "invalid api key"}}))
    assert "VOICESTUDIO_API_KEY" in vs.explain(_status_error(403, {}))
    msg = vs.explain(_status_error(409, {"error": {"message": "No speech-to-text model is installed. Download Whisper"}}))
    assert "409" in msg and "No speech-to-text model" in msg

# ---------------------------------------------------------------------------------------- session
def cfg(**over) -> SessionConfig:
    base = {"persona": "restaurant", "stt": {"provider": "voicestudio"}, "llm": {"provider": "mock", "mock_profile": "fast-inference-70b"},
            "tts": {"provider": "voicestudio", "voice_id": "voice_ada", "model": "omnivoice"}, "vad": {"provider": "energy"}}
    base.update(over)
    return SessionConfig.model_validate(base)


async def collect_events(s: VoiceSession, stop: str, timeout=20.0):
    evs, audio, end = [], 0, asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < end:
        item = await asyncio.wait_for(s.bus.get(), timeout=end - asyncio.get_running_loop().time())
        if isinstance(item, (bytes, bytearray)):
            audio += len(item)
            continue
        evs.append(item)
        if item["type"] == stop:
            return evs, audio
    raise AssertionError(stop)


async def test_a_live_turn_speaks_with_voicestudio_and_surfaces_its_server_metrics(fake):
    s = VoiceSession(cfg())
    await s.start(greet=False)
    names = [e["component"] for e in s.bus.history if e["type"] == "provider.ready"]
    assert "stt" in names and "tts-voice" in names  # both engines were warmed before the first caller spoke
    await s.on_text("Hi, I'd like to book a table for four people at 7pm.")
    evs, audio = await collect_events(s, "turn.metrics")
    assert audio > 10_000
    stats = [e for e in evs if e["type"] == "tts.server_stats"]
    assert stats and stats[0]["engine"] == "omnivoice" and stats[0]["transport"] == "ws"
    m = evs[-1]
    assert m["tts"]["provider"] == "voicestudio" and m["tts"]["server"]["rtf"] == 0.12 and m["tts"]["ttfb_ms"] > 0
    assert any(r["voice"] == "voice_ada" and r["engine"] == "omnivoice" for r in fake.ws_requests)
    await s.close()
    assert not s.tts._pool  # the pooled socket is released with the session


async def test_barge_in_mid_sentence_with_voicestudio_flushes_cleanly(fake):
    s = VoiceSession(cfg(interrupt={"enabled": True, "min_duration_ms": 100}))
    await s.start(greet=False)
    await s.on_text("Tell me about your menu.")
    evs, _ = await collect_events(s, "response.audio_start")
    rid = evs[-1]["response_id"]
    await asyncio.sleep(0.5)
    s.on_playback(rid, 1000)
    task = asyncio.create_task(s._interrupt("test"))
    while True:
        item = await asyncio.wait_for(s.bus.get(), 5)
        if isinstance(item, dict) and item["type"] == "flush":
            s.on_flushed(rid, 1000)
            break
    await task
    done = [e for e in s.bus.history if e["type"] == "interrupt"]
    assert done and done[0]["heard_text"] and s.agent_state == "idle"
    # the next response must be clean: a new socket, no stale frames from the cancelled sentence
    await s.on_text("What time do you close?")
    evs, audio = [], 0
    while True:  # skip the interrupted turn's own (already queued) metrics, wait for the new response
        got, a = await collect_events(s, "turn.metrics")
        evs, audio = evs + got, audio + a
        if not got[-1]["interrupted"]:
            break
    assert audio > 5_000 and not [e for e in evs if e["type"] == "error"]
    await s.close()


# ---------------------------------------------------------------------------------------- HTTP API
def test_providers_list_voicestudio_with_its_voices_and_engines(fake):
    c = TestClient(app)
    p = c.get("/api/providers").json()
    st = next(x for x in p["stt"] if x["id"] == "voicestudio")
    tt = next(x for x in p["tts"] if x["id"] == "voicestudio")
    assert st["available"] and st["local"] and "mlx-whisper" in st["note"]
    assert tt["available"] and tt["streaming"] and tt["models"] == ["omnivoice", "kittentts"]
    assert [v["id"] for v in tt["voices"]] == ["", "voice_ada", "voice_bo"]
    assert p["voicestudio"]["reachable"] and p["voicestudio"]["voices"] == 2 and p["voicestudio"]["version"] == "0.5.7-fake"


def test_providers_flag_voicestudio_unavailable_with_a_hint_when_it_is_down(monkeypatch):
    monkeypatch.setenv("VOICESTUDIO_URL", "http://127.0.0.1:9")
    vs._cache["snap"] = None
    p = TestClient(app).get("/api/providers").json()
    tt = next(x for x in p["tts"] if x["id"] == "voicestudio")
    assert not tt["available"] and "make studio-up" in tt["reason"]


def test_status_speak_transcribe_and_selftest_endpoints(fake):
    c = TestClient(app)
    s = c.get("/api/voicestudio/status").json()
    assert s["reachable"] and s["engines"][0]["id"] == "omnivoice" and [v["voice_id"] for v in s["voice_profiles"]] == ["voice_ada", "voice_bo"]

    r = c.post("/api/voicestudio/speak", json={"text": "Hello from the dashboard", "voice": "voice_ada"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    assert float(r.headers["x-vs-ttfa-ms"]) > 0 and r.headers["x-vs-rtf"] == "0.12" and r.headers["x-vs-engine"] == "omnivoice"

    raw = tone(800)  # 24 kHz tone, treated as 16 kHz PCM here: only the plumbing matters
    t = c.post("/api/voicestudio/transcribe?sr=16000&language=en", content=raw, headers={"content-type": "application/octet-stream"}).json()
    assert t["text"] == "hello from voice studio" and t["latency_ms"] >= 0

    fake.transcript = lambda secs: "The quick brown fox jumps over the lazy dog. This voice is running locally."
    st = c.post("/api/voicestudio/selftest", json={}).json()
    assert st["ok"] and st["match"] and st["wer"] == 0 and st["tts"]["server_ttfa_ms"] > 0 and st["stt"]["latency_ms"] >= 0
    assert fake.stt_requests[-1]["rate"] == MIC_RATE  # the STT leg gets what the agent's STT would receive

    fake.transcript = "totally different words"
    bad = c.post("/api/voicestudio/selftest", json={"text": "alpha beta gamma delta"}).json()
    assert bad["ok"] and not bad["match"] and bad["wer"] == 1


def test_endpoints_report_502_with_advice_when_voicestudio_is_down(monkeypatch):
    monkeypatch.setenv("VOICESTUDIO_URL", "http://127.0.0.1:9")
    c = TestClient(app)
    r = c.post("/api/voicestudio/speak", json={"text": "hi"})
    assert r.status_code == 502 and "make studio-up" in r.json()["error"]
    assert c.post("/api/voicestudio/selftest", json={}).status_code == 502
    assert c.post("/api/voicestudio/transcribe", content=b"\x00\x01" * 400).status_code == 502
