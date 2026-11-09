"""VoiceStudio integration – the thin client VoiceLab uses to talk to a local VoiceStudio.

VoiceStudio (https://github.com/debpalash/VoiceStudio, AGPL-3.0) is a local, ElevenLabs-style voice
studio: cloning, voice design, dubbing, dictation, transcription. Its backend (default
http://127.0.0.1:3900) exposes

    GET  /.well-known/voicestudio-speech   capabilities + version
    GET  /health                           liveness
    GET  /v1/models, /v1/audio/voices      engines and voice profiles
    POST /v1/audio/transcriptions          OpenAI-compatible STT (multipart)
    POST /v1/audio/speech                  OpenAI-compatible TTS (whole clip, `pcm` = 24 kHz s16le mono)
    WS   /ws/tts                           streaming TTS: JSON request -> binary PCM16 chunks -> `done` + ttfa_ms

VoiceLab only ever speaks to it over HTTP/WebSocket. No VoiceStudio code is imported, vendored or
linked, so the two projects stay separate programs (and licences).
"""
from __future__ import annotations

import io
import re
import threading
import time
import wave
from typing import Any

import httpx

from .audio import MIC_RATE, to_wav
from .config import settings

TTS_SAMPLE_RATE = 24_000  # what /ws/tts and `response_format=pcm` produce
START_HINT = "Start VoiceStudio with `make studio-up` (first time: `make studio-install`)."


class VoiceStudioError(RuntimeError):
    """A readable failure talking to VoiceStudio (not running, auth, model missing…)."""


# --------------------------------------------------------------------------------------------
# URLs / auth
# --------------------------------------------------------------------------------------------
def base_url() -> str:
    return settings.voicestudio_url


def ws_url(path: str) -> str:
    u = base_url()
    u = "wss://" + u[len("https://"):] if u.startswith("https://") else "ws://" + u.split("://", 1)[-1]
    return u + path


def auth_headers() -> dict[str, str]:
    key = settings.voicestudio_key
    return {"Authorization": f"Bearer {key}"} if key else {}


def _client(timeout: float = 30.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url(), headers=auth_headers(), timeout=timeout)


def explain(exc: Exception) -> str:
    """Turn a transport/HTTP failure into advice a person can act on."""
    if isinstance(exc, VoiceStudioError):
        return str(exc)
    if isinstance(exc, (httpx.ConnectError, ConnectionRefusedError, OSError)):
        return f"VoiceStudio is not reachable at {base_url()}. {START_HINT}"
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        try:
            body = exc.response.json()
        except Exception:
            body = None
        err = body.get("error") if isinstance(body, dict) else None
        detail = body.get("detail") if isinstance(body, dict) else None
        # VoiceStudio refuses to run a model until its licence was accepted – a 403 that has nothing to do with the API key.
        if isinstance(detail, dict) and detail.get("code") == "model_licence_required":
            repos = ", ".join(m.get("repo_id", "?") for m in detail.get("models", [])) or "the model"
            return (f"VoiceStudio will not use {repos} until its licence is accepted. Open VoiceStudio's Model Catalogue, read the "
                    "notice and accept it – or run `make studio-licences` – then retry.")
        msg = (err.get("message") if isinstance(err, dict) else err) or (detail if isinstance(detail, str) else None)
        if code == 401 or (code == 403 and not msg):
            return "VoiceStudio rejected the request (set VOICESTUDIO_API_KEY for a remote server)."
        if not msg:
            try:
                msg = exc.response.text[:200]
            except httpx.ResponseNotRead:
                msg = exc.response.reason_phrase
        return f"VoiceStudio returned HTTP {code}: {msg}"
    return f"{type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------------------------
# Discovery (sync – called from FastAPI's thread-pooled endpoints, like the Ollama probe)
# --------------------------------------------------------------------------------------------
_cache: dict[str, Any] = {"at": 0.0, "key": "", "snap": None}


def probe(*, force: bool = False, timeout: float = 1.5, ttl: float = 3.0) -> dict[str, Any]:
    """Everything the dashboard needs to know about the local VoiceStudio, in one call. Never raises."""
    key = base_url() + "|" + settings.voicestudio_key
    if not force and _cache["snap"] is not None and _cache["key"] == key and time.monotonic() - _cache["at"] < ttl:
        return _cache["snap"]

    snap: dict[str, Any] = {
        "reachable": False, "url": base_url(), "version": None, "device": None, "error": "", "hint": START_HINT, "auth_required": False,
        "features": {}, "asr_engine": None, "tts_engines": [], "voices": [], "models": [], "probe_ms": None, "engines_loading": False,
    }
    t0 = time.perf_counter()
    try:
        with httpx.Client(base_url=base_url(), headers=auth_headers(), timeout=timeout) as c:
            caps = c.get("/.well-known/voicestudio-speech")
            if caps.status_code in (401, 403):
                snap.update(reachable=True, auth_required=True, error="VoiceStudio requires an API key (VOICESTUDIO_API_KEY).")
                raise _Stop
            caps.raise_for_status()
            body = caps.json()
            snap.update(reachable=True, version=body.get("service_version"), features=body.get("features", {}), hint="")
            try:  # /health is instant and says which accelerator is in use ("mps", "cuda", "cpu")
                h = c.get("/health").json()
                snap.update(device=h.get("device"), version=h.get("version") or snap["version"])
            except Exception:
                pass
            # The engine/voice listings import VoiceStudio's heavy engine modules on first use (a real first call took
            # ~55 s). Never let that read as "no engines": give up quickly, say they are loading, and warm them off-thread.
            try:
                models = c.get("/v1/models").json().get("data", [])
                snap["models"] = models
                stt = [m["id"] for m in models if m.get("voicestudio", {}).get("kind") == "stt" and not m["voicestudio"].get("alias_for_active_engine")]
                snap["asr_engine"] = stt[0] if stt else None
                v = c.get("/v1/audio/voices").json()
                snap["voices"] = v.get("voices", [])
                snap["tts_engines"] = [e for e in v.get("engines", []) if isinstance(e, dict)]
            except httpx.TimeoutException:
                snap["engines_loading"] = True
                _warm_listings()
            except Exception:
                pass
    except _Stop:
        pass
    except Exception as e:  # not running / refused / timeout
        snap["error"] = "" if isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout)) else explain(e)
    snap["probe_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    _cache.update(at=time.monotonic(), key=key, snap=snap)
    return snap


class _Stop(Exception):
    pass


_warming = threading.Event()


def _warm_listings() -> None:
    """Fetch the slow listings once in the background so the next probe finds them ready."""
    if _warming.is_set():
        return
    _warming.set()

    def run() -> None:
        try:
            with httpx.Client(base_url=base_url(), headers=auth_headers(), timeout=180.0) as c:
                c.get("/v1/models")
                c.get("/v1/audio/voices")
        except Exception:
            pass
        finally:
            _cache["snap"] = None  # drop the partial snapshot
            _warming.clear()

    threading.Thread(target=run, daemon=True, name="voicestudio-warm").start()


def tts_engine_ids(snap: dict[str, Any] | None = None) -> list[str]:
    snap = snap or probe()
    return [e["id"] for e in snap["tts_engines"] if e.get("available") and e.get("id")]


def voice_options(snap: dict[str, Any] | None = None) -> list[dict[str, str]]:
    """Voices a user can pick: their own profiles first, then the generic default."""
    snap = snap or probe()
    out = [{"id": "", "label": "Default (engine voice)"}]
    for v in snap["voices"]:
        if v.get("type") == "profile":
            out.append({"id": v["voice_id"], "label": f'{v.get("name") or v["voice_id"]}' + (f' · {v["language"]}' if v.get("language") else "")})
    return out


# --------------------------------------------------------------------------------------------
# Speech-to-text (OpenAI-compatible)
# --------------------------------------------------------------------------------------------
async def transcribe_wav(wav: bytes, *, model: str = "", language: str = "", prompt: str = "", client: httpx.AsyncClient | None = None) -> str:
    own = client is None
    c = client or _client(60.0)
    try:
        data = {"model": model or "whisper-1", "response_format": "json"}
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt
        r = await c.post("/v1/audio/transcriptions", files={"file": ("audio.wav", io.BytesIO(wav), "audio/wav")}, data=data)
        r.raise_for_status()
        return (r.json().get("text") or "").strip()
    finally:
        if own:
            await c.aclose()


def warm_asr(model: str = "", language: str = "en") -> float:
    """Run one dummy transcription so VoiceStudio loads its ASR engine *before* the first caller speaks."""
    import numpy as np

    silence = to_wav(np.zeros(MIC_RATE, dtype="<i2").tobytes(), MIC_RATE)
    t0 = time.perf_counter()
    try:
        with httpx.Client(base_url=base_url(), headers=auth_headers(), timeout=180.0) as c:
            data = {"model": model or "whisper-1", "response_format": "json", **({"language": language} if language else {})}
            c.post("/v1/audio/transcriptions", files={"file": ("w.wav", silence, "audio/wav")}, data=data).raise_for_status()
    except Exception as e:
        raise VoiceStudioError(explain(e)) from e
    return (time.perf_counter() - t0) * 1000


# --------------------------------------------------------------------------------------------
# Text-to-speech helpers
# --------------------------------------------------------------------------------------------
def warm_tts(model: str = "", voice: str = "") -> float:
    """Render a tiny clip so the engine is loaded (the first synthesis after start-up is slow)."""
    t0 = time.perf_counter()
    body: dict[str, Any] = {"model": model or "omnivoice", "input": "Warm up.", "response_format": "pcm"}
    if voice:
        body["voice"] = voice
    try:
        with httpx.Client(base_url=base_url(), headers=auth_headers(), timeout=300.0) as c:
            c.post("/v1/audio/speech", json=body).raise_for_status()
    except Exception as e:
        raise VoiceStudioError(explain(e)) from e
    return (time.perf_counter() - t0) * 1000


def pcm_to_wav(pcm: bytes, sample_rate: int = TTS_SAMPLE_RATE) -> bytes:
    return to_wav(pcm, sample_rate)


# --------------------------------------------------------------------------------------------
# Round-trip self-test: text -> VoiceStudio TTS -> VoiceStudio ASR -> text
# --------------------------------------------------------------------------------------------
def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate (0 = identical). Plain Levenshtein over normalised words."""
    r, h = _words(reference), _words(hypothesis)
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i]
        for j, hw in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw)))
        prev = cur
    return prev[-1] / len(r)


def wav_duration(wav: bytes) -> float:
    with wave.open(io.BytesIO(wav), "rb") as w:
        return w.getnframes() / w.getframerate()
