# VoiceLab

A hands-on companion to the DeepLearning.AI × LiveKit course **“Building AI Voice Agents for Production.”**
It is a working voice agent *and* a set of labs, so every idea from the five lessons is something you can
run, break, measure and see.

```
 mic ─► VAD ─► STT (streaming) ─► turn detection ─► LLM (token stream) ─► sentence chunker ─► TTS ─► speaker
          │            ▲  silence timer + semantic extension                                    │
          └── barge-in: cancel LLM + TTS, flush playout, truncate history to what was *heard* ◄─┘
```

* **Live Agent** – a real streaming pipeline (Silero VAD → Whisper → LLM → sentence chunker → TTS) with a live
  pipeline diagram, VAD trace, turn-timer countdown, latency waterfall, per-turn metrics, a barge-in inspector and
  scripted “virtual callers”. Runs **fully local, no API keys**.
* **Turn-taking Lab** – the same turn-policy code run against scripted utterances: when does a silence timer fire, when does a
  semantic model extend it, and what does a barge-in do to the conversation history?
* **Transport Lab** – TCP head-of-line blocking vs UDP/WebRTC on the same lossy network, Opus payload size, HTTP vs
  streaming timelines, and the LiveKit mesh route. *(Simulation – see the notes in the app.)*
* **Latency Lab** – a budget model anchored to the course numbers, the optimisation levers from Lesson 1, and a
  **measured** A/B benchmark (the gpt-4o vs gpt-4o-mini TTFT experiment) against real or simulated providers.
* **Architecture Lab** – speech-to-speech vs pipeline, a weighted decision helper, and the per-use-case budget
  allocator (restaurant booking → spend on the LLM, medical triage → spend on STT).
* **LiveKit** – the course-faithful agent (`livekit_agent/agent.py`), a real WebRTC join with metrics streamed back over an
  RTCDataChannel, and an annotated code viewer.

---

## Quick start

Prerequisites: Python 3.11+ with [`uv`](https://docs.astral.sh/uv/), Node 20+, and (for the fully local stack)
[Ollama](https://ollama.com) with a small chat model (`ollama pull llama3.2`).

```bash
make setup        # installs Python + Node deps, downloads Whisper + Piper voices (~250 MB), creates .env
make start        # builds the dashboard and serves everything on http://localhost:8000
```

Developing the UI instead? `make dev` runs the backend with auto-reload plus the Vite dev server on
<http://localhost:5173>. `make help` lists every task.

**No Ollama / no models yet?** Pick the **Simulated** preset in the Live Agent: scripted replies with the course’s latency
profiles, a synthetic voice, and an “oracle” STT that understands the built-in scenarios. All labs work.

**With API keys**, copy them into `.env` (see `.env.example`) — OpenAI, Anthropic, Groq, Cerebras, Together, ElevenLabs,
Deepgram — and they appear as selectable providers. Secrets never leave the backend.

## A guided tour (15 minutes)

1. **Baseline.** Live Agent → *Start session* → run **Clean booking**. Read the waterfall: STT runs *during* speech, TTS
   starts while the LLM is still streaming. Where do the milliseconds go?
2. **Turn detection.** Run **Mid-thought pause** with “VAD timer”, then “VAD + semantic”. The caller trails off at “…a table
   *for*”; watch the timer get extended instead of the caller cut off. Then explore the trade-off curve in the Turn-taking Lab.
3. **Barge-in.** Run **Barge-in**, open the *Barge-in* tab: how much audio was generated, how much was actually heard, and what
   the LLM’s history now ends with.
4. **Reproduce Lesson 5.** Latency Lab → *Measured*: gpt-4o vs gpt-4o-mini TTFT (simulated profiles anchored to the course’s
   0.84 s → 0.42 s, or real OpenAI if you have a key).
5. **Your own voice.** Start with the microphone on (**use headphones** – otherwise the agent hears itself and interrupts itself)
   and talk over the agent.
6. **Break things.** Switch VAD to *energy gate*, raise the VAD threshold, turn interruptions off, switch TTS to macOS `say`
   (a non-streaming TTS: look at its TTFB), enable guardrails and run **Sensitive data**.

## How the course maps onto the project

| Lesson | Concept | Where to see it | Where it lives |
|---|---|---|---|
| 1 | Speech-to-speech vs pipeline | Architecture Lab; Live Agent → *Architecture* | `backend/voicelab/realtime`, `session.py` |
| 1 | VAD, end-of-turn detection | Live Agent VAD trace + timer; Turn-taking Lab | `vad/`, `turn/` |
| 1 | Human 236 ms (σ 520), floor 540 ms, typical > 1.5 s | Latency Lab, latency bars | `frontend/src/components/ui.tsx` (`HUMAN`) |
| 1 | Latency levers: smaller / quantised / fast-inference models, concise prompts | Latency Lab levers; Live Agent LLM + prompt | `llm/`, `personas.py` |
| 1 | Disfluencies, barge-in demo | Scenarios *Disfluent caller*, *Barge-in* | `scenarios.py` |
| 2 | TCP vs UDP, head-of-line blocking | Transport Lab lanes | `frontend/src/lib/transport.ts` |
| 2 | HTTP vs WebSocket vs WebRTC; Opus ≈ 3 %; pacing & timestamps | Transport Lab tables / payload / timelines | same |
| 2 | LiveKit mesh, −20…50 % network latency | Transport Lab mesh; LiveKit page | same, `livekit_agent/` |
| 3 | Stateful per-session agent; cascaded streaming flow; sentence chunking | Live Agent pipeline diagram | `session.py` (`SentenceChunker`, `_llm_producer`, `_tts_worker`) |
| 3 | VAD timer + semantic turn detector | Turn-taking Lab; Live Agent | `turn/`, `session._turn_timer` |
| 3 | Interruption: cancel LLM + TTS, flush; truncate history to what was heard | *Barge-in* tab; Turn-taking Lab → Interruption | `session._interrupt`, `interrupt.py`, `lib/audio.ts` (`playedMs`) |
| 4 | VAD gating (cost, STT hallucinations) | “VAD gate: N % of audio not sent to STT” | `session._push_stt` |
| 4 | Modular trade-offs (booking → LLM, triage → STT) | Architecture Lab allocator; personas | `personas.py` |
| 4 | Guardrails at the LLM layer; TTS `voice_id`, pronunciation overrides | Live Agent config; scenario *Sensitive data* | `session._begin_response`, `tts/` |
| 4 | LiveKit code: `Agent`, `AgentSession`, `entrypoint`, `cli.run_app` | LiveKit page code viewer | `livekit_agent/agent.py` |
| 5 | `getUserMedia`, `RTCDataChannel` (and `getDisplayMedia`, unused here) | Mic capture; LiveKit metrics channel | `lib/audio.ts`, `LiveKitPage.tsx` |
| 5 | Blocking vs streaming stages | Waterfall + pipeline diagram labels | `session._emit_metrics` |
| 5 | TTFT, TTFB; `LLMMetrics / STTMetrics / EOUMetrics / TTSMetrics` | Metrics panel (same field names) | `session.py`, `livekit_agent/agent.py` |
| 5 | gpt-4o 0.84 s → gpt-4o-mini 0.42 s | Latency Lab → Measured | `benchmark.py`, `llm/mock.py` |

## Architecture

```
frontend/ (React + TS + Tailwind)            backend/ (FastAPI, asyncio)
  Live Agent ──── WebSocket /ws/session ────►  VoiceSession  ─ VAD ─ STT ─ turn timer ─ LLM ─ chunker ─ TTS
   • mic → AudioWorklet → 16 kHz PCM16 ──►     │  emits JSON events (vad, stt.*, turn.*, llm.*, tts.*, interrupt…)
   • ◄── TTS PCM16 + JSON events               │  + ordered binary audio on the same queue (so a flush can drop it)
   • AudioContext player reports "played ms"   └─ RealtimeSession (OpenAI speech-to-speech bridge, same event schema)
  Turn / Latency / Transport / Architecture ─► REST: /api/turn/*, /api/benchmark, /api/providers …
  LiveKit page ── WebRTC ──► LiveKit server ◄── livekit_agent/agent.py (course code, per-room worker)
```

**WebSocket protocol** (`/ws/session`). Client → server: JSON `start{config,greet}`, `config{config}` (live re-config),
`text{text}`, `scenario{id}`, `playback{response_id,played_ms}`, `playout_done`, `flushed{played_ms}`, `ping`; binary =
16 kHz mono PCM16 microphone frames. Server → client: JSON events (every event carries `t`, ms on the session clock) and
binary TTS PCM16, announced by `response.audio_start{sample_rate}`. A barge-in sends `flush`; the browser stops playout and
answers `flushed{played_ms}` — that number is what the server uses to truncate the LLM history.

**Providers** (all optional beyond the local stack)

| Layer | Local (no key) | Cloud |
|---|---|---|
| VAD | Silero (ONNX), energy gate | – |
| STT | faster-whisper `tiny/base/small.en` | OpenAI transcribe, Deepgram (streaming) |
| LLM | Ollama (OpenAI-compatible, tool calls) | OpenAI, Groq, Cerebras, Together (one OpenAI-compatible client), Anthropic |
| TTS | Piper (streaming neural), macOS `say` (non-streaming baseline) | ElevenLabs, OpenAI |
| S2S | – | OpenAI Realtime |
| Mock | scripted STT/LLM with course latency profiles, synthetic voice | – |

## LiveKit mode (the production path)

```bash
brew install livekit && make livekit-server     # local dev server: ws://localhost:7880, key devkey / secret secret
make agent-models                               # once: turn-detector weights
make agent                                      # the course agent (needs OPENAI_API_KEY + ELEVEN_API_KEY, or see knobs below)
```
Then open the **LiveKit** page and *Join room* (mic access required). Without provider keys, `make demo-agent` publishes
fake metrics into the room so you can see the data-channel panel work. `make agent-console` talks to the agent in your
terminal with no server at all. Knobs (no code edits): `LK_LLM_MODEL=gpt-4o` vs `gpt-4o-mini`, `LK_LLM=groq|cerebras|ollama`,
`LK_STT=deepgram`, `LK_VOICE_ID=…`, `LK_TURN=vad`.

## What was verified (and what wasn’t)

| Area | Status |
|---|---|
| Pipeline on real local models (Silero, faster-whisper, Ollama `llama3.2` with tool calls, Piper, macOS `say`) | ✅ run end-to-end through the headless runner **and** the dashboard: turn detection, barge-in + history truncation, tool calls, metrics |
| Backend logic | ✅ 38 automated tests (`make test`): chunker, turn policy/simulator/sweep, truncation, VAD debounce, tools, guardrail, pipeline with mock providers, WebSocket protocol, realtime event mapping, Anthropic message mapping |
| Dashboard | ✅ type-checked, production-built, and exercised in a browser (all pages) |
| LiveKit | ✅ WebRTC join to a local `livekit-server`, token endpoint, data-channel metrics (via `demo_publisher.py`); `agent.py` imports and builds its providers/`AgentSession` against `livekit-agents 1.8.11`. ⚠️ **Not run end-to-end** – that needs OpenAI/ElevenLabs keys |
| Cloud providers: OpenAI STT/TTS, ElevenLabs, Deepgram, Anthropic, OpenAI Realtime | ⚠️ written against the vendors’ docs, **not exercised against the live APIs** (no keys here). The OpenAI-compatible LLM path *is* verified (it is the same client used for Ollama) |
| Live microphone in a browser | ⚠️ the capture path (`getUserMedia` → AudioWorklet) could not be exercised in the preview pane used for development; the playback / flush / played-ms side was. Test with headphones |
| Transport Lab, Latency/Architecture budgets | ℹ️ models and simulations, labelled as such in the UI. Numbers from the course are tagged “course”; everything else is “estimate” |

## Project layout

```
backend/voicelab/   config · events · audio · session (the pipeline) · interrupt · scenarios · benchmark · main (API)
                    vad/ stt/ llm/ tts/ turn/ tools/ realtime/    – provider implementations
backend/tests/      pytest suite              backend/scripts/run_scenario.py   headless scenario runner
frontend/src/       pages/ (6 labs) · components/ (charts, pipeline diagram, config panel) · lib/ (session store, audio, simulators)
livekit_agent/      agent.py (course code)  ·  demo_publisher.py (keyless LiveKit demo)
scripts/            download_models.py         Makefile · .env.example
```

Headless smoke test of the real pipeline (prints every event): `cd backend && .venv/bin/python scripts/run_scenario.py barge_in --stt whisper-local --llm ollama --tts piper`

## Troubleshooting

* **First session is slow** – Whisper and the Piper voice load (and Ollama loads its model) on first use; the status pill shows what is loading.
* **Agent keeps interrupting itself** – use headphones; the browser’s echo cancellation helps but isn’t perfect.
* **Long “STT finalize”** – use `tiny.en` (≈ 2× faster) or a streaming provider (Deepgram); Whisper re-transcribes the utterance so far.
* **The semantic turn detector is only as good as the transcript it reads.** In one of ~4 real runs Whisper heard “a table *for*” as “a table *saw*”, which looks like a finished sentence, so the caller was cut off. The STT **Vocabulary hint** (pre-filled per persona) biases Whisper toward your domain and made the hold reliable in the following runs, but it reduces the problem rather than removing it – a larger STT model or a streaming provider helps further.
* **Small local models misbehave** – e.g. `llama3.2` may send tool arguments as strings or print a tool call as text; the pipeline coerces the former and suppresses the latter instead of speaking JSON.
* **Port in use** – backend `:8000`, Vite `:5173`, LiveKit `:7880`.
