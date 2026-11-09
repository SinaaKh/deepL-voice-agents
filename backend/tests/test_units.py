"""Pure-logic tests: the pieces whose behaviour the course specifies precisely."""
import numpy as np
import pytest

from voicelab.audio import FRAME_MS, read_wav, resample, to_wav
from voicelab.config import Pronunciation
from voicelab.interrupt import build_segments, heard_text, split_heard
from voicelab.llm.mock import MockLLM, PROFILES
from voicelab.session import SentenceChunker
from voicelab.tools import ToolBox
from voicelab.tts import apply_pronunciations
from voicelab.turn import HeuristicSemanticDetector, TurnPolicy
from voicelab.turn.sim import DATASET, SimRequest, SimSegment, simulate, sweep
from voicelab.vad import VADTracker


# ----------------------------------------------------------------------------- chunker (Lesson 3)
def test_chunker_emits_complete_sentences_only():
    c = SentenceChunker("sentence", 10)
    out = []
    for tok in ["Hello ", "there. ", "How ", "are ", "you ", "today? ", "Fine"]:
        out += c.feed(tok)
    assert out == ["Hello there.", "How are you today?"]
    assert c.flush() == "Fine"


def test_chunker_does_not_split_abbreviations_or_decimals():
    c = SentenceChunker("sentence", 10)
    out = c.feed("We open at 7 p.m. daily and a table costs 3.50 extra. Next sentence here. ")
    assert out == ["We open at 7 p.m. daily and a table costs 3.50 extra.", "Next sentence here."]


def test_eager_chunker_flushes_first_clause_early():
    eager, sent = SentenceChunker("eager", 12), SentenceChunker("sentence", 12)
    text = "Sure, I can check that for you right now while we talk about the menu. "
    assert eager.feed(text)[0].startswith("Sure,")
    assert sent.feed(text)[0].endswith("menu.")


# ----------------------------------------------------------------------------- turn detection (Lesson 3)
DET = HeuristicSemanticDetector()


@pytest.mark.parametrize("text", [
    "I'd like to book a table for", "Hi um", "I'm feeling dizzy and", "Could I get the", "The name is",
    "I need to cancel because", "My phone number is five five five",
])
def test_detector_thinks_unfinished_thoughts_are_unfinished(text):
    assert DET.predict(text) < 0.5


@pytest.mark.parametrize("text", [
    "Can you tell me what time you close today", "Yes", "Okay sounds good", "I want to change my reservation to tomorrow evening",
])
def test_detector_recognises_finished_thoughts(text):
    assert DET.predict(text) >= 0.5


def test_detector_uses_previous_agent_turn():
    hist = [{"role": "assistant", "content": "May I have a name for the booking?"}]
    assert DET.predict("John Smith", hist) >= 0.85
    assert DET.predict("John Smith") < 0.85


def test_turn_policy_extends_timer_only_for_unfinished_thoughts():
    p = TurnPolicy("semantic", 500, 2500, 0.5)
    assert p.delay_ms(0.9) == 500
    assert p.delay_ms(0.1) == 2500
    assert TurnPolicy("vad", 500, 2500, 0.5).delay_ms(0.1) == 500


def _script(*items):
    return [SimSegment(kind="speech", text=i, ms=1500) if isinstance(i, str) else SimSegment(kind="pause", ms=i[0], intent=i[1]) for i in items]


def test_semantic_mode_saves_a_mid_thought_pause_that_vad_cuts_off():
    segs = _script("I'd like a table for", (1100, "continue"), "four people", (1500, "end"))
    vad = simulate(SimRequest(segments=segs, mode="vad", silence_timer_ms=500))
    sem = simulate(SimRequest(segments=segs, mode="semantic", silence_timer_ms=500, max_delay_ms=2500))
    assert vad["summary"]["cut_offs"] == 1
    assert sem["summary"]["cut_offs"] == 0 and sem["summary"]["saved_by_semantic"] == 1


def test_sweep_semantic_never_cuts_off_more_than_vad():
    r = sweep()
    for v, s in zip(r["series"]["vad"], r["series"]["semantic"]):
        assert s["cut_off_rate"] <= v["cut_off_rate"] + 1e-9
    rates = [p["cut_off_rate"] for p in r["series"]["vad"]]
    assert rates == sorted(rates, reverse=True), "longer silence timers must not cut off more"
    assert len(DATASET) >= 10


# ----------------------------------------------------------------------------- interruption (Lesson 3)
def test_heard_text_truncates_at_the_played_position():
    segs = build_segments([("One two three four.", 1000), ("Five six seven eight.", 1000), ("Nine ten.", 500)])
    heard, unheard, cur = heard_text(segs, 1500)
    assert heard == "One two three four. Five six…" and cur == 1
    assert unheard.endswith("Nine ten.") and "seven eight." in unheard
    assert heard_text(segs, 0)[0] == "" and heard_text(segs, 2500)[1] == ""
    parts = split_heard(segs, 1500)
    assert parts[0] == ("One two three four.", "") and parts[2] == ("", "Nine ten.")


# ----------------------------------------------------------------------------- VAD tracker (Lesson 4/5)
def test_vad_tracker_debounces_start_and_end():
    tr = VADTracker(threshold=0.5, min_speech_ms=64, min_silence_ms=160)
    events, t = [], 0.0
    for p in [0.1, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9] + [0.05] * 6:
        e = tr.update(p, t)
        t += FRAME_MS
        if e:
            events.append((e.kind, e.t_ms))
    assert [k for k, _ in events] == ["speech_start", "speech_end"]  # the lone early blip is ignored
    assert events[0][1] == pytest.approx(3 * FRAME_MS)  # retroactively dated to the first speech frame of the run


# ----------------------------------------------------------------------------- tools (Lesson 1: overbooking)
async def test_tools_prevent_overbooking_and_tolerate_llm_type_sloppiness():
    tb = ToolBox()
    for name in ("A", "B"):
        assert (await tb.call("book_table", {"party_size": "4", "time": "7pm", "name": name}))["booked"] is True
    assert (await tb.call("check_availability", {"party_size": 2, "time": "7 pm"}))["available"] is False
    third = await tb.call("book_table", {"party_size": 4, "time": "19:00", "name": "C"})
    assert third["booked"] is False and "overbooking" in third["reason"]
    assert (await tb.call("check_availability", {"party_size": "four", "time": "8pm"}))["available"] is True


# ----------------------------------------------------------------------------- TTS pronunciation (Lesson 4)
def test_pronunciation_overrides():
    rules = [Pronunciation(match="LiveKit", say="live kit"), Pronunciation(match="API", say="A P I")]
    assert apply_pronunciations("The LiveKit API is fast, not LiveKitty.", rules) == "The live kit A P I is fast, not LiveKitty."


# ----------------------------------------------------------------------------- mock LLM profiles (Lesson 5)
async def test_mock_llm_reproduces_course_ttft_ordering():
    async def ttft(profile):
        import time
        m = MockLLM(profile)
        t0 = time.perf_counter()
        async for ev in m.stream([{"role": "system", "content": "x"}, {"role": "user", "content": "hello"}], None):
            if ev.kind == "text":
                return (time.perf_counter() - t0) * 1000
    big, small = await ttft("gpt-4o"), await ttft("gpt-4o-mini")
    assert PROFILES["gpt-4o"]["ttft_ms"] == 840 and PROFILES["gpt-4o-mini"]["ttft_ms"] == 420
    assert 0.8 * 840 <= big <= 1.4 * 840 and 0.8 * 420 <= small <= 1.4 * 420
    assert big > small * 1.5


async def test_mock_restaurant_fills_slots_then_calls_tools():
    m = MockLLM("fast-inference-70b", "restaurant")
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "Hi, I'd like to book a table for four people at 7pm."}]
    evs = [e async for e in m.stream(msgs, None)]
    calls = [e.tool for e in evs if e.kind == "tool_call"]
    assert calls and calls[0].name == "check_availability" and calls[0].arguments["party_size"] == 4


# ----------------------------------------------------------------------------- audio helpers
def test_wav_roundtrip_and_resample():
    pcm = (np.sin(np.linspace(0, 200, 16000)) * 12000).astype("<i2").tobytes()
    back, sr = read_wav(to_wav(pcm, 16000))
    assert sr == 16000 and back == pcm
    assert len(resample(pcm, 16000, 24000)) == pytest.approx(len(pcm) * 1.5, abs=4)


# ----------------------------------------------------------------------------- Anthropic message mapping
def test_openai_history_maps_to_anthropic_tool_blocks():
    from voicelab.llm import _to_anthropic

    msgs = [
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "Book a table"},
        {"role": "assistant", "content": "Checking.", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "check_availability", "arguments": '{"party_size": 2}'}}]},
        {"role": "tool", "tool_call_id": "t1", "content": '{"available": true}'},
        {"role": "tool", "tool_call_id": "t2", "content": '{"x": 1}'},
        {"role": "assistant", "content": None},
    ]
    system, out = _to_anthropic(msgs)
    assert system == "Be brief."
    assert out[1]["content"][0] == {"type": "text", "text": "Checking."} and out[1]["content"][1]["type"] == "tool_use"
    assert out[1]["content"][1]["input"] == {"party_size": 2}
    assert out[2]["role"] == "user" and [b["type"] for b in out[2]["content"]] == ["tool_result", "tool_result"]  # consecutive results are merged
    assert out[3]["content"]  # empty assistant content is made valid
