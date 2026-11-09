import type { Persona, Providers, Scenario } from './types'

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  providers: () => j<Providers>('/api/providers'),
  personas: () => j<Persona[]>('/api/personas'),
  scenarios: () => j<Scenario[]>('/api/scenarios'),
  turnSimulate: (req: unknown) => j<TurnSim>('/api/turn/simulate', post(req)),
  turnSweep: (max_delay_ms: number, threshold: number) => j<Sweep>(`/api/turn/sweep?max_delay_ms=${max_delay_ms}&threshold=${threshold}`),
  turnDataset: () => j<DatasetItem[]>('/api/turn/dataset'),
  interruptSimulate: (body: unknown) => j<{ heard: string; unheard: string; current: number; total_ms: number }>('/api/interrupt/simulate', post(body)),
  livekitToken: (room: string) => j<{ token: string; url: string; room: string; identity: string }>(`/api/livekit/token?room=${encodeURIComponent(room)}`),
  source: (name: string) => j<{ name: string; text: string }>(`/api/source/${name}`),
  health: () => j<{ ok: boolean }>('/api/health'),
}

/** Stream the A/B benchmark (NDJSON) and call `onRow` for every line as it arrives. */
export async function streamBenchmark(req: unknown, onRow: (row: any) => void, signal?: AbortSignal) {
  const r = await fetch('/api/benchmark', { ...post(req), signal })
  if (!r.ok || !r.body) throw new Error(await r.text())
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onRow(JSON.parse(line))
    }
  }
}

export interface SimSegment { kind: 'speech' | 'pause'; text?: string; ms: number; intent?: 'continue' | 'end' }
export interface DatasetItem { name: string; agent_last: string; segments: SimSegment[] }
export interface PauseResult {
  index: number; start: number; duration: number; intent: string; p_eot: number; reasons: string[]; delay_ms: number
  fire_at: number | null; outcome: 'held' | 'cut_off' | 'ended'; saved_by_semantic: boolean; extra_wait_ms: number; waited_ms: number; transcript: string
}
export interface TurnSim {
  spans: { start: number; end: number; text: string }[]
  pauses: PauseResult[]
  fires: { t: number; outcome: string }[]
  total_ms: number
  summary: { cut_offs: number; saved_by_semantic: number; extra_wait_ms: number; final_eou_delay_ms: number | null }
}
export interface Sweep {
  timers: number[]
  series: Record<'vad' | 'semantic', { timer_ms: number; cut_off_rate: number; cut_offs: number; pauses: number; mean_end_delay_ms: number }[]>
  utterances: number
}
