"""
Keyless demo for the dashboard's LiveKit page.

Joins a room as a pretend agent and publishes metrics / transcripts over the RTCDataChannel using
exactly the schema `agent.py` uses – so you can watch the LiveKit panel work without any
OpenAI / ElevenLabs keys. (It does NOT do speech; for that run `agent.py`.)

    python livekit_agent/demo_publisher.py --room voicelab-demo
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from pathlib import Path

from dotenv import load_dotenv
from livekit import api, rtc

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

SCRIPT = [
    ("Hi, I'd like a table for four at seven.", "Happy to help. Let me check that for you."),
    ("The name is Johnson.", "Perfect, I'll book that now. You're all set, your code is V L 4 2 1 7."),
]


async def main(room_name: str, turns: int) -> None:
    url, key, secret = os.getenv("LIVEKIT_URL"), os.getenv("LIVEKIT_API_KEY"), os.getenv("LIVEKIT_API_SECRET")
    if not (url and key and secret):
        sys.exit("Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env first.")
    token = (
        api.AccessToken(key, secret).with_identity("agent-demo").with_name("Demo agent (no speech)")
        .with_grants(api.VideoGrants(room_join=True, room=room_name, can_publish_data=True)).to_jwt()
    )
    room = rtc.Room()
    await room.connect(url, token)
    print(f"joined {room_name} as agent-demo – open the LiveKit page, join the same room, and watch")

    async def send(kind: str, **payload) -> None:
        await room.local_participant.publish_data(json.dumps({"kind": kind, **payload}).encode(), reliable=True, topic="voicelab")

    async def state(s: str) -> None:
        await room.local_participant.set_attributes({"lk.agent.state": s})

    await state("listening")
    for n in range(turns):
        user, agent = SCRIPT[n % len(SCRIPT)]
        sid = f"SP_demo{n:03d}"
        await asyncio.sleep(3)
        await send("transcript", role="user", text=user[: len(user) // 2], final=False)
        await asyncio.sleep(0.6)
        await send("transcript", role="user", text=user, final=True)
        await send("stt", audio_duration=round(0.07 * len(user), 2), streamed=True, duration=0.0)
        await state("thinking")
        eou, ttft, ttfb = random.uniform(0.45, 0.7), random.uniform(0.35, 0.55), random.uniform(0.08, 0.2)
        await asyncio.sleep(eou)
        await send("eou", end_of_utterance_delay=round(eou, 3), transcription_delay=round(eou + 0.05, 3), speech_id=sid)
        await asyncio.sleep(ttft)
        await send("llm", ttft=round(ttft, 3), tokens_per_second=round(random.uniform(90, 140), 1), prompt_tokens=random.randint(220, 420),
                   completion_tokens=random.randint(18, 40), speech_id=sid)
        await asyncio.sleep(ttfb)
        await send("tts", ttfb=round(ttfb, 3), audio_duration=round(0.06 * len(agent), 2), streamed=True, duration=1.1, speech_id=sid)
        await state("speaking")
        await send("transcript", role="assistant", text=agent, final=True, interrupted=False)
        await asyncio.sleep(3.5)
        await state("listening")
    await asyncio.sleep(1)
    await room.disconnect()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--room", default="voicelab-demo")
    ap.add_argument("--turns", type=int, default=3)
    a = ap.parse_args()
    asyncio.run(main(a.room, a.turns))
