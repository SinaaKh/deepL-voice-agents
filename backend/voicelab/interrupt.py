"""Interruption handling helpers (Lesson 3: barge-in + context/timestamp synchronisation).

When the user barges in, the agent has generated (and maybe synthesised) more text than the user
actually *heard*. LiveKit uses WebRTC packet timestamps to find the last frame that played out and
truncates the LLM's chat history to that point. We do the same with the client-reported
"audio milliseconds played" counter: each TTS sentence occupies a known slice of the playout
timeline, so we can recover exactly which words were heard.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SpokenSegment:
    text: str
    start_ms: float  # offset on the *audio* timeline (gaps between sentences do not count)
    dur_ms: float

    @property
    def end_ms(self) -> float:
        return self.start_ms + self.dur_ms


def heard_text(segments: list[SpokenSegment], played_ms: float) -> tuple[str, str, int]:
    """Return (heard, unheard, index_of_sentence_being_played)."""
    heard: list[str] = []
    unheard: list[str] = []
    current = -1
    for i, seg in enumerate(segments):
        if played_ms >= seg.end_ms - 1:
            heard.append(seg.text)
        elif played_ms <= seg.start_ms:
            unheard.append(seg.text)
        else:
            current = i
            words = seg.text.split()
            frac = (played_ms - seg.start_ms) / max(1.0, seg.dur_ms)
            n = max(0, min(len(words), int(len(words) * frac)))
            if n:
                heard.append(" ".join(words[:n]) + ("" if n == len(words) else "…"))
            if n < len(words):
                unheard.append(" ".join(words[n:]))
    return " ".join(heard).strip(), " ".join(unheard).strip(), current


def split_heard(segments: list[SpokenSegment], played_ms: float) -> list[tuple[str, str]]:
    """Per-sentence (heard, unheard) fragments for a given playout position."""
    out: list[tuple[str, str]] = []
    for seg in segments:
        words = seg.text.split()
        if played_ms >= seg.end_ms - 1:
            out.append((seg.text, ""))
        elif played_ms <= seg.start_ms:
            out.append(("", seg.text))
        else:
            frac = (played_ms - seg.start_ms) / max(1.0, seg.dur_ms)
            n = max(0, min(len(words), int(len(words) * frac)))
            out.append((" ".join(words[:n]), " ".join(words[n:])))
    return out


def build_segments(sentences: list[tuple[str, float]]) -> list[SpokenSegment]:
    """sentences: [(text, audio_duration_ms)] in playout order."""
    t = 0.0
    out: list[SpokenSegment] = []
    for text, dur in sentences:
        out.append(SpokenSegment(text, t, dur))
        t += dur
    return out
