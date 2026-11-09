import { ArrowRight, Check, Minus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Button, Card, Field, LessonTag, PageHeader, Segmented, Slider, Stat, cx } from '../components/ui'
import { pushConfig, useMeta } from '../lib/config'

export default function ArchitectureLab() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-4">
      <PageHeader title="Architecture Lab" lessons={<><LessonTag n={1} /><LessonTag n={4} /></>}>
        There are two ways to build a voice agent: one model that listens and speaks (<b>speech-to-speech</b>), or a chain of specialised stages (<b>pipeline</b>). Pick by what you need to control — and, in a pipeline, decide
        <i> which layer deserves your latency and cost budget</i>.
      </PageHeader>
      <Diagrams />
      <Decide />
      <Allocator />
      <Ecosystem />
    </div>
  )
}

/* ============================================================================================ */
function Box({ x, y, w, h, title, sub, color, dashed }: { x: number; y: number; w: number; h: number; title: string; sub?: string; color: string; dashed?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={9} fill={`color-mix(in srgb, ${color} 13%, var(--surface))`} stroke={color} strokeWidth={dashed ? 2 : 1.5} strokeDasharray={dashed ? '6 4' : undefined} />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 2 : h / 2 + 4)} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--fg)">{title}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" fontSize={10} fill="var(--fg2)">{sub}</text>}
    </g>
  )
}
const Arr = ({ x1, x2, y, label, color = 'var(--fg3)' }: { x1: number; x2: number; y: number; label?: string; color?: string }) => (
  <g><line x1={x1} x2={x2 - 5} y1={y} y2={y} stroke={color} strokeWidth={2} className="flow" /><path d={`M${x2 - 8} ${y - 4} L${x2} ${y} L${x2 - 8} ${y + 4}`} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />{label && <text x={(x1 + x2) / 2} y={y - 7} textAnchor="middle" fontSize={9} fill="var(--fg3)">{label}</text>}</g>
)

function Diagrams() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <Card title="Speech-to-speech (Realtime API)" sub="one end-to-end model">
        <svg viewBox="0 0 400 150" className="w-full" role="img" aria-label="Speech to speech architecture">
          <Box x={6} y={50} w={70} h={50} title="User" sub="audio in" color="var(--c-endpoint)" />
          <Arr x1={78} x2={128} y={75} label="audio" />
          <Box x={130} y={24} w={140} h={102} title="Speech-to-speech" sub="hears, thinks, speaks" color="var(--c-llm)" dashed />
          <text x={200} y={108} textAnchor="middle" fontSize={9.5} fill="var(--fg3)">black box</text>
          <Arr x1={272} x2={322} y={75} label="audio" />
          <Box x={324} y={50} w={70} h={50} title="Agent" sub="audio out" color="var(--c-play)" />
        </svg>
        <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
          <Pros title="Pros" tone="good" items={['Simple to implement', 'Rapid deployment', 'Very natural prosody']} />
          <Pros title="Cons" tone="bad" items={['Less control of behaviour', 'Hard to inspect or swap parts', 'No per-stage latency / cost budget']} />
        </div>
      </Card>
      <Card title="Pipeline (cascaded)" sub="STT → LLM → TTS, each stage swappable">
        <svg viewBox="0 0 700 150" className="w-full" role="img" aria-label="Pipeline architecture">
          <Box x={4} y={50} w={58} h={50} title="User" sub="audio" color="var(--c-endpoint)" />
          <Arr x1={64} x2={96} y={75} />
          <Box x={98} y={50} w={78} h={50} title="VAD + turn" sub="when to listen" color="var(--c-endpoint)" />
          <Arr x1={178} x2={206} y={75} />
          <Box x={208} y={50} w={74} h={50} title="STT" sub="audio → text" color="var(--c-stt)" />
          <Arr x1={284} x2={312} y={75} label="text" />
          <Box x={314} y={36} w={128} h={78} title="LLM / agent" sub="tools · memory · RAG" color="var(--c-llm)" />
          <Box x={330} y={118} w={96} h={24} title="databases · APIs" color="var(--c-tool)" />
          <Arr x1={444} x2={472} y={75} label="text" />
          <Box x={474} y={50} w={74} h={50} title="TTS" sub="text → audio" color="var(--c-tts)" />
          <Arr x1={550} x2={578} y={75} />
          <Box x={580} y={50} w={64} h={50} title="Agent" sub="audio + visuals" color="var(--c-play)" />
          {[['swap STT', 245, 38], ['swap LLM', 378, 22], ['swap voice', 511, 38]].map(([t, x, y]) => <text key={t as string} x={x as number} y={y as number} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--accent)">↺ {t}</text>)}
          <text x={350} y={12} textAnchor="middle" fontSize={9.5} fill="var(--fg3)">multimodal context (images, links) can ride alongside the reply</text>
        </svg>
        <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
          <Pros title="Pros" tone="good" items={['Control and customisation per layer', 'Inspectable intermediate state (transcripts, tool calls)', 'Supports multimodal output']} />
          <Pros title="Cons" tone="bad" items={['More orchestration complexity', 'Latency must be managed across stages']} />
        </div>
      </Card>
    </div>
  )
}
function Pros({ title, items, tone }: { title: string; items: string[]; tone: 'good' | 'bad' }) {
  return <div><div className={cx('mb-1 font-semibold', tone === 'good' ? 'text-good' : 'text-bad')}>{title}</div><ul className="space-y-1">{items.map((i) => <li key={i} className="flex gap-1.5 text-fg2">{tone === 'good' ? <Check size={12} className="mt-0.5 shrink-0 text-good" /> : <Minus size={12} className="mt-0.5 shrink-0 text-bad" />}{i}</li>)}</ul></div>
}

/* ============================================================================================
   Weighted decision helper (qualitative scores distilled from Lessons 1 & 4)
   ============================================================================================ */
const CRITERIA: { k: string; label: string; s2s: number; pipe: number; note: string }[] = [
  { k: 'speed', label: 'Time to first prototype', s2s: 5, pipe: 2, note: 'S2S: one connection and a prompt.' },
  { k: 'control', label: 'Fine-grained behaviour control', s2s: 2, pipe: 5, note: 'Pipeline: swap models, filter content, tune every layer.' },
  { k: 'observe', label: 'Observability & debugging', s2s: 1, pipe: 5, note: 'Pipeline exposes transcripts, tool calls and per-stage metrics.' },
  { k: 'multi', label: 'Multimodal output (images, links, avatars)', s2s: 2, pipe: 5, note: 'The LLM stage can emit more than text for speech.' },
  { k: 'latency', label: 'Lowest achievable latency', s2s: 4, pipe: 3, note: 'No stage hand-offs in S2S; pipelines can get close with streaming + fast providers.' },
  { k: 'domain', label: 'Domain vocabulary / compliance', s2s: 2, pipe: 5, note: 'Pick a specialised STT and add guardrails at the LLM layer.' },
]
function Decide() {
  const [w, setW] = useState<Record<string, number>>({ speed: 2, control: 3, observe: 3, multi: 1, latency: 3, domain: 2 })
  const score = (side: 's2s' | 'pipe') => CRITERIA.reduce((a, c) => a + c[side] * (w[c.k] ?? 0), 0)
  const a = score('s2s'), b = score('pipe')
  const max = CRITERIA.reduce((s, c) => s + 5 * (w[c.k] ?? 0), 0) || 1
  const win = a > b ? 'Speech-to-speech' : b > a ? 'Pipeline' : 'Either'
  return (
    <Card title="Which one fits? Weigh what matters to you" right={<Badge tone="accent">{win}</Badge>} sub="editorial scores distilled from the lessons – not a benchmark">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {CRITERIA.map((c) => (
            <div key={c.k} className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-4">
              <div><div className="text-[13px] font-medium">{c.label}</div><div className="text-[11px] text-fg3">{c.note}</div></div>
              <div><Slider value={w[c.k]} min={0} max={5} onChange={(v) => setW({ ...w, [c.k]: v })} /><div className="flex justify-between text-[10px] text-fg3"><span>don’t care</span><span>critical</span></div></div>
            </div>
          ))}
        </div>
        <div className="space-y-4 rounded-xl bg-inset p-4">
          {([['Speech-to-speech', a, 'var(--c-llm)'], ['Pipeline', b, 'var(--c-stt)']] as const).map(([l, v, c]) => (
            <div key={l}><div className="mb-1 flex justify-between text-xs"><b>{l}</b><span className="num text-fg2">{Math.round((v / max) * 100)}% fit</span></div><div className="h-3 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full transition-all" style={{ width: `${(v / max) * 100}%`, background: c }} /></div></div>
          ))}
          <p className="text-[12px] leading-snug text-fg2">{win === 'Pipeline' ? 'You value control, inspection or domain accuracy — pay the orchestration tax and tune each layer.' : win === 'Speech-to-speech' ? 'You value speed of delivery and a natural-sounding baseline more than per-layer control.' : 'A tie: prototype with speech-to-speech, move to a pipeline when you need to look inside.'}</p>
        </div>
      </div>
    </Card>
  )
}

/* ============================================================================================
   Modular trade-offs: where does *your* use case spend its budget?
   ============================================================================================ */
type Layer = 'stt' | 'llm' | 'tts'
const TIERS: Record<Layer, { name: string; ms: number; cost: string; detail: string }[]> = {
  stt: [{ name: 'Fast', ms: 50, cost: '$', detail: 'small streaming model (e.g. Whisper tiny / Deepgram Nova)' }, { name: 'Balanced', ms: 150, cost: '$$', detail: 'general-purpose streaming STT' }, { name: 'Precise', ms: 300, cost: '$$$', detail: 'larger / domain-tuned or telephony model for specialised vocabulary' }],
  llm: [{ name: 'Fast', ms: 190, cost: '$', detail: 'open model on ultra-fast inference (Groq, Cerebras, Together)' }, { name: 'Balanced', ms: 420, cost: '$$', detail: 'gpt-4o-mini class' }, { name: 'Strong', ms: 840, cost: '$$$', detail: 'gpt-4o class – best tool accuracy and reasoning' }],
  tts: [{ name: 'Fast', ms: 100, cost: '$', detail: 'low-TTFB streaming voice' }, { name: 'Natural', ms: 220, cost: '$$', detail: 'higher-fidelity voice' }, { name: 'Expressive', ms: 420, cost: '$$$', detail: 'cloned / highly expressive voice (ElevenLabs custom voice)' }],
}
const FOCUS: Record<string, [number, number, number]> = { llm: [0.2, 0.55, 0.25], stt: [0.5, 0.28, 0.22], tts: [0.2, 0.3, 0.5], balanced: [0.33, 0.34, 0.33] }
const tierOf = (wt: number) => (wt >= 0.42 ? 2 : wt >= 0.26 ? 1 : 0)
const WHY: Record<string, string> = {
  restaurant: 'A booking agent must call tools reliably and never overbook – a wrong tool call is worse than a slower reply.',
  medical: 'Clinical vocabulary (“tachycardia”, “photophobia”) must be transcribed correctly before anything else can go right.',
  tutor: 'A language tutor lives or dies on how natural and expressive the voice sounds.',
  support: 'A generic support line wants a balanced stack without a single expensive layer.',
}

function Allocator() {
  const { personas } = useMeta()
  const [persona, setPersona] = useState('restaurant')
  const p = personas.find((x) => x.id === persona)
  const [w, setW] = useState<[number, number, number]>(FOCUS.llm)
  const pick = (id: string) => { setPersona(id); setW(FOCUS[personas.find((x) => x.id === id)?.focus ?? 'balanced']) }
  const layers: Layer[] = ['stt', 'llm', 'tts']
  const choice = layers.map((l, i) => TIERS[l][tierOf(w[i])])
  const net = 60, endpoint = 300
  const total = endpoint + net + choice.reduce((a, c) => a + c.ms, 0)
  const costScore = choice.reduce((a, c) => a + c.cost.length, 0)
  const setW1 = (i: number, v: number) => {
    const n = [...w] as [number, number, number]; const rest = 1 - v; const others = [0, 1, 2].filter((k) => k !== i)
    const sum = others.reduce((a, k) => a + n[k], 0) || 1
    others.forEach((k) => { n[k] = (n[k] / sum) * rest }); n[i] = v; setW(n)
  }
  const load = () => {
    pushConfig((c) => {
      c.persona = persona; c.system_prompt = ''
      c.stt.model = ['tiny.en', 'base.en', 'small.en'][tierOf(w[0])]
      c.tts.chunking.strategy = tierOf(w[2]) === 0 ? 'eager' : 'sentence'
      c.llm.mock_profile = ['fast-inference-70b', 'gpt-4o-mini', 'gpt-4o'][tierOf(w[1])]
      c.turn.mode = 'semantic'
    })
    location.hash = '#/live'
  }
  return (
    <Card title="Spend the budget where your use case needs it" sub="modular trade-offs – the pipeline advantage" right={<LessonTag n={4}>global vs modular optimisation</LessonTag>}>
      <div className="mb-4 max-w-2xl"><Segmented value={persona} onChange={pick} options={personas.map((x) => ({ value: x.id, label: x.name.split('·')[1]?.trim() ?? x.name }))} /></div>
      {p && <p className="mb-4 text-[13px] leading-snug text-fg2"><b className="text-fg">{p.name}.</b> {WHY[persona]}</p>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          {([['STT', 'var(--c-stt)'], ['LLM', 'var(--c-llm)'], ['TTS', 'var(--c-tts)']] as const).map(([l, c], i) => (
            <Field key={l} label={<span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l} share of the budget</span>} value={`${Math.round(w[i] * 100)}%`}>
              <Slider value={Math.round(w[i] * 100)} min={5} max={80} step={1} onChange={(v) => setW1(i, v / 100)} />
            </Field>
          ))}
          <div className="grid grid-cols-3 gap-3 rounded-lg bg-inset p-3">
            <Stat label="est. response" value={(total / 1000).toFixed(2)} unit="s" sub="model, see Latency Lab" />
            <Stat label="relative cost" value={'$'.repeat(Math.round(costScore / 3))} sub={`${costScore}/9`} />
            <Stat label="priority layer" value={['STT', 'LLM', 'TTS'][w.indexOf(Math.max(...w))]} tone="good" />
          </div>
          <Button variant="primary" icon={<ArrowRight size={14} />} onClick={load}>Load this stack into the Live Agent</Button>
        </div>
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-[12.5px]">
            <thead><tr className="border-b border-line bg-inset text-left text-fg3"><th className="px-3 py-2 font-medium">Layer</th><th className="font-medium">Tier</th><th className="font-medium">What to choose</th><th className="pr-3 text-right font-medium">≈ ms</th></tr></thead>
            <tbody>
              {choice.map((c, i) => (
                <tr key={i} className="border-b border-line last:border-0 align-top">
                  <td className="px-3 py-2.5 font-semibold" style={{ color: ['var(--c-stt)', 'var(--c-llm)', 'var(--c-tts)'][i] }}>{['STT', 'LLM', 'TTS'][i]}</td>
                  <td className="py-2.5 pr-2"><Badge tone={c.name === 'Fast' ? 'good' : c.name === 'Balanced' || c.name === 'Natural' ? 'neutral' : 'warn'}>{c.name} {c.cost}</Badge></td>
                  <td className="py-2.5 pr-3 text-fg2">{c.detail}</td>
                  <td className="num py-2.5 pr-3 text-right">{c.ms}</td>
                </tr>
              ))}
              <tr className="bg-inset"><td className="px-3 py-2 text-fg3" colSpan={3}>+ endpointing {endpoint} ms + network {net} ms (fixed in this model)</td><td className="num pr-3 text-right font-semibold">{total}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-snug text-fg3">A speech-to-speech model forces one global compromise. A pipeline lets a booking agent buy a stronger LLM at the price of ~400 ms, while a triage line spends the same money on transcription accuracy and keeps the LLM lean.</p>
    </Card>
  )
}

/* ============================================================================================ */
function Ecosystem() {
  const { providers } = useMeta()
  const ok = (list: { id: string; available: boolean }[] | undefined, id: string) => list?.find((p) => p.id === id)?.available
  const rows: { layer: string; name: string; id?: string; list?: 'stt' | 'llm' | 'tts'; good: string; color: string }[] = [
    { layer: 'VAD', name: 'Silero', id: 'silero', good: 'tiny neural VAD, runs on CPU', color: 'var(--c-endpoint)' },
    { layer: 'STT', name: 'Whisper (local)', id: 'whisper-local', list: 'stt', good: 'free, offline; fine-grained model size choice', color: 'var(--c-stt)' },
    { layer: 'STT', name: 'OpenAI transcribe', id: 'openai', list: 'stt', good: 'accurate, buffered REST', color: 'var(--c-stt)' },
    { layer: 'STT', name: 'Deepgram', id: 'deepgram', list: 'stt', good: 'true streaming, telephony models', color: 'var(--c-stt)' },
    { layer: 'LLM', name: 'Ollama (local)', id: 'ollama', list: 'llm', good: 'private, zero cost, hardware-bound latency', color: 'var(--c-llm)' },
    { layer: 'LLM', name: 'Groq · Cerebras · Together', id: 'groq', list: 'llm', good: 'Llama-class models on ultra-fast inference', color: 'var(--c-llm)' },
    { layer: 'LLM', name: 'OpenAI', id: 'openai', list: 'llm', good: 'gpt-4o / mini – strong tool use', color: 'var(--c-llm)' },
    { layer: 'LLM', name: 'Anthropic', id: 'anthropic', list: 'llm', good: 'Anthropic models, strong tool use', color: 'var(--c-llm)' },
    { layer: 'TTS', name: 'Piper (local)', id: 'piper', list: 'tts', good: 'free, neural, ~60 ms TTFB on CPU', color: 'var(--c-tts)' },
    { layer: 'TTS', name: 'ElevenLabs', id: 'elevenlabs', list: 'tts', good: 'custom voice clones, expressive', color: 'var(--c-tts)' },
    { layer: 'TTS', name: 'OpenAI TTS', id: 'openai', list: 'tts', good: 'streaming PCM, simple', color: 'var(--c-tts)' },
    { layer: 'STT', name: 'VoiceStudio ASR (local)', id: 'voicestudio', list: 'stt', good: 'local MLX/whisper.cpp engines behind one OpenAI-style API', color: 'var(--c-stt)' },
    { layer: 'TTS', name: 'VoiceStudio (local)', id: 'voicestudio', list: 'tts', good: 'your cloned & designed voices, streamed sentence by sentence', color: 'var(--c-tts)' },
    { layer: 'TTS', name: 'macOS say', id: 'macos-say', list: 'tts', good: 'free baseline – and a non-streaming example', color: 'var(--c-tts)' },
  ]
  return (
    <Card title="Provider ecosystem" sub="what this project can talk to, and whether it’s available here" pad={false}>
      <div className="overflow-x-auto"><table className="w-full text-[12.5px]">
        <thead><tr className="border-b border-line text-left text-fg3"><th className="px-4 py-2 font-medium">Layer</th><th className="font-medium">Provider</th><th className="font-medium">Good for</th><th className="pr-4 font-medium">Here</th></tr></thead>
        <tbody>{rows.map((r) => {
          const on = !providers ? undefined : r.id === 'silero' ? ok(providers.vad, 'silero') : r.list ? ok(providers[r.list], r.id!) : undefined
          return <tr key={r.layer + r.name} className="border-b border-line last:border-0"><td className="px-4 py-2 font-semibold" style={{ color: r.color }}>{r.layer}</td><td className="py-2">{r.name}</td><td className="py-2 pr-3 text-fg2">{r.good}</td><td className="py-2 pr-4">{on === undefined ? '' : on ? <Badge tone="good">ready</Badge> : <Badge>needs key / install</Badge>}</td></tr>
        })}</tbody>
      </table></div>
    </Card>
  )
}
