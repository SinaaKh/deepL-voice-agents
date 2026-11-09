import { Check, Plus, Scissors, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type DatasetItem, type SimSegment, type Sweep, type TurnSim } from '../lib/api'
import { Badge, Card, Field, LessonTag, PageHeader, Segmented, Select, Slider, Stat, Button, cx, useWidth } from '../components/ui'

const wordsMs = (t: string) => Math.max(300, Math.round(t.trim().split(/\s+/).filter(Boolean).length * 290))

export default function TurnLab() {
  const [tab, setTab] = useState<'detect' | 'interrupt'>('detect')
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Turn-taking Lab" lessons={<><LessonTag n={3} /><LessonTag n={4} /></>}>
        Deciding when a person is <i>done</i> rather than merely <i>pausing</i> is one of the hardest problems in conversational AI. This lab runs the same turn-policy code as the live pipeline against scripted callers, so you can see
        exactly when a silence timer fires, when a semantic model extends it, and what a barge-in does to the conversation history.
      </PageHeader>
      <div className="mb-4 max-w-md"><Segmented value={tab} onChange={setTab} options={[{ value: 'detect', label: 'End-of-turn detection' }, { value: 'interrupt', label: 'Interruption & context sync' }]} /></div>
      {tab === 'detect' ? <Detect /> : <Interrupt />}
    </div>
  )
}

/* =============================================================================================
   End-of-turn detection
   ============================================================================================= */
function Detect() {
  const [dataset, setDataset] = useState<DatasetItem[]>([])
  const [pick, setPick] = useState(0)
  const [segments, setSegments] = useState<SimSegment[]>([])
  const [agentLast, setAgentLast] = useState('')
  const [mode, setMode] = useState<'vad' | 'semantic'>('semantic')
  const [timer, setTimer] = useState(500)
  const [maxDelay, setMaxDelay] = useState(2500)
  const [thr, setThr] = useState(0.5)
  const [res, setRes] = useState<TurnSim | null>(null)
  const [vadRes, setVadRes] = useState<TurnSim | null>(null)
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => { api.turnDataset().then((d) => { setDataset(d); setSegments(d[0].segments); setAgentLast(d[0].agent_last) }).catch((e) => setErr(String(e.message))) }, [])
  useEffect(() => {
    if (!segments.length) return
    const id = setTimeout(() => {
      const base = { segments, silence_timer_ms: timer, max_delay_ms: maxDelay, threshold: thr, agent_last: agentLast }
      api.turnSimulate({ ...base, mode }).then(setRes).catch((e) => setErr(String(e.message)))
      api.turnSimulate({ ...base, mode: 'vad' }).then(setVadRes).catch(() => {})
    }, 120)
    return () => clearTimeout(id)
  }, [segments, mode, timer, maxDelay, thr, agentLast])
  useEffect(() => { const id = setTimeout(() => api.turnSweep(maxDelay, thr).then(setSweep).catch(() => {}), 200); return () => clearTimeout(id) }, [maxDelay, thr])

  const choose = (i: number) => { setPick(i); setSegments(dataset[i].segments); setAgentLast(dataset[i].agent_last) }
  const upd = (i: number, patch: Partial<SimSegment>) => setSegments((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)))

  if (err) return <Card><p className="text-sm text-bad">Backend error: {err}</p></Card>
  return (
    <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title="Caller script">
          <div className="space-y-3">
            <Field label="Preset utterance"><Select value={String(pick)} onChange={(v) => choose(Number(v))} options={dataset.map((d, i) => ({ value: String(i), label: d.name }))} /></Field>
            <div className="space-y-1.5">
              {segments.map((s, i) => (
                <div key={i} className="rounded-lg border border-line p-2">
                  {s.kind === 'speech' ? (
                    <div className="flex items-center gap-2">
                      <Badge tone="accent">speech</Badge>
                      <input value={s.text} onChange={(e) => upd(i, { text: e.target.value, ms: wordsMs(e.target.value) })} className="min-w-0 flex-1 rounded-md border border-line-strong bg-inset px-2 py-1 text-xs outline-none focus:border-accent" />
                      <button aria-label="Remove" onClick={() => setSegments(segments.filter((_, k) => k !== i))} className="text-fg3 hover:text-bad"><Trash2 size={13} /></button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge>pause</Badge>
                        <span className="num text-xs">{s.ms} ms</span>
                        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-fg3">user will
                          <Segmented size="sm" value={s.intent ?? 'continue'} onChange={(v) => upd(i, { intent: v })} options={[{ value: 'continue', label: 'continue' }, { value: 'end', label: 'be done' }]} />
                        </div>
                        <button aria-label="Remove" onClick={() => setSegments(segments.filter((_, k) => k !== i))} className="text-fg3 hover:text-bad"><Trash2 size={13} /></button>
                      </div>
                      <Slider value={s.ms} min={100} max={3000} step={50} onChange={(v) => upd(i, { ms: v })} />
                    </div>
                  )}
                </div>
              ))}
              <div className="flex gap-1.5">
                <Button size="sm" icon={<Plus size={12} />} onClick={() => setSegments([...segments, { kind: 'speech', text: 'and then', ms: wordsMs('and then') }])}>Speech</Button>
                <Button size="sm" icon={<Plus size={12} />} onClick={() => setSegments([...segments, { kind: 'pause', ms: 800, intent: 'continue' }])}>Pause</Button>
              </div>
            </div>
            <Field label="Agent’s previous line" hint="The turn detector looks at the last few turns: a short reply to a question is complete even if it's only one word.">
              <input value={agentLast} onChange={(e) => setAgentLast(e.target.value)} placeholder="e.g. What time would you like?" className="w-full rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-xs outline-none focus:border-accent" />
            </Field>
          </div>
        </Card>

        <Card title="Turn policy">
          <div className="space-y-3.5">
            <Segmented value={mode} onChange={setMode} options={[{ value: 'vad', label: 'VAD timer only' }, { value: 'semantic', label: 'VAD + semantic' }]} />
            <Field label="Silence timer" value={`${timer} ms`} hint="Silence after the last speech frame before end-of-turn fires (min_endpointing_delay)."><Slider value={timer} min={100} max={2000} step={50} onChange={setTimer} /></Field>
            <Field label="Extended delay" value={`${maxDelay} ms`} hint="Used instead when the transcript looks unfinished (max_endpointing_delay)."><Slider disabled={mode === 'vad'} value={maxDelay} min={500} max={5000} step={100} onChange={setMaxDelay} /></Field>
            <Field label="Completeness threshold" value={thr.toFixed(2)}><Slider disabled={mode === 'vad'} value={thr} min={0.1} max={0.9} step={0.05} onChange={setThr} /></Field>
          </div>
        </Card>
      </div>

      <div className="min-w-0 space-y-4">
        {res && (
          <Card title="Timeline" sub="speech, silence timers and the moment the agent starts talking">
            <Timeline res={res} timer={timer} />
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="premature cut-offs" value={res.summary.cut_offs} tone={res.summary.cut_offs ? 'bad' : 'good'} sub={vadRes && mode === 'semantic' ? `VAD-only: ${vadRes.summary.cut_offs}` : undefined} />
              <Stat label="saved by semantics" value={res.summary.saved_by_semantic} tone={res.summary.saved_by_semantic ? 'good' : undefined} sub="mid-thought pauses held" />
              <Stat label="final EOU delay" value={res.summary.final_eou_delay_ms != null ? Math.round(res.summary.final_eou_delay_ms) : '—'} unit="ms" sub="wait after the user truly finished" />
              <Stat label="extra wait" value={Math.round(res.summary.extra_wait_ms)} unit="ms" tone={res.summary.extra_wait_ms ? 'warn' : undefined} sub="cost of being cautious" />
            </div>
          </Card>
        )}
        {res && <PauseTable res={res} />}
        {sweep && <Tradeoff sweep={sweep} mode={mode} timer={timer} />}
      </div>
    </div>
  )
}

function Timeline({ res, timer }: { res: TurnSim; timer: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const L = 78, R = 14
  const tail = Math.max(0, ...res.pauses.map((p) => (p.fire_at ?? p.start + p.waited_ms) + 600))
  const domain = Math.max(res.total_ms, tail, 1000)
  const x = (t: number) => L + (t / domain) * (w - L - R)
  const H = 188
  const step = domain > 9000 ? 2000 : domain > 4500 ? 1000 : 500
  const ticks: number[] = []
  for (let t = 0; t <= domain; t += step) ticks.push(t)
  return (
    <div ref={ref} className="w-full overflow-hidden">
      <svg width={w} height={H} role="img" aria-label="Turn-taking timeline">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="color-mix(in srgb, var(--warn) 18%, transparent)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--warn)" strokeWidth="2" /></pattern>
          <pattern id="hatchbad" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="color-mix(in srgb, var(--bad) 14%, transparent)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--bad)" strokeWidth="2" /></pattern>
        </defs>
        {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={6} y2={H - 22} stroke="var(--line)" /><text x={x(t)} y={H - 8} fontSize={10} textAnchor="middle" fill="var(--fg3)" className="num">{(t / 1000).toFixed(1)}s</text></g>)}
        {['Caller', 'Silence timer', 'Agent'].map((l, i) => <text key={l} x={L - 8} y={[34, 94, 152][i]} textAnchor="end" fontSize={11} fill="var(--fg2)">{l}</text>)}
        {/* speech */}
        {res.spans.map((s, i) => {
          const wd = x(s.end) - x(s.start)
          return (
            <g key={i}>
              <rect x={x(s.start)} y={18} width={Math.max(2, wd)} height={28} rx={6} fill="var(--c-endpoint)" opacity={0.9} />
              <clipPath id={`c${i}`}><rect x={x(s.start) + 4} y={18} width={Math.max(0, wd - 8)} height={28} /></clipPath>
              {wd > 50 && <text clipPath={`url(#c${i})`} x={x(s.start) + 6} y={36} fontSize={10.5} fill="#fff" fontWeight={500}>{s.text}</text>}
            </g>
          )
        })}
        {/* timers */}
        {res.pauses.map((p) => {
          const base = Math.min(timer, p.waited_ms)
          const ext = Math.max(0, p.waited_ms - timer)
          const end = p.start + p.waited_ms
          return (
            <g key={p.index}>
              <rect x={x(p.start)} y={78} width={Math.max(2, x(p.start + base) - x(p.start))} height={22} rx={5} fill="var(--c-endpoint)" opacity={0.55} />
              {ext > 0 && <rect x={x(p.start + timer)} y={78} width={Math.max(2, x(p.start + timer + ext) - x(p.start + timer))} height={22} rx={5} fill="url(#hatch)" stroke="var(--warn)" strokeWidth={1} />}
              <text x={x(p.start)} y={72} fontSize={10} fill="var(--fg2)" className="num">P(end)={p.p_eot.toFixed(2)}</text>
              {p.outcome === 'held' && <g><circle cx={x(end)} cy={89} r={9} fill="var(--good)" /><path d={`M${x(end) - 4} ${89} l3 3 l5 -6`} stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" /><text x={x(end)} y={116} fontSize={10} textAnchor="middle" fill="var(--good)" fontWeight={600}>{p.saved_by_semantic ? 'held ✓ saved' : 'resumed'}</text></g>}
              {p.outcome === 'cut_off' && <g><circle cx={x(end)} cy={89} r={9} fill="var(--bad)" /><path d={`M${x(end) - 4} ${85} l8 8 M${x(end) + 4} ${85} l-8 8`} stroke="#fff" strokeWidth={2} strokeLinecap="round" /><text x={x(end)} y={116} fontSize={10} textAnchor="middle" fill="var(--bad)" fontWeight={600}>cut off</text></g>}
              {p.outcome === 'ended' && <g><rect x={x(end) - 7} y={82} width={14} height={14} transform={`rotate(45 ${x(end)} 89)`} fill="var(--c-stt)" /><text x={x(end)} y={116} fontSize={10} textAnchor="middle" fill="var(--fg2)" fontWeight={600}>end of turn</text></g>}
            </g>
          )
        })}
        {/* agent */}
        {res.fires.map((f, i) => {
          const bad = f.outcome === 'cut_off'
          const x0 = x(f.t)
          return (
            <g key={i}>
              <rect x={x0} y={136} width={Math.max(40, Math.min(w - R - x0, x(Math.min(domain, f.t + 1400)) - x0))} height={24} rx={6} fill={bad ? 'url(#hatchbad)' : 'var(--c-llm)'} stroke={bad ? 'var(--bad)' : 'none'} strokeWidth={1} opacity={bad ? 1 : 0.85} />
              <text x={x0 + 7} y={152} fontSize={10.5} fill={bad ? 'var(--bad)' : '#fff'} fontWeight={600}>{bad ? 'talks over the caller' : 'agent replies'}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function PauseTable({ res }: { res: TurnSim }) {
  return (
    <Card title="Pause by pause" sub="what the detector saw and decided" pad={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead><tr className="border-b border-line text-left text-fg3"><th className="px-4 py-2 font-medium">#</th><th className="font-medium">Transcript so far</th><th className="font-medium">P(end)</th><th className="font-medium">Why</th><th className="font-medium">Timer</th><th className="pr-4 font-medium">Outcome</th></tr></thead>
          <tbody>
            {res.pauses.map((p, i) => (
              <tr key={p.index} className="border-b border-line last:border-0 align-top">
                <td className="num px-4 py-2">{i + 1}</td>
                <td className="max-w-[260px] py-2 pr-3 italic text-fg2">“{p.transcript || '…'}”</td>
                <td className="num py-2 pr-3">{p.p_eot.toFixed(2)}</td>
                <td className="max-w-[220px] py-2 pr-3 text-fg3">{p.reasons.join('; ')}</td>
                <td className="num py-2 pr-3 whitespace-nowrap">{Math.round(p.delay_ms)} ms{p.delay_ms > 0 && p.outcome === 'held' && <span className="text-fg3"> (user back at {Math.round(p.duration)})</span>}</td>
                <td className="py-2 pr-4">
                  {p.outcome === 'held' && <Badge tone="good"><Check size={11} />{p.saved_by_semantic ? 'held — would have cut in with VAD only' : 'user resumed in time'}</Badge>}
                  {p.outcome === 'cut_off' && <Badge tone="bad"><X size={11} />cut off — user was mid-thought</Badge>}
                  {p.outcome === 'ended' && <Badge tone={p.extra_wait_ms > 0 ? 'warn' : 'neutral'}>turn ended{p.extra_wait_ms > 0 ? ` · waited ${Math.round(p.extra_wait_ms)} ms longer than needed` : ''}</Badge>}
                </td>
              </tr>
            ))}
            {res.pauses.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-fg3">Add a pause to the script.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** Cut-off rate vs. wait time for the whole labelled dataset, VAD-only vs. VAD+semantic. */
function Tradeoff({ sweep, mode, timer }: { sweep: Sweep; mode: 'vad' | 'semantic'; timer: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ m: 'vad' | 'semantic'; i: number } | null>(null)
  const H = 250, L = 46, B = 38, T = 12, R = 16
  const all = [...sweep.series.vad, ...sweep.series.semantic]
  const xMax = Math.max(...all.map((p) => p.mean_end_delay_ms)) * 1.05
  const yMax = Math.max(0.3, ...all.map((p) => p.cut_off_rate)) * 1.1
  const xs = (v: number) => L + (v / xMax) * (w - L - R)
  const ys = (v: number) => T + (1 - v / yMax) * (H - T - B)
  const series: { m: 'vad' | 'semantic'; label: string; color: string; dash?: string }[] = [
    { m: 'vad', label: 'VAD timer only', color: 'var(--c-neutral)', dash: '5 4' },
    { m: 'semantic', label: 'VAD + semantic', color: 'var(--c-endpoint)' },
  ]
  const cur = sweep.series[mode].reduce((a, p) => (Math.abs(p.timer_ms - timer) < Math.abs(a.timer_ms - timer) ? p : a))
  return (
    <Card title="The trade-off" sub={`${sweep.utterances} labelled utterances · swept silence timer 200 → 1500 ms`} right={<LessonTag n={3} />}>
      <div ref={ref} className="relative">
        <svg width={w} height={H} role="img" aria-label="Cut-off rate versus mean wait time">
          {[0, 0.25, 0.5, 0.75, 1].filter((v) => v <= yMax).map((v) => <g key={v}><line x1={L} x2={w - R} y1={ys(v)} y2={ys(v)} stroke="var(--line)" /><text x={L - 6} y={ys(v) + 3} textAnchor="end" fontSize={10} fill="var(--fg3)" className="num">{Math.round(v * 100)}%</text></g>)}
          {[200, 400, 600, 800, 1000, 1200, 1400, 1600].filter((v) => v <= xMax).map((v) => <g key={v}><line x1={xs(v)} x2={xs(v)} y1={T} y2={H - B} stroke="var(--line)" /><text x={xs(v)} y={H - B + 14} textAnchor="middle" fontSize={10} fill="var(--fg3)" className="num">{v}</text></g>)}
          <text x={(L + w - R) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--fg2)">mean wait after the caller really finished (ms) → slower</text>
          <text transform={`translate(12 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="var(--fg2)">premature cut-offs ↑ worse</text>
          {series.map((s) => (
            <g key={s.m}>
              <polyline fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} points={sweep.series[s.m].map((p) => `${xs(p.mean_end_delay_ms)},${ys(p.cut_off_rate)}`).join(' ')} />
              {sweep.series[s.m].map((p, i) => (
                <g key={i} onMouseEnter={() => setHover({ m: s.m, i })} onMouseLeave={() => setHover(null)}>
                  <circle cx={xs(p.mean_end_delay_ms)} cy={ys(p.cut_off_rate)} r={12} fill="transparent" />
                  <circle cx={xs(p.mean_end_delay_ms)} cy={ys(p.cut_off_rate)} r={3.5} fill={s.color} stroke="var(--surface)" strokeWidth={1.5} />
                </g>
              ))}
            </g>
          ))}
          <circle cx={xs(cur.mean_end_delay_ms)} cy={ys(cur.cut_off_rate)} r={8} fill="none" stroke="var(--c-stt)" strokeWidth={2.5} />
          <text x={xs(cur.mean_end_delay_ms) + 11} y={ys(cur.cut_off_rate) - 8} fontSize={11} fill="var(--c-stt)" fontWeight={600}>your setting</text>
          <text x={xs(sweep.series.semantic[3].mean_end_delay_ms) + 8} y={ys(sweep.series.semantic[3].cut_off_rate) + 16} fontSize={11} fill="var(--c-endpoint)" fontWeight={600}>VAD + semantic</text>
          <text x={xs(sweep.series.vad[1].mean_end_delay_ms) + 8} y={ys(sweep.series.vad[1].cut_off_rate) - 6} fontSize={11} fill="var(--fg2)" fontWeight={600}>VAD timer only</text>
        </svg>
        {hover && (() => { const p = sweep.series[hover.m][hover.i]; return <div className="pointer-events-none absolute left-14 top-2 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[11px] shadow-lg"><b>{hover.m === 'vad' ? 'VAD timer only' : 'VAD + semantic'}</b> · timer {p.timer_ms} ms<br />cut-offs {p.cut_offs}/{p.pauses} ({Math.round(p.cut_off_rate * 100)}%) · mean wait <span className="num">{Math.round(p.mean_end_delay_ms)}</span> ms</div> })()}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-fg2">Every point is one silence-timer setting. A pure timer forces a choice: wait long (slow) or cut people off (rude). Reading the transcript lets the semantic detector keep the timer <i>short</i> when the thought is complete and <i>extend</i> it only when it isn’t, moving the curve down-and-left. The remaining cut-offs are grammatically complete clauses followed by more speech — no text-only model can see those coming.</p>
    </Card>
  )
}

/* =============================================================================================
   Interruption + context synchronisation
   ============================================================================================= */
const SAMPLE = [
  'We have a variety of Italian dishes tonight.',
  'The short rib ragu is made with fresh pappardelle.',
  'For starters, the burrata with roasted tomatoes is a favourite.',
  'We also keep several vegetarian and gluten free options.',
  'Desserts are made in house, and the tiramisu is the one people come back for.',
]

function Interrupt() {
  const [sents, setSents] = useState(SAMPLE)
  const durs = useMemo(() => sents.map((s) => wordsMs(s) * 1.25), [sents])
  const total = durs.reduce((a, b) => a + b, 0)
  const [at, setAt] = useState(Math.round(total * 0.38))
  const [out, setOut] = useState<{ heard: string; unheard: string; current: number } | null>(null)
  const [ref, w] = useWidth<HTMLDivElement>()
  useEffect(() => { const id = setTimeout(() => api.interruptSimulate({ sentences: sents.map((t, i) => ({ text: t, dur_ms: durs[i] })), played_ms: at }).then(setOut).catch(() => {}), 80); return () => clearTimeout(id) }, [sents, durs, at])
  let acc = 0
  const x = (t: number) => (t / total) * (w - 2)
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card title="What the user actually heard" sub="drag the barge-in point" right={<LessonTag n={3}>timestamp sync</LessonTag>}>
          <div ref={ref}>
            <svg width={w} height={92} role="img" aria-label="Agent speech timeline with interruption marker">
              {durs.map((d, i) => {
                const x0 = x(acc); acc += d
                const heard = at >= acc - 1, partial = !heard && at > acc - d
                return (
                  <g key={i}>
                    <rect x={x0 + 1} y={14} width={Math.max(2, x(d) - 3)} height={34} rx={6} fill={heard ? 'var(--c-play)' : 'var(--inset)'} stroke="var(--line-strong)" opacity={heard ? 0.85 : 1} />
                    {partial && <rect x={x0 + 1} y={14} width={Math.max(0, x(at - (acc - d)) - 1)} height={34} rx={6} fill="var(--c-play)" opacity={0.85} />}
                    <text x={x0 + x(d) / 2} y={36} fontSize={11} fontWeight={600} textAnchor="middle" fill={heard ? '#fff' : 'var(--fg2)'}>S{i + 1}</text>
                    <text x={x0 + x(d) / 2} y={64} fontSize={10} textAnchor="middle" fill="var(--fg3)" className="num">{(d / 1000).toFixed(1)}s</text>
                  </g>
                )
              })}
              <line x1={x(at)} x2={x(at)} y1={6} y2={54} stroke="var(--bad)" strokeWidth={2} />
              <text x={Math.min(w - 90, x(at) + 5)} y={10} fontSize={10.5} fill="var(--bad)" fontWeight={600}>✂ user barges in</text>
              <text x={0} y={86} fontSize={10} fill="var(--fg3)">0 s</text><text x={w - 2} y={86} fontSize={10} fill="var(--fg3)" textAnchor="end">{(total / 1000).toFixed(1)} s</text>
            </svg>
          </div>
          <Slider value={at} min={0} max={Math.round(total)} step={50} onChange={setAt} />
          <div className="mt-1 flex items-center justify-between text-xs text-fg3"><span>interrupt at <b className="num text-fg">{(at / 1000).toFixed(2)} s</b> of audio played</span><span>sentence S{out ? Math.max(1, out.current + 1) : '–'} in progress</span></div>
        </Card>
        <Card title="Agent’s response (5 sentences, synthesised ahead of playback)">
          <ol className="space-y-1.5">{sents.map((s, i) => <li key={i} className="flex gap-2 text-xs"><span className="num w-6 shrink-0 text-fg3">S{i + 1}</span><input value={s} onChange={(e) => setSents(sents.map((x, k) => (k === i ? e.target.value : x)))} className="min-w-0 flex-1 rounded-md border border-line bg-inset px-2 py-1 outline-none focus:border-accent" /></li>)}</ol>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="History handed to the LLM">
          <div className="space-y-3 text-xs">
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-good"><Check size={13} />Synced to playback (what LiveKit does)</div>
              <div className="rounded-lg bg-inset p-2.5 leading-snug">{out?.heard || <i className="text-fg3">(nothing heard yet)</i>}</div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-bad"><Scissors size={13} />Naïve: whole response assumed delivered</div>
              <div className="rounded-lg bg-inset p-2.5 leading-snug">{sents.join(' ')}</div>
            </div>
            <div className="rounded-lg border border-line p-2.5 leading-snug text-fg2">
              <b className="text-fg">Why it matters.</b> If the caller now asks <i>“wait, what was the last thing you said?”</i>, a naïve history makes the model answer about {sents.length > 0 ? `“${sents[sents.length - 1].slice(0, 44)}…”` : 'text'} — words the caller never heard. A synced history makes it repeat {out?.heard ? `“…${out.heard.slice(-40)}”` : 'from the start'}.
            </div>
            {out?.unheard && <div><div className="mb-1 font-semibold text-fg3">Dropped (generated, never heard)</div><div className="rounded-lg bg-inset p-2.5 leading-snug text-fg3 line-through decoration-bad/60">{out.unheard}</div></div>}
          </div>
        </Card>
        <Card title="How it works" pad>
          <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-snug text-fg2">
            <li>VAD hears <b>speech while the agent is talking</b> → interruption event.</li>
            <li>Cancel LLM inference, cancel TTS synthesis, drop queued audio, stop client playout.</li>
            <li>Ask the client how many <b>audio milliseconds actually played</b> (LiveKit uses WebRTC packet timestamps; the Live Agent uses its AudioContext clock).</li>
            <li>Map that position onto each sentence’s slice of the audio timeline and truncate the transcript at the word boundary.</li>
          </ol>
        </Card>
      </div>
    </div>
  )
}
