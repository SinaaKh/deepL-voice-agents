import { Info } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ')

/** Stage identity colours (validated categorical palette, fixed order). */
export const STAGE: Record<string, { color: string; label: string }> = {
  user_speech: { color: 'var(--c-neutral)', label: 'User speaking' },
  endpointing: { color: 'var(--c-endpoint)', label: 'Endpointing' },
  vad: { color: 'var(--c-endpoint)', label: 'VAD' },
  turn: { color: 'var(--c-endpoint)', label: 'Turn detection' },
  stt: { color: 'var(--c-stt)', label: 'STT' },
  stt_final: { color: 'var(--c-stt)', label: 'STT finalize' },
  llm: { color: 'var(--c-llm)', label: 'LLM' },
  llm_ttft: { color: 'var(--c-llm)', label: 'LLM TTFT' },
  llm_stream: { color: 'var(--c-llm)', label: 'LLM stream' },
  tool: { color: 'var(--c-tool)', label: 'Tool call' },
  chunk: { color: 'var(--c-chunk)', label: 'Sentence chunker' },
  chunking: { color: 'var(--c-chunk)', label: 'Chunk wait' },
  tts: { color: 'var(--c-tts)', label: 'TTS' },
  tts_ttfb: { color: 'var(--c-tts)', label: 'TTS TTFB' },
  tts_render: { color: 'var(--c-tts)', label: 'TTS render' },
  play: { color: 'var(--c-play)', label: 'Playout' },
  playout: { color: 'var(--c-play)', label: 'Playout' },
  transport: { color: 'var(--c-play)', label: 'Transport' },
  other: { color: 'var(--c-neutral)', label: 'Other' },
}

export function Card({ title, icon, right, children, className, pad = true, sub }: {
  title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean; sub?: ReactNode
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)}>
      {(title || right) && (
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          {icon && <span className="text-fg3">{icon}</span>}
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
          {sub && <span className="text-xs text-fg3">{sub}</span>}
          <div className="ml-auto flex items-center gap-2">{right}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; className?: string; title?: string }) {
  const t = {
    neutral: 'bg-inset text-fg2', good: 'bg-good/15 text-good', warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad', accent: 'bg-accent/15 text-accent',
  }[tone]
  return <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none', t, className)}>{children}</span>
}

export function LessonTag({ n, children }: { n: number | string; children?: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg3">L{n}{children && <span className="normal-case tracking-normal">· {children}</span>}</span>
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <span className="group relative inline-flex align-middle">
      <Info size={12} className="text-fg3" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden w-60 -translate-x-1/2 rounded-lg border border-line-strong bg-surface p-2 text-[11px] font-normal leading-snug text-fg2 shadow-xl group-hover:block">{children}</span>
    </span>
  )
}

export function Field({ label, hint, value, children, lesson }: { label: ReactNode; hint?: ReactNode; value?: ReactNode; children: ReactNode; lesson?: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-fg2">
        <span className="font-medium">{label}</span>
        {hint && <Hint>{hint}</Hint>}
        {lesson && <LessonTag n={lesson} />}
        {value !== undefined && <span className="num ml-auto text-fg">{value}</span>}
      </div>
      {children}
    </div>
  )
}

export function Slider({ value, min, max, step = 1, onChange, disabled }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled?: boolean }) {
  return <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-valuenow={value} />
}

export function Select({ value, onChange, options, disabled, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[]; disabled?: boolean; className?: string }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className={cx('w-full rounded-lg border border-line-strong bg-inset px-2 py-1.5 text-xs text-fg outline-none focus:border-accent disabled:opacity-50', className)}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-center gap-2 text-xs text-fg2', disabled && 'opacity-50')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {label}
    </label>
  )
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex w-full rounded-lg border border-line-strong bg-inset p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}
          className={cx('flex-1 rounded-md px-2 font-medium transition-colors disabled:opacity-40', size === 'sm' ? 'py-0.5 text-[11px]' : 'py-1 text-xs',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-fg3 hover:text-fg2')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Button({ children, onClick, variant = 'default', disabled, icon, className, title, size = 'md' }: {
  children?: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; icon?: ReactNode; className?: string; title?: string; size?: 'sm' | 'md'
}) {
  const v = {
    default: 'border border-line-strong bg-surface hover:bg-inset text-fg',
    primary: 'bg-accent text-white hover:brightness-110',
    danger: 'bg-bad text-white hover:brightness-110',
    ghost: 'text-fg2 hover:bg-inset',
  }[variant]
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50', size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-[13px]', v, className)}>
      {icon}{children}
    </button>
  )
}

export function Stat({ label, value, unit, sub, tone, big }: { label: ReactNode; value: ReactNode; unit?: string; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad'; big?: boolean }) {
  const c = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-fg'
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-fg3">{label}</div>
      <div className={cx('num leading-tight', big ? 'text-3xl font-semibold' : 'text-xl font-medium', c)}>
        {value}{unit && <span className="ml-0.5 text-xs font-normal text-fg3">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-fg3">{sub}</div>}
    </div>
  )
}

export function PageHeader({ title, children, lessons }: { title: string; children?: ReactNode; lessons?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{title}</h1>{lessons}</div>
      {children && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg2">{children}</p>}
    </div>
  )
}

/** Measure an element's width (for responsive SVG charts). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setW(Math.max(200, Math.floor(e[0].contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export const ms = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(d)}`)
export const fmtMs = (v: number | null | undefined) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`)

/** Human-conversation baselines + pipeline bounds from Lesson 1. */
export const HUMAN = { mean: 236, sd: 520, floor: 540, typical: 1500 }
export function latencyVerdict(total: number): { tone: 'good' | 'warn' | 'bad'; text: string } {
  if (total <= HUMAN.mean + HUMAN.sd) return { tone: 'good', text: 'Within 1σ of human response time' }
  if (total <= HUMAN.typical) return { tone: 'warn', text: 'Noticeable lag' }
  return { tone: 'bad', text: 'Unnatural pause (> 1.5 s)' }
}
