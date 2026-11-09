"""Virtual-time simulation of the turn detector (powers the Turn-Taking Lab).

Runs the *same* `TurnPolicy` + semantic detector the live pipeline uses, but against a scripted
timeline so you can ask "what would have happened if the silence timer were 400 ms?" instantly.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from . import HeuristicSemanticDetector, TurnPolicy


class SimSegment(BaseModel):
    kind: Literal["speech", "pause"]
    text: str = ""
    ms: int = 500
    # For pauses: does the user *intend* to keep talking afterwards? (ground truth for scoring)
    intent: Literal["continue", "end"] = "continue"


class SimRequest(BaseModel):
    segments: list[SimSegment]
    mode: Literal["vad", "semantic"] = "semantic"
    silence_timer_ms: int = 500
    max_delay_ms: int = 2500
    threshold: float = 0.5
    vad_min_silence_ms: int = 160
    agent_last: str = ""  # the agent's previous utterance (helps detect "answers")


_DET = HeuristicSemanticDetector()


def simulate(req: SimRequest) -> dict:
    policy = TurnPolicy(req.mode, req.silence_timer_ms, req.max_delay_ms, req.threshold)
    history = [{"role": "assistant", "content": req.agent_last}] if req.agent_last else []

    t = 0.0
    transcript = ""
    spans: list[dict] = []
    pauses: list[dict] = []
    fires: list[dict] = []
    segs = req.segments

    for i, seg in enumerate(segs):
        if seg.kind == "speech":
            spans.append({"start": t, "end": t + seg.ms, "text": seg.text})
            transcript = (transcript + " " + seg.text).strip()
            t += seg.ms
            continue

        t0, d = t, float(seg.ms)
        has_next_speech = any(s.kind == "speech" for s in segs[i + 1 :])
        verdict = _DET.explain(transcript, history)
        p = verdict.p_eot
        delay = policy.delay_ms(p if req.mode != "vad" else None)
        baseline = float(req.silence_timer_ms)
        fire_at = t0 + delay
        resume_at = t0 + d if has_next_speech else None

        # The VAD only reports "speech ended" after its own debounce; the timer is measured from
        # the last speech frame, so firing earlier than that debounce is impossible.
        fire_at = max(fire_at, t0 + req.vad_min_silence_ms)

        if resume_at is not None and resume_at < fire_at:
            outcome = "held"  # user resumed before the timer – turn continues
            saved = resume_at >= t0 + max(baseline, req.vad_min_silence_ms)  # VAD-only would have cut in
            extra = 0.0
            wait = resume_at - t0
        else:
            fired = fire_at
            if resume_at is not None:
                outcome = "cut_off"  # agent would start talking mid-thought
            else:
                outcome = "ended"
            saved = False
            extra = max(0.0, delay - baseline) if outcome == "ended" else 0.0
            wait = fired - t0
            fires.append({"t": fired, "outcome": outcome})
            if outcome == "cut_off":
                transcript = ""  # the remainder becomes a fresh (orphaned) turn
        pauses.append(
            {
                "index": i,
                "start": t0,
                "duration": d,
                "intent": seg.intent,
                "p_eot": round(p, 3),
                "reasons": verdict.reasons,
                "delay_ms": delay,
                "fire_at": fire_at if outcome != "held" else None,
                "outcome": outcome,
                "saved_by_semantic": bool(saved and req.mode != "vad" and delay > baseline),
                "extra_wait_ms": extra,
                "waited_ms": wait,
                "transcript": transcript,
            }
        )
        t += d

    cut_offs = sum(1 for p in pauses if p["outcome"] == "cut_off")
    saved_n = sum(1 for p in pauses if p["saved_by_semantic"])
    ended = [p for p in pauses if p["outcome"] == "ended"]
    return {
        "spans": spans,
        "pauses": pauses,
        "fires": fires,
        "total_ms": t,
        "summary": {
            "cut_offs": cut_offs,
            "saved_by_semantic": saved_n,
            "extra_wait_ms": sum(p["extra_wait_ms"] for p in pauses),
            "final_eou_delay_ms": ended[-1]["waited_ms"] if ended else None,
        },
    }


# --------------------------------------------------------------------------- #
# Trade-off sweep: silence timer vs (false cut-offs, added latency)
# --------------------------------------------------------------------------- #
def _w(text: str) -> SimSegment:
    return SimSegment(kind="speech", text=text, ms=max(300, int(len(text.split()) * 290)))


def _p(ms: int, intent: str = "continue") -> SimSegment:
    return SimSegment(kind="pause", ms=ms, intent=intent)  # type: ignore[arg-type]


DATASET: list[dict] = [
    {"name": "Booking, trailing preposition", "agent_last": "", "segments": [_w("I'd like to book a table for"), _p(900), _w("four people at seven"), _p(1500, "end")]},
    {"name": "Filler + hesitation", "agent_last": "", "segments": [_w("Hi um"), _p(700), _w("I was wondering if you have"), _p(800), _w("a table free tonight"), _p(1500, "end")]},
    {"name": "Phone number in chunks", "agent_last": "What's your phone number?", "segments": [_w("My phone number is five five five"), _p(650), _w("one two three four"), _p(1500, "end")]},
    {"name": "Complete question", "agent_last": "", "segments": [_w("Can you tell me what time you close today"), _p(1500, "end")]},
    {"name": "One-word answer", "agent_last": "Is that for tonight?", "segments": [_w("Yes"), _p(1500, "end")]},
    {"name": "Symptom list", "agent_last": "", "segments": [_w("I'm feeling dizzy and"), _p(1100), _w("I have had a headache since this morning"), _p(1500, "end")]},
    {"name": "Complete clause, more to say", "agent_last": "", "segments": [_w("I want to change my reservation"), _p(700), _w("to tomorrow evening"), _p(1500, "end")]},
    {"name": "Thinking out loud", "agent_last": "", "segments": [_w("Uh let me think"), _p(1300), _w("make it six thirty"), _p(1500, "end")]},
    {"name": "Name after prompt", "agent_last": "May I have a name for the booking?", "segments": [_w("The name is"), _p(1000), _w("Johnson"), _p(1500, "end")]},
    {"name": "Cancel because…", "agent_last": "", "segments": [_w("I need to cancel because"), _p(900), _w("something came up at work"), _p(1500, "end")]},
    {"name": "Order with hesitation", "agent_last": "", "segments": [_w("Could I get the"), _p(1200), _w("gluten free pasta"), _p(1500, "end")]},
    {"name": "Quick confirmation", "agent_last": "Shall I confirm that?", "segments": [_w("Okay sounds good"), _p(1500, "end")]},
]


def sweep(max_delay_ms: int = 2500, threshold: float = 0.5) -> dict:
    timers = list(range(200, 1501, 100))
    out: dict[str, list[dict]] = {"vad": [], "semantic": []}
    for mode in ("vad", "semantic"):
        for timer in timers:
            cuts = pauses_continue = 0
            end_delays: list[float] = []
            for item in DATASET:
                r = simulate(
                    SimRequest(
                        segments=item["segments"],
                        mode=mode,  # type: ignore[arg-type]
                        silence_timer_ms=timer,
                        max_delay_ms=max_delay_ms,
                        threshold=threshold,
                        agent_last=item["agent_last"],
                    )
                )
                for p in r["pauses"]:
                    if p["intent"] == "continue":
                        pauses_continue += 1
                        if p["outcome"] == "cut_off":
                            cuts += 1
                    elif p["outcome"] == "ended":
                        end_delays.append(p["waited_ms"])
            out[mode].append(
                {
                    "timer_ms": timer,
                    "cut_off_rate": cuts / max(1, pauses_continue),
                    "cut_offs": cuts,
                    "pauses": pauses_continue,
                    "mean_end_delay_ms": sum(end_delays) / max(1, len(end_delays)),
                }
            )
    return {"timers": timers, "series": out, "utterances": len(DATASET)}
