import { Pause, Play, RotateCcw, Shuffle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, Field, LessonTag, PageHeader, Segmented, Slider, Stat, Toggle, cx, fmtMs, useWidth } from '../components/ui'
import { httpTurn, payload, route, simulate, streamingTurn, type NetParams, type Server, type Sim, PKT_MS } from '../lib/transport'

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'

export default function TransportLab() {
  const [net, setNet] = useState<NetParams>({ rtt: 120, jitter: 25, loss: 4, burst: false, seconds: 5, jb: 60, seed: 7 })
  const sim = useMemo(() => simulate(net), [net])
  const set = (patch: Partial<NetParams>) => setNet((n) => ({ ...n, ...patch }))
  return (
    <div className="mx-auto max-w-[1280px] space-y-4">
      <PageHeader title="Transport Lab" lessons={<LessonTag n={2} />}>
        Voice agents trade <b>latency</b> against <b>reliability</b>. TCP guarantees every byte arrives, in order — which is exactly wrong for live audio. This lab sends the same audio over the same lossy network twice, as a WebSocket (TCP)
        and as WebRTC (UDP), so you can watch head-of-line blocking happen. <span className="text-fg3">Simulation: it illustrates the mechanism, it does not emulate a real network stack.</span>
      </PageHeader>

      <ProtocolTable />

      <Card title="Same network, two transports" sub="one 20 ms audio packet every 20 ms" right={<Badge>deterministic · seed {net.seed}</Badge>}>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="Round-trip time" value={`${net.rtt} ms`}><Slider value={net.rtt} min={20} max={400} step={10} onChange={(v) => set({ rtt: v })} /></Field>
          <Field label="Jitter" value={`${net.jitter} ms`}><Slider value={net.jitter} min={0} max={100} step={5} onChange={(v) => set({ jitter: v })} /></Field>
          <Field label="Packet loss" value={`${net.loss}%`}><Slider value={net.loss} min={0} max={15} step={0.5} onChange={(v) => set({ loss: v })} /></Field>
          <Field label="Jitter buffer" value={`${net.jb} ms`} hint="Playout delay both receivers add to absorb jitter. WebRTC's buffer is adaptive; this model keeps it fixed."><Slider value={net.jb} min={20} max={200} step={10} onChange={(v) => set({ jb: v })} /></Field>
          <div className="flex flex-col justify-end gap-2">
            <Toggle checked={net.burst} onChange={(v) => set({ burst: v })} label="Bursty loss (Wi-Fi, cellular)" />
            <Button size="sm" icon={<Shuffle size={12} />} onClick={() => set({ seed: Math.floor(Math.random() * 9999) + 1 })}>Re-roll network</Button>
          </div>
        </div>
        <div className="mt-4"><Lanes sim={sim} /></div>
        <StatsTable sim={sim} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Payload seconds={net.seconds} onSeconds={(v) => set({ seconds: v })} />
        <HttpVsStream rtt={net.rtt} seconds={net.seconds} />
      </div>
      <Mesh />
    </div>
  )
}

/* ============================================================================================= */
function ProtocolTable() {
  const rows: [string, string, string, string][] = [
    ['Underlying transport', 'TCP', 'TCP', 'UDP'],
    ['Connection model', 'Stateless: connect → send → disconnect', 'Stateful, long-lived, bidirectional', 'Stateful, long-lived, bidirectional media'],
    ['Lost / late packet', 'Retransmit; app waits', 'Retransmit; blocks everything behind it', 'App decides: skip, interpolate, conceal'],
    ['Built for audio?', 'No – buffer whole files client-side', 'No – no pacing, compression or timestamps', 'Yes – pacing, Opus compression (~3 % of the bytes), per-packet timestamps'],
    ['Interruptions', 'Hard (whole response in flight)', 'Possible, but you build the plumbing', 'Timestamps pinpoint exactly what was played'],
    ['Used in this project', '—  (the 1st-gen Siri/Alexa pattern)', 'Live Agent page (inspectable events)', 'LiveKit page (real WebRTC via LiveKit)'],
  ]
  return (
    <Card title="Application-layer protocols for voice" pad={false}>
      <div className="overflow-x-auto"><table className="w-full text-[12.5px]">
        <thead><tr className="border-b border-line text-left"><th className="px-4 py-2" /><th className="py-2 font-semibold">HTTP</th><th className="py-2 font-semibold">WebSocket</th><th className="py-2 pr-4 font-semibold" style={{ color: 'var(--c-play)' }}>WebRTC</th></tr></thead>
        <tbody>{rows.map(([a, b, c, d]) => <tr key={a} className="border-b border-line align-top last:border-0"><td className="px-4 py-2 text-fg3">{a}</td><td className="py-2 pr-3">{b}</td><td className="py-2 pr-3">{c}</td><td className="py-2 pr-4">{d}</td></tr>)}</tbody>
      </table></div>
    </Card>
  )
}

/* ============================================================================================
   Animated lanes
   ============================================================================================ */
function Lanes({ sim }: { sim: Sim }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const cv = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState('1')
  const [tShow, setTShow] = useState(0)
  const t = useRef(0)
  const simRef = useRef(sim); simRef.current = sim
  const playRef = useRef(playing); playRef.current = playing
  const spdRef = useRef(1); spdRef.current = Number(speed)
  useEffect(() => { t.current = 0 }, [sim])

  useEffect(() => {
    const c = cv.current!
    const ctx = c.getContext('2d')!
    let raf = 0, last = performance.now(), acc = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const dt = now - last; last = now
      const s = simRef.current
      if (playRef.current) { t.current += dt * spdRef.current; if (t.current > s.totalMs + 600) t.current = 0 }
      acc += dt; if (acc > 90) { acc = 0; setTShow(t.current) }
      const dpr = window.devicePixelRatio || 1
      const W = c.clientWidth, H = c.clientHeight
      if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H)
      paint(ctx, s, t.current, W)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div ref={ref}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={playing ? <Pause size={12} /> : <Play size={12} />} onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Play'}</Button>
        <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => { t.current = 0 }}>Restart</Button>
        <div className="w-44"><Segmented size="sm" value={speed} onChange={setSpeed} options={[{ value: '0.25', label: '¼×' }, { value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }]} /></div>
        <span className="num ml-auto text-xs text-fg3">t = {(tShow / 1000).toFixed(2)} s</span>
      </div>
      <canvas ref={cv} style={{ width: '100%', height: 292 }} className="block rounded-lg bg-inset" role="img" aria-label="Animated comparison of TCP head-of-line blocking and UDP packet delivery" />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg2">
        <Key c="var(--c-endpoint)" l="packet in flight" /><Key c="var(--bad)" l="lost" /><Key c="var(--warn)" l="retransmission" /><Key c="var(--c-neutral)" l="blocked behind a lost packet" />
        <Key c="var(--good)" l="played on time" /><Key c="var(--c-tool)" l="concealed glitch (UDP skips it)" /><Key c="var(--bad)" l="stall: playback frozen" bar />
      </div>
    </div>
  )
}
const Key = ({ c, l, bar }: { c: string; l: string; bar?: boolean }) => <span className="inline-flex items-center gap-1.5"><i className={cx('inline-block', bar ? 'h-2 w-4' : 'h-2.5 w-2.5')} style={{ background: c, borderRadius: 2 }} />{l}</span>

function paint(ctx: CanvasRenderingContext2D, s: Sim, t: number, W: number) {
  const col = { blue: css('--c-endpoint'), bad: css('--bad'), warn: css('--warn'), grey: css('--c-neutral'), good: css('--good'), glitch: css('--c-tool'), fg2: css('--fg2'), fg3: css('--fg3'), line: css('--line-strong'), surf: css('--surface') }
  const lanes: { key: 'tcp' | 'udp'; title: string; sub: string; y: number }[] = [
    { key: 'tcp', title: 'WebSocket · TCP', sub: 'reliable, in order', y: 0 },
    { key: 'udp', title: 'WebRTC · UDP', sub: 'jitter buffer + concealment', y: 146 },
  ]
  const xa = 20, xb = W - 150
  for (const L of lanes) {
    const y0 = L.y
    ctx.fillStyle = col.fg2; ctx.font = '600 12px Inter, sans-serif'; ctx.fillText(L.title, 10, y0 + 16)
    const titleW = ctx.measureText(L.title).width // measure while the bold title font is still set
    ctx.fillStyle = col.fg3; ctx.font = '11px Inter, sans-serif'; ctx.fillText(L.sub, 10 + titleW + 10, y0 + 16)
    const cy = y0 + 56
    ctx.strokeStyle = col.line; ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(xa, cy); ctx.lineTo(xb, cy); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = col.fg3; ctx.fillText('client', xa, cy + 34); ctx.textAlign = 'right'; ctx.fillText('server', W - 10, cy + 34); ctx.textAlign = 'left'
    // server receive buffer box
    ctx.strokeStyle = col.line; ctx.strokeRect(xb + 6, cy - 30, W - xb - 16, 60)
    ctx.fillStyle = col.fg3; ctx.font = '10px Inter, sans-serif'; ctx.fillText(L.key === 'tcp' ? 'receive queue' : 'jitter buffer', xb + 10, cy - 34)
    let blocked = 0, buffered = 0
    const sq = (x: number, y: number, c: string, a = 1) => { ctx.globalAlpha = a; ctx.fillStyle = c; ctx.fillRect(x - 3, y - 3, 6, 6); ctx.globalAlpha = 1 }
    if (L.key === 'tcp') {
      for (const p of s.tcp.pkts) {
        if (t < p.send || t > p.deliver + 400) continue
        const yy = cy + ((p.i % 3) - 1) * 9
        const lostFirst = p.retx > 0
        if (t <= p.first) {
          const f = (t - p.send) / (p.first - p.send)
          if (!lostFirst) sq(xa + f * (xb - xa), yy, col.blue)
          else if (f < 0.5) sq(xa + f * (xb - xa), yy, col.blue)
          else if (t - (p.send + (p.first - p.send) * 0.5) < 350) { ctx.fillStyle = col.bad; ctx.font = '700 12px Inter'; ctx.fillText('✕', xa + 0.5 * (xb - xa) - 4, yy + 4) }
        }
        if (lostFirst) {
          const rs = p.arrive - p.delay
          if (t >= rs && t < p.arrive) sq(xa + ((t - rs) / p.delay) * (xb - xa), yy, col.warn)
        }
        if (t >= p.arrive && t < p.deliver) { blocked++; if (blocked <= 40) sq(xb + 16 + ((blocked - 1) % 10) * 11, cy - 20 + Math.floor((blocked - 1) / 10) * 11, col.grey) }
      }
      if (blocked) { ctx.fillStyle = col.bad; ctx.font = '600 11px Inter, sans-serif'; ctx.fillText(`${blocked} blocked`, xb + 14, cy + 44) }
    } else {
      for (const p of s.udp.pkts) {
        if (t < p.send || t > p.deadline + 300) continue
        const yy = cy + ((p.i % 3) - 1) * 9
        if (p.arrive === null) {
          const half = p.send + p.delay * 0.5
          if (t < half) sq(xa + ((t - p.send) / p.delay) * (xb - xa), yy, col.blue)
          else if (t - half < 350) { ctx.fillStyle = col.bad; ctx.font = '700 12px Inter'; ctx.fillText('✕', xa + 0.5 * (xb - xa) - 4, yy + 4) }
        } else if (t < p.arrive) sq(xa + ((t - p.send) / p.delay) * (xb - xa), yy, col.blue)
        else if (t < p.deadline && !p.late) { buffered++; if (buffered <= 40) sq(xb + 16 + ((buffered - 1) % 10) * 11, cy - 20 + Math.floor((buffered - 1) / 10) * 11, col.good, 0.8) }
        else if (p.late && t < p.arrive + 350) sq(xb + 24, cy, col.glitch)
      }
      if (buffered) { ctx.fillStyle = col.fg2; ctx.font = '600 11px Inter, sans-serif'; ctx.fillText(`${buffered} buffered`, xb + 14, cy + 44) }
    }
    // playout strip
    const sy = y0 + 104, sh = 18, sx = xa, sw = W - 20 - xa
    const T = s.totalMs
    ctx.fillStyle = css('--surface'); ctx.fillRect(sx, sy, sw, sh)
    const cells = s[L.key].play
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      if (c.start > t) break
      ctx.fillStyle = c.kind === 'glitch' ? col.glitch : col.good
      ctx.fillRect(sx + (c.start / T) * sw, sy, Math.max(1, (PKT_MS / T) * sw), sh)
      if (k > 0) { const gap = c.start - cells[k - 1].end; if (gap > 3) { ctx.fillStyle = col.bad; ctx.fillRect(sx + (cells[k - 1].end / T) * sw, sy, Math.max(1, (gap / T) * sw), sh) } }
    }
    ctx.strokeStyle = col.line; ctx.strokeRect(sx, sy, sw, sh)
    ctx.fillStyle = col.fg3; ctx.font = '10px Inter, sans-serif'; ctx.fillText('what the listener hears', sx + 2, sy + sh + 11)
    ctx.strokeStyle = css('--fg'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sx + (Math.min(t, T) / T) * sw, sy - 3); ctx.lineTo(sx + (Math.min(t, T) / T) * sw, sy + sh + 3); ctx.stroke()
  }
}

function StatsTable({ sim }: { sim: Sim }) {
  const a = sim.tcp.stats, b = sim.udp.stats
  const row = (label: string, tcp: string, udp: string, hint: string, tcpBad?: boolean, udpBad?: boolean) => (
    <tr className="border-t border-line"><td className="py-1.5 pr-3 text-fg3" title={hint}>{label}</td><td className={cx('num py-1.5 pr-3', tcpBad && 'font-semibold text-bad')}>{tcp}</td><td className={cx('num py-1.5', udpBad && 'font-semibold text-warn')}>{udp}</td></tr>
  )
  return (
    <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-fg3"><th className="pb-1 font-medium" /><th className="pb-1 font-semibold text-fg">WebSocket · TCP</th><th className="pb-1 font-semibold text-fg">WebRTC · UDP</th></tr></thead>
        <tbody>
          {row('mouth-to-ear delay (mean)', fmtMs(a.mean), fmtMs(b.mean), 'time from the packet being captured to being heard')}
          {row('delay p95', fmtMs(a.p95), fmtMs(b.p95), '95th percentile')}
          {row('worst packet', fmtMs(a.max), fmtMs(b.max), 'max delay')}
          {row('playback freezes', `${a.stalls}  (${fmtMs(a.stallMs)})`, '0', 'audible stutters where the player ran dry', a.stalls > 0)}
          {row('concealed glitches', '0', `${b.glitches} of ${b.delivered} (${((b.glitches / b.delivered) * 100).toFixed(1)}%)`, 'lost or too-late 20 ms frames replaced by packet-loss concealment', false, b.glitches > 0)}
        </tbody>
      </table>
      <div className="rounded-lg bg-inset p-3 text-[12px] leading-relaxed text-fg2">
        {a.stalls > 0 ? (
          <><b className="text-fg">Head-of-line blocking.</b> One lost packet held back everything behind it for a full retransmit round-trip, so the receive queue filled up and then dumped in a burst — the player froze {a.stalls}× for {fmtMs(a.stallMs)} in total. UDP kept the timeline steady and just concealed {b.glitches} tiny {b.glitches === 1 ? 'gap' : 'gaps'}.</>
        ) : (
          <><b className="text-fg">No loss, no problem.</b> On a clean network TCP and UDP behave almost identically. Raise packet loss or switch on bursty loss and watch the left lane freeze while the right lane carries on.</>
        )}
        <div className="mt-1.5 text-fg3">With tens of thousands of packets per second across a call, a few slow or dropped ones are the norm, not the exception.</div>
      </div>
    </div>
  )
}

/* ============================================================================================ */
function Payload({ seconds, onSeconds }: { seconds: number; onSeconds: (v: number) => void }) {
  const [kbps, setKbps] = useState(24)
  const p = payload(seconds, kbps)
  const kb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${(b / 1e3).toFixed(1)} kB`)
  const p16 = payload(seconds, kbps, 16000)
  return (
    <Card title="Audio payload" right={<LessonTag n={2}>automatic compression</LessonTag>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Utterance length" value={`${seconds} s`}><Slider value={seconds} min={2} max={12} step={1} onChange={onSeconds} /></Field>
        <Field label="Opus bitrate" value={`${kbps} kbps`} hint="WebRTC picks and adapts this for you. Speech is typically 16–32 kbps."><Slider value={kbps} min={8} max={64} step={2} onChange={setKbps} /></Field>
      </div>
      <div className="mt-4 space-y-2.5">
        <Bar label="Raw PCM · 48 kHz 16-bit (what HTTP / WebSocket would send)" v={p.raw} max={p.raw} text={kb(p.raw)} color="var(--c-neutral)" />
        <Bar label={`WebRTC · Opus ${kbps} kbps`} v={p.opus} max={p.raw} text={`${kb(p.opus)}  ·  ${(p.ratio * 100).toFixed(1)}% of raw`} color="var(--c-play)" />
      </div>
      <p className="mt-3 text-[12px] leading-snug text-fg2">At 24 kbps, {seconds} s of speech shrinks to ≈ <b>{(p.ratio * 100).toFixed(0)}%</b> of its original size — the “3%” from the lesson. Against 16 kHz PCM (a leaner baseline) it is still {(p16.ratio * 100).toFixed(0)}%. Fewer bytes means less to retransmit and less to queue behind a slow link.</p>
    </Card>
  )
}
function Bar({ label, v, max, text, color }: { label: string; v: number; max: number; text: string; color: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-fg2">{label}</div>
      <div className="relative h-6 overflow-hidden rounded-md bg-inset"><div className="absolute inset-y-0 left-0 rounded-md" style={{ width: `${Math.max(1, (v / max) * 100)}%`, background: color }} /><span className="num absolute inset-y-0 left-2 flex items-center text-[11px] font-medium" style={{ color: v / max > 0.5 ? '#fff' : 'var(--fg)', paddingLeft: v / max > 0.5 ? 0 : `${(v / max) * 100}%` }}>{text}</span></div>
    </div>
  )
}

function HttpVsStream({ rtt, seconds }: { rtt: number; seconds: number }) {
  const [srv, setSrv] = useState<Server>({ stt: 450, llmTtft: 800, llmTotal: 2200, ttsTotal: 1300, ttfb: 150, endpointing: 500 })
  const http = httpTurn(rtt, seconds, srv)
  const str = streamingTurn(rtt, srv)
  const th = http.reduce((a, b) => a + b.ms, 0), ts = str.reduce((a, b) => a + b.ms, 0)
  const max = Math.max(th, ts)
  const colors = ['var(--c-endpoint)', 'var(--c-stt)', 'var(--c-llm)', 'var(--c-tool)', 'var(--c-chunk)', 'var(--c-tts)']
  const Row = ({ title, segs, total }: { title: string; segs: { label: string; ms: number; why: string }[]; total: number }) => (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs"><b>{title}</b><span className="num text-fg2">{fmtMs(total)} until the user hears anything</span></div>
      <div className="flex h-7 overflow-hidden rounded-md bg-inset" style={{ width: `${(total / max) * 100}%`, minWidth: 80 }}>
        {segs.map((s, i) => <div key={s.label} title={`${s.label}: ${Math.round(s.ms)} ms – ${s.why}`} style={{ width: `${(s.ms / total) * 100}%`, background: colors[i % colors.length], marginRight: 2 }} className="rounded-[3px]" />)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-fg2">{segs.map((s, i) => <span key={s.label} className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: colors[i % colors.length] }} />{s.label} <span className="num text-fg">{Math.round(s.ms)}</span></span>)}</div>
    </div>
  )
  return (
    <Card title="Request/response vs. streaming" right={<LessonTag n={2}>why early Siri felt slow</LessonTag>}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Field label="LLM TTFT" value={`${srv.llmTtft} ms`}><Slider value={srv.llmTtft} min={150} max={2000} step={50} onChange={(v) => setSrv({ ...srv, llmTtft: v, llmTotal: v + 1400 })} /></Field>
        <Field label="Endpointing" value={`${srv.endpointing} ms`}><Slider value={srv.endpointing} min={100} max={1500} step={50} onChange={(v) => setSrv({ ...srv, endpointing: v })} /></Field>
      </div>
      <div className="mt-4 space-y-4">
        <Row title="HTTP: record → upload → process everything → download" segs={http} total={th} />
        <Row title="WebRTC streaming: everything overlaps" segs={str} total={ts} />
      </div>
      <p className="mt-3 text-[12px] leading-snug text-fg2">The HTTP flow cannot start STT until the file is uploaded, cannot start TTS until the LLM has written the last word, and cannot start playing until the last byte is downloaded. Streaming over a persistent WebRTC connection overlaps every stage — only the first token and the first audio byte are on the critical path. <b className="text-fg">≈ {(th / ts).toFixed(1)}× faster</b> here.</p>
    </Card>
  )
}

/* ============================================================================================
   Public internet vs. private mesh
   ============================================================================================ */
function Mesh() {
  const [km, setKm] = useState(8000)
  const [cong, setCong] = useState(45)
  const r = route(km, cong)
  const inRange = r.reduction >= 0.2 && r.reduction <= 0.5
  const presets: [string, number][] = [['Same city', 50], ['Same region', 800], ['Cross-continent', 4500], ['Intercontinental', 9500]]
  return (
    <Card title="LiveKit Cloud: public internet vs. private mesh" right={<LessonTag n={2}>20–50 % lower network latency</LessonTag>}>
      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Field label="Distance user ↔ agent" value={`${km.toLocaleString()} km`}><Slider value={km} min={50} max={12000} step={50} onChange={setKm} /></Field>
          <div className="flex flex-wrap gap-1.5">{presets.map(([l, v]) => <Button key={l} size="sm" onClick={() => setKm(v)}>{l}</Button>)}</div>
          <Field label="Public-internet congestion" value={`${cong}%`}><Slider value={cong} min={0} max={100} step={5} onChange={setCong} /></Field>
          <div className="grid grid-cols-3 gap-3 rounded-lg bg-inset p-3">
            <Stat label="public" value={Math.round(r.publicMs)} unit="ms" sub="one way" />
            <Stat label="mesh" value={Math.round(r.meshMs)} unit="ms" sub="one way" tone="good" />
            <Stat label="change" value={`${r.reduction >= 0 ? '−' : '+'}${Math.abs(Math.round(r.reduction * 100))}`} unit="%" tone={r.reduction > 0.05 ? 'good' : 'warn'} sub={inRange ? 'inside the 20–50 % range' : r.reduction < 0.05 ? 'little to gain nearby' : ''} />
          </div>
        </div>
        <div>
          <svg viewBox="0 0 640 230" className="w-full" role="img" aria-label="Route comparison between public internet and mesh network">
            <text x="8" y="16" fontSize="12" fontWeight="600" fill="var(--fg2)">Standard WebRTC: one long, uncontrolled hop</text>
            <path d="M 50 70 C 200 10, 440 10, 590 70" stroke="var(--bad)" strokeWidth="2.5" fill="none" className="flow" opacity={0.5 + cong / 200} />
            {[0.25, 0.5, 0.75].map((f, i) => <circle key={i} cx={50 + f * 540} cy={70 - 38 * Math.sin(Math.PI * f)} r={3 + cong / 40} fill="var(--bad)" opacity={0.25 + cong / 200} />)}
            <text x="320" y="36" fontSize="11" fill="var(--bad)" textAnchor="middle">congestion · routing detours · loss</text>
            <text x="8" y="130" fontSize="12" fontWeight="600" fill="var(--fg2)">LiveKit Cloud: short first hop → private mesh → short last hop</text>
            <line x1="50" y1="170" x2="150" y2="170" stroke="var(--c-endpoint)" strokeWidth="2.5" />
            <line x1="150" y1="170" x2="490" y2="170" stroke="var(--good)" strokeWidth="3.5" className="flow" />
            <line x1="490" y1="170" x2="590" y2="170" stroke="var(--c-endpoint)" strokeWidth="2.5" />
            {[150, 235, 320, 405, 490].map((x, i) => <g key={x}><circle cx={x} cy={170} r={i === 0 || i === 4 ? 8 : 5} fill={i === 0 || i === 4 ? 'var(--good)' : 'var(--surface)'} stroke="var(--good)" strokeWidth="2" /></g>)}
            <text x="320" y="196" fontSize="11" fill="var(--good)" textAnchor="middle">congestion-free private backbone · {Math.round(r.backbone)} ms</text>
            <text x="100" y="196" fontSize="10.5" fill="var(--fg2)" textAnchor="middle">hop 1 · {Math.round(r.hop1)} ms</text>
            <text x="540" y="196" fontSize="10.5" fill="var(--fg2)" textAnchor="middle">hop 2 · {Math.round(r.hop2)} ms</text>
            <g><circle cx="50" cy="70" r="11" fill="var(--c-endpoint)" /><text x="50" y="74" fontSize="10" fill="#fff" textAnchor="middle" fontWeight="700">U</text><circle cx="590" cy="70" r="11" fill="var(--c-play)" /><text x="590" y="74" fontSize="10" fill="#fff" textAnchor="middle" fontWeight="700">A</text></g>
            <g><circle cx="50" cy="170" r="11" fill="var(--c-endpoint)" /><text x="50" y="174" fontSize="10" fill="#fff" textAnchor="middle" fontWeight="700">U</text><circle cx="590" cy="170" r="11" fill="var(--c-play)" /><text x="590" y="174" fontSize="10" fill="#fff" textAnchor="middle" fontWeight="700">A</text></g>
            <text x="50" y="222" fontSize="10" fill="var(--fg3)" textAnchor="middle">user</text><text x="590" y="222" fontSize="10" fill="var(--fg3)" textAnchor="middle">agent server</text>
          </svg>
          <p className="text-[12px] leading-snug text-fg2">The user’s device connects to the <i>nearest</i> edge, packets then ride LiveKit’s private tunnels between edges and exit at the node closest to your agent. The benefit grows with distance and congestion — and nearly vanishes when the agent is next door. <span className="text-fg3">Illustrative model (fiber ≈ 200 km/ms, routing stretch ×1.8 on the public path); the 20–50 % figure comes from the course. OpenAI serves ChatGPT Advanced Voice Mode through LiveKit Cloud.</span></p>
        </div>
      </div>
    </Card>
  )
}
