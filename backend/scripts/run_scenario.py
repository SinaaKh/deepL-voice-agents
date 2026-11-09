"""Headless runner: drive a scenario through the real pipeline and print the key events.

    python scripts/run_scenario.py book_table --stt mock --llm mock --tts mock
    python scripts/run_scenario.py barge_in --stt whisper-local --llm ollama --tts piper
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # make `voicelab` importable from backend/scripts

from voicelab.config import SessionConfig
from voicelab.scenarios import run_scenario
from voicelab.session import VoiceSession

SHOW = {
    "session.ready", "provider.loading", "provider.ready", "vad.speech_start", "vad.speech_end", "turn.start", "turn.timer", "turn.end",
    "turn.discarded", "turn.cut_off", "stt.final", "transcript", "llm.request", "llm.first_token", "llm.tool_call", "llm.tool_result",
    "llm.done", "chunker.first_sentence", "tts.first_byte", "response.audio_start", "agent_state", "interrupt.start", "interrupt",
    "interrupt.suppressed", "guardrail.block", "error", "scenario.step", "scenario.done", "flush", "response.audio_end",
}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario")
    ap.add_argument("--stt", default="mock")
    ap.add_argument("--llm", default="mock")
    ap.add_argument("--tts", default="mock")
    ap.add_argument("--model", default="")
    ap.add_argument("--turn", default="semantic")
    ap.add_argument("--profile", default="gpt-4o-mini")
    ap.add_argument("--persona", default="")
    ap.add_argument("--raw", action="store_true")
    a = ap.parse_args()

    from voicelab.scenarios import SCENARIOS

    base = {"persona": a.persona or SCENARIOS[a.scenario]["persona"], "stt": {"provider": a.stt},
            "llm": {"provider": a.llm, "model": a.model, "mock_profile": a.profile},
            "tts": {"provider": a.tts}, "turn": {"mode": a.turn}}
    for k, v in SCENARIOS[a.scenario]["suggest"].items():
        base[k] = {**base.get(k, {}), **v} if isinstance(v, dict) else v
    cfg = SessionConfig.model_validate(base)
    s = VoiceSession(cfg)

    played = {"ms": 0.0, "t0": None}

    async def consume() -> None:
        sr = 22050
        while True:
            item = await s.bus.get()
            if item is None:
                return
            if isinstance(item, (bytes, bytearray)):
                if played["t0"] is None:
                    played["t0"] = time.perf_counter()
                played["ms"] += len(item) / 2 / sr * 1000
                continue
            if item["type"] == "response.audio_start":
                sr = item["sample_rate"]
                played["ms"], played["t0"] = 0.0, None
                rid = item["response_id"]
                asyncio.create_task(emulate_client(rid))
            if item["type"] == "flush":
                p = (time.perf_counter() - played["t0"]) * 1000 if played["t0"] else 0
                s.on_flushed(item["response_id"], min(p, played["ms"]))
            if a.raw or item["type"] in SHOW:
                d = {k: v for k, v in item.items() if k not in ("type", "t", "config")}
                print(f"{item['t']:9.0f}ms  {item['type']:<22} {json.dumps(d, ensure_ascii=False)[:230]}")
            if item["type"] == "turn.metrics":
                print("   └─ METRICS", json.dumps({k: item[k] for k in ("response_latency_ms", "breakdown", "llm", "stt", "eou", "tts")}, ensure_ascii=False))

    async def emulate_client(rid: int) -> None:
        """What the browser does: report playback position, then playout_done."""
        t0 = time.perf_counter()
        while s._resp and s._resp.id == rid and not s._closed:
            await asyncio.sleep(0.1)
            pos = min((time.perf_counter() - t0) * 1000, played["ms"])
            s.on_playback(rid, pos)
            r = s._resp
            if r and r.done and pos >= r.audio_ms_sent - 5:
                s.on_playout_done(rid)
                return

    cons = asyncio.create_task(consume())
    await s.start(greet=True)
    await run_scenario(s, a.scenario)
    await asyncio.sleep(0.5)
    print("\nHISTORY:")
    for m in s.messages[1:]:
        print(" ", m["role"], "→", (m.get("content") or "")[:200], "[interrupted]" if m.get("_interrupted") else "", "tool_calls" if m.get("tool_calls") else "")
    await s.close()
    cons.cancel()


asyncio.run(main())
