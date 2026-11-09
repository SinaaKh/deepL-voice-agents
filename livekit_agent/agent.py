"""
LiveKit voice agent – the course's code, runnable.

    python livekit_agent/agent.py console   # talk to it in your terminal (mic + speakers, no server needed)
    python livekit_agent/agent.py dev       # connect to LIVEKIT_URL and wait for rooms (use the VoiceLab
                                            # "LiveKit" page, the LiveKit Playground, or any LiveKit client)

It mirrors Lessons 1, 3, 4 and 5:

  Step 1  Imports & environment          – Silero VAD, STT, LLM and TTS plugins (Lesson 4)
  Step 2  The `Assistant` agent          – stateful instructions + tools (Lesson 4)
  Step 3  `entrypoint()` + AgentSession  – one isolated agent per room; VAD + semantic turn detection (Lessons 3, 4)
  Step 4  Dispatch & customisation       – cli.run_app registers the worker; swap `voice_id` / models via env
  Metrics (Lesson 5)                     – LLM TTFT / tokens-per-second, STT duration, EOU delay, TTS TTFB,
                                           logged AND published over the room data channel to the dashboard.

Everything provider-specific is chosen with environment variables (see .env.example) so you can
reproduce the course's experiments, e.g. LK_LLM_MODEL=gpt-4o vs gpt-4o-mini to compare TTFT.
"""
from __future__ import annotations

# --------------------------------------------------------------------------------------------
# Step 1 – imports and environment
# --------------------------------------------------------------------------------------------
import asyncio
import json
import logging
import os
import random
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    MetricsCollectedEvent,
    RunContext,
    UserInputTranscribedEvent,
    WorkerOptions,
    cli,
    function_tool,
    metrics,
)
from livekit.plugins import deepgram, elevenlabs, openai, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
logger = logging.getLogger("voicelab.agent")
logging.basicConfig(level=logging.INFO)

# Knobs you can turn without touching the code ------------------------------------------------
STT_PROVIDER = os.getenv("LK_STT", "openai")            # openai | deepgram
LLM_PROVIDER = os.getenv("LK_LLM", "openai")            # openai | groq | cerebras | together | ollama
LLM_MODEL = os.getenv("LK_LLM_MODEL", "gpt-4o-mini")    # try gpt-4o to reproduce the Lesson 5 TTFT comparison
TTS_PROVIDER = os.getenv("LK_TTS", "elevenlabs")        # elevenlabs | openai
VOICE_ID = os.getenv("LK_VOICE_ID", "CwhRBWXzGAHq8TQ4Fs17")  # ElevenLabs "Roger" – the voice swapped in during Lesson 4
TURN_MODE = os.getenv("LK_TURN", "semantic")            # semantic (VAD + transformer) | vad
MIN_ENDPOINTING = float(os.getenv("LK_MIN_ENDPOINTING_DELAY", "0.5"))  # the VAD silence timer, seconds
MAX_ENDPOINTING = float(os.getenv("LK_MAX_ENDPOINTING_DELAY", "3.0"))  # used when the semantic model says "not done"
ALLOW_INTERRUPTIONS = os.getenv("LK_ALLOW_INTERRUPTIONS", "1") != "0"
DATA_TOPIC = "voicelab"  # RTCDataChannel topic the dashboard listens on


# --------------------------------------------------------------------------------------------
# Step 2 – the Assistant
#   An `Agent` is a *stateful* object: it owns the conversation history, whose turn it is,
#   whether the user may interrupt, and the tools the LLM can call. The system prompt is the
#   `instructions` parameter; everything else is inherited from the base class.
# --------------------------------------------------------------------------------------------
INSTRUCTIONS = (
    "You are Bella, the phone host at Bella Notte, an Italian restaurant open 5 to 10 pm daily. "
    "Collect party size, time and a name. Call check_availability BEFORE book_table, and never say a "
    "booking succeeded unless book_table returned booked=true. "
    # Prompt engineering is the cheapest latency optimisation: short spoken replies reach TTS sooner.
    "You are speaking out loud on a phone call: answer in one to three short sentences, plain spoken English, "
    "no markdown, no lists, no emoji, and ask one question at a time."
)

SLOT_CAPACITY = 2  # tiny on purpose, so overbooking is easy to provoke (Lesson 1: "prevent overbooking")


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self._bookings: dict[str, list[dict]] = {}

    @function_tool
    async def check_availability(self, context: RunContext, party_size: int, time: str) -> dict:
        """Check whether the restaurant has a free table.

        Args:
            party_size: number of guests
            time: requested time, for example "7 pm" or "19:30"
        """
        await asyncio.sleep(random.uniform(0.08, 0.2))  # pretend database round-trip
        taken = len(self._bookings.get(time.lower(), []))
        if party_size > 8:
            return {"available": False, "reason": "parties over 8 need a phone reservation"}
        return {"available": taken < SLOT_CAPACITY, "tables_left": max(0, SLOT_CAPACITY - taken)}

    @function_tool
    async def book_table(self, context: RunContext, party_size: int, time: str, name: str) -> dict:
        """Book a table. Only call after check_availability says it is available.

        Args:
            party_size: number of guests
            time: requested time
            name: name for the reservation
        """
        slot = self._bookings.setdefault(time.lower(), [])
        if len(slot) >= SLOT_CAPACITY:
            return {"booked": False, "reason": "overbooking prevented – slot filled just now"}
        slot.append({"name": name, "party_size": party_size})
        return {"booked": True, "confirmation": f"VL{random.randint(1000, 9999)}"}


# --------------------------------------------------------------------------------------------
# Provider factories – this is the "pipeline" idea: every stage is a swappable plugin.
# --------------------------------------------------------------------------------------------
def make_stt():
    if STT_PROVIDER == "deepgram":
        return deepgram.STT(model="nova-3")  # true streaming STT → STTMetrics.streamed == True
    return openai.STT(model=os.getenv("LK_STT_MODEL", "gpt-4o-mini-transcribe"))


def make_llm():
    if LLM_PROVIDER == "ollama":
        return openai.LLM.with_ollama(model=LLM_MODEL, base_url=os.getenv("OLLAMA_URL", "http://localhost:11434") + "/v1")
    if LLM_PROVIDER == "cerebras":
        return openai.LLM.with_cerebras(model=LLM_MODEL)
    if LLM_PROVIDER == "together":
        return openai.LLM.with_together(model=LLM_MODEL)
    if LLM_PROVIDER == "groq":  # ultra-fast inference of open models (Lesson 1: "API routing")
        return openai.LLM(model=LLM_MODEL, base_url="https://api.groq.com/openai/v1", api_key=os.environ["GROQ_API_KEY"])
    return openai.LLM(model=LLM_MODEL)


def make_tts():
    if TTS_PROVIDER == "openai":
        return openai.TTS(voice=os.getenv("LK_OPENAI_VOICE", "alloy"))
    # Swapping `voice_id` changes the agent's persona instantly.
    return elevenlabs.TTS(voice_id=VOICE_ID, model=os.getenv("LK_TTS_MODEL", "eleven_flash_v2_5"))


# --------------------------------------------------------------------------------------------
# Step 3 – entrypoint
#   LiveKit calls this once per room (= one user session). It runs as an isolated agent instance.
# --------------------------------------------------------------------------------------------
async def entrypoint(ctx: JobContext) -> None:
    # 3.1  connect this worker process to the LiveKit room
    await ctx.connect()

    # 3.2  an AgentSession links VAD + STT + LLM + TTS (+ turn detection) into one pipeline
    session = AgentSession(
        vad=silero.VAD.load(),                       # speech / no-speech per audio frame (also drives barge-in)
        stt=make_stt(),
        llm=make_llm(),
        tts=make_tts(),
        # Lesson 3: VAD starts a silence timer, a transformer reads the transcript (+ recent turns) and
        # *extends* it when the user is mid-thought. "vad" falls back to the plain timer.
        turn_detection=MultilingualModel() if TURN_MODE == "semantic" else "vad",
        min_endpointing_delay=MIN_ENDPOINTING,
        max_endpointing_delay=MAX_ENDPOINTING,
        allow_interruptions=ALLOW_INTERRUPTIONS,      # barge-in: cancel LLM + TTS, truncate history to what was heard
    )

    # ---- Lesson 5: metrics collection -----------------------------------------------------
    usage = metrics.UsageCollector()

    def publish(kind: str, payload: dict) -> None:
        """Send JSON to the dashboard over an RTCDataChannel (the third WebRTC primitive in Lesson 5)."""
        data = json.dumps({"kind": kind, **payload}, default=str).encode()
        asyncio.create_task(ctx.room.local_participant.publish_data(data, reliable=True, topic=DATA_TOPIC))

    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent) -> None:
        m = ev.metrics
        metrics.log_metrics(m)  # pretty console log
        usage.collect(m)
        if isinstance(m, metrics.LLMMetrics):
            publish("llm", {"ttft": m.ttft, "tokens_per_second": m.tokens_per_second, "prompt_tokens": m.prompt_tokens,
                            "completion_tokens": m.completion_tokens, "speech_id": m.speech_id})
        elif isinstance(m, metrics.STTMetrics):
            publish("stt", {"audio_duration": m.audio_duration, "streamed": m.streamed, "duration": m.duration})
        elif isinstance(m, metrics.EOUMetrics):
            publish("eou", {"end_of_utterance_delay": m.end_of_utterance_delay, "transcription_delay": m.transcription_delay,
                            "speech_id": m.speech_id})
        elif isinstance(m, metrics.TTSMetrics):
            publish("tts", {"ttfb": m.ttfb, "audio_duration": m.audio_duration, "streamed": m.streamed, "duration": m.duration,
                            "speech_id": m.speech_id})

    @session.on("user_input_transcribed")
    def _on_user_text(ev: UserInputTranscribedEvent) -> None:
        publish("transcript", {"role": "user", "text": ev.transcript, "final": ev.is_final})

    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if getattr(item, "role", None) == "assistant":
            publish("transcript", {"role": "assistant", "text": item.text_content or "", "final": True,
                                   "interrupted": bool(getattr(item, "interrupted", False))})

    async def log_usage() -> None:
        logger.info("session usage: %s", usage.get_summary())

    ctx.add_shutdown_callback(log_usage)

    # 3.3  attach the Assistant to the session and join the room
    await session.start(agent=Assistant(), room=ctx.room)

    # let the agent speak first
    await session.generate_reply(instructions="Greet the caller: say thanks for calling Bella Notte and ask how you can help.")


# --------------------------------------------------------------------------------------------
# Step 4 – dispatch
#   `cli.run_app` registers the worker with LiveKit so it can be dispatched to rooms.
#   In `dev`/`start` mode every new room automatically requests an agent instance.
# --------------------------------------------------------------------------------------------
if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
