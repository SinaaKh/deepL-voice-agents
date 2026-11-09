"""VoiceLab API + WebSocket gateway.

  WS  /ws/session      – the live voice session (binary mic PCM in, JSON events + binary TTS PCM out)
  GET /api/providers   – what is actually available on this machine (no secrets are ever returned)
  POST /api/turn/*     – Turn-Taking Lab (same TurnPolicy code as the live pipeline)
  POST /api/benchmark  – A/B latency benchmark (NDJSON stream)
  GET  /api/livekit/*  – token minting for the LiveKit mode
Static dashboard: serves ../frontend/dist when it has been built.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, Request, Response, WebSocket
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from . import voicestudio as vs
from .benchmark import BenchRequest, run_benchmark
from .audio import MIC_RATE, resample, to_wav
from .config import ROOT, SessionConfig, settings
from .interrupt import build_segments, heard_text
from .llm import ENDPOINTS, ollama_models
from .llm.mock import PROFILES
from .personas import PERSONAS
from .realtime import RealtimeSession
from .scenarios import list_scenarios, run_scenario
from .session import VoiceSession
from .stt import whisper_is_warm
from .tts import ELEVEN_VOICES, create_tts, piper_voices, say_voices
from .turn.sim import DATASET, SimRequest, simulate, sweep
from .vad import find_silero_model

app = FastAPI(title="VoiceLab", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --------------------------------------------------------------------------- #
# Introspection
# --------------------------------------------------------------------------- #
def _silero_ok() -> bool:
    try:
        find_silero_model()
        return True
    except Exception:
        return False


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/api/providers")
def providers():
    ollama = ollama_models()
    voices = say_voices()
    vsnap = vs.probe()
    vs_ok = vsnap["reachable"] and not vsnap["auth_required"]
    vs_reason = "" if vs_ok else (vsnap["error"] or vs.START_HINT)
    keys = {
        "openai": bool(settings.openai_key), "anthropic": bool(settings.anthropic_key), "elevenlabs": bool(settings.elevenlabs_key),
        "deepgram": bool(settings.deepgram_key), "groq": bool(settings.groq_key), "cerebras": bool(settings.cerebras_key),
        "together": bool(settings.together_key),
    }
    llm = [
        {"id": "ollama", "label": "Ollama (local)", "available": bool(ollama), "reason": "" if ollama else "Ollama is not running or has no chat model",
         "models": ollama, "default": ollama[0] if ollama else "", "local": True},
        {"id": "mock", "label": "Simulated (latency profile)", "available": True, "reason": "", "local": True,
         "models": list(PROFILES), "default": "gpt-4o-mini",
         "profiles": {k: v for k, v in PROFILES.items()}},
    ]
    for pid, (_, default_model, _) in ENDPOINTS.items():
        llm.append({"id": pid, "label": {"openai": "OpenAI", "groq": "Groq", "cerebras": "Cerebras", "together": "Together AI"}[pid],
                    "available": keys[pid], "reason": "" if keys[pid] else f"set {pid.upper()}_API_KEY in .env",
                    "models": {"openai": ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"], "groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
                               "cerebras": ["llama-3.3-70b", "llama3.1-8b"], "together": ["meta-llama/Llama-3.3-70B-Instruct-Turbo"]}[pid],
                    "default": default_model, "local": False})
    llm.append({"id": "anthropic", "label": "Anthropic", "available": keys["anthropic"], "reason": "" if keys["anthropic"] else "set ANTHROPIC_API_KEY in .env",
                "models": ["claude-haiku-5-5", "claude-sonnet-5-5"], "default": "claude-haiku-5-5", "local": False})
    return {
        "keys": keys,
        "vad": [
            {"id": "silero", "label": "Silero VAD (neural)", "available": _silero_ok(), "reason": "" if _silero_ok() else "run `uv sync --extra livekit`"},
            {"id": "energy", "label": "Energy gate (naive)", "available": True, "reason": ""},
        ],
        "stt": [
            {"id": "whisper-local", "label": "Whisper (local, faster-whisper)", "available": True, "reason": "", "local": True, "streaming": True,
             "models": ["tiny.en", "base.en", "small.en"], "default": settings.whisper_model, "loaded": whisper_is_warm(settings.whisper_model)},
            {"id": "voicestudio", "label": "VoiceStudio ASR (local)", "available": vs_ok, "reason": vs_reason, "local": True, "streaming": True,
             "models": [vsnap["asr_engine"]] if vsnap["asr_engine"] else [], "default": "",
             "note": f"uses the ASR engine active in VoiceStudio ({vsnap['asr_engine'] or 'unknown'})" if vs_ok else ""},
            {"id": "openai", "label": "OpenAI transcribe", "available": keys["openai"], "reason": "" if keys["openai"] else "set OPENAI_API_KEY in .env",
             "local": False, "streaming": False, "models": ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"], "default": "gpt-4o-mini-transcribe"},
            {"id": "deepgram", "label": "Deepgram (streaming)", "available": keys["deepgram"], "reason": "" if keys["deepgram"] else "set DEEPGRAM_API_KEY in .env",
             "local": False, "streaming": True, "models": ["nova-3", "nova-2-phonecall"], "default": "nova-3"},
            {"id": "mock", "label": "Scripted (oracle – scenarios only)", "available": True, "reason": "", "local": True, "streaming": True, "models": [], "default": ""},
        ],
        "llm": llm,
        "tts": [
            {"id": "piper", "label": "Piper (local neural)", "available": bool(piper_voices()), "reason": "" if piper_voices() else "run `python scripts/download_models.py`",
             "local": True, "streaming": True, "voices": piper_voices(), "default": piper_voices()[0]["id"] if piper_voices() else ""},
            {"id": "voicestudio", "label": "VoiceStudio (local)", "available": vs_ok, "reason": vs_reason, "local": True, "streaming": True,
             "voices": vs.voice_options(vsnap), "models": vs.tts_engine_ids(vsnap), "default": "",
             "note": "your cloned / designed voices from VoiceStudio; streams sentence by sentence" if vs_ok else ""},
            {"id": "macos-say", "label": "macOS say (local)", "available": bool(shutil.which("say")), "reason": "" if shutil.which("say") else "macOS only",
             "local": True, "streaming": False, "voices": voices, "default": "Samantha",
             "note": "renders each sentence in a separate process (~1.5 s) – a good example of a non-streaming TTS"},
            {"id": "openai", "label": "OpenAI TTS", "available": keys["openai"], "reason": "" if keys["openai"] else "set OPENAI_API_KEY in .env", "local": False,
             "streaming": True, "voices": [{"id": v, "label": v} for v in ("alloy", "ash", "coral", "echo", "nova", "sage", "shimmer")], "default": "alloy"},
            {"id": "elevenlabs", "label": "ElevenLabs", "available": keys["elevenlabs"], "reason": "" if keys["elevenlabs"] else "set ELEVEN_API_KEY in .env",
             "local": False, "streaming": True, "voices": ELEVEN_VOICES, "default": ELEVEN_VOICES[0]["id"]},
            {"id": "mock", "label": "Synthetic tone voice", "available": True, "reason": "", "local": True, "streaming": True,
             "voices": [{"id": "a", "label": "Voice A"}, {"id": "b", "label": "Voice B"}, {"id": "c", "label": "Voice C"}], "default": "a"},
        ],
        "realtime": {"available": keys["openai"], "reason": "" if keys["openai"] else "set OPENAI_API_KEY in .env",
                     "models": ["gpt-realtime", "gpt-realtime-mini"], "voices": ["marin", "cedar", "alloy", "ash", "coral", "echo", "sage", "shimmer", "verse"]},
        "livekit": {"configured": bool(settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret), "url": settings.livekit_url},
        "voicestudio": _voicestudio_summary(vsnap),
    }


def _voicestudio_summary(snap: dict) -> dict:
    home = Path(settings.voicestudio_home)
    return {
        "reachable": snap["reachable"], "url": snap["url"], "version": snap["version"], "device": snap["device"],
        "engines_loading": snap["engines_loading"], "auth_required": snap["auth_required"],
        "asr_engine": snap["asr_engine"], "tts_engines": vs.tts_engine_ids(snap), "voices": len([v for v in snap["voices"] if v.get("type") == "profile"]),
        "error": snap["error"], "hint": snap["hint"], "installed": (home / "backend").is_dir(), "home": str(home),
    }


@app.get("/api/personas")
def personas():
    return [{"id": k, **{kk: vv for kk, vv in v.items() if kk != "system_prompt"}, "system_prompt": v["system_prompt"]} for k, v in PERSONAS.items()]


@app.get("/api/scenarios")
def scenarios():
    return list_scenarios()


# --------------------------------------------------------------------------- #
# Turn-taking lab
# --------------------------------------------------------------------------- #
@app.post("/api/turn/simulate")
def turn_simulate(req: SimRequest):
    return simulate(req)


@app.get("/api/turn/sweep")
def turn_sweep(max_delay_ms: int = 2500, threshold: float = 0.5):
    return sweep(max_delay_ms, threshold)


@app.get("/api/turn/dataset")
def turn_dataset():
    return [{"name": d["name"], "agent_last": d["agent_last"], "segments": [s.model_dump() for s in d["segments"]]} for d in DATASET]


@app.post("/api/interrupt/simulate")
def interrupt_simulate(body: dict):
    sentences = [(s["text"], float(s["dur_ms"])) for s in body["sentences"]]
    segs = build_segments(sentences)
    heard, unheard, idx = heard_text(segs, float(body["played_ms"]))
    return {"heard": heard, "unheard": unheard, "current": idx, "total_ms": sum(d for _, d in sentences)}


# --------------------------------------------------------------------------- #
# Benchmark
# --------------------------------------------------------------------------- #
@app.post("/api/benchmark")
async def benchmark(req: BenchRequest):
    async def gen():
        async for row in run_benchmark(req):
            yield json.dumps(row) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# --------------------------------------------------------------------------- #
# VoiceStudio – local ElevenLabs-style voice studio (see docs/VOICESTUDIO.md)
# --------------------------------------------------------------------------- #
@app.get("/api/voicestudio/status")
def voicestudio_status():
    snap = vs.probe(force=True, timeout=2.0)
    return {**_voicestudio_summary(snap), "features": snap["features"], "engines": snap["tts_engines"], "probe_ms": snap["probe_ms"],
            "voice_profiles": [v for v in snap["voices"] if v.get("type") == "profile"],
            "models": [m["id"] for m in snap["models"] if not m.get("voicestudio", {}).get("alias_for_active_engine")]}


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    voice: str = ""
    model: str = ""
    speed: float = Field(1.0, ge=0.5, le=2.0)
    language: str = ""
    instruct: str = ""


async def _speak(req: SpeakRequest) -> dict:
    """Synthesise through the *same* provider class the live agent uses, timing it like the agent would."""
    tts = create_tts("voicestudio", req.model, req.language, req.instruct)
    t0, first, chunks = time.perf_counter(), None, []
    try:
        async for pcm in tts.synthesize(req.text, voice_id=req.voice, speed=req.speed):
            if first is None:
                first = (time.perf_counter() - t0) * 1000
            chunks.append(pcm)
    finally:
        await tts.aclose()
    pcm = b"".join(chunks)
    if not pcm:
        raise vs.VoiceStudioError("VoiceStudio returned no audio.")
    rate = tts.sample_rate
    return {"pcm": pcm, "rate": rate, "ttfb_ms": first, "total_ms": (time.perf_counter() - t0) * 1000,
            "audio_ms": len(pcm) / 2 / rate * 1000, "server": tts.last_stats or {}}


@app.post("/api/voicestudio/speak")
async def voicestudio_speak(req: SpeakRequest):
    """Audition a voice: returns a WAV, with VoiceStudio's own TTFA/RTF in X-VS-* headers."""
    try:
        r = await _speak(req)
    except Exception as e:
        return JSONResponse({"error": vs.explain(e)}, status_code=502)
    s = r["server"]
    headers = {"X-VS-TTFB-Ms": f"{r['ttfb_ms']:.0f}", "X-VS-Total-Ms": f"{r['total_ms']:.0f}", "X-VS-Audio-Ms": f"{r['audio_ms']:.0f}",
               "X-VS-TTFA-Ms": "" if s.get("ttfa_ms") is None else str(s["ttfa_ms"]), "X-VS-RTF": "" if s.get("rtf") is None else str(s["rtf"]),
               "X-VS-Engine": str(s.get("engine") or ""), "X-VS-Transport": str(s.get("transport") or "")}
    return Response(vs.pcm_to_wav(r["pcm"], r["rate"]), media_type="audio/wav", headers=headers)


@app.post("/api/voicestudio/transcribe")
async def voicestudio_transcribe(request: Request, sr: int = MIC_RATE, model: str = "", language: str = "en", prompt: str = ""):
    """Transcribe a WAV, or raw PCM16 mono at `sr`, with VoiceStudio's active ASR engine."""
    body = await request.body()
    if not body:
        return JSONResponse({"error": "empty body"}, status_code=400)
    wav = body if body[:4] == b"RIFF" else to_wav(body, sr)
    t0 = time.perf_counter()
    try:
        text = await vs.transcribe_wav(wav, model=model, language=language, prompt=prompt)
    except Exception as e:
        return JSONResponse({"error": vs.explain(e)}, status_code=502)
    return {"text": text, "latency_ms": round((time.perf_counter() - t0) * 1000, 1), "audio_s": round(vs.wav_duration(wav), 2)}


class SelfTestRequest(SpeakRequest):
    text: str = "The quick brown fox jumps over the lazy dog. This voice is running locally."
    language: str = "en"


@app.post("/api/voicestudio/selftest")
async def voicestudio_selftest(req: SelfTestRequest):
    """text -> VoiceStudio TTS -> VoiceStudio ASR -> text: proves both directions and measures them the way the agent would."""
    t0 = time.perf_counter()
    try:
        r = await _speak(req)
        wav16 = to_wav(resample(r["pcm"], r["rate"], MIC_RATE), MIC_RATE)  # what the agent's STT would actually receive
        t1 = time.perf_counter()
        heard = await vs.transcribe_wav(wav16, language=req.language)
        stt_ms = (time.perf_counter() - t1) * 1000
    except Exception as e:
        return JSONResponse({"ok": False, "error": vs.explain(e)}, status_code=502)
    w = vs.wer(req.text, heard)
    s = r["server"]
    return {
        "ok": True, "reference": req.text, "heard": heard, "wer": round(w, 3), "match": w <= 0.15,
        "tts": {"ttfb_ms": round(r["ttfb_ms"], 1), "render_ms": round(r["total_ms"], 1), "audio_ms": round(r["audio_ms"]), "sample_rate": r["rate"],
                "server_ttfa_ms": s.get("ttfa_ms"), "rtf": s.get("rtf"), "engine": s.get("engine"), "transport": s.get("transport")},
        "stt": {"latency_ms": round(stt_ms, 1)},
        "total_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


# --------------------------------------------------------------------------- #
# Read-only source viewer (the Code page shows the course-faithful LiveKit agent)
# --------------------------------------------------------------------------- #
_SOURCES = {"livekit_agent": ROOT / "livekit_agent" / "agent.py", "pipeline": ROOT / "backend" / "voicelab" / "session.py"}


@app.get("/api/source/{name}")
def source(name: str):
    path = _SOURCES.get(name)
    if not path or not path.exists():
        return JSONResponse({"error": "unknown source"}, status_code=404)
    return {"name": name, "text": path.read_text()}


# --------------------------------------------------------------------------- #
# LiveKit
# --------------------------------------------------------------------------- #
@app.get("/api/livekit/token")
def livekit_token(room: str = "voicelab-demo", identity: str = ""):
    if not (settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret):
        return JSONResponse({"error": "Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env"}, status_code=400)
    from livekit import api

    ident = identity or f"web-{int(time.time()) % 100000}"
    tok = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(ident)
        .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True, can_publish_data=True))
        .to_jwt()
    )
    return {"token": tok, "url": settings.livekit_url, "room": room, "identity": ident}


# --------------------------------------------------------------------------- #
# Live session WebSocket
# --------------------------------------------------------------------------- #
@app.websocket("/ws/session")
async def ws_session(ws: WebSocket):
    await ws.accept()
    session: VoiceSession | RealtimeSession | None = None
    pump: asyncio.Task | None = None
    scenario: asyncio.Task | None = None
    lock = asyncio.Lock()

    async def send_json(obj):
        async with lock:
            await ws.send_text(json.dumps(obj))

    async def run_pump(s):
        while True:
            item = await s.bus.get()
            if item is None:
                return
            async with lock:
                if isinstance(item, (bytes, bytearray)):
                    await ws.send_bytes(bytes(item))
                else:
                    await ws.send_text(json.dumps(item))

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if session:
                    session.feed_audio(msg["bytes"])
                continue
            if not msg.get("text"):
                continue
            data = json.loads(msg["text"])
            typ = data.get("type")
            if typ == "start":
                if session:
                    await session.close()
                    if pump:
                        pump.cancel()
                try:
                    cfg = SessionConfig.model_validate(data.get("config", {}))
                except Exception as e:
                    await send_json({"type": "error", "where": "config", "message": str(e)[:400], "t": 0})
                    continue
                session = RealtimeSession(cfg) if cfg.architecture == "realtime" else VoiceSession(cfg)
                pump = asyncio.create_task(run_pump(session))
                asyncio.create_task(session.start(greet=bool(data.get("greet", True))))
            elif typ == "config" and session:
                with contextlib.suppress(Exception):
                    await session.reconfigure(SessionConfig.model_validate(data["config"]))
            elif typ == "text" and session:
                asyncio.create_task(session.on_text(data.get("text", "")))
            elif typ == "playback" and session:
                session.on_playback(int(data["response_id"]), float(data["played_ms"]))
            elif typ == "playout_done" and session:
                session.on_playout_done(int(data["response_id"]))
            elif typ == "flushed" and session:
                session.on_flushed(int(data["response_id"]), float(data["played_ms"]))
            elif typ == "ping":
                await send_json({"type": "pong", "ts": data.get("ts")})
            elif typ == "scenario" and isinstance(session, VoiceSession):
                if scenario and not scenario.done():
                    scenario.cancel()
                scenario = asyncio.create_task(_scenario(session, data["id"], data.get("voice", "Daniel")))
            elif typ == "scenario_stop" and scenario:
                scenario.cancel()
            elif typ == "stop":
                break
    except Exception:
        pass
    finally:
        if scenario:
            scenario.cancel()
        if session:
            await session.close()
        if pump:
            pump.cancel()
        with contextlib.suppress(Exception):
            await ws.close()


async def _scenario(session: VoiceSession, sid: str, voice: str) -> None:
    try:
        await run_scenario(session, sid, voice)
    except asyncio.CancelledError:
        session.bus.emit("scenario.done", id=sid, cancelled=True)
    except Exception as e:
        session.bus.emit("error", where="scenario", message=f"{type(e).__name__}: {e}"[:300])


# --------------------------------------------------------------------------- #
# Static dashboard
# --------------------------------------------------------------------------- #
DIST = ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="dashboard")
