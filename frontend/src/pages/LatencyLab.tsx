import { FlaskConical, Play, Square } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { LatencyBar } from '../components/charts'
import { Badge, Button, Card, Field, HUMAN, LessonTag, PageHeader, Segmented, Select, Slider, Stat, Toggle, cx, fmtMs, latencyVerdict, useWidth } from '../components/ui'
import { streamBenchmark } from '../lib/api'
import { useMeta } from '../lib/config'

/* =============================================================================================
   Budget model. Anchors that come straight from the course are marked "course"; the rest are
   plausible orders of magnitude ("estimate") – move the sliders to your own measurements.
   ============================================================================================= */
interface Budget { vad: number; endpointing: number; stt: number; ttft: number; chunk: number; ttfb: number; net: number }
const STAGES: { k: keyof Budget; label: string; stage: string; min: number; max: number; step: number; src: 'course' | 'estimate'; hint: string }[] = [
  { k: 'vad', label: 'VAD blocking', stage: 'endpointing', min: 0, max: 200, step: 5, src: 'course', hint: 'VAD is intentionally blocking: ~15–20 ms lost at the start of each utterance.' },
  { k: 'endpointing', label: 'End-of-turn wait', stage: 'endpointing', min: 50, max: 1500, step: 10, src: 'estimate', hint: 'Silence timer (+ semantic extension) before the agent decides you are done.' },
  { k: 'stt', label: 'STT finalise', stage: 'stt_final', min: 0, max: 1000, step: 10, src: 'estimate', hint: 'Streaming STT has the text nearly ready; buffered STT pays for the whole file.' },
  { k: 'ttft', label: 'LLM time-to-first-token', stage: 'llm_ttft', min: 100, max: 2500, step: 10, src: 'course', hint: 'gpt-4o ≈ 840 ms, gpt-4o-mini ≈ 420 ms (Lesson 5).' },
  { k: 'chunk', label: 'Wait for first sentence', stage: 'chunking', min: 0, max: 800, step: 10, src: 'estimate', hint: 'TTS gets complete sentences, so the first one has to finish streaming first.' },
  { k: 'ttfb', label: 'TTS time-to-first-byte', stage: 'tts_ttfb', min: 40, max: 1500, step: 10, src: 'estimate', hint: 'When the user physically hears the agent start. Total render time is secondary.' },
  { k: 'net', label: 'Network + playout', stage: 'transport', min: 0, max: 400, step: 10, src: 'estimate', hint: 'WebRTC round trip + client audio buffer.' },
]
const PRESETS: Record<string, { label: string; note: string; b: Budget }> = {
  floor: { label: 'Course best case', note: '≈ 540 ms – just inside 1σ of human response time', b: { vad: 20, endpointing: 120, stt: 40, ttft: 190, chunk: 40, ttfb: 80, net: 50 } },
  typical: { label: 'Typical unoptimised', note: '> 1.5 s – the “something is wrong” pause', b: { vad: 20, endpointing: 600, stt: 250, ttft: 840, chunk: 200, ttfb: 350, net: 80 } },
  gpt4o: { label: 'gpt-4o stack', note: 'TTFT 0.84 s (course)', b: { vad: 20, endpointing: 500, stt: 150, ttft: 840, chunk: 150, ttfb: 250, net: 60 } },
  mini: { label: 'gpt-4o-mini stack', note: 'TTFT 0.42 s (course) – same everything else', b: { vad: 20, endpointing: 500, stt: 150, ttft: 420, chunk: 150, ttfb: 250, net: 60 } },
}
const total = (b: Budget) => Object.values(b).reduce((a, v) => a + v, 0)
const items = (b: Budget) => [
  { stage: 'endpointing', ms: b.vad + b.endpointing }, { stage: 'stt_final', ms: b.stt }, { stage: 'llm_ttft', ms: b.ttft },
  { stage: 'chunking', ms: b.chunk }, { stage: 'tts_ttfb', ms: b.ttfb }, { stage: 'transport', ms: b.net },
]

/** Optimisation levers from Lesson 1 – each maps onto the stage it attacks. */
const LEVERS: { id: string; label: string; detail: string; src: 'course' | 'estimate'; apply: (b: Budget) => Budget }[] = [
  { id: 'mini', label: 'Smaller model (gpt-4o → gpt-4o-mini)', detail: 'TTFT 0.84 s → 0.42 s with similar quality for ordinary assistant queries.', src: 'course', apply: (b) => ({ ...b, ttft: Math.min(b.ttft, 420) }) },
  { id: 'fast', label: 'Ultra-fast inference provider (Groq, Cerebras…)', detail: 'Open models on inference-optimised hardware: TTFT in the 150–250 ms range.', src: 'course', apply: (b) => ({ ...b, ttft: Math.min(b.ttft, 190) }) },
  { id: 'self', label: 'Self-host a smaller / quantised model near the agent', detail: 'Removes provider queueing and a network hop.', src: 'course', apply: (b) => ({ ...b, ttft: Math.min(b.ttft, 300), net: Math.max(20, b.net - 20) }) },
  { id: 'prompt', label: 'Prompt for short, staged replies', detail: 'Fewer tokens before the first sentence ends ⇒ audio starts sooner.', src: 'course', apply: (b) => ({ ...b, chunk: Math.min(b.chunk, 80) }) },
  { id: 'stream', label: 'True streaming STT', detail: 'Transcribe while the user talks; finalisation is nearly free.', src: 'estimate', apply: (b) => ({ ...b, stt: Math.min(b.stt, 50) }) },
  { id: 'turn', label: 'Semantic turn detection with a shorter timer', detail: 'Short timer when the thought is complete, extended only when it isn’t.', src: 'estimate', apply: (b) => ({ ...b, endpointing: Math.min(b.endpointing, 280) }) },
  { id: 'tts', label: 'Low-TTFB streaming TTS model', detail: 'Optimise time-to-first-byte, not total render time.', src: 'estimate', apply: (b) => ({ ...b, ttfb: Math.min(b.ttfb, 110) }) },
  { id: 'webrtc', label: 'WebRTC + global mesh transport', detail: 'UDP, pacing, Opus, nearest-edge routing: −20…50 % network latency.', src: 'course', apply: (b) => ({ ...b, net: Math.round(b.net * 0.6) }) },
]

export default function LatencyLab() {
  const [tab, setTab] = useState<'budget' | 'measured'>('budget')
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Latency Lab" lessons={<><LessonTag n={1} /><LessonTag n={5} /></>}>
        A human answers in ~236 ms (σ ≈ 520 ms). A pipeline can’t beat ~540 ms and a naive one lands above 1.5 s. Build a budget stage by stage, flip the optimisations from the course on and off, then confirm with <b>measured</b> numbers from your own models.
      </PageHeader>
      <div className="mb-4 max-w-md"><Segmented value={tab} onChange={setTab} options={[{ value: 'budget', label: 'Budget & levers (model)' }, { value: 'measured', label: 'Measured A/B benchmark' }]} /></div>
      {tab === 'budget' ? <BudgetTab /> : <MeasuredTab />}
    </div>
  )
}

/* ============================================================================================ */
function HumanCurve({ ms }: { ms: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 150, L = 8, B = 28, T = 10
  const X = 3200
  const pdf = (x: number) => Math.exp(-0.5 * ((x - HUMAN.mean) / HUMAN.sd) ** 2)
  const xs = (v: number) => L + (Math.min(v, X) / X) * (w - L - 8)
  const ys = (v: number) => T + (1 - v) * (H - T - B)
  const pts = Array.from({ length: 81 }, (_, i) => (i / 80) * X)
  const area = `M ${xs(0)} ${ys(0)} ` + pts.map((x) => `L ${xs(x)} ${ys(pdf(x))}`).join(' ') + ` L ${xs(X)} ${ys(0)} Z`
  const bands = [{ a: 0, b: HUMAN.mean + HUMAN.sd, c: 'var(--good)', l: 'natural' }, { a: HUMAN.mean + HUMAN.sd, b: HUMAN.typical, c: 'var(--warn)', l: 'noticeable lag' }, { a: HUMAN.typical, b: X, c: 'var(--bad)', l: 'unnatural' }]
  return (
    <div ref={ref}>
      <svg width={w} height={H} role="img" aria-label="Human response-time distribution with your pipeline total marked">
        {bands.map((b) => <g key={b.l}><rect x={xs(b.a)} y={T} width={xs(b.b) - xs(b.a)} height={H - T - B} fill={b.c} opacity={0.09} /><text x={(xs(b.a) + xs(b.b)) / 2} y={T + 11} textAnchor="middle" fontSize={10} fill={b.c} fontWeight={600}>{b.l}</text></g>)}
        <path d={area} fill="var(--c-endpoint)" opacity={0.28} stroke="var(--c-endpoint)" />
        {[0, 500, 1000, 1500, 2000, 2500, 3000].map((t) => <g key={t}><line x1={xs(t)} x2={xs(t)} y1={H - B} y2={H - B + 4} stroke="var(--fg3)" /><text x={xs(t)} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--fg3)" className="num">{t}</text></g>)}
        {[{ v: HUMAN.mean, l: 'μ 236' }, { v: HUMAN.mean + HUMAN.sd, l: '+1σ 756' }, { v: HUMAN.floor, l: 'floor 540' }].map((m, i) => <g key={m.l}><line x1={xs(m.v)} x2={xs(m.v)} y1={T + 14} y2={H - B} stroke="var(--fg3)" strokeDasharray="3 3" /><text x={xs(m.v) + 3} y={H - B - 4 - i * 0} fontSize={9.5} fill="var(--fg3)" transform={`rotate(-90 ${xs(m.v) + 3} ${H - B - 4})`}>{m.l}</text></g>)}
        <line x1={xs(ms)} x2={xs(ms)} y1={T} y2={H - B} stroke="var(--fg)" strokeWidth={2} />
        <rect x={Math.min(w - 78, xs(ms) + 4)} y={T + 16} width={74} height={20} rx={4} fill="var(--fg)" /><text x={Math.min(w - 78, xs(ms) + 4) + 37} y={T + 30} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--surface)" className="num">{Math.round(ms)} ms</text>
        <text x={w - 10} y={H - 1} textAnchor="end" fontSize={10} fill="var(--fg3)">response time (ms) →</text>
      </svg>
    </div>
  )
}

function BudgetTab() {
  const [b, setB] = useState<Budget>(PRESETS.typical.b)
  const [preset, setPreset] = useState('typical')
  const [on, setOn] = useState<Record<string, boolean>>({})
  const optimized = useMemo(() => LEVERS.filter((l) => on[l.id]).reduce((acc, l) => l.apply(acc), b), [b, on])
  const t0 = total(b), t1 = total(optimized)
  const v = latencyVerdict(t1)
  // savings attributed one lever at a time, in list order
  const savings = useMemo(() => {
    let cur = b
    const out: Record<string, number> = {}
    for (const l of LEVERS) { if (!on[l.id]) continue; const nx = l.apply(cur); out[l.id] = total(cur) - total(nx); cur = nx }
    return out
  }, [b, on])
  const sel = (k: string) => { setPreset(k); setB(PRESETS[k].b); setOn({}) }
  const z = (t1 - HUMAN.mean) / HUMAN.sd
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title="Latency budget" sub="critical path from “user stops talking” to “first audio heard”">
          <div className="mb-3 flex flex-wrap gap-1.5">{Object.entries(PRESETS).map(([k, p]) => <Button key={k} size="sm" variant={preset === k ? 'primary' : 'default'} onClick={() => sel(k)}>{p.label}</Button>)}</div>
          <p className="mb-3 text-[11.5px] text-fg3">{PRESETS[preset]?.note}</p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {STAGES.map((s) => (
              <Field key={s.k} label={<span className="inline-flex items-center gap-1.5">{s.label}<Badge tone={s.src === 'course' ? 'accent' : 'neutral'}>{s.src}</Badge></span>} value={`${b[s.k]} ms`} hint={s.hint}>
                <Slider value={b[s.k]} min={s.min} max={s.max} step={s.step} onChange={(v) => { setB({ ...b, [s.k]: v }); setPreset('') }} />
              </Field>
            ))}
          </div>
        </Card>
        <Card title="Optimisation levers" sub="from Lesson 1 – tick to apply to the budget above">
          <ul className="divide-y divide-line">
            {LEVERS.map((l) => (
              <li key={l.id} className="flex items-start gap-3 py-2.5">
                <div className="pt-0.5"><Toggle checked={!!on[l.id]} onChange={(v) => setOn((o) => ({ ...o, [l.id]: v }))} /></div>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">{l.label}<Badge tone={l.src === 'course' ? 'accent' : 'neutral'}>{l.src}</Badge></div><div className="text-[11.5px] leading-snug text-fg3">{l.detail}</div></div>
                <div className={cx('num w-16 shrink-0 text-right text-sm', savings[l.id] ? 'font-semibold text-good' : 'text-fg3')}>{on[l.id] ? `−${Math.round(savings[l.id] || 0)}` : ''}<span className="text-[10px] font-normal"> {on[l.id] ? 'ms' : ''}</span></div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Result" right={<Badge tone={v.tone}>{v.text}</Badge>}>
          <div className="mb-3 grid grid-cols-3 gap-4">
            <Stat big label="Total" value={(t1 / 1000).toFixed(2)} unit="s" tone={v.tone} />
            <Stat label="vs. baseline" value={t1 === t0 ? '—' : `−${Math.round(t0 - t1)}`} unit={t1 === t0 ? '' : 'ms'} tone={t1 < t0 ? 'good' : undefined} sub={t1 === t0 ? 'no levers on' : `${Math.round((1 - t1 / t0) * 100)}% faster`} />
            <Stat label="vs. human mean" value={`${z >= 0 ? '+' : ''}${z.toFixed(1)}`} unit="σ" sub="(total − 236) / 520" />
          </div>
          <LatencyBar items={items(optimized)} total={t1} />
          {t1 !== t0 && <div className="mt-4"><div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg3">Before</div><LatencyBar items={items(b)} total={t0} showScale={false} /></div>}
        </Card>
        <Card title="Where that lands against a human" right={<LessonTag n={1}>236 ms · σ 520 ms</LessonTag>}>
          <HumanCurve ms={t1} />
          <p className="mt-2 text-[12px] leading-snug text-fg2">Conversational timing varies a lot between people and languages, so the human curve is wide. Staying within ~1σ (≈ 756 ms) feels natural; the course puts the practical pipeline floor at ≈ 540 ms and a typical unoptimised build above 1.5 s.</p>
        </Card>
      </div>
    </div>
  )
}

/* =============================================================================================
   Measured A/B benchmark – runs the same prompts through two LLM(+TTS) configurations
   ============================================================================================= */
interface Cfg { label: string; llm_provider: string; llm_model: string; mock_profile: string; tts_provider: string; voice_id: string }
interface Run { label: string; run: number; warmup: boolean; ttft_ms: number; tokens_per_second: number; first_sentence_ms: number; tts_ttfb_ms: number | null; time_to_first_audio_ms: number; model: string }
interface Summ { n: number; ttft_mean_ms: number; ttft_p50_ms: number; ttft_p95_ms: number; tps_mean: number; first_audio_mean_ms: number; tts_ttfb_mean_ms: number }

function MeasuredTab() {
  const { providers } = useMeta()
  const [a, setA] = useState<Cfg>({ label: 'gpt-4o', llm_provider: 'mock', llm_model: '', mock_profile: 'gpt-4o', tts_provider: 'mock', voice_id: '' })
  const [b, setB] = useState<Cfg>({ label: 'gpt-4o-mini', llm_provider: 'mock', llm_model: '', mock_profile: 'gpt-4o-mini', tts_provider: 'mock', voice_id: '' })
  const [runs, setRuns] = useState(5)
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle')
  const [rows, setRows] = useState<Run[]>([])
  const [summary, setSummary] = useState<Record<string, Summ> | null>(null)
  const [err, setErr] = useState('')
  const abort = useRef<AbortController | null>(null)
  const has = (id: string) => !!providers?.llm.find((p) => p.id === id)?.available

  const presets: { label: string; need?: string | null; apply: () => void }[] = [
    { label: 'Lesson 5 · gpt-4o vs mini (simulated)', apply: () => { setA({ ...a, label: 'gpt-4o', llm_provider: 'mock', mock_profile: 'gpt-4o', llm_model: '' }); setB({ ...b, label: 'gpt-4o-mini', llm_provider: 'mock', mock_profile: 'gpt-4o-mini', llm_model: '' }) } },
    { label: 'Lesson 5 · real OpenAI', need: has('openai') ? null : 'needs OPENAI_API_KEY', apply: () => { setA({ ...a, label: 'gpt-4o', llm_provider: 'openai', llm_model: 'gpt-4o' }); setB({ ...b, label: 'gpt-4o-mini', llm_provider: 'openai', llm_model: 'gpt-4o-mini' }) } },
    { label: 'Local Ollama vs fast-inference profile', need: has('ollama') ? null : 'Ollama not running', apply: () => { setA({ ...a, label: 'Ollama local', llm_provider: 'ollama', llm_model: providers?.llm.find((p) => p.id === 'ollama')?.default ?? '' }); setB({ ...b, label: 'fast-inference-70b (sim)', llm_provider: 'mock', mock_profile: 'fast-inference-70b', llm_model: '' }) } },
    { label: 'Streaming vs non-streaming TTS', apply: () => { const ttsA = providers?.tts.find((p) => p.id === 'piper')?.available ? 'piper' : 'mock'; const sayOk = providers?.tts.find((p) => p.id === 'macos-say')?.available; setA({ ...a, label: `TTS ${ttsA}`, llm_provider: 'mock', mock_profile: 'gpt-4o-mini', tts_provider: ttsA }); setB({ ...b, label: sayOk ? 'TTS macOS say' : 'TTS mock', llm_provider: 'mock', mock_profile: 'gpt-4o-mini', tts_provider: sayOk ? 'macos-say' : 'mock' }) } },
  ]

  const run = async () => {
    setRows([]); setSummary(null); setErr(''); setState('running')
    abort.current = new AbortController()
    try {
      await streamBenchmark({ configs: [a, b], runs, persona: 'restaurant', measure_tts: true }, (r) => {
        if (r.type === 'run') setRows((x) => [...x, r])
        else if (r.type === 'summary') setSummary(r.summary)
        else if (r.type === 'error') setErr(`${r.label}: ${r.message}`)
      }, abort.current.signal)
    } catch (e: any) { if (e.name !== 'AbortError') setErr(String(e.message ?? e)) }
    setState('done')
  }
  const stop = () => { abort.current?.abort(); setState('done') }

  const sA = summary?.[a.label], sB = summary?.[b.label]
  return (
    <div className="grid gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title="Experiment" icon={<FlaskConical size={14} />}>
          <div className="mb-3 space-y-1.5">{presets.map((p) => <Button key={p.label} size="sm" className="w-full !justify-start" disabled={!!p.need} title={p.need ?? ''} onClick={p.apply}>{p.label}</Button>)}</div>
          <CfgEditor title="A" c={a} set={setA} providers={providers} color="var(--c-endpoint)" />
          <div className="my-3 border-t border-line" />
          <CfgEditor title="B" c={b} set={setB} providers={providers} color="var(--c-stt)" />
          <div className="mt-4"><Field label="Runs per configuration" value={runs}><Slider value={runs} min={3} max={12} onChange={setRuns} /></Field></div>
          <div className="mt-3 flex gap-2">
            {state === 'running' ? <Button variant="danger" icon={<Square size={12} />} onClick={stop}>Stop</Button> : <Button variant="primary" icon={<Play size={12} />} onClick={run} disabled={!providers}>Run benchmark</Button>}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-fg3">Five short customer questions, streamed through each LLM, then the first sentence through TTS. The first run is a warm-up and excluded (cold connections / model load).</p>
          {err && <p className="mt-2 text-xs text-bad">{err}</p>}
        </Card>
      </div>

      <div className="min-w-0 space-y-4">
        <Card title="Time to first token" sub="per run, lower is better" right={state === 'running' ? <Badge tone="warn" className="pulse">running…</Badge> : undefined}>
          <DotPlot rows={rows} a={a.label} b={b.label} />
          {sA && sB && <Verdict a={a.label} b={b.label} sa={sA} sb={sB} />}
        </Card>
        {summary && (
          <Card title="Summary" pad={false}>
            <table className="w-full text-[12.5px]"><thead><tr className="border-b border-line text-left text-fg3"><th className="px-4 py-2 font-medium">metric</th><th className="font-semibold" style={{ color: 'var(--fg)' }}><Dot c="var(--c-endpoint)" />{a.label}</th><th className="font-semibold"><Dot c="var(--c-stt)" />{b.label}</th></tr></thead>
              <tbody>{([['TTFT mean', 'ttft_mean_ms', 'ms'], ['TTFT p50', 'ttft_p50_ms', 'ms'], ['TTFT p95', 'ttft_p95_ms', 'ms'], ['tokens / second', 'tps_mean', ''], ['TTS TTFB', 'tts_ttfb_mean_ms', 'ms'], ['time to first audio', 'first_audio_mean_ms', 'ms']] as const).map(([l, k, u]) => (
                <tr key={k} className="border-b border-line last:border-0"><td className="px-4 py-2 text-fg3">{l}</td><td className="num py-2">{sA ? `${Math.round(sA[k])}${u && ' ' + u}` : '—'}</td><td className="num py-2">{sB ? `${Math.round(sB[k])}${u && ' ' + u}` : '—'}</td></tr>))}</tbody></table>
          </Card>
        )}
        {!rows.length && state === 'idle' && <Card><p className="text-sm text-fg2">Pick a preset and press <b>Run benchmark</b>. The simulated profiles reproduce the course’s numbers (gpt-4o ≈ 0.84 s, gpt-4o-mini ≈ 0.42 s TTFT); point A and B at real providers to measure your own.</p></Card>}
      </div>
    </div>
  )
}
const Dot = ({ c }: { c: string }) => <i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: c }} />

function CfgEditor({ title, c, set, providers, color }: { title: string; c: Cfg; set: (c: Cfg) => void; providers: ReturnType<typeof useMeta>['providers']; color: string }) {
  const llm = providers?.llm.find((p) => p.id === c.llm_provider)
  const tts = providers?.tts.find((p) => p.id === c.tts_provider)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: color }}>{title}</span>
        <input value={c.label} onChange={(e) => set({ ...c, label: e.target.value })} className="min-w-0 flex-1 rounded-md border border-line-strong bg-inset px-2 py-1 text-xs font-medium outline-none focus:border-accent" /></div>
      <div className="grid grid-cols-2 gap-2">
        <Select value={c.llm_provider} onChange={(v) => { const p = providers?.llm.find((x) => x.id === v); set({ ...c, llm_provider: v, llm_model: v === 'mock' ? '' : p?.default ?? '' }) }} options={(providers?.llm ?? []).map((p) => ({ value: p.id, label: p.label + (p.available ? '' : ' (n/a)'), disabled: !p.available }))} />
        {c.llm_provider === 'mock'
          ? <Select value={c.mock_profile} onChange={(v) => set({ ...c, mock_profile: v })} options={Object.keys(llm?.profiles ?? {}).map((k) => ({ value: k, label: k }))} />
          : <Select value={c.llm_model || llm?.default || ''} onChange={(v) => set({ ...c, llm_model: v })} options={(llm?.models ?? []).map((m) => ({ value: m, label: m }))} />}
      </div>
      <Select value={c.tts_provider} onChange={(v) => set({ ...c, tts_provider: v, voice_id: providers?.tts.find((x) => x.id === v)?.default ?? '' })} options={(providers?.tts ?? []).map((p) => ({ value: p.id, label: 'TTS · ' + p.label + (p.available ? '' : ' (n/a)'), disabled: !p.available }))} />
      {tts && tts.streaming === false && <p className="text-[10.5px] text-warn">Non-streaming TTS: TTFB = time to render the whole sentence.</p>}
    </div>
  )
}

function DotPlot({ rows, a, b }: { rows: Run[]; a: string; b: string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<Run | null>(null)
  const real = rows.filter((r) => !r.warmup)
  const H = 210, L = 46, B = 28, T = 14, R = 74
  const maxV = Math.max(1000, ...rows.map((r) => r.ttft_ms)) * 1.1
  const n = Math.max(1, ...real.map((r) => r.run))
  const xs = (i: number) => L + ((i - 0.5) / Math.max(5, n)) * (w - L - R)
  const ys = (v: number) => T + (1 - v / maxV) * (H - T - B)
  const col = (l: string) => (l === a ? 'var(--c-endpoint)' : 'var(--c-stt)')
  const mean = (l: string) => { const x = real.filter((r) => r.label === l); return x.length ? x.reduce((s, r) => s + r.ttft_ms, 0) / x.length : null }
  return (
    <div ref={ref} className="relative">
      <svg width={w} height={H} role="img" aria-label="Time to first token for each run">
        {Array.from({ length: 5 }, (_, i) => (maxV / 4) * i).map((v) => <g key={v}><line x1={L} x2={w - R} y1={ys(v)} y2={ys(v)} stroke="var(--line)" /><text x={L - 6} y={ys(v) + 3} textAnchor="end" fontSize={10} fill="var(--fg3)" className="num">{Math.round(v)}</text></g>)}
        <text x={(L + w - R) / 2} y={H - 4} textAnchor="middle" fontSize={10.5} fill="var(--fg3)">run →</text>
        <text transform={`translate(11 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle" fontSize={10.5} fill="var(--fg3)">TTFT (ms)</text>
        {[a, b].map((l) => { const m = mean(l); return m == null ? null : <g key={l}><line x1={L} x2={w - R} y1={ys(m)} y2={ys(m)} stroke={col(l)} strokeDasharray="5 4" strokeWidth={1.5} /><text x={w - R + 6} y={ys(m) + 4} fontSize={11} fontWeight={700} fill="var(--fg)">{l}</text><text x={w - R + 6} y={ys(m) + 17} fontSize={11} fill="var(--fg2)" className="num">{Math.round(m)} ms</text></g> })}
        {real.map((r) => { const off = r.label === a ? -5 : 5; return <g key={r.label + r.run} onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)}><circle cx={xs(r.run) + off} cy={ys(r.ttft_ms)} r={13} fill="transparent" /><circle cx={xs(r.run) + off} cy={ys(r.ttft_ms)} r={5} fill={col(r.label)} stroke="var(--surface)" strokeWidth={2} /></g> })}
        {rows.length === 0 && <text x={w / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="var(--fg3)">no runs yet</text>}
      </svg>
      {hover && <div className="pointer-events-none absolute left-14 top-1 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[11px] shadow-lg"><b>{hover.label}</b> · run {hover.run}<br />TTFT <span className="num">{Math.round(hover.ttft_ms)} ms</span> · {Math.round(hover.tokens_per_second)} tok/s{hover.tts_ttfb_ms != null && <> · TTS TTFB <span className="num">{Math.round(hover.tts_ttfb_ms)}</span></>}<br /><span className="text-fg3">{hover.model}</span></div>}
    </div>
  )
}

function Verdict({ a, b, sa, sb }: { a: string; b: string; sa: Summ; sb: Summ }) {
  const fast = sa.ttft_mean_ms <= sb.ttft_mean_ms ? [a, sa, b, sb] as const : [b, sb, a, sa] as const
  const [fl, fs, sl, ss] = fast
  const saved = ss.ttft_mean_ms - fs.ttft_mean_ms
  return (
    <div className="mt-2 rounded-lg bg-inset px-3 py-2 text-[12.5px] leading-snug">
      <b>{fl}</b> reaches the first token <b className="text-good">{Math.round(saved)} ms sooner</b> ({(ss.ttft_mean_ms / Math.max(1, fs.ttft_mean_ms)).toFixed(1)}× faster than {sl}). In a voice agent that gap comes straight off the user’s waiting time — and everything after the first token (sentence → TTS) overlaps with generation.
    </div>
  )
}
