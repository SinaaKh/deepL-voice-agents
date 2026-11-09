import { useSyncExternalStore } from 'react'
import { Mic, Player } from './audio'
import type { Ev, SessionConfig, StageId, TurnMetrics } from './types'

export type Status = 'idle' | 'connecting' | 'loading' | 'live' | 'error'
export interface ConvItem {
  key: string; role: 'user' | 'agent' | 'note'; turnId: number
  text: string; partial?: string; final: boolean
  interrupted?: boolean; heard?: string; unheard?: string
  tone?: 'info' | 'warn' | 'error'
  metrics?: TurnMetrics
  tools?: { name: string; args: any; result?: any; ms?: number }[]
  sentences: string[]
}
export interface StageState { active: boolean; value?: string }
export interface TimerState {
  phase: string; turn_id: number; mode?: string; base_ms?: number; delay_ms?: number; p_eot?: number | null
  reasons?: string[]; extended?: boolean; deadline_t?: number; text?: string; stale?: boolean; stt_wait_ms?: number; saved?: boolean
  speechEndAt?: number
}
export interface SessionState {
  status: Status; error?: string
  loading: Record<string, 'loading' | 'ready'>
  userState: 'speaking' | 'listening'
  agentState: 'idle' | 'thinking' | 'speaking'
  conv: ConvItem[]
  metrics: TurnMetrics[]
  timer: TimerState | null
  stages: Record<StageId, StageState>
  events: Ev[]
  gate: { total: number; sent: number }
  rtt: number | null
  llmModel: string; vadImpl: string
  architecture: 'pipeline' | 'realtime'
  scenario: { id: string; running: boolean; step?: number } | null
  lastInterrupt: Ev | null
  micOn: boolean
  micRequested: boolean
  config: SessionConfig | null
}

const N = 480 // ~15 s of VAD frames at 31 Hz
export const vadRing = {
  p: new Float32Array(N), rms: new Float32Array(N), sp: new Uint8Array(N), t: new Float64Array(N),
  head: 0, count: 0, markers: [] as { t: number; kind: string }[],
  push(t: number, p: number, rms: number, sp: boolean) {
    this.p[this.head] = p; this.rms[this.head] = rms; this.sp[this.head] = sp ? 1 : 0; this.t[this.head] = t
    this.head = (this.head + 1) % N; this.count = Math.min(N, this.count + 1)
  },
  reset() { this.head = 0; this.count = 0; this.markers = [] },
  N,
}

const emptyStages = (): Record<StageId, StageState> => ({
  vad: { active: false }, turn: { active: false }, stt: { active: false }, llm: { active: false },
  chunk: { active: false }, tts: { active: false }, play: { active: false },
})

const initial = (): SessionState => ({
  status: 'idle', loading: {}, userState: 'listening', agentState: 'idle', conv: [], metrics: [], timer: null,
  stages: emptyStages(), events: [], gate: { total: 0, sent: 0 }, rtt: null, llmModel: '', vadImpl: '',
  architecture: 'pipeline', scenario: null, lastInterrupt: null, micOn: false, micRequested: false, config: null,
})

class SessionStore {
  state: SessionState = initial()
  private listeners = new Set<() => void>()
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  player: Player | null = null
  mic: Mic | null = null
  private ready = false
  private clockOffset: number | null = null
  private pingTimer: number | null = null
  private cfgTimer: number | null = null
  private agentKey = ''
  private ttsPending = 0
  private firstSentenceWait: Record<number, number> = {}

  // ---- store plumbing -------------------------------------------------------------------
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getState = () => this.state
  private set(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((l) => l()) }
  private stage(id: StageId, patch: Partial<StageState>) {
    this.set({ stages: { ...this.state.stages, [id]: { ...this.state.stages[id], ...patch } } })
  }
  /** Server clock (ms) -> performance.now() clock. */
  toClient(serverT: number) { return serverT + (this.clockOffset ?? 0) }
  analyserMic() { return this.mic?.analyser ?? null }
  analyserOut() { return this.player?.analyser ?? null }

  // ---- lifecycle ------------------------------------------------------------------------
  async connect(config: SessionConfig, opts: { mic: boolean; greet: boolean }) {
    this.disconnect()
    vadRing.reset()
    this.state = { ...initial(), status: 'connecting', config, architecture: config.architecture, micRequested: opts.mic }
    this.listeners.forEach((l) => l())
    this.ready = false
    this.clockOffset = null
    this.agentKey = ''
    this.ttsPending = 0
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await ctx.resume()
      this.ctx = ctx
      const player = new Player(ctx)
      player.onReport = (id, ms) => this.send({ type: 'playback', response_id: id, played_ms: ms })
      player.onDone = (id) => this.send({ type: 'playout_done', response_id: id })
      this.player = player

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws/session`)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      ws.onopen = () => this.send({ type: 'start', config, greet: opts.greet })
      ws.onmessage = (m) => (typeof m.data === 'string' ? this.onEvent(JSON.parse(m.data)) : this.player?.push(m.data as ArrayBuffer))
      ws.onerror = () => this.set({ status: 'error', error: 'WebSocket error – is the backend running on :8000?' })
      ws.onclose = () => {
        if (this.state.status !== 'error') this.set({ status: 'idle' })
        this.teardownAudio()
      }
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping', ts: performance.now() }), 2000)

      if (opts.mic) {
        try {
          this.mic = await Mic.start(ctx, (buf) => { if (this.ready && ws.readyState === 1) ws.send(buf) })
          this.set({ micOn: true })
        } catch (e: any) {
          this.note(`Microphone unavailable (${e?.message ?? e}). You can still run scenarios or type to the agent.`, 'warn')
        }
      }
    } catch (e: any) {
      this.set({ status: 'error', error: String(e?.message ?? e) })
    }
  }

  disconnect() {
    if (this.pingTimer) window.clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.ws) { try { this.send({ type: 'stop' }); this.ws.onclose = null; this.ws.close() } catch { /* closed */ } }
    this.ws = null
    this.teardownAudio()
    if (this.state.status !== 'idle') this.set({ status: 'idle', agentState: 'idle', userState: 'listening', scenario: null, micOn: false, micRequested: false, stages: emptyStages() })
  }

  private teardownAudio() {
    this.mic?.stop(); this.mic = null
    this.player?.stopAll(); this.player = null
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {})
    this.ctx = null
  }

  private send(obj: unknown) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)) }
  sendText(text: string) { this.send({ type: 'text', text }) }
  runScenario(id: string) { this.set({ scenario: { id, running: true } }); this.send({ type: 'scenario', id }) }
  stopScenario() { this.send({ type: 'scenario_stop' }) }
  /** Live re-configuration (thresholds, turn mode, voice…) without dropping the call. */
  updateConfig(config: SessionConfig) {
    this.state = { ...this.state, config }
    if (this.cfgTimer) window.clearTimeout(this.cfgTimer)
    this.cfgTimer = window.setTimeout(() => this.send({ type: 'config', config }), 250)
  }
  clearConversation() { this.set({ conv: [], metrics: [], events: [] }) }

  // ---- conversation helpers -------------------------------------------------------------
  private note(text: string, tone: 'info' | 'warn' | 'error' = 'info') {
    this.set({ conv: [...this.state.conv, { key: `n${Date.now()}${Math.random()}`, role: 'note', turnId: 0, text, final: true, tone, sentences: [] }] })
  }
  private upsert(key: string, role: ConvItem['role'], turnId: number, mut: (c: ConvItem) => void) {
    const conv = [...this.state.conv]
    let i = conv.findIndex((c) => c.key === key)
    if (i < 0) { conv.push({ key, role, turnId, text: '', final: false, sentences: [] }); i = conv.length - 1 }
    const c = { ...conv[i], sentences: [...conv[i].sentences] }
    mut(c)
    conv[i] = c
    this.set({ conv })
  }

  // ---- event reducer --------------------------------------------------------------------
  private onEvent(ev: Ev) {
    const now = performance.now()
    if (typeof ev.t === 'number' && ev.type !== 'pong') {
      const off = now - ev.t
      this.clockOffset = this.clockOffset == null ? off : Math.min(this.clockOffset, off)
    }
    switch (ev.type) {
      case 'vad': {
        vadRing.push(ev.t, ev.p, Math.min(1, ev.rms * 6), !!ev.speaking)
        return
      }
      case 'llm.token': {
        if (this.state.architecture === 'realtime') this.agentUpsert(ev.turn_id, (c) => { c.text += ev.text })
        return
      }
      case 'stt.interim': this.upsert(`u${ev.turn_id}`, 'user', ev.turn_id, (c) => { c.partial = ev.text }); return
      case 'pong': this.set({ rtt: Math.round(performance.now() - ev.ts) }); return
      case 'vad.gate': this.set({ gate: { total: ev.total_ms, sent: ev.sent_ms } }); return
    }

    // everything else is rare enough to log + re-render
    const events = [...this.state.events.slice(-299), ev]
    this.state = { ...this.state, events }

    switch (ev.type) {
      case 'session.starting': this.set({ status: 'loading' }); break
      case 'provider.loading': this.set({ loading: { ...this.state.loading, [ev.component]: 'loading' } }); break
      case 'provider.ready': this.set({ loading: { ...this.state.loading, [ev.component]: 'ready' } }); break
      case 'session.ready':
        this.ready = true
        this.set({ status: 'live', llmModel: ev.llm_model, vadImpl: ev.vad_impl })
        break
      case 'error':
        this.note(`${ev.where}: ${ev.message}`, 'error')
        if (ev.where === 'realtime' || ev.where === 'config') this.set({ status: 'error', error: ev.message })
        break
      case 'user_state':
        this.set({ userState: ev.state })
        this.stage('vad', { active: ev.state === 'speaking' })
        break
      case 'agent_state':
        this.set({ agentState: ev.state })
        if (ev.state === 'idle') this.stage('play', { active: false })
        break
      case 'vad.speech_start': vadRing.markers.push({ t: ev.t, kind: 'speech_start' }); break
      case 'vad.speech_end': vadRing.markers.push({ t: ev.t, kind: 'speech_end' }); break
      case 'turn.start':
        this.stage('stt', { active: true })
        break
      case 'turn.timer': {
        if (ev.phase === 'resumed') {
          vadRing.markers.push({ t: ev.t, kind: ev.saved ? 'saved' : 'resume' })
          this.set({ timer: { ...(this.state.timer ?? { turn_id: ev.turn_id }), phase: 'resumed', saved: ev.saved } as TimerState })
          this.stage('turn', { active: false })
        } else {
          this.set({ timer: { ...ev, speechEndAt: ev.t } as unknown as TimerState })
          this.stage('turn', { active: true, value: `${Math.round(ev.delay_ms)} ms` })
        }
        break
      }
      case 'turn.end':
        vadRing.markers.push({ t: ev.t, kind: 'eot' })
        this.set({ timer: this.state.timer ? { ...this.state.timer, phase: 'fired' } : null })
        this.stage('turn', { active: false, value: `${Math.round(ev.eou_delay_ms)} ms` })
        break
      case 'stt.final':
        this.upsert(`u${ev.turn_id}`, 'user', ev.turn_id, (c) => { c.text = ev.text; c.partial = undefined; c.final = true })
        this.stage('stt', { active: false, value: `${Math.round(ev.finalize_ms)} ms` })
        break
      case 'transcript':
        if (ev.role === 'user') this.upsert(`u${ev.turn_id}`, 'user', ev.turn_id, (c) => { c.text = ev.text; c.partial = undefined; c.final = true })
        break
      case 'turn.discarded': this.note(`Turn ${ev.turn_id} discarded – ${ev.reason}`, 'info'); break
      case 'turn.cut_off': this.note(`Turn ${ev.turn_id} was cut off: you started talking again while the agent was finalising your previous words. The two turns were merged.`, 'warn'); break
      case 'guardrail.block': this.note(`Guardrail blocked ${ev.side}: “${ev.term}”`, 'warn'); break
      case 'interrupt.suppressed': this.note(ev.reason, 'info'); break
      case 'llm.malformed_output': this.note('LLM printed a tool call as text – suppressed instead of speaking JSON', 'warn'); break
      case 'llm.request':
        this.agentUpsert(ev.turn_id, () => {})
        this.stage('llm', { active: true })
        break
      case 'llm.first_token': this.stage('llm', { active: true, value: `TTFT ${Math.round(ev.ttft_ms)} ms` }); break
      case 'llm.done': this.stage('llm', { active: false }); break
      case 'llm.tool_call':
        this.agentUpsert(ev.turn_id, (c) => { c.tools = [...(c.tools ?? []), { name: ev.name, args: ev.args }] })
        break
      case 'llm.tool_result':
        this.agentUpsert(ev.turn_id, (c) => {
          const tools = [...(c.tools ?? [])]
          const i = tools.findIndex((t) => t.name === ev.name && t.result === undefined)
          if (i >= 0) tools[i] = { ...tools[i], result: ev.result, ms: ev.ms }
          c.tools = tools
        })
        break
      case 'chunker.first_sentence': this.firstSentenceWait[ev.idx] = ev.wait_ms; this.stage('chunk', { active: true, value: `${Math.round(ev.wait_ms)} ms` }); break
      case 'chunker.sentence':
        this.agentUpsert(ev.turn_id, (c) => { c.sentences.push(ev.text); if (this.state.architecture !== 'realtime') c.text = c.sentences.join(' ') })
        this.stage('chunk', { active: true })
        window.setTimeout(() => this.stage('chunk', { active: false }), 350)
        break
      case 'tts.request': this.ttsPending++; this.stage('tts', { active: true }); break
      case 'tts.first_byte': this.stage('tts', { active: true, value: `TTFB ${Math.round(ev.ttfb_ms)} ms` }); break
      case 'tts.done': this.ttsPending = Math.max(0, this.ttsPending - 1); if (!this.ttsPending) this.stage('tts', { active: false }); break
      case 'response.audio_start':
        this.player?.startResponse(ev.response_id, ev.sample_rate)
        this.stage('play', { active: true })
        break
      case 'response.audio_end':
        this.player?.endResponse()
        this.stage('play', { active: true, value: `${(ev.total_ms / 1000).toFixed(1)} s audio` })
        break
      case 'flush': {
        const played = this.player?.flush() ?? 0
        this.send({ type: 'flushed', response_id: ev.response_id, played_ms: played })
        break
      }
      case 'interrupt':
        vadRing.markers.push({ t: ev.t, kind: 'interrupt' })
        this.ttsPending = 0
        this.set({ lastInterrupt: ev, stages: { ...this.state.stages, llm: { active: false }, tts: { active: false }, play: { active: false }, chunk: { active: false } } })
        this.upsert(this.agentKey, 'agent', 0, (c) => { c.interrupted = true; c.heard = ev.heard_text; c.unheard = ev.unheard_text; c.final = true })
        break
      case 'turn.metrics': {
        const m = ev as unknown as TurnMetrics
        this.set({ metrics: [...this.state.metrics, m] })
        this.agentUpsert(m.turn_id, (c) => { c.metrics = m; c.final = true; if (m.interrupted) c.interrupted = true })
        break
      }
      case 'scenario.step': this.set({ scenario: { id: this.state.scenario?.id ?? '', running: true, step: ev.i } }); break
      case 'scenario.done': this.set({ scenario: null }); break
    }
  }

  private agentUpsert(turnId: number, mut: (c: ConvItem) => void) {
    const key = `a${turnId}`
    this.agentKey = key
    this.upsert(key, 'agent', turnId, mut)
  }
}

export const store = new SessionStore()

export function useSession<T>(sel: (s: SessionState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.getState()))
}
