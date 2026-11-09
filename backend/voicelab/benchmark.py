"""A/B latency benchmark (Lesson 5: "Optimising LLM latency").

Reproduces the course experiment: run the same prompts against two configurations and compare
Time-To-First-Token (and, one hop later, TTS Time-To-First-Byte). Results stream back as NDJSON so
the dashboard can draw the distributions while the runs are still going.
"""
from __future__ import annotations

import asyncio
import statistics
import time
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel, Field

from .llm import create_llm
from .personas import system_prompt
from .session import SentenceChunker
from .tts import create_tts

PROMPTS = [
    "Hi, I'd like to book a table for four tonight.",
    "What kind of pasta do you recommend?",
    "Do you have anything gluten free on the menu?",
    "Can you tell me what time you close?",
    "I need to change my reservation to tomorrow.",
]


class BenchConfig(BaseModel):
    label: str
    llm_provider: str = "mock"
    llm_model: str = ""
    mock_profile: str = "gpt-4o-mini"
    tts_provider: str = "mock"
    voice_id: str = ""


class BenchRequest(BaseModel):
    configs: list[BenchConfig]
    runs: int = Field(5, ge=1, le=20)
    persona: str = "restaurant"
    measure_tts: bool = True


def _pct(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    k = (len(s) - 1) * q
    f, c = int(k), min(int(k) + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


async def run_benchmark(req: BenchRequest) -> AsyncIterator[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    results: dict[str, list[dict]] = {c.label: [] for c in req.configs}
    for cfg in req.configs:
        yield {"type": "config_start", "label": cfg.label}
        try:
            llm = await loop.run_in_executor(None, create_llm, cfg.llm_provider, cfg.llm_model, cfg.mock_profile, req.persona)
            tts = create_tts(cfg.tts_provider)
        except Exception as e:
            yield {"type": "error", "label": cfg.label, "message": str(e)}
            continue
        for run in range(req.runs + 1):  # run 0 is a warm-up (cold TLS / model load) and is reported but excluded
            prompt = PROMPTS[run % len(PROMPTS)]
            msgs = [{"role": "system", "content": system_prompt(req.persona)}, {"role": "user", "content": prompt}]
            t0 = time.perf_counter()
            ttft = first_sentence = None
            n_tok, text = 0, ""
            chunker = SentenceChunker("sentence", 18)
            first_sent_text = None
            try:
                async for ev in llm.stream(msgs, None, temperature=0.4, max_tokens=120):
                    if ev.kind == "text":
                        now = time.perf_counter()
                        if ttft is None:
                            ttft = (now - t0) * 1000
                        n_tok += 1
                        text += ev.text
                        if first_sentence is None:
                            got = chunker.feed(ev.text)
                            if got:
                                first_sentence = (now - t0) * 1000
                                first_sent_text = got[0]
                end = time.perf_counter()
            except Exception as e:
                yield {"type": "error", "label": cfg.label, "message": f"{type(e).__name__}: {e}"[:200]}
                break
            if first_sent_text is None:
                first_sent_text = text.strip() or "Okay."
                first_sentence = first_sentence or (end - t0) * 1000
            gen_s = max(0.001, (end - t0) - (ttft or 0) / 1000)
            tts_ttfb = None
            if req.measure_tts:
                t1 = time.perf_counter()
                try:
                    async for _ in tts.synthesize(first_sent_text, voice_id=cfg.voice_id, speed=1.0):
                        tts_ttfb = (time.perf_counter() - t1) * 1000
                        break
                except Exception as e:
                    yield {"type": "error", "label": cfg.label, "message": f"TTS {type(e).__name__}: {e}"[:200]}
            row = {
                "type": "run", "label": cfg.label, "run": run, "warmup": run == 0, "prompt": prompt,
                "ttft_ms": round(ttft or 0, 1), "tokens_per_second": round(n_tok / gen_s, 1),
                "first_sentence_ms": round(first_sentence or 0, 1), "tts_ttfb_ms": None if tts_ttfb is None else round(tts_ttfb, 1),
                "model": llm.model,
            }
            row["time_to_first_audio_ms"] = round(row["first_sentence_ms"] + (tts_ttfb or 0), 1)
            if run > 0:
                results[cfg.label].append(row)
            yield row
        await llm.aclose()

    summary = {}
    for label, rows in results.items():
        if not rows:
            continue
        ttfts = [r["ttft_ms"] for r in rows]
        summary[label] = {
            "n": len(rows),
            "ttft_mean_ms": round(statistics.fmean(ttfts), 1),
            "ttft_p50_ms": round(_pct(ttfts, 0.5), 1),
            "ttft_p95_ms": round(_pct(ttfts, 0.95), 1),
            "tps_mean": round(statistics.fmean(r["tokens_per_second"] for r in rows), 1),
            "first_audio_mean_ms": round(statistics.fmean(r["time_to_first_audio_ms"] for r in rows), 1),
            "tts_ttfb_mean_ms": round(statistics.fmean(r["tts_ttfb_ms"] or 0 for r in rows), 1),
        }
    yield {"type": "summary", "summary": summary}
