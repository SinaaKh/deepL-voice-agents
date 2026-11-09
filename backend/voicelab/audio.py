"""Small PCM helpers. Wire format everywhere: mono, 16-bit little-endian PCM.

Mic -> server is 16 kHz. Server -> browser keeps the TTS provider's native rate
(announced in `response.audio_start`) so we never resample on the hot path.
"""
from __future__ import annotations

import io
import wave

import numpy as np

MIC_RATE = 16_000
FRAME_MS = 32  # one Silero VAD window at 16 kHz = 512 samples
FRAME_SAMPLES = MIC_RATE * FRAME_MS // 1000  # 512
FRAME_BYTES = FRAME_SAMPLES * 2


def pcm16_to_f32(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def f32_to_pcm16(x: np.ndarray) -> bytes:
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def rms(pcm: bytes) -> float:
    if not pcm:
        return 0.0
    x = pcm16_to_f32(pcm)
    return float(np.sqrt(np.mean(x * x)))


def duration_ms(n_bytes: int, sample_rate: int) -> float:
    return n_bytes / 2 / sample_rate * 1000.0


def resample(pcm: bytes, src: int, dst: int) -> bytes:
    """Linear-interpolation resample (good enough for speech)."""
    if src == dst or not pcm:
        return pcm
    x = pcm16_to_f32(pcm)
    n_out = int(round(len(x) * dst / src))
    if n_out <= 0:
        return b""
    xp = np.linspace(0, len(x) - 1, num=n_out)
    y = np.interp(xp, np.arange(len(x)), x)
    return f32_to_pcm16(y)


def to_wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def read_wav(data: bytes) -> tuple[bytes, int]:
    """Return (mono int16 pcm, sample_rate)."""
    with wave.open(io.BytesIO(data), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError(f"expected 16-bit wav, got {sw * 8}-bit")
    if ch > 1:
        x = np.frombuffer(raw, dtype="<i2").reshape(-1, ch).mean(axis=1).astype("<i2")
        raw = x.tobytes()
    return raw, sr


def silence(ms: float, sample_rate: int = MIC_RATE, noise: float = 0.0008) -> bytes:
    """Quiet room-tone (tiny noise floor so VAD/STT see a realistic signal)."""
    n = int(sample_rate * ms / 1000)
    rng = np.random.default_rng(7)
    return f32_to_pcm16(rng.normal(0, noise, n).astype(np.float32))


def chunk(pcm: bytes, size: int):
    for i in range(0, len(pcm), size):
        yield pcm[i : i + size]
