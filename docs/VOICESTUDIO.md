# VoiceLab × VoiceStudio

[VoiceStudio](https://github.com/debpalash/VoiceStudio) is an open-source, fully local, ElevenLabs-style voice studio:
voice cloning and design, many TTS engines, Whisper-class transcription — all on your own machine, behind a small HTTP/WebSocket API.
VoiceLab can use it as its **TTS** and **STT**, so the agent speaks with *your* voices and listens with a local ASR, with no API key and no audio leaving the laptop.

```
 mic ─► VAD ─► STT ──────────────► turn ─► LLM ─► sentence chunker ─► TTS ─► speaker
                │                                                       │
                └─ POST /v1/audio/transcriptions        WS /ws/tts ◄────┘     (VoiceStudio, :3900)
```

VoiceStudio is a **separate program**. VoiceLab only talks to it over the network; it never imports, vendors or redistributes its code
(see [Licences](#licences)).

## 1 · Install and run

Needs Node 20+, [`uv`](https://docs.astral.sh/uv/) and `git`. Everything here was verified on an Apple-Silicon Mac; VoiceStudio itself also targets Windows and Linux, which this project has not been tried on.
Intel Macs are refused by the installer (PyTorch ships no wheels for them) — point `VOICESTUDIO_URL` at a VoiceStudio running elsewhere instead.

```bash
make studio-install    # shallow-clones the pinned release (v0.5.7) next to this repo and builds its Python env (~2 GB)
make studio-up         # starts its headless backend on http://127.0.0.1:3900 and waits until it answers
make studio-status     # version, accelerator, ASR engine, TTS engines, voice profiles
```

`make studio-down` stops it, `make studio-logs` tails `.voicestudio/backend.log`.
The first call after a cold start can take about a minute (VoiceStudio imports its engines lazily); VoiceLab shows “loading” instead of “offline”.

### Models (you choose — they are large and carry licences)

Nothing is downloaded implicitly. List what exists, then install what you want:

```bash
make studio-models                                                            # ● installed  ○ available, with size and licence
python3 scripts/voicestudio.py models install k2-fsa/OmniVoice --yes          # TTS · ≈3.3 GB · non-commercial (CC-BY-NC)
python3 scripts/voicestudio.py models install mlx-community/whisper-large-v3-turbo --yes   # ASR · 1.6 GB (Apple Silicon)
make studio-licences                                                          # VoiceStudio will not run a model until its licence is accepted
python3 scripts/voicestudio.py licences accept <repo_id> [<repo_id> …] --yes  # prints the terms, then records your acceptance
```

Accepting a licence states that **you** hold the rights those terms require, so VoiceLab never does it for you:
the command prints the terms and source URL and does nothing without `--yes`. OmniVoice needs two entries
(`k2-fsa/OmniVoice` and its tokenizer `eustlb/higgs-audio-v2-tokenizer`).

On Apple Silicon `make studio-up` starts VoiceStudio with `ASR_MODEL=mlx-community/whisper-large-v3-turbo`
(override: `VOICESTUDIO_ASR_MODEL`). VoiceStudio’s own default for batch transcription is the full 3 GB large-v3; turbo is half the size and several times faster, which suits a live agent.

## 2 · Use it in VoiceLab

* **Dashboard → VoiceStudio** shows the connection, engines and your voice profiles, lets you *audition* a voice (with VoiceStudio’s own TTFA and real-time factor beside VoiceLab’s TTFB),
  and runs a **round-trip self-test**: text → VoiceStudio TTS → resample to 16 kHz → VoiceStudio ASR → word-error-rate. *Use in Live Agent* applies the chosen voice, engine and STT in one click.
* **Live Agent → the “VoiceStudio” preset** (or pick *VoiceStudio* as the STT and/or TTS provider). With *Ollama* as the LLM the whole agent is local.
  The TTS panel then offers **Engine**, **Voice** (your profiles), **Voice style** (a description, for engines that support voice design) and **Language**.
* **LiveKit agent**: `LK_STT=voicestudio LK_TTS=voicestudio LK_LLM=ollama make agent` (the Ollama model defaults to `llama3.2`; change it with `LK_LLM_MODEL`). It uses the OpenAI plugin pointed at VoiceStudio’s OpenAI-compatible `/v1` routes;
  `LK_VOICE_ID` = a VoiceStudio profile id or name, `LK_STT_MODEL` / `LK_TTS_MODEL` override the model names.
* **Metrics**: every turn’s TTS block gains `server` — `ttfa_ms`, `rtf`, engine and transport — shown in the Live Agent’s TTS card and carried in the `tts.server_stats` event.

| Variable | Default | Meaning |
|---|---|---|
| `VOICESTUDIO_URL` | `http://127.0.0.1:3900` | where VoiceStudio listens |
| `VOICESTUDIO_API_KEY` (or `OMNIVOICE_API_KEY`) | – | Bearer key; only a **remote** VoiceStudio needs one (loopback is open) |
| `VOICESTUDIO_HOME` | `../voicestudio` | the checkout `make studio-*` manages |
| `VOICESTUDIO_VERSION` | `v0.5.7` | release tag the installer clones |
| `VOICESTUDIO_ASR_MODEL` | `mlx-community/whisper-large-v3-turbo` | Apple Silicon only: Whisper checkpoint selected by `studio-up` |

VoiceLab’s own endpoints for the same features: `GET /api/voicestudio/status`, `POST /api/voicestudio/speak` (WAV + `X-VS-*` timing headers),
`POST /api/voicestudio/transcribe` (raw 16 kHz PCM16 or WAV), `POST /api/voicestudio/selftest`.

## 3 · How the integration works

| Need | VoiceStudio API used | Notes |
|---|---|---|
| Discovery | `GET /.well-known/voicestudio-speech`, `/health`, `/v1/models`, `/v1/audio/voices` | version, accelerator, engines (`available` + reason), ASR engine, voice profiles |
| TTS | `WS /ws/tts` | `{text, voice?, engine?, speed, language?, instruct?}` → `start{sample_rate}` → binary PCM16 chunks → `done{ttfa_ms, rtf, …}` |
| TTS fallback | `POST /v1/audio/speech` (`response_format: pcm`) | used automatically if the WebSocket handshake is refused |
| STT | `POST /v1/audio/transcriptions` | multipart WAV, `model`, `language`, `prompt` (the persona’s vocabulary hint) |
| Models / licences | `GET /models`, `POST /models/install`, `GET /models/install/status`, `GET/POST /models/licenses/…` | only used by `scripts/voicestudio.py`, never by the running agent |

Design choices, and why:

* **Sentence-by-sentence TTS over a pooled WebSocket.** The pipeline’s chunker hands each sentence to VoiceStudio as soon as the LLM finishes it. One socket is reused for the whole conversation (no handshake per sentence).
  On barge-in the in-flight socket is **closed, not reused**, so audio of the cancelled sentence can never leak into the next one.
* **STT over HTTP, not the streaming WebSocket.** VoiceStudio’s stream endpoint emits partials every ~2 s after a 2 s minimum buffer and ends on 3 s of silence — too coarse for the semantic turn detector, which needs the *latest* words exactly when the caller pauses.
  VoiceLab instead decodes the utterance-so-far every ~0.7 s for live interim text, and once more at the first pause (the “speculative final”), so end-of-turn is decided on fresh text and the final transcript is usually already available.
* **Warm-ups at session start.** Both engines load their model on first use (OmniVoice took ~28 s here). Starting a session sends a tiny synthesis and a tiny transcription in the background and reports `tts-voice` / `stt` as ready — so the first real sentence does not pay for it.
* **Two different “first audio” numbers.** *TTFA* (`ttfa_ms`) is VoiceStudio’s own: request received → first audio chunk produced. VoiceLab’s *TTFB* is measured by the pipeline: sentence handed over → first byte received. They differ by transport, and both appear on the TTS card.
  Engines that render a whole clip before sending anything (OmniVoice) have TTFA ≈ render time.

## 4 · What to expect (measured on an Apple M3 Pro, `mps`, OmniVoice + Whisper large-v3-turbo)

| | cold (first call) | warm |
|---|---|---|
| ASR, 3.6 s utterance | 3.7 s | **0.7 s** (0.8–1.0 s for 4–5 s of audio) |
| TTS, one short sentence | ≈28 s (model load) | **TTFA 3.5–4.0 s**, RTF 1.3–1.65 |
| Round trip “said → heard” | – | WER 0 % |

Honest reading: OmniVoice is a high-quality, multilingual voice-cloning model, but at RTF > 1 on this machine it is **slower than real time** and renders each sentence whole, so every sentence adds ~4 s before the caller hears it.
That is perfect for auditioning voices and for studying a *slow-TTS* pipeline in the waterfall — and a poor match for snappy conversation. For responsiveness choose a lighter engine from the engine list
(for example `kittentts`, which VoiceStudio also reports as available; it is not downloaded or measured here), or keep VoiceStudio for ASR and use Piper for TTS.
The trade-off is exactly the course’s TTFB lesson, with your own numbers.

## Licences

* **VoiceStudio** is AGPL-3.0. VoiceLab communicates with it only through its public network API and contains none of its code, which keeps the two programs separate.
  If you modify and publicly host VoiceStudio itself, its AGPL obligations apply to *that* program.
* **Models carry their own licences**, independent of VoiceStudio’s. For example **OmniVoice is non-commercial** (CC-BY-NC weights; its audio tokenizer adds Boson Higgs-Audio-2 and Meta Llama 3 terms),
  and the MLX Whisper repositories ship with unasserted licence metadata. VoiceStudio shows these in its Model Catalogue and refuses to run a model until you accept them — read them before commercial use.
* **Voices you clone are your responsibility**: only clone voices you have the right to use.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dashboard says *not running* | `make studio-up` (first time `make studio-install`). Check `VOICESTUDIO_URL`. |
| Status says *loading engine catalogue* | VoiceStudio’s first call after a cold start can take ~1 min; it refreshes by itself. |
| “…will not use k2-fsa/OmniVoice until its licence is accepted” | `make studio-licences`, then `licences accept … --yes` after reading the terms. |
| “No speech-to-text model is installed” (HTTP 409) | Install a Whisper model (`make studio-models`). `studio-up` selects the turbo checkpoint; if you installed a different one set `VOICESTUDIO_ASR_MODEL`, or run `studio-down` then `studio-up`. |
| “rejected the request (set VOICESTUDIO_API_KEY …)” | A remote VoiceStudio needs a Bearer key: `VOICESTUDIO_API_KEY=…` in `.env`. Loopback needs none. |
| First sentence of a session is slow | Engine still loading; the session warm-up covers most of it. Keep VoiceStudio running between sessions. |
| Sentences take ~4 s | Expected for OmniVoice (RTF > 1). Pick a lighter engine, or see *What to expect*. |
| Voice list only has “Default” | You have not created a voice profile in VoiceStudio yet (clone or design one in its app). |

## Tests

* `make test` — runs the integration against a faithful **fake** of VoiceStudio’s documented API (no install needed): discovery, cold-start listing, auth, WebSocket TTS, socket reuse and barge-in discard, HTTP fallback, error frames,
  STT interim/speculative-final reuse, a full live turn with server metrics, and the dashboard endpoints.
* `make studio-test` — the same behaviour against your **real, running** VoiceStudio (needs the models installed and their licences accepted): real-socket TTS with server stats, barge-in socket discard,
  the TTS→ASR round trip, a full turn with VoiceStudio’s voice, and caller speech transcribed by VoiceStudio inside a session.
