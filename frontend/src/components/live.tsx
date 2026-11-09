import { AudioWaveform, Brain, Captions, ChevronRight, Headphones, Mic, Scissors, Send, Sparkles, Timer, Volume2, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSession, type ConvItem } from '../lib/session'
import type { StageId, TurnMetrics } from '../lib/types'
import { Badge, STAGE, cx, fmtMs, latencyVerdict, Stat } from './ui'

/* ============================================================================================
   Pipeline diagram – lights up as each stage works. Behaviour labels come straight from the
   Lesson 5 table: VAD blocking · STT streaming · turn detection gatekeeper · LLM token stream ·
   TTS byte stream.
   ============================================================================================ */
const NODES: { id: StageId; title: string; role: string; icon: typeof Mic; color: string }[] = [
  { id: 'vad', title: 'VAD', role: 'blocking', icon: AudioWaveform, color: STAGE.vad.color },
  { id: 'stt', title: 'STT', role: 'streaming', icon: Captions, color: STAGE.stt.color },
  { id: 'turn', title: 'Turn', role: 'gatekeeper', icon: Timer, color: STAGE.turn.color },
  { id: 'llm', title: 'LLM', role: 'token stream', icon: Brain, color: STAGE.llm.color },
  { id: 'chunk', title: 'Chunk', role: 'sentences', icon: Scissors, color: STAGE.chunk.color },
  { id: 'tts', title: 'TTS', role: 'byte stream', icon: Volume2, color: STAGE.tts.color },
  { id: 'play', title: 'Play', role: 'client speaker', icon: Headphones, color: STAGE.play.color },
]

export function PipelineDiagram({ sub }: { sub: Partial<Record<StageId, string>> }) {
  const stages = useSession((s) => s.stages)
  const arch = useSession((s) => s.architecture)
  const agent = useSession((s) => s.agentState)
  const user = useSession((s) => s.userState)
  if (arch === 'realtime') {
    return (
      <div className="flex flex-wrap items-stretch gap-2">
        <Node icon={Mic} title="Microphone" role="PCM16 → 24 kHz" color={STAGE.vad.color} active={user === 'speaking'} />
        <Arrow on={user === 'speaking'} />
        <div className={cx('flex min-w-[240px] flex-1 flex-col justify-center rounded-xl border-2 border-dashed p-3', agent !== 'idle' ? 'border-accent' : 'border-line-strong')}>
          <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-accent" />Speech-to-speech model</div>
          <p className="mt-1 text-xs text-fg2">Audio in → audio out inside one model. Server-side VAD, turn detection, reasoning and voice are bundled – <b>no per-stage state to inspect, swap or budget</b>.</p>
          <div className="mt-1.5 flex gap-1.5"><Badge tone="accent">opaque</Badge><Badge>{agent}</Badge></div>
        </div>
        <Arrow on={agent === 'speaking'} />
        <Node icon={Headphones} title="Playout" role="client speaker" color={STAGE.play.color} active={stages.play.active} value={stages.play.value} />
      </div>
    )
  }
  return (
    <div className="flex items-stretch">
      <Node icon={Mic} title="Mic" role="16 kHz PCM16" color={STAGE.vad.color} active={user === 'speaking'} small />
      {NODES.map((n) => (
        <div key={n.id} className="flex min-w-0 flex-1 items-stretch">
          <Arrow on={stages[n.id].active} />
          <Node icon={n.icon} title={n.title} role={n.role} color={n.color} active={stages[n.id].active} value={stages[n.id].value} sub={sub[n.id]} />
        </div>
      ))}
    </div>
  )
}

function Node({ icon: Icon, title, role, color, active, value, sub, small }: { icon: typeof Mic; title: string; role: string; color: string; active: boolean; value?: string; sub?: string; small?: boolean }) {
  return (
    <div className={cx('relative rounded-xl border bg-surface p-2.5 transition-all', small ? 'w-[74px] shrink-0' : 'min-w-0 flex-1', active ? 'pulse border-transparent' : 'border-line')}
      style={{ ['--ring' as string]: color, boxShadow: active ? `0 0 0 2px ${color}` : undefined }}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${color} ${active ? 30 : 16}%, transparent)`, color }}><Icon size={14} /></span>
        <span className="text-xs font-semibold leading-tight">{title}</span>
      </div>
      <div className="mt-1 text-[10px] leading-tight text-fg3">{role}</div>
      {sub && <div className="mt-0.5 truncate text-[10px] text-fg2" title={sub}>{sub}</div>}
      <div className={cx('num mt-1 h-4 truncate text-[11px] font-medium', value ? 'text-fg' : 'text-fg3')}>{value ?? (active ? 'working…' : '')}</div>
    </div>
  )
}

function Arrow({ on }: { on: boolean }) {
  return (
    <div className="flex w-5 shrink-0 items-center justify-center" aria-hidden>
      <svg width="20" height="12" viewBox="0 0 24 12"><line x1="0" y1="6" x2="17" y2="6" stroke={on ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth="2" className={on ? 'flow' : ''} /><path d="M16 1.5 L23 6 L16 10.5" fill="none" stroke={on ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth="2" strokeLinecap="round" /></svg>
    </div>
  )
}

/* ============================================================================================
   Metrics panel – the four metric families from Lesson 5 (LLMMetrics, STTMetrics, EOUMetrics,
   TTSMetrics) for the selected turn.
   ============================================================================================ */
export function MetricsPanel({ m }: { m?: TurnMetrics }) {
  if (!m) return <div className="rounded-lg bg-inset px-3 py-8 text-center text-xs text-fg3">Metrics appear after the first completed turn.</div>
  const v = m.response_latency_ms != null ? latencyVerdict(m.response_latency_ms) : null
  const ttftTone = m.llm.ttft_ms == null ? undefined : m.llm.ttft_ms < 500 ? 'good' : m.llm.ttft_ms < 900 ? 'warn' : 'bad'
  const ttfbTone = m.tts.ttfb_ms == null ? undefined : m.tts.ttfb_ms < 250 ? 'good' : m.tts.ttfb_ms < 600 ? 'warn' : 'bad'
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-4 rounded-lg bg-inset p-3">
        <Stat big label="Response latency" value={m.response_latency_ms != null ? (m.response_latency_ms / 1000).toFixed(2) : '—'} unit="s" tone={v?.tone} sub={v?.text} />
        <div className="ml-auto text-right text-[11px] text-fg3">speech end → first audio byte<br />{m.interrupted && <Badge tone="bad">interrupted</Badge>}</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Family name="LLMMetrics" color="var(--c-llm)" title={m.llm.model}>
          <Stat label="ttft" value={m.llm.ttft_ms != null ? Math.round(m.llm.ttft_ms) : '—'} unit="ms" tone={ttftTone} />
          <Stat label="tok / s" value={m.llm.tokens_per_second ? Math.round(m.llm.tokens_per_second) : '—'} />
          <Stat label="prompt" value={m.llm.prompt_tokens || '—'} />
          <Stat label="output" value={m.llm.completion_tokens || '—'} sub={m.llm.estimated_usage ? 'estimated' : undefined} />
        </Family>
        <Family name="STTMetrics" color="var(--c-stt)" title={m.stt.provider}>
          <Stat label="duration" value={m.stt.audio_ms != null ? (m.stt.audio_ms / 1000).toFixed(1) : '—'} unit="s" />
          <Stat label="streamed" value={m.stt.streamed == null ? '—' : m.stt.streamed ? 'true' : 'false'} tone={m.stt.streamed ? 'good' : m.stt.streamed === false ? 'warn' : undefined} />
          <Stat label="finalize" value={m.stt.finalize_ms != null ? Math.round(m.stt.finalize_ms) : '—'} unit="ms" />
        </Family>
        <Family name="EOUMetrics" color="var(--c-endpoint)" title={`${m.eou.mode}${m.eou.extended ? ' · extended' : ''}`}>
          <Stat label="eou delay" value={m.eou.end_of_utterance_delay_ms != null ? Math.round(m.eou.end_of_utterance_delay_ms) : '—'} unit="ms" />
          <Stat label="stt delay" value={m.eou.transcription_delay_ms != null ? Math.round(m.eou.transcription_delay_ms) : '—'} unit="ms" />
          <Stat label="P(end)" value={m.eou.p_eot != null ? m.eou.p_eot.toFixed(2) : '—'} />
        </Family>
        <Family name="TTSMetrics" color="var(--c-tts)" title={m.tts.provider}>
          <Stat label="ttfb" value={m.tts.ttfb_ms != null ? Math.round(m.tts.ttfb_ms) : '—'} unit="ms" tone={ttfbTone} />
          <Stat label="audio" value={m.tts.audio_ms != null ? (m.tts.audio_ms / 1000).toFixed(1) : '—'} unit="s" />
          <Stat label="render" value={m.tts.render_ms != null ? Math.round(m.tts.render_ms) : '—'} unit="ms" />
          <Stat label="streamed" value={m.tts.streamed == null ? '—' : m.tts.streamed ? 'true' : 'false'} tone={m.tts.streamed ? 'good' : m.tts.streamed === false ? 'warn' : undefined} />
          {m.tts.server && <Stat label="server ttfa" value={m.tts.server.ttfa_ms != null ? Math.round(m.tts.server.ttfa_ms) : '—'} unit="ms" sub={m.tts.server.engine ?? undefined} />}
          {m.tts.server?.rtf != null && <Stat label="rtf" value={m.tts.server.rtf.toFixed(2)} sub="render ÷ audio" tone={m.tts.server.rtf < 1 ? 'good' : 'warn'} />}
        </Family>
      </div>
      {m.vad.audio_total_ms ? (
        <div className="rounded-lg bg-inset px-3 py-2 text-[11px] text-fg2">
          <b>VAD gating</b> · {((m.vad.audio_sent_to_stt_ms ?? 0) / 1000).toFixed(1)} s of {(m.vad.audio_total_ms / 1000).toFixed(1)} s audio reached STT
          <span className="num ml-1 text-good">({Math.round(100 - ((m.vad.audio_sent_to_stt_ms ?? 0) / m.vad.audio_total_ms) * 100)}% never transcribed or billed)</span>
        </div>
      ) : null}
    </div>
  )
}

function Family({ name, color, title, children }: { name: string; color: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line p-2.5" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="mb-1.5 flex items-center gap-1.5"><code className="text-[10.5px] font-medium text-fg2">{name}</code>{title && <span className="truncate text-[10px] text-fg3">{title}</span>}</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-2">{children}</div>
    </div>
  )
}

/* ============================================================================================
   Event log
   ============================================================================================ */
const FAMILY: [RegExp, string][] = [[/^vad|user_state/, 'var(--c-endpoint)'], [/^stt/, 'var(--c-stt)'], [/^turn|^interrupt|^flush/, 'var(--c-endpoint)'], [/^llm|^guardrail/, 'var(--c-llm)'], [/^chunker/, 'var(--c-chunk)'], [/^tts|^response/, 'var(--c-tts)'], [/^agent_state/, 'var(--c-play)'], [/^error/, 'var(--bad)']]
export function EventLog() {
  const events = useSession((s) => s.events)
  const [filter, setFilter] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [events])
  const shown = events.filter((e) => !filter || e.type.includes(filter))
  return (
    <div>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter events (e.g. llm, tts, turn)…" className="mb-2 w-full rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-xs outline-none focus:border-accent" />
      <div ref={box} onScroll={(e) => { const t = e.currentTarget; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24 }} className="h-[420px] overflow-y-auto rounded-lg bg-inset p-2 font-mono text-[11px] leading-relaxed">
        {shown.length === 0 && <div className="py-8 text-center text-fg3">No events yet.</div>}
        {shown.map((e, i) => {
          const { type, t, ...rest } = e
          const col = FAMILY.find(([r]) => r.test(type))?.[1] ?? 'var(--fg3)'
          const body = JSON.stringify(rest, (_k, v) => (typeof v === 'string' && v.length > 70 ? v.slice(0, 70) + '…' : v)).slice(0, 190)
          return <div key={i} className="whitespace-nowrap"><span className="text-fg3">{(t / 1000).toFixed(2).padStart(7)}s</span> <span style={{ color: col }} className="font-medium">{type}</span> <span className="text-fg3">{body}</span></div>
        })}
      </div>
    </div>
  )
}

/* ============================================================================================
   Transcript (+ typed input). Interrupted agent turns show what was heard vs. what was cut.
   ============================================================================================ */
export function Transcript({ items, onSend, canSend, selected, onSelect }: { items: ConvItem[]; onSend: (t: string) => void; canSend: boolean; selected: number | null; onSelect: (turnId: number) => void }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }) }, [items])
  const submit = () => { if (text.trim()) { onSend(text.trim()); setText('') } }
  return (
    <div className="flex h-full flex-col">
      <div ref={box} className="min-h-[220px] flex-1 space-y-3 overflow-y-auto pr-1">
        {items.length === 0 && <div className="py-10 text-center text-sm text-fg3">Start a session, then talk, type, or run a scenario.</div>}
        {items.map((c) => <Bubble key={c.key} c={c} selected={selected === c.turnId} onSelect={() => onSelect(c.turnId)} />)}
      </div>
      <div className="mt-3 flex gap-2">
        <input value={text} disabled={!canSend} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={canSend ? 'Type to the agent (bypasses VAD + STT)…' : 'Connect to chat'}
          className="flex-1 rounded-lg border border-line-strong bg-inset px-3 py-2 text-[13px] outline-none focus:border-accent disabled:opacity-50" />
        <button onClick={submit} disabled={!canSend || !text.trim()} className="rounded-lg bg-accent px-3 text-white disabled:opacity-40" aria-label="Send"><Send size={15} /></button>
      </div>
    </div>
  )
}

function Bubble({ c, selected, onSelect }: { c: ConvItem; selected: boolean; onSelect: () => void }) {
  if (c.role === 'note') {
    const col = c.tone === 'error' ? 'text-bad' : c.tone === 'warn' ? 'text-warn' : 'text-fg3'
    return <div className={cx('fade-in rounded-md bg-inset px-3 py-1.5 text-center text-[11px]', col)}>{c.text}</div>
  }
  const user = c.role === 'user'
  const m = c.metrics
  const v = m?.response_latency_ms != null ? latencyVerdict(m.response_latency_ms) : null
  return (
    <div className={cx('fade-in flex flex-col', user ? 'items-end' : 'items-start')}>
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-fg3">
        {user ? 'You' : 'Agent'}
        {m?.response_latency_ms != null && (
          <button onClick={onSelect} className={cx('num rounded px-1 py-0.5 normal-case', selected ? 'bg-accent text-white' : 'bg-inset hover:bg-line', v?.tone === 'good' ? 'text-good' : v?.tone === 'warn' ? 'text-warn' : 'text-bad')} title="Show this turn's waterfall">⏱ {fmtMs(m.response_latency_ms)}</button>
        )}
        {c.interrupted && <Badge tone="bad"><Scissors size={10} />interrupted</Badge>}
      </div>
      <div className={cx('max-w-[92%] rounded-2xl px-3 py-2 text-[13px] leading-snug', user ? 'rounded-br-md bg-accent text-white' : 'rounded-bl-md border border-line bg-inset')}>
        {user ? (
          <>{c.text}{c.partial && !c.final && <span className="italic opacity-80">{c.partial}<span className="animate-pulse">▍</span></span>}</>
        ) : c.interrupted && c.heard !== undefined ? (
          <>
            <span>{c.heard || <i className="text-fg3">(nothing was heard)</i>}</span>
            {c.unheard && <span className="text-fg3 line-through decoration-bad/70"> {c.unheard}</span>}
          </>
        ) : (
          <>{c.text || <span className="text-fg3">…</span>}{!c.final && <span className="animate-pulse text-fg3"> ▍</span>}</>
        )}
      </div>
      {!!c.tools?.length && (
        <div className="mt-1 flex max-w-[92%] flex-wrap gap-1">
          {c.tools.map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-fg2">
              <Wrench size={10} style={{ color: 'var(--c-tool)' }} />
              <b>{t.name}</b>({Object.entries(t.args ?? {}).map(([k, val]) => `${k}=${val}`).join(', ')})
              {t.result !== undefined && <><ChevronRight size={10} /><span className="num">{summarize(t.result)}</span><span className="num text-fg3">{t.ms ? Math.round(t.ms) + ' ms' : ''}</span></>}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function summarize(r: any): string {
  if (r?.error) return 'error'
  if ('available' in r) return r.available ? 'available' : 'unavailable'
  if ('booked' in r) return r.booked ? `booked ${r.confirmation}` : 'not booked'
  if ('dishes' in r) return `${r.dishes.length} dishes`
  if ('urgency' in r) return r.urgency
  return 'ok'
}
