import { ArrowRight, Check, Cpu, Minus } from 'lucide-react'
import { Badge, Card, Stat } from '../components/ui'
import { useMeta } from '../lib/config'

const LESSONS = [
  { n: 1, title: 'Fundamentals of AI voice agents', blurb: 'Speech-to-speech vs. the STT → LLM → TTS pipeline, the latency challenge, and why WebRTC + streaming matter.',
    concepts: ['Two architectures & their trade-offs', 'VAD and end-of-turn detection', 'Human baseline 236 ms (σ 520 ms)', 'Pipeline floor ≈ 540 ms, typical > 1.5 s', 'Disfluencies, multilingual ASR, optimisation levers'],
    try: [['Architecture Lab', 'architecture'], ['Latency Lab', 'latency']] },
  { n: 2, title: 'Networking protocols & real-time audio', blurb: 'Why TCP stalls audio, what WebRTC adds on top of UDP, and how LiveKit’s global mesh shortens the path.',
    concepts: ['TCP head-of-line blocking vs. UDP', 'HTTP vs. WebSocket vs. WebRTC', 'Opus: 5 s of audio → ~3 % of the bytes', 'Packet pacing & timestamps', 'LiveKit Cloud mesh: −20…50 % network latency'],
    try: [['Transport Lab', 'transport']] },
  { n: 3, title: 'Inside the voice agent: architecture & turn detection', blurb: 'The cascaded execution flow, VAD + semantic turn detection, interruption flush, and history synchronisation.',
    concepts: ['Streaming flow: audio → STT → LLM → sentences → TTS', 'VAD silence timer + transformer turn detector', 'Barge-in: cancel LLM + TTS, flush playout', 'Truncating history to what was actually heard'],
    try: [['Turn-taking Lab', 'turn'], ['Live Agent', 'live']] },
  { n: 4, title: 'Pipeline building blocks & coding an agent', blurb: 'Choosing VAD / STT / LLM / TTS per use case, and the LiveKit Agents code: Agent, AgentSession, entrypoint.',
    concepts: ['VAD gating cuts STT cost & hallucinations', 'Domain trade-offs: booking (LLM) vs. triage (STT)', 'Guardrails at the LLM layer', 'TTS voice_id & pronunciation overrides', 'Assistant · AgentSession · rooms · dispatch'],
    try: [['Live Agent', 'live'], ['LiveKit', 'livekit']] },
  { n: 5, title: 'Pipeline latency metrics & optimisation', blurb: 'Blocking vs. streaming stages, the north-star metrics (TTFT, TTFB), instrumentation, and the gpt-4o → gpt-4o-mini experiment.',
    concepts: ['VAD blocking ≈ 15–20 ms; others stream', 'LLM TTFT & TTS TTFB drive perceived latency', 'LLMMetrics · STTMetrics · EOUMetrics · TTSMetrics', 'gpt-4o 0.84 s → gpt-4o-mini 0.42 s'],
    try: [['Live Agent', 'live'], ['Latency Lab', 'latency']] },
]

export default function Overview() {
  const { providers } = useMeta()
  const ok = (list: { id: string; available: boolean }[] | undefined, id: string) => !!list?.find((p) => p.id === id)?.available
  const local = ok(providers?.stt, 'whisper-local') && ok(providers?.llm, 'ollama') && ok(providers?.tts, 'piper')
  return (
    <div className="mx-auto max-w-[1180px]">
      <div className="mb-6 rounded-2xl border border-line bg-surface p-6">
        <div className="flex flex-wrap items-start gap-6">
          <div className="min-w-[320px] flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">VoiceLab</h1>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-fg2">
              A working voice agent you can poke at, built to mirror every idea in the course: a real streaming pipeline (Silero VAD → Whisper → LLM → sentence chunker → TTS), semantic turn detection,
              barge-in with history truncation, and per-stage latency instrumentation — plus simulators for the parts you can’t easily feel (TCP vs. UDP, turn-taking trade-offs, latency budgets).
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href="#/live" className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110">Open the Live Agent <ArrowRight size={14} /></a>
              <a href="#/latency" className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3.5 py-2 text-[13px] font-medium hover:bg-inset">Explore the latency budget</a>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            <Stat label="human response" value="236" unit="ms" sub="σ ≈ 520 ms" />
            <Stat label="pipeline floor" value="540" unit="ms" sub="best case" tone="good" />
            <Stat label="typical" value=">1.5" unit="s" sub="unoptimised" tone="bad" />
            <Stat label="WebRTC audio" value="3" unit="%" sub="of raw bytes" />
            <Stat label="LiveKit mesh" value="−20…50" unit="%" sub="network latency" />
            <Stat label="TTFT 4o → mini" value="0.84→0.42" unit="s" sub="Lesson 5" />
          </div>
        </div>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card title="What runs on this machine" icon={<Cpu size={14} />} sub={local ? 'fully local, no API keys' : undefined}>
          {!providers ? <p className="text-sm text-fg3">Checking providers…</p> : (
            <ul className="space-y-1.5 text-[13px]">
              {[
                ['VAD', 'Silero (ONNX)', ok(providers.vad, 'silero')], ['STT', 'faster-whisper (local)', ok(providers.stt, 'whisper-local')], ['LLM', 'Ollama (local)', ok(providers.llm, 'ollama')],
                ['TTS', 'Piper (local neural)', ok(providers.tts, 'piper')], ['TTS (slow baseline)', 'macOS say', ok(providers.tts, 'macos-say')],
              ].map(([k, v, a]) => <Row key={k as string} k={k as string} v={v as string} on={a as boolean} />)}
              <li className="pt-1.5 text-[11px] uppercase tracking-wide text-fg3">Optional — add keys to .env</li>
              {[['OpenAI (STT · LLM · TTS · Realtime)', providers.keys.openai], ['Groq / Cerebras / Together (fast LLM inference)', providers.keys.groq || providers.keys.cerebras || providers.keys.together],
                ['ElevenLabs (voices, clones)', providers.keys.elevenlabs], ['Deepgram (streaming STT)', providers.keys.deepgram], ['Anthropic', providers.keys.anthropic]].map(([k, on]) => <Row key={k as string} k={k as string} v={on ? 'key found' : 'not set'} on={on as boolean} muted />)}
            </ul>
          )}
        </Card>
        <Card title="Try this first">
          <ol className="space-y-3 text-[13px] leading-snug text-fg2">
            <li><b className="text-fg">1 · Baseline.</b> In <a className="text-accent underline" href="#/live">Live Agent</a> press <i>Start session</i>, run the <i>Clean booking</i> scenario, and read the waterfall: where do the milliseconds go?</li>
            <li><b className="text-fg">2 · Turn detection.</b> Run <i>Mid-thought pause</i> with “VAD timer”, then “VAD + semantic”. Watch the silence timer get extended instead of cutting the caller off.</li>
            <li><b className="text-fg">3 · Barge-in.</b> Run <i>Barge-in</i> and open the <i>Barge-in</i> tab: how much audio was heard, and what the LLM’s history keeps.</li>
            <li><b className="text-fg">4 · Reproduce Lesson 5.</b> In <a className="text-accent underline" href="#/latency">Latency Lab → Measured</a> benchmark gpt-4o vs. gpt-4o-mini TTFT.</li>
            <li><b className="text-fg">5 · Use your own voice.</b> Start with the mic on (headphones recommended) and interrupt the agent.</li>
          </ol>
        </Card>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg3">Course map</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {LESSONS.map((l) => (
          <Card key={l.n} className="flex flex-col">
            <div className="flex items-center gap-2"><Badge tone="accent">Lesson {l.n}</Badge></div>
            <h3 className="mt-2 text-[15px] font-semibold leading-snug">{l.title}</h3>
            <p className="mt-1 text-[12.5px] leading-snug text-fg2">{l.blurb}</p>
            <ul className="mt-3 space-y-1 text-[12px] text-fg2">{l.concepts.map((c) => <li key={c} className="flex gap-1.5"><Minus size={12} className="mt-1 shrink-0 text-fg3" />{c}</li>)}</ul>
            <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
              {l.try.map(([label, to]) => <a key={to} href={`#/${to}`} className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1 text-xs font-medium hover:bg-inset">{label}<ArrowRight size={12} /></a>)}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

function Row({ k, v, on, muted }: { k: string; v: string; on: boolean; muted?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span className={on ? 'text-good' : muted ? 'text-fg3' : 'text-bad'}>{on ? <Check size={14} /> : <Minus size={14} />}</span>
      <span className="text-fg2">{k}</span><span className="ml-auto text-xs text-fg3">{v}</span>
    </li>
  )
}
