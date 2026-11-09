"""End-of-turn detection (Lesson 3: "Signal + Semantic Processing").

Two parallel signals decide when a user is *done* rather than merely *pausing*:

  1. Signal processing – VAD flips to "no speech" and starts a developer-configured timer.
  2. Semantic processing – a model reads the current transcript (+ the last few turns) and
     predicts whether the thought is complete. If VAD says "silence" but the model says "still
     mid-thought", the VAD timer is *extended*.

`TurnPolicy` is the pure decision logic (shared by the live pipeline and the Turn-Taking Lab).
"""
from __future__ import annotations

from dataclasses import dataclass

from .semantic import HeuristicSemanticDetector, normalize

__all__ = ["TurnPolicy", "HeuristicSemanticDetector", "normalize"]


@dataclass
class TurnPolicy:
    mode: str = "semantic"  # vad | semantic | llm
    silence_timer_ms: int = 500
    max_delay_ms: int = 2500
    threshold: float = 0.5

    def delay_ms(self, p_eot: float | None) -> float:
        """How long after the last speech frame we wait before firing end-of-turn."""
        if self.mode == "vad" or p_eot is None:
            return float(self.silence_timer_ms)
        if p_eot >= self.threshold:
            return float(self.silence_timer_ms)
        return float(max(self.silence_timer_ms, self.max_delay_ms))
