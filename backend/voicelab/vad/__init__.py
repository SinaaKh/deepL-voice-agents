"""Voice Activity Detection (Lesson 1, 3, 4, 5).

A VAD is "a small binary classifier neural network that detects whether human speech is
present (1) or absent (0) in each audio frame". Here:

  * `SileroVAD`   – the real Silero v5 ONNX model (what the course's `silero` plugin runs)
  * `EnergyVAD`   – a naive RMS gate, kept so you can *see* why a neural VAD matters
  * `VADTracker`  – turns noisy per-frame probabilities into debounced speech start/end events.
                    `min_speech_ms` is the "intentionally blocking" cost from Lesson 5: audio is
                    held back until we're sure it is speech.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..audio import FRAME_MS, FRAME_SAMPLES, MIC_RATE, pcm16_to_f32


class SileroVAD:
    """Silero VAD v5 (16 kHz, 512-sample windows) running on onnxruntime."""

    name = "silero"
    CONTEXT = 64

    def __init__(self, model_path: str | Path | None = None) -> None:
        import onnxruntime as ort

        path = str(model_path or find_silero_model())
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        self._sess = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(MIC_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, self.CONTEXT), dtype=np.float32)
        self._buf = np.zeros((1, self.CONTEXT + FRAME_SAMPLES), dtype=np.float32)

    def prob(self, pcm_frame: bytes) -> float:
        x = pcm16_to_f32(pcm_frame)
        if len(x) != FRAME_SAMPLES:
            x = np.pad(x, (0, max(0, FRAME_SAMPLES - len(x))))[:FRAME_SAMPLES]
        self._buf[:, : self.CONTEXT] = self._context
        self._buf[:, self.CONTEXT :] = x
        out, self._state = self._sess.run(
            None, {"input": self._buf, "state": self._state, "sr": self._sr}
        )
        self._context = self._buf[:, -self.CONTEXT :].copy()
        return float(out.item())


class EnergyVAD:
    """RMS gate mapped onto a pseudo-probability. Fooled by any loud noise (that's the point)."""

    name = "energy"

    def __init__(self, floor_db: float = -48.0, ceil_db: float = -28.0) -> None:
        self.floor, self.ceil = floor_db, ceil_db

    def reset(self) -> None:
        pass

    def prob(self, pcm_frame: bytes) -> float:
        x = pcm16_to_f32(pcm_frame)
        r = float(np.sqrt(np.mean(x * x))) if len(x) else 0.0
        db = 20 * math.log10(max(r, 1e-6))
        return float(min(1.0, max(0.0, (db - self.floor) / (self.ceil - self.floor))))


def find_silero_model() -> Path:
    """Locate silero_vad.onnx shipped with `livekit-plugins-silero` (what the course installs).

    We look the file up on disk instead of importing the plugin: importing a LiveKit plugin
    registers it with the framework, which must happen on the main thread."""
    import importlib.util

    try:
        spec = importlib.util.find_spec("livekit.plugins.silero")
        for loc in (spec.submodule_search_locations or []) if spec else []:
            p = Path(loc) / "resources" / "silero_vad.onnx"
            if p.exists():
                return p
    except Exception:
        pass
    local = Path(__file__).with_name("silero_vad.onnx")
    if local.exists():
        return local
    raise FileNotFoundError(
        "silero_vad.onnx not found. Install the livekit extra (`uv sync --extra livekit`) "
        "or drop the model next to voicelab/vad/__init__.py"
    )


def create_vad(provider: str):
    if provider == "silero":
        try:
            return SileroVAD()
        except Exception:
            return EnergyVAD()
    return EnergyVAD()


@dataclass
class VADTransition:
    kind: str  # "speech_start" | "speech_end"
    t_ms: float  # when the speech actually started / when the last speech frame ended


class VADTracker:
    """Debounce frame probabilities into speech_start / speech_end transitions."""

    def __init__(
        self,
        threshold: float = 0.5,
        min_speech_ms: int = 64,
        min_silence_ms: int = 160,
    ) -> None:
        self.threshold = threshold
        self.neg_threshold = max(0.05, threshold - 0.15)
        self.min_speech_ms = min_speech_ms
        self.min_silence_ms = min_silence_ms
        self.speaking = False
        self._run_speech_ms = 0.0
        self._run_silence_ms = 0.0
        self._first_speech_t = 0.0
        self._last_speech_t = 0.0

    def update(self, prob: float, t_ms: float) -> VADTransition | None:
        """`t_ms` is the *start* time of the frame this probability describes."""
        frame_end = t_ms + FRAME_MS
        if prob >= self.threshold:
            if self._run_speech_ms == 0:
                self._first_speech_t = t_ms
            self._run_speech_ms += FRAME_MS
            self._run_silence_ms = 0.0
            self._last_speech_t = frame_end
            if not self.speaking and self._run_speech_ms >= max(self.min_speech_ms, FRAME_MS):
                self.speaking = True
                return VADTransition("speech_start", self._first_speech_t)
        elif prob < self.neg_threshold:
            self._run_speech_ms = 0.0 if not self.speaking else self._run_speech_ms
            if self.speaking:
                self._run_silence_ms += FRAME_MS
                if self._run_silence_ms >= self.min_silence_ms:
                    self.speaking = False
                    self._run_speech_ms = 0.0
                    self._run_silence_ms = 0.0
                    return VADTransition("speech_end", self._last_speech_t)
            else:
                self._run_speech_ms = 0.0
        # in the hysteresis band: hold state
        return None
