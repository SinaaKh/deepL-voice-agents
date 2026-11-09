"""Settings + the per-session configuration the dashboard sends us.

Everything the course lets you tune lives in `SessionConfig`:
  * VAD            (Lesson 3/4)  – threshold, debounce
  * Turn detection (Lesson 3)    – silence timer, semantic extension, max delay
  * Interruptions  (Lesson 3)    – barge-in on/off, minimum duration
  * STT / LLM / TTS (Lesson 4)   – provider, model, voice_id, pronunciation overrides
  * Architecture   (Lesson 1/4)  – cascaded pipeline vs speech-to-speech
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


class Settings:
    """Environment-driven settings (read lazily so tests can monkeypatch)."""

    @property
    def openai_key(self) -> str:
        return os.getenv("OPENAI_API_KEY", "")

    @property
    def anthropic_key(self) -> str:
        return os.getenv("ANTHROPIC_API_KEY", "")

    @property
    def elevenlabs_key(self) -> str:
        return os.getenv("ELEVEN_API_KEY", "") or os.getenv("ELEVENLABS_API_KEY", "")

    @property
    def deepgram_key(self) -> str:
        return os.getenv("DEEPGRAM_API_KEY", "")

    @property
    def groq_key(self) -> str:
        return os.getenv("GROQ_API_KEY", "")

    @property
    def cerebras_key(self) -> str:
        return os.getenv("CEREBRAS_API_KEY", "")

    @property
    def together_key(self) -> str:
        return os.getenv("TOGETHER_API_KEY", "")

    @property
    def ollama_url(self) -> str:
        return os.getenv("OLLAMA_URL", "http://localhost:11434")

    @property
    def livekit_url(self) -> str:
        return os.getenv("LIVEKIT_URL", "")

    @property
    def livekit_api_key(self) -> str:
        return os.getenv("LIVEKIT_API_KEY", "")

    @property
    def livekit_api_secret(self) -> str:
        return os.getenv("LIVEKIT_API_SECRET", "")

    @property
    def whisper_model(self) -> str:
        return os.getenv("WHISPER_MODEL", "base.en")


settings = Settings()


# --------------------------------------------------------------------------- #
# Per-session configuration (sent by the dashboard)
# --------------------------------------------------------------------------- #
class VADConfig(BaseModel):
    provider: Literal["silero", "energy"] = "silero"
    threshold: float = Field(0.5, ge=0.05, le=0.95)  # activation probability
    min_speech_ms: int = Field(64, ge=0, le=500)  # blocking cost at utterance start
    min_silence_ms: int = Field(160, ge=32, le=2000)  # debounce before "speech ended"
    prefix_padding_ms: int = Field(320, ge=0, le=1000)  # audio kept from before detection


class TurnConfig(BaseModel):
    # vad      : fire end-of-turn after a fixed silence timer (Lesson 3, signal processing)
    # semantic : timer is *extended* when a semantic model thinks the thought is unfinished
    # llm      : like semantic, but the chosen LLM judges completeness (slower, more flexible)
    mode: Literal["vad", "semantic", "llm"] = "semantic"
    silence_timer_ms: int = Field(500, ge=100, le=5000)  # min endpointing delay
    max_delay_ms: int = Field(2500, ge=200, le=10000)  # delay used when thought looks unfinished
    threshold: float = Field(0.5, ge=0.05, le=0.95)  # P(end-of-turn) needed to use the short timer


class InterruptConfig(BaseModel):
    enabled: bool = True
    min_duration_ms: int = Field(320, ge=0, le=2000)  # speech needed during playback to barge in


class STTConfig(BaseModel):
    provider: Literal["whisper-local", "openai", "deepgram", "mock"] = "whisper-local"
    model: str = ""  # provider default if empty
    language: str = "en"
    # Vocabulary hint (Whisper `initial_prompt` / OpenAI `prompt`). Empty = use the persona's domain prompt.
    prompt: str = ""


class LLMConfig(BaseModel):
    provider: Literal[
        "ollama", "openai", "groq", "cerebras", "together", "anthropic", "mock"
    ] = "ollama"
    model: str = ""  # provider default if empty
    temperature: float = Field(0.4, ge=0, le=1.5)
    max_tokens: int = Field(220, ge=16, le=2000)
    # Course mock-latency profile (only used by provider == "mock")
    mock_profile: str = "gpt-4o-mini"


class Pronunciation(BaseModel):
    match: str
    say: str


class ChunkingConfig(BaseModel):
    # sentence : flush on . ! ?                          (Lesson 3: "complete sentences")
    # eager    : first chunk flushes at first clause     (lower TTFB, choppier prosody)
    strategy: Literal["sentence", "eager"] = "sentence"
    min_chars: int = Field(18, ge=1, le=200)


class TTSConfig(BaseModel):
    provider: Literal["piper", "macos-say", "openai", "elevenlabs", "mock"] = "piper"
    voice_id: str = ""  # the `voice_id` knob from Lesson 4
    speed: float = Field(1.0, ge=0.5, le=2.0)
    model: str = ""
    pronunciations: list[Pronunciation] = Field(default_factory=list)
    chunking: ChunkingConfig = Field(default_factory=ChunkingConfig)


class GuardrailConfig(BaseModel):
    enabled: bool = False
    blocked_terms: list[str] = Field(default_factory=lambda: ["password", "credit card number"])


class SessionConfig(BaseModel):
    architecture: Literal["pipeline", "realtime"] = "pipeline"
    persona: str = "restaurant"
    system_prompt: str = ""  # overrides persona prompt when non-empty
    vad: VADConfig = Field(default_factory=VADConfig)
    turn: TurnConfig = Field(default_factory=TurnConfig)
    interrupt: InterruptConfig = Field(default_factory=InterruptConfig)
    stt: STTConfig = Field(default_factory=STTConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)
    guardrails: GuardrailConfig = Field(default_factory=GuardrailConfig)
    # realtime (speech-to-speech) knobs
    realtime_model: str = "gpt-realtime"
    realtime_voice: str = "marin"
