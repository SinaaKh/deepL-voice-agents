import { useEffect, useMemo, useRef, useState } from 'react'
import { store, useSession, vadRing } from '../lib/session'
import type { BreakdownItem, Span, TurnMetrics } from '../lib/types'
import { fmtMs, HUMAN, STAGE, useWidth, cx } from './ui'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'

/* ============================================================================================
   VAD trace – the last ~15 s of Silero speech-probability, with the activation threshold, the
   debounced speech segments, and turn events (EOT / resumed / interrupt) marked on the timeline.
   ============================================================================================ */
export function VadTrace({ threshold, height = 120 }: { threshold: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const thr = useRef(threshold)
  thr.current = threshold
  useEffect(() => {
    const cv = ref.current!
    const ctx = cv.getContext('2d')!
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const line = css('--line'), accent = css('--c-endpoint'), neutral = css('--c-neutral'), fg3 = css('--fg3')
      const padB = 14, H = h - padB
      // grid
      ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.setLineDash([])
      for (const f of [0, 0.5, 1]) { const y = H - f * (H - 4) - 0; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }
      const n = vadRing.count
      if (n < 2) { ctx.fillStyle = fg3; ctx.font = '11px Inter, sans-serif'; ctx.fillText('VAD idle – start a session', 8, h / 2); return }
      const WIN = 15000
      const tNow = vadRing.t[(vadRing.head - 1 + vadRing.N) % vadRing.N]
      const X = (t: number) => w - ((tNow - t) / WIN) * w
      const idx = (k: number) => (vadRing.head - n + k + vadRing.N) % vadRing.N
      // speech bands
      ctx.fillStyle = accent + '22'
      let start = -1
      for (let k = 0; k <= n; k++) {
        const on = k < n && vadRing.sp[idx(k)] === 1
        if (on && start < 0) start = k
        if (!on && start >= 0) { const x0 = X(vadRing.t[idx(start)]), x1 = X(vadRing.t[idx(k - 1)]); ctx.fillRect(x0, 0, Math.max(2, x1 - x0), H); start = -1 }
      }
      // rms area
      ctx.beginPath(); ctx.moveTo(X(vadRing.t[idx(0)]), H)
      for (let k = 0; k < n; k++) ctx.lineTo(X(vadRing.t[idx(k)]), H - vadRing.rms[idx(k)] * (H - 4))
      ctx.lineTo(X(vadRing.t[idx(n - 1)]), H); ctx.closePath(); ctx.fillStyle = neutral + '55'; ctx.fill()
      // probability
      ctx.beginPath()
      for (let k = 0; k < n; k++) { const x = X(vadRing.t[idx(k)]), y = H - vadRing.p[idx(k)] * (H - 4); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y) }
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke()
      // threshold
      ctx.setLineDash([5, 4]); ctx.strokeStyle = css('--warn'); ctx.lineWidth = 1
      const ty = H - thr.current * (H - 4); ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = css('--warn'); ctx.font = '10px JetBrains Mono, monospace'; ctx.fillText(`threshold ${thr.current.toFixed(2)}`, 6, ty - 3)
      // markers
      vadRing.markers = vadRing.markers.filter((m) => tNow - m.t < WIN + 500)
      for (const m of vadRing.markers) {
        const x = X(m.t)
        if (x < 0) continue
        const col = m.kind === 'interrupt' ? css('--bad') : m.kind === 'saved' ? css('--good') : m.kind === 'eot' ? css('--c-stt') : m.kind === 'resume' ? css('--fg3') : null
        if (!col) continue
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
        ctx.font = '10px Inter, sans-serif'
        const label = { interrupt: 'barge-in', saved: 'held ✓', eot: 'end of turn', resume: 'resumed' }[m.kind]
        ctx.fillText(label!, Math.min(w - 52, x + 3), 11)
      }
      // time axis
      ctx.fillStyle = fg3; ctx.font = '10px JetBrains Mono, monospace'
      for (const s of [0, 5, 10, 15]) { const x = w - (s * 1000 / WIN) * w; ctx.fillText(s === 0 ? 'now' : `-${s}s`, Math.max(2, Math.min(w - 26, x - (s ? 12 : 22))), h - 2) }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} style={{ width: '100%', height }} className="block rounded-lg bg-inset" role="img" aria-label="Voice activity detection probability over the last 15 seconds" />
}

/* ============================================================================================
   Turn-timer countdown – VAD says "silence", the timer counts down to end-of-turn. When the
   semantic model thinks the user is mid-thought the bar is *extended* (hatched section).
   ============================================================================================ */
export function TurnTimerBar() {
  const timer = useSession((s) => s.timer)
  const mode = useSession((s) => s.config?.turn.mode)
  const [, tick] = useState(0)
  const running = timer && (timer.phase === 'started' || timer.phase === 'updated')
  useEffect(() => {
    if (!running) return
    let raf = 0
    const loop = () => { tick((x) => x + 1); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running])
  if (!timer) return <div className="rounded-lg bg-inset px-3 py-2 text-xs text-fg3">Silence timer – speak, then pause: the countdown to “end of turn” appears here.</div>
  const delay = timer.delay_ms ?? 0, base = timer.base_ms ?? delay
  const t0 = (timer.deadline_t ?? 0) - delay
  const elapsed = timer.phase === 'fired' ? delay : running ? Math.min(delay, performance.now() - store.toClient(t0)) : 0
  const frac = delay ? Math.max(0, Math.min(1, elapsed / delay)) : 0
  const baseFrac = delay ? base / delay : 1
  const resumed = timer.phase === 'resumed'
  return (
    <div className="rounded-lg bg-inset px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">Silence timer</span>
        <span className="num text-fg2">{Math.round(Math.min(elapsed, delay))} / {Math.round(delay)} ms</span>
        {timer.p_eot != null && <span className="text-fg3">P(end of turn) <span className="num text-fg">{timer.p_eot.toFixed(2)}</span></span>}
        {timer.extended && !resumed && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn">extended – thought looks unfinished</span>}
        {resumed && <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium', timer.saved ? 'bg-good/15 text-good' : 'bg-inset text-fg2')}>{timer.saved ? 'user resumed – semantic hold saved the turn' : 'user resumed before the timer'}</span>}
        {timer.phase === 'fired' && <span className="rounded bg-stt/15 px-1.5 py-0.5 text-[11px] font-medium text-stt">end-of-turn fired</span>}
        {timer.stale && <span className="text-[11px] text-warn">STT lag</span>}
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-line">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${frac * 100}%`, background: resumed ? 'var(--c-neutral)' : 'var(--c-endpoint)' }} />
        {delay > base && <div className="absolute inset-y-0" style={{ left: `${baseFrac * 100}%`, right: 0, background: 'repeating-linear-gradient(45deg, color-mix(in srgb, var(--warn) 35%, transparent) 0 4px, transparent 4px 8px)' }} />}
        <div className="absolute inset-y-0 w-px bg-fg/60" style={{ left: `${baseFrac * 100}%` }} title="base silence timer" />
      </div>
      {timer.reasons && timer.reasons.length > 0 && <div className="mt-1.5 text-[11px] text-fg3">{mode === 'vad' ? '' : 'Why: '}{timer.reasons.join(' · ')}</div>}
      {timer.text && <div className="mt-0.5 truncate text-[11px] italic text-fg3">“{timer.text}”</div>}
    </div>
  )
}

/* ============================================================================================
   Latency breakdown (critical path to first audio) as one stacked bar, plus human baseline ticks
   ============================================================================================ */
export function LatencyBar({ items, total, showScale = true }: { items: BreakdownItem[]; total: number; showScale?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const domain = Math.max(total * 1.04, 1650)
  const segs = items.filter((i) => i.ms > 0.5)
  let acc = 0
  const x = (v: number) => (v / domain) * w
  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={showScale ? 82 : 48} role="img" aria-label={`Response latency ${Math.round(total)} milliseconds`}>
        {segs.map((s) => {
          const x0 = x(acc); acc += s.ms
          const wd = Math.max(1, x(s.ms) - 2)
          const meta = STAGE[s.stage] ?? STAGE.other
          return (
            <g key={s.stage}>
              <rect x={x0} y={20} width={wd} height={20} rx={4} fill={meta.color}><title>{`${meta.label}: ${Math.round(s.ms)} ms`}</title></rect>
              {wd > 40 && <text x={x0 + wd / 2} y={34} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff" style={{ pointerEvents: 'none' }}>{Math.round(s.ms)}</text>}
            </g>
          )
        })}
        <line x1={x(total)} x2={x(total)} y1={16} y2={42} stroke="var(--fg)" strokeWidth={1.5} />
        <text x={Math.min(w - 2, x(total) + 4)} y={12} fontSize={12} fontWeight={700} fill="var(--fg)" textAnchor={x(total) + 60 > w ? 'end' : 'start'} className="num">{fmtMs(total)}</text>
        {showScale && [
          { v: HUMAN.mean, t: 'human 236' }, { v: HUMAN.floor, t: 'pipeline floor 540' }, { v: HUMAN.typical, t: 'typical 1500' },
        ].map((r, i) => (
          <g key={r.v}>
            <line x1={x(r.v)} x2={x(r.v)} y1={14} y2={46} stroke="var(--fg3)" strokeDasharray="3 3" />
            <text x={x(r.v)} y={58 + (i % 2) * 12} textAnchor="middle" fontSize={10} fill="var(--fg3)">{r.t}</text>
          </g>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {segs.map((s) => {
          const meta = STAGE[s.stage] ?? STAGE.other
          return <span key={s.stage} className="inline-flex items-center gap-1.5 text-[11px] text-fg2"><i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: meta.color }} />{meta.label}<span className="num text-fg">{Math.round(s.ms)} ms</span></span>
        })}
      </div>
    </div>
  )
}

/* ============================================================================================
   Waterfall (Gantt) – every stage as a span on a shared time axis, t = 0 is "user stops talking".
   Streaming overlap is visible: STT runs *during* speech, TTS starts while the LLM still streams.
   ============================================================================================ */
const ROW_ORDER = ['user_speech', 'stt', 'endpointing', 'stt_final', 'llm_ttft', 'llm_stream', 'tool', 'tts_ttfb', 'tts_render', 'playout']
export function Waterfall({ m }: { m: TurnMetrics }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const spans = (m.spans ?? []).filter((s): s is Required<Span> => s.start != null && s.end != null) as (Span & { start: number; end: number })[]
  const rows = ROW_ORDER.filter((r) => spans.some((s) => s.stage === r))
  const L = 108, R = 10, rowH = 24, top = 22
  const lat = m.response_latency_ms ?? 0
  const tMin = Math.max(-900, Math.min(0, ...spans.map((s) => s.start))) - 40 // long speech bars are clipped on the left
  const tMax = Math.max(lat + 700, ...spans.filter((s) => s.stage !== 'playout').map((s) => s.end)) + 60
  const x = (t: number) => L + ((t - tMin) / (tMax - tMin)) * (w - L - R)
  const H = top + rows.length * rowH + 22
  const ticks = useMemo(() => {
    const span = tMax - tMin
    const step = [100, 200, 250, 500, 1000, 2000].find((s) => span / s <= Math.max(4, Math.floor((w - 118) / 64))) ?? 2000
    const out: number[] = []
    for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) out.push(t)
    return out
  }, [tMin, tMax, w])
  return (
    <div ref={ref} className="relative w-full">
      <svg width={w} height={H} role="img" aria-label="Latency waterfall for the last turn" onMouseLeave={() => setTip(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top - 4} y2={H - 16} stroke="var(--line)" />
            <text x={x(t)} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--fg3)" className="num">{t === 0 ? '0' : t}</text>
          </g>
        ))}
        {[{ v: HUMAN.mean, l: 'human 236' }, { v: HUMAN.floor, l: '540' }, { v: HUMAN.typical, l: '1500' }].map((r) => r.v < tMax && Math.abs(x(r.v) - x(0)) > 30 && (
          <g key={r.v}><line x1={x(r.v)} x2={x(r.v)} y1={top - 4} y2={H - 16} stroke="var(--fg3)" strokeDasharray="2 4" opacity={0.6} /><text x={x(r.v) + 3} y={10} fontSize={9} fill="var(--fg3)">{r.l}</text></g>
        ))}
        <line x1={x(0)} x2={x(0)} y1={top - 6} y2={H - 16} stroke="var(--fg2)" strokeWidth={1.5} />
        <text x={x(0) - 4} y={top - 9} textAnchor="end" fontSize={9} fill="var(--fg2)" fontWeight={600}>user stops</text>
        {lat > 0 && <><line x1={x(lat)} x2={x(lat)} y1={top - 6} y2={H - 16} stroke="var(--c-play)" strokeWidth={1.5} /><text x={x(lat) + 3} y={top + rows.length * rowH + 8} fontSize={10} fill="var(--c-play)" fontWeight={600}>agent speaks · {Math.round(lat)} ms</text></>}
        {rows.map((r, i) => {
          const y = top + i * rowH
          const meta = STAGE[r]
          return (
            <g key={r}>
              <text x={L - 8} y={y + 14} textAnchor="end" fontSize={11} fill="var(--fg2)">{meta.label}</text>
              {spans.filter((s) => s.stage === r).map((s, k) => {
                const x0 = x(Math.max(s.start, tMin)), x1 = Math.min(x(s.end), w - R)
                const clipped = x(s.end) > w - R
                const clippedL = s.start < tMin
                const dur = s.end - s.start
                return (
                  <g key={k} onMouseMove={(e) => { const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - b.left, y: e.clientY - b.top, text: `${meta.label}${s.label ? ' · ' + s.label : ''}: ${Math.round(s.start)} → ${Math.round(s.end)} ms (${Math.round(dur)} ms)` }) }}>
                    <rect x={x0} y={y + 3} width={Math.max(2, x1 - x0)} height={14} rx={3} fill={meta.color} opacity={r === 'playout' || r === 'user_speech' ? 0.55 : 1} />
                    {clipped && <text x={w - R - 2} y={y + 14} textAnchor="end" fontSize={10} fill="#fff">→</text>}
                    {clippedL && <text x={x0 + 4} y={y + 14} fontSize={10} fill="#fff">←</text>}
                    {x1 - x0 > 34 && !clipped && <text x={(x0 + x1) / 2} y={y + 14} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#fff" style={{ pointerEvents: 'none' }}>{Math.round(dur)}</text>}
                    {x1 - x0 <= 34 && <text x={x1 + 4} y={y + 14} fontSize={9.5} fill="var(--fg2)" style={{ pointerEvents: 'none' }}>{Math.round(dur)}</text>}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      {tip && <div className="pointer-events-none absolute z-10 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] shadow-lg" style={{ left: Math.min(tip.x + 10, w - 220), top: tip.y + 14 }}>{tip.text}</div>}
    </div>
  )
}

/* ============================================================================================
   Per-turn history – stacked critical path columns; the composition shows which stage dominates.
   ============================================================================================ */
export function LatencyHistory({ metrics, height = 150 }: { metrics: TurnMetrics[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const data = metrics.filter((m) => m.response_latency_ms != null).slice(-16)
  if (!data.length) return <div className="rounded-lg bg-inset px-3 py-6 text-center text-xs text-fg3">No completed turns yet.</div>
  const L = 34, B = 18, T = 8
  const maxV = Math.max(1700, ...data.map((d) => d.response_latency_ms!))
  const bw = Math.min(46, (w - L - 6) / data.length - 4)
  const y = (v: number) => T + (1 - v / maxV) * (height - T - B)
  return (
    <div ref={ref} className="relative w-full">
      <svg width={w} height={height} role="img" aria-label="Response latency per turn">
        {[0, 500, 1000, 1500].filter((v) => v <= maxV).map((v) => (
          <g key={v}><line x1={L} x2={w} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 5} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--fg3)" className="num">{v}</text></g>
        ))}
        <line x1={L} x2={w} y1={y(HUMAN.floor)} y2={y(HUMAN.floor)} stroke="var(--good)" strokeDasharray="4 4" />
        <text x={w - 2} y={y(HUMAN.floor) - 3} textAnchor="end" fontSize={9.5} fill="var(--good)">540 ms pipeline floor</text>
        <line x1={L} x2={w} y1={y(HUMAN.typical)} y2={y(HUMAN.typical)} stroke="var(--bad)" strokeDasharray="4 4" />
        <text x={w - 2} y={y(HUMAN.typical) - 3} textAnchor="end" fontSize={9.5} fill="var(--bad)">1.5 s typical unoptimised</text>
        {data.map((d, i) => {
          const x0 = L + 6 + i * (bw + 4)
          let acc = 0
          return (
            <g key={d.turn_id} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x0 - 2} y={T} width={bw + 4} height={height - T - B} fill="transparent" />
              {d.breakdown.filter((b) => b.ms > 0.5).map((b) => {
                const y1 = y(acc), y2 = y(acc + b.ms); acc += b.ms
                return <rect key={b.stage} x={x0} y={y2} width={bw} height={Math.max(1, y1 - y2 - 1.5)} rx={2} fill={(STAGE[b.stage] ?? STAGE.other).color} opacity={hover == null || hover === i ? 1 : 0.5} />
              })}
              <text x={x0 + bw / 2} y={height - 5} textAnchor="middle" fontSize={10} fill="var(--fg3)">#{d.turn_id}</text>
              {d.interrupted && <text x={x0 + bw / 2} y={y(d.response_latency_ms!) - 3} textAnchor="middle" fontSize={11} fill="var(--bad)">✂</text>}
            </g>
          )
        })}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute left-10 top-1 z-10 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[11px] shadow-lg">
          <div className="font-semibold">Turn #{data[hover].turn_id} · {fmtMs(data[hover].response_latency_ms)}</div>
          {data[hover].breakdown.filter((b) => b.ms > 0.5).map((b) => <div key={b.stage} className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm" style={{ background: (STAGE[b.stage] ?? STAGE.other).color }} />{(STAGE[b.stage] ?? STAGE.other).label}<span className="num ml-auto pl-3">{Math.round(b.ms)}</span></div>)}
        </div>
      )}
    </div>
  )
}
