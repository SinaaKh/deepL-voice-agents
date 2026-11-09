"""The speech-to-speech bridge, driven by a fake socket with the documented OpenAI Realtime server events.

These verify our event *mapping* (and the barge-in `conversation.item.truncate`), not the live service –
no API key is available in the test environment.
"""
import asyncio
import base64
import json

from voicelab.config import SessionConfig
from voicelab.realtime import RealtimeSession


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def close(self):
        pass


def drain(s):
    out, audio = [], 0
    while s.bus._q:
        x = s.bus._q.popleft()
        if isinstance(x, (bytes, bytearray)):
            audio += len(x)
        else:
            out.append(x)
    return out, audio


async def test_turn_maps_to_common_events_and_measures_speech_to_audio_latency():
    s = RealtimeSession(SessionConfig(architecture="realtime"))
    s._ws = FakeWS()
    await s._handle({"type": "input_audio_buffer.speech_started"})
    await s._handle({"type": "input_audio_buffer.speech_stopped"})
    await s._handle({"type": "conversation.item.input_audio_transcription.completed", "transcript": "Hi there"})
    await s._handle({"type": "response.created"})
    await asyncio.sleep(0.05)
    pcm = (b"\x01\x00" * 2400)  # 100 ms @ 24 kHz
    await s._handle({"type": "response.output_audio.delta", "item_id": "item_1", "delta": base64.b64encode(pcm).decode()})
    await s._handle({"type": "response.output_audio_transcript.delta", "delta": "Hello!"})
    await s._handle({"type": "response.output_audio.done"})
    await s._handle({"type": "response.done", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}})
    evs, audio = drain(s)
    types = [e["type"] for e in evs]
    assert audio == len(pcm)
    assert {"user_state", "stt.final", "response.audio_start", "agent_state", "turn.metrics", "response.audio_end"} <= set(types)
    m = next(e for e in evs if e["type"] == "turn.metrics")
    assert m["user_text"] == "Hi there" and m["agent_text"] == "Hello!"
    assert m["response_latency_ms"] is not None and m["response_latency_ms"] >= 40
    assert m["breakdown"][0]["stage"].startswith("speech_to_speech")  # opaque: one undivided block


async def test_barge_in_tells_the_server_how_much_audio_was_actually_heard():
    s = RealtimeSession(SessionConfig(architecture="realtime"))
    ws = s._ws = FakeWS()
    await s._handle({"type": "response.created"})
    await s._handle({"type": "response.audio.delta", "item_id": "item_9", "delta": base64.b64encode(b"\x00\x00" * 4800).decode()})  # beta name also works
    assert s.agent_state == "speaking"
    s.on_playback(1, 80)

    async def client():  # the browser answers the flush request
        while not any(e["type"] == "flush" for e in s.bus.history):
            await asyncio.sleep(0.01)
        s.on_flushed(1, 120)

    await asyncio.gather(s._handle({"type": "input_audio_buffer.speech_started"}), client())
    trunc = [m for m in ws.sent if m["type"] == "conversation.item.truncate"]
    assert trunc and trunc[0]["item_id"] == "item_9" and trunc[0]["audio_end_ms"] == 120
    assert s.agent_state == "idle"


async def test_missing_key_is_reported_not_raised(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    s = RealtimeSession(SessionConfig(architecture="realtime"))
    await s.start()
    evs, _ = drain(s)
    assert any(e["type"] == "error" and "OPENAI_API_KEY" in e["message"] for e in evs)
