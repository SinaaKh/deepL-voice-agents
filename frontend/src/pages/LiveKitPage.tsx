import { Check, Copy, Mic, PlugZap, Power } from 'lucide-react'
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Card, LessonTag, PageHeader, Stat, cx, fmtMs } from '../components/ui'
import { api } from '../lib/api'
import { useMeta } from '../lib/config'

interface Msg { kind: string; [k: string]: any }
interface Turn { speech: string; ttft?: number; ttfb?: number; eou?: number; tps?: number; ptok?: number; ctok?: number; transcription?: number; streamed?: boolean }

export default function LiveKitPage() {
  const { providers } = useMeta()
  const configured = providers?.livekit.configured
  return (
    <div className="mx-auto max-w-[1280px] space-y-4">
      <PageHeader title="LiveKit · the production path" lessons={<><LessonTag n={1} /><LessonTag n={3} /><LessonTag n={4} /><LessonTag n={5} /></>}>
        The Live Agent page runs VoiceLab’s own inspectable pipeline over a WebSocket. This page is the real thing from the course: a browser connected by <b>WebRTC</b> to a <b>LiveKit</b> server, with a stateful
        <b> LiveKit Agents</b> worker joining each room. Same ideas, production plumbing — and the agent streams its metrics back over an <b>RTCDataChannel</b>.
      </PageHeader>
      <Architecture />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Setup configured={!!configured} url={providers?.livekit.url ?? ''} />
        <Connect configured={!!configured} />
      </div>
      <CodeViewer />
    </div>
  )
}

/* ============================================================================================ */
function Architecture() {
  const Node = ({ x, y, w, h, t, s, c }: { x: number; y: number; w: number; h: number; t: string; s: string; c: string }) => (
    <g><rect x={x} y={y} width={w} height={h} rx={10} fill={`color-mix(in srgb, ${c} 13%, var(--surface))`} stroke={c} strokeWidth={1.6} /><text x={x + w / 2} y={y + h / 2 - 3} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--fg)">{t}</text><text x={x + w / 2} y={y + h / 2 + 13} textAnchor="middle" fontSize={10.5} fill="var(--fg2)">{s}</text></g>
  )
  return (
    <Card title="How the pieces connect">
      <svg viewBox="0 0 980 204" className="w-full" role="img" aria-label="Browser to LiveKit server to agent worker">
        <Node x={10} y={50} w={210} h={74} t="Browser / mobile app" s="livekit-client · getUserMedia" c="var(--c-endpoint)" />
        <Node x={385} y={50} w={210} h={74} t="LiveKit server" s="rooms · SFU · global mesh" c="var(--c-play)" />
        <Node x={760} y={50} w={210} h={74} t="Agent worker (Python)" s="1 isolated Agent per room" c="var(--c-llm)" />
        {[[222, 383], [597, 758]].map(([a, b], i) => <g key={i}><line x1={a} x2={b - 6} y1={78} y2={78} stroke="var(--c-play)" strokeWidth={3} className="flow" /><line x1={b - 6} x2={a} y1={104} y2={104} stroke="var(--c-play)" strokeWidth={3} className="flow" style={{ animationDirection: 'reverse' }} /></g>)}
        <text x={302} y={70} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--c-play)">WebRTC · UDP</text><text x={302} y={120} textAnchor="middle" fontSize={10} fill="var(--fg3)">Opus audio both ways</text>
        <text x={678} y={70} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--c-play)">WebRTC</text>
        <path d="M 865 128 C 865 175, 115 175, 115 128" fill="none" stroke="var(--c-tool)" strokeWidth={2} strokeDasharray="6 5" />
        <text x={490} y={192} textAnchor="middle" fontSize={11} fill="var(--c-tool)" fontWeight={600}>RTCDataChannel · metrics, transcripts, state</text>
        <text x={865} y={34} textAnchor="middle" fontSize={11} fill="var(--fg2)">VAD · STT · LLM · TTS · tools</text>
        <text x={115} y={34} textAnchor="middle" fontSize={11} fill="var(--fg2)">signalling WS · media UDP</text>
      </svg>
    </Card>
  )
}

/* ============================================================================================ */
function Cmd({ children }: { children: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="group flex items-center gap-2 rounded-lg bg-inset px-3 py-2 font-mono text-[12px]">
      <span className="select-none text-fg3">$</span><code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{children}</code>
      <button aria-label="Copy" onClick={() => { navigator.clipboard?.writeText(children); setDone(true); setTimeout(() => setDone(false), 1200) }} className="text-fg3 hover:text-fg">{done ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
  )
}

function Setup({ configured, url }: { configured: boolean; url: string }) {
  return (
    <Card title="Run it" right={configured ? <Badge tone="good">LiveKit configured · {url}</Badge> : <Badge tone="warn">LiveKit not configured</Badge>}>
      <ol className="space-y-3 text-[12.5px] leading-snug text-fg2">
        <li><b className="text-fg">1 · A LiveKit server.</b> Either LiveKit Cloud (free tier) or a local dev server:
          <div className="mt-1.5 space-y-1.5"><Cmd>brew install livekit</Cmd><Cmd>livekit-server --dev</Cmd></div>
          <div className="mt-1 text-[11px] text-fg3">Dev mode uses <code>ws://localhost:7880</code>, key <code>devkey</code>, secret <code>secret</code>.</div></li>
        <li><b className="text-fg">2 · Credentials</b> in <code>.env</code> (copy <code>.env.example</code>):
          <div className="mt-1.5 rounded-lg bg-inset p-2.5 font-mono text-[11.5px] leading-relaxed">LIVEKIT_URL=ws://localhost:7880<br />LIVEKIT_API_KEY=devkey<br />LIVEKIT_API_SECRET=secret<br />OPENAI_API_KEY=…<br />ELEVEN_API_KEY=…</div></li>
        <li><b className="text-fg">3 · The agent worker</b> (downloads the turn-detector model once):
          <div className="mt-1.5 space-y-1.5"><Cmd>make agent-models</Cmd><Cmd>make agent</Cmd></div>
          <div className="mt-1 text-[11px] text-fg3">No server? <code>make agent-console</code> talks to the same agent in your terminal.</div></li>
        <li><b className="text-fg">4 · Connect</b> from the panel on the right — or use the hosted <i>LiveKit Playground</i> with the same project keys.</li>
      </ol>
      <p className="mt-3 rounded-lg bg-inset p-2.5 text-[11.5px] leading-snug text-fg3">Swap models without editing code: <code>LK_LLM_MODEL=gpt-4o</code> vs <code>gpt-4o-mini</code> reproduces the Lesson 5 TTFT experiment; <code>LK_VOICE_ID</code> switches the ElevenLabs voice; <code>LK_TURN=vad</code> disables the semantic turn detector; <code>LK_STT=voicestudio LK_TTS=voicestudio LK_LLM=ollama</code> runs the whole agent locally with your own <a className="text-accent underline" href="#/voicestudio">VoiceStudio</a> voices.</p>
    </Card>
  )
}

/* ============================================================================================ */
function Connect({ configured }: { configured: boolean }) {
  const [room, setRoom] = useState('voicelab-demo')
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle')
  const [err, setErr] = useState('')
  const [agentState, setAgentState] = useState('')
  const [agentId, setAgentId] = useState('')
  const [mic, setMic] = useState(false)
  const [turns, setTurns] = useState<Record<string, Turn>>({})
  const [order, setOrder] = useState<string[]>([])
  const [lines, setLines] = useState<{ role: string; text: string; final: boolean; interrupted?: boolean }[]>([])
  const [raw, setRaw] = useState<Msg[]>([])
  const roomRef = useRef<Room | null>(null)
  const audioBox = useRef<HTMLDivElement>(null)

  const onMsg = (m: Msg) => {
    setRaw((r) => [...r.slice(-80), m])
    if (m.kind === 'transcript') {
      setLines((ls) => {
        const last = ls[ls.length - 1]
        if (last && last.role === m.role && !last.final) return [...ls.slice(0, -1), { role: m.role, text: m.text, final: m.final, interrupted: m.interrupted }]
        return [...ls, { role: m.role, text: m.text, final: m.final, interrupted: m.interrupted }]
      })
      return
    }
    const id = String(m.speech_id ?? 'n/a')
    setOrder((o) => (o.includes(id) ? o : [...o, id]))
    setTurns((t) => {
      const c = { ...(t[id] ?? { speech: id }) }
      if (m.kind === 'llm') { c.ttft = m.ttft; c.tps = m.tokens_per_second; c.ptok = m.prompt_tokens; c.ctok = m.completion_tokens }
      if (m.kind === 'tts') { c.ttfb = m.ttfb }
      if (m.kind === 'eou') { c.eou = m.end_of_utterance_delay; c.transcription = m.transcription_delay }
      if (m.kind === 'stt') c.streamed = m.streamed
      return { ...t, [id]: c }
    })
  }

  const connect = async () => {
    setErr(''); setState('connecting'); setTurns({}); setOrder([]); setLines([]); setRaw([])
    try {
      const { token, url } = await api.livekitToken(room)
      const r = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = r
      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => { if (track.kind === Track.Kind.Audio && audioBox.current) { const el = track.attach(); audioBox.current.appendChild(el) } })
      r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((e) => e.remove()))
      r.on(RoomEvent.ParticipantAttributesChanged, (attrs, p) => { if (attrs['lk.agent.state'] !== undefined) { setAgentState(attrs['lk.agent.state']); setAgentId(p.identity) } })
      r.on(RoomEvent.DataReceived, (payload: Uint8Array, _p, _k, topic?: string) => { if (topic === 'voicelab') { try { onMsg(JSON.parse(new TextDecoder().decode(payload))) } catch { /* ignore */ } } })
      r.on(RoomEvent.Disconnected, () => setState('idle'))
      await r.connect(url, token)
      setState('live')
      try { await r.localParticipant.setMicrophoneEnabled(true); setMic(true) } catch (e: any) { setErr(`Joined the room, but the microphone could not be published: ${e?.message ?? e}`) }
    } catch (e: any) { setErr(String(e?.message ?? e)); setState('error') }
  }
  const disconnect = async () => { await roomRef.current?.disconnect(); roomRef.current = null; setState('idle'); setAgentState(''); setMic(false) }
  useEffect(() => () => { roomRef.current?.disconnect() }, [])

  const rows = order.map((id) => turns[id]).filter((t) => t && (t.ttft != null || t.ttfb != null || t.eou != null))
  const latest = rows[rows.length - 1]
  const resp = latest && latest.eou != null && latest.ttft != null && latest.ttfb != null ? (latest.eou + latest.ttft + latest.ttfb) * 1000 : null

  return (
    <Card title="Connect over WebRTC" right={<Badge tone={state === 'live' ? 'good' : state === 'error' ? 'bad' : 'neutral'} className={state === 'live' ? 'pulse' : ''}>{state}</Badge>}>
      <div className="flex flex-wrap items-center gap-2">
        <input value={room} onChange={(e) => setRoom(e.target.value)} disabled={state !== 'idle' && state !== 'error'} className="w-44 rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-xs outline-none focus:border-accent" aria-label="Room name" />
        {state === 'live' || state === 'connecting' ? <Button variant="danger" icon={<Power size={14} />} onClick={disconnect}>Leave room</Button> : <Button variant="primary" icon={<PlugZap size={14} />} onClick={connect} disabled={!configured}>Join room</Button>}
        {state === 'live' && mic && <Badge tone="accent"><Mic size={11} />mic published</Badge>}
        {agentState && <Badge tone={agentState === 'speaking' ? 'good' : agentState === 'thinking' ? 'warn' : 'neutral'}>{agentId || 'agent'} · {agentState}</Badge>}
      </div>
      {!configured && <p className="mt-3 rounded-lg bg-warn/10 p-2.5 text-xs text-warn">Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in <code>.env</code> and restart the backend to enable this panel (see “Run it”).</p>}
      {err && <p className="mt-3 text-xs text-bad">{err}</p>}
      <div ref={audioBox} className="hidden" />

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="eou delay" value={latest?.eou != null ? Math.round(latest.eou * 1000) : '—'} unit="ms" />
        <Stat label="llm ttft" value={latest?.ttft != null ? Math.round(latest.ttft * 1000) : '—'} unit="ms" />
        <Stat label="tts ttfb" value={latest?.ttfb != null ? Math.round(latest.ttfb * 1000) : '—'} unit="ms" />
        <Stat label="≈ response" value={resp != null ? fmtMs(resp) : '—'} tone={resp == null ? undefined : resp < 800 ? 'good' : resp < 1500 ? 'warn' : 'bad'} sub="eou + ttft + ttfb" />
      </div>

      <div className="mt-4 max-h-44 space-y-1.5 overflow-y-auto rounded-lg bg-inset p-2.5 text-[12px]">
        {lines.length === 0 && <div className="py-3 text-center text-fg3">Transcripts arrive over the data channel once you speak.</div>}
        {lines.map((l, i) => <div key={i} className={cx(l.role === 'user' ? 'text-fg2' : 'text-fg', !l.final && 'italic opacity-70')}><b className="mr-1 text-[10px] uppercase text-fg3">{l.role === 'user' ? 'you' : 'agent'}</b>{l.text}{l.interrupted && <Badge tone="bad" className="ml-1">interrupted</Badge>}</div>)}
      </div>
      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto"><table className="w-full text-[11.5px]"><thead><tr className="text-left text-fg3"><th className="py-1 pr-2 font-medium">speech</th><th className="font-medium">eou</th><th className="font-medium">transcr.</th><th className="font-medium">ttft</th><th className="font-medium">tok/s</th><th className="font-medium">ttfb</th></tr></thead>
          <tbody>{rows.slice(-6).reverse().map((t) => <tr key={t.speech} className="num border-t border-line"><td className="py-1 pr-2 text-fg3">{t.speech.slice(-6)}</td><td>{t.eou != null ? Math.round(t.eou * 1000) : '—'}</td><td>{t.transcription != null ? Math.round(t.transcription * 1000) : '—'}</td><td>{t.ttft != null ? Math.round(t.ttft * 1000) : '—'}</td><td>{t.tps ? Math.round(t.tps) : '—'}</td><td>{t.ttfb != null ? Math.round(t.ttfb * 1000) : '—'}</td></tr>)}</tbody></table>
          <div className="mt-1 text-[10.5px] text-fg3">ms · {raw.length} data-channel messages received</div></div>
      )}
    </Card>
  )
}

/* ============================================================================================
   Annotated source of the agent (read from the repo, so it can't drift)
   ============================================================================================ */
const STEPS: { id: string; match: RegExp; title: string; lesson: string; blurb: ReactNode }[] = [
  { id: 's1', match: /Step 1/, title: 'Step 1 · Imports & environment', lesson: 'L4', blurb: 'Plugins for each pipeline stage (Silero VAD, OpenAI STT/LLM, ElevenLabs TTS), dotenv for keys, logging to watch runtime state.' },
  { id: 's2', match: /Step 2/, title: 'Step 2 · The Assistant', lesson: 'L4', blurb: 'A stateful Agent: instructions are the system prompt; history, turn-taking state, interruption permission and tools come from the base class.' },
  { id: 's3', match: /Step 3/, title: 'Step 3 · entrypoint + AgentSession', lesson: 'L3·L4·L5', blurb: 'Called once per room. Connects, builds the VAD+STT+LLM+TTS pipeline with semantic turn detection, attaches the Assistant — and wires up the Lesson 5 metrics.' },
  { id: 's4', match: /Step 4/, title: 'Step 4 · Dispatch', lesson: 'L4', blurb: 'cli.run_app registers the worker with LiveKit so rooms can be dispatched to it.' },
]
const KW = /\b(import|from|class|def|async|await|return|if|elif|else|for|in|not|and|or|is|None|True|False|with|try|except|lambda|pass|raise|as|self)\b/g

function Code({ line }: { line: string }) {
  if (/^\s*#/.test(line)) return <span className="text-fg3">{line}</span>
  const parts: ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|@\w+)/g
  let last = 0, m: RegExpExecArray | null, k = 0
  const kw = (s: string) => s.split(KW).map((t, i) => (i % 2 ? <span key={i} style={{ color: 'var(--c-chunk)' }}>{t}</span> : t))
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push(<span key={k++}>{kw(line.slice(last, m.index))}</span>)
    const t = m[0]
    parts.push(<span key={k++} style={{ color: t.startsWith('#') ? 'var(--fg3)' : t.startsWith('@') ? 'var(--c-tool)' : 'var(--c-llm)' }}>{t}</span>)
    last = m.index + t.length
  }
  if (last < line.length) parts.push(<span key={k++}>{kw(line.slice(last))}</span>)
  return <>{parts}</>
}

function CodeViewer() {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { api.source('livekit_agent').then((r) => setText(r.text)).catch((e) => setErr(String(e.message))) }, [])
  const lines = useMemo(() => text.split('\n'), [text])
  // lines inside triple-quoted docstrings are prose, not code: don't keyword-highlight them
  const inDoc = useMemo(() => {
    let open = false
    return lines.map((l) => { const n = (l.match(/"""/g) ?? []).length; const was = open; if (n % 2 === 1) open = !open; return was || n > 0 })
  }, [lines])
  const anchors = useMemo(() => STEPS.map((s) => ({ ...s, line: lines.findIndex((l) => /^#\s+Step/.test(l) && s.match.test(l)) })), [lines])
  const jump = (line: number) => document.getElementById(`ln-${line}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <Card title="livekit_agent/agent.py" sub="the course code, runnable" right={<Badge>Python · livekit-agents 1.x</Badge>} pad={false}>
      <div className="grid lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-2 border-b border-line p-4 lg:border-b-0 lg:border-r">
          {anchors.map((s) => (
            <button key={s.id} onClick={() => s.line >= 0 && jump(s.line)} className="block w-full rounded-lg border border-line p-2.5 text-left hover:bg-inset">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold">{s.title}<LessonTag n={s.lesson.replace('L', '')} /></div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-fg3">{s.blurb}</div>
            </button>
          ))}
        </div>
        <div className="max-h-[560px] overflow-auto bg-inset/50 p-3 font-mono text-[11.5px] leading-[1.55]">
          {err && <div className="text-bad">{err}</div>}
          {lines.map((l, i) => <div key={i} id={`ln-${i}`} className="flex whitespace-pre"><span className="mr-3 w-7 shrink-0 select-none text-right text-fg3/60">{i + 1}</span><span>{inDoc[i] ? <span className="text-fg3">{l}</span> : <Code line={l} />}</span></div>)}
        </div>
      </div>
    </Card>
  )
}
