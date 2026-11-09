"""A stand-in for VoiceStudio's local API, built from its documented protocol (docs/speech-platform.md and the
OpenAI-compatible audio routes). It lets the integration be tested without installing VoiceStudio, and it records
everything it receives so tests can assert on the wire format.

    GET  /.well-known/voicestudio-speech      GET /health      GET /v1/models      GET /v1/audio/voices
    POST /v1/audio/transcriptions (multipart)     POST /v1/audio/speech (pcm)     WS /ws/tts
"""
from __future__ import annotations

import asyncio
import io
import json
import threading
import time
import wave

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

SR = 24_000
MS_PER_WORD = 150


def tone(ms: float, f0: float = 220.0) -> bytes:
    n = int(SR * ms / 1000)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * f0 * t) * 9000).astype("<i2").tobytes()


class FakeVoiceStudio:
    def __init__(self, *, api_key: str = "", ws: bool = True) -> None:
        self.api_key = api_key
        self.transcript = "hello from voice studio"
        self.first_listing_delay = 0.0
        self.ws_connections = 0
        self.ws_requests: list[dict] = []
        self.speech_requests: list[dict] = []
        self.stt_requests: list[dict] = []
        self.app = self._build(ws)
        self._server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=0, log_level="error", ws="websockets-sansio"))
        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self.url = ""

    # ------------------------------------------------------------------------------------------
    def start(self) -> "FakeVoiceStudio":
        self._thread.start()
        deadline = time.time() + 10
        while time.time() < deadline and not (self._server.started and self._server.servers):
            time.sleep(0.02)
        port = self._server.servers[0].sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        return self

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=5)

    # ------------------------------------------------------------------------------------------
    def _build(self, ws: bool) -> FastAPI:
        app = FastAPI()
        me = self

        def authed(headers) -> bool:
            return not me.api_key or headers.get("authorization") == f"Bearer {me.api_key}"

        @app.middleware("http")
        async def guard(request: Request, call_next):
            if not authed(request.headers):
                return JSONResponse({"error": {"message": "invalid api key"}}, status_code=401)
            return await call_next(request)

        @app.get("/health")
        async def health():
            return {"status": "ok", "device": "mps", "version": "0.5.7-fake"}

        @app.get("/.well-known/voicestudio-speech")
        async def caps():
            return {"schema": "voicestudio.speech-capabilities", "protocol": "voicestudio.speech.v1", "service": "VoiceStudio",
                    "service_version": "0.5.7-fake", "features": {"batch_transcription": True, "streaming_transcription": True}}

        @app.get("/v1/models")
        async def models():
            if me.first_listing_delay:  # a real VoiceStudio imports its engines on the first call (~55 s)
                d, me.first_listing_delay = me.first_listing_delay, 0.0
                await asyncio.sleep(d)
            def m(i, kind, alias):
                return {"id": i, "object": "model", "owned_by": "voicestudio", "voicestudio": {"kind": kind, "alias_for_active_engine": alias}}

            return {"object": "list", "data": [m("tts-1", "tts", True), m("whisper-1", "stt", True), m("omnivoice", "tts", False),
                                               m("kittentts", "tts", False), m("mlx-whisper", "stt", False)]}

        @app.get("/v1/audio/voices")
        async def voices():
            return {"voices": [{"voice_id": "alloy", "id": "alloy", "name": "Alloy", "type": "openai_alias"},
                               {"voice_id": "voice_ada", "id": "voice_ada", "name": "Ada", "type": "profile", "language": "en"},
                               {"voice_id": "voice_bo", "id": "voice_bo", "name": "Bo", "type": "profile", "language": "de"}],
                    "engines": [{"id": "omnivoice", "available": True}, {"id": "kittentts", "available": True}, {"id": "voxcpm2", "available": False}]}

        @app.post("/v1/audio/transcriptions")
        async def transcribe(file: UploadFile = File(...), model: str = Form("whisper-1"), language: str = Form(None),
                             prompt: str = Form(None), response_format: str = Form("json")):
            data = await file.read()
            with wave.open(io.BytesIO(data), "rb") as w:
                secs = w.getnframes() / w.getframerate()
                rate = w.getframerate()
            me.stt_requests.append({"model": model, "language": language, "prompt": prompt, "seconds": secs, "rate": rate, "bytes": len(data)})
            text = me.transcript(secs) if callable(me.transcript) else me.transcript
            return {"text": text}

        @app.post("/v1/audio/speech")
        async def speech(request: Request):
            body = await request.json()
            me.speech_requests.append(body)
            dur = max(300, len(body["input"].split()) * MS_PER_WORD)
            pcm = tone(dur)

            async def gen():
                for i in range(0, len(pcm), 4800):
                    yield pcm[i:i + 4800]
                    await asyncio.sleep(0.005)

            return StreamingResponse(gen(), media_type="audio/pcm")

        if ws:
            @app.websocket("/ws/tts")
            async def ws_tts(sock: WebSocket):
                if not authed(sock.headers):
                    await sock.close(code=1008)
                    return
                await sock.accept()
                me.ws_connections += 1
                try:
                    while True:
                        req = await sock.receive_json()
                        me.ws_requests.append(req)
                        text = req.get("text", "")
                        if text == "FAIL":
                            await sock.send_json({"type": "error", "detail": "engine exploded"})
                            continue
                        t0 = time.perf_counter()
                        dur = max(300, len(text.split()) * MS_PER_WORD)
                        pcm = tone(dur)
                        await sock.send_json({"type": "start", "sample_rate": SR, "channels": 1, "format": "pcm16", "engine": req.get("engine") or "omnivoice"})
                        first = None
                        for i in range(0, len(pcm), 4800):
                            await sock.send_bytes(pcm[i:i + 4800])
                            first = first or time.perf_counter()
                            await asyncio.sleep(0.01)
                        await sock.send_json({"type": "done", "duration_s": dur / 1000, "gen_time_s": round(time.perf_counter() - t0, 3),
                                              "ttfa_ms": round((first - t0) * 1000, 1), "rtf": 0.12, "samples": len(pcm) // 2,
                                              "sample_rate": SR, "engine": req.get("engine") or "omnivoice"})
                except WebSocketDisconnect:
                    pass

        return app
