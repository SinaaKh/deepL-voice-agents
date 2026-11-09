import { ArrowRight, Check, Copy, Play, RefreshCw, ShieldAlert, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Field, PageHeader, Select, Slider, Stat, cx, fmtMs } from '../components/ui'
import { api, voicestudioSpeak, type SpeakMetrics } from '../lib/api'
import { pushConfig } from '../lib/config'
import type { VoiceStudioSelfTest, VoiceStudioStatus } from '../lib/types'

export default function VoiceStudioPage() {
  const [st, setSt] = useState<VoiceStudioStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => { setBusy(true); api.voicestudioStatus().then((s) => { setSt(s); setErr('') }).catch((e) => setErr(String(e.message ?? e))).finally(() => setBusy(false)) }
  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id) }, [])
  const up = !!st?.reachable && !st.auth_required
  return (
    <div className="mx-auto max-w-[1180px] space-y-4">
      <PageHeader title="VoiceStudio" lessons={<Badge tone="accent">local voice studio</Badge>}>
        <b>VoiceStudio</b> is an open-source, fully local ElevenLabs-style studio: voice cloning, voice design, dubbing and transcription on your own machine. Plug it into VoiceLab and your
        <i> own voices</i> and its ASR engine become the agent’s TTS and STT — streamed sentence by sentence, with VoiceStudio’s own time-to-first-audio and real-time factor shown next to the course’s metrics.
      </PageHeader>
      <StatusCard st={st} err={err} busy={busy} onRefresh={load} />
      {up && st && <Audition st={st} />}
      {up && <SelfTest />}
      <HowItFits />
    </div>
  )
}

function Cmd({ children }: { children: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2 font-mono text-[12px]">
      <span className="select-none text-fg3">$</span><code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{children}</code>
      <button aria-label="Copy" onClick={() => { navigator.clipboard?.writeText(children); setDone(true); setTimeout(() => setDone(false), 1200) }} className="text-fg3 hover:text-fg">{done ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
  )
}

function StatusCard({ st, err, busy, onRefresh }: { st: VoiceStudioStatus | null; err: string; busy: boolean; onRefresh: () => void }) {
  const up = !!st?.reachable
  const tone = !st ? 'neutral' : st.auth_required ? 'warn' : up ? 'good' : 'bad'
  return (
    <Card title="Connection" right={<><Badge tone={tone} className={up ? 'pulse' : ''}>{!st ? 'checking…' : st.auth_required ? 'needs API key' : up ? 'running' : 'not running'}</Badge><Button size="sm" variant="ghost" icon={<RefreshCw size={12} className={cx(busy && 'animate-spin')} />} onClick={onRefresh}>Refresh</Button></>}>
      {err && <p className="text-xs text-bad">{err}</p>}
      {st && !up && (
        <div className="space-y-3 text-[13px] text-fg2">
          <p>No VoiceStudio answering at <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-xs">{st.url}</code>.{st.installed ? ' It is installed on this machine – start it:' : ' Install it next to this project, then start it:'}</p>
          {!st.installed && <Cmd>make studio-install</Cmd>}
          <Cmd>make studio-up</Cmd>
          <p className="text-[11.5px] text-fg3">Checkout: <code>{st.home}</code> · override with <code>VOICESTUDIO_HOME</code> / <code>VOICESTUDIO_URL</code>.</p>
        </div>
      )}
      {st?.auth_required && <p className="flex items-center gap-2 text-xs text-warn"><ShieldAlert size={14} />This VoiceStudio requires a bearer key – set <code>VOICESTUDIO_API_KEY</code> in .env (remote servers only; loopback needs none).</p>}
      {up && !st.auth_required && st && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="version" value={st.version ?? '—'} />
            <Stat label="accelerator" value={st.device ?? '—'} tone={st.device === 'mps' || st.device === 'cuda' ? 'good' : st.device ? 'warn' : undefined} sub={st.device === 'cpu' ? 'slower' : undefined} />
            <Stat label="asr engine" value={st.asr_engine ?? '—'} />
            <Stat label="voice profiles" value={st.voices} />
            <Stat label="tts engines" value={st.tts_engines.length} sub="available" />
            <Stat label="probe" value={st.probe_ms != null ? Math.round(st.probe_ms) : '—'} unit="ms" />
          </div>
          {st.engines_loading && <p className="rounded-lg bg-warn/10 p-2.5 text-xs text-warn">VoiceStudio is loading its engine catalogue (the very first call can take up to a minute). This page refreshes by itself.</p>}
          {st.engines.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {st.engines.map((e) => (
                <div key={e.id} title={e.reason ?? ''} className={cx('flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs', !e.available && 'opacity-60')}>
                  <span className={cx('h-2 w-2 shrink-0 rounded-full', e.available ? 'bg-good' : 'bg-line-strong')} />
                  <b className="font-mono">{e.id}</b><span className="truncate text-fg3">{e.display_name?.replace(/\s*\(.*$/, '')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function Audition({ st }: { st: VoiceStudioStatus }) {
  const [text, setText] = useState('Thanks for calling Bella Notte. I can book a table for you in just a moment.')
  const [voice, setVoice] = useState('')
  const [engine, setEngine] = useState(st.engines.find((e) => e.available)?.id ?? '')
  const [speed, setSpeed] = useState(1)
  const [instruct, setInstruct] = useState('')
  const [language, setLanguage] = useState('')
  const [m, setM] = useState<SpeakMetrics | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null)
  const available = st.engines.filter((e) => e.available)
  const speak = async () => {
    setBusy(true); setErr('')
    try {
      const { blob, metrics } = await voicestudioSpeak({ text, voice, model: engine, speed, language, instruct })
      setM(metrics)
      audio.current?.pause()
      audio.current = new Audio(URL.createObjectURL(blob))
      await audio.current.play().catch(() => {})
    } catch (e: any) { setErr(String(e.message ?? e)) }
    setBusy(false)
  }
  const use = () => {
    pushConfig((c) => {
      c.tts = { ...c.tts, provider: 'voicestudio', voice_id: voice, model: engine, speed, instruct, language }
      c.stt = { ...c.stt, provider: 'voicestudio', model: '' }
    })
    location.hash = '#/live'
  }
  return (
    <Card title="Audition a voice" sub="same provider code the live agent uses">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={400} className="w-full resize-y rounded-lg border border-line-strong bg-inset px-3 py-2 text-[13px] outline-none focus:border-accent" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Voice"><Select value={voice} onChange={setVoice} options={[{ value: '', label: 'Default (engine voice)' }, ...st.voice_profiles.map((v) => ({ value: v.voice_id, label: v.name + (v.language ? ` · ${v.language}` : '') }))]} /></Field>
            <Field label="Engine"><Select value={engine} onChange={setEngine} options={available.map((e) => ({ value: e.id, label: e.id }))} /></Field>
            <Field label="Speed" value={`${speed.toFixed(2)}×`}><Slider value={speed} min={0.7} max={1.4} step={0.05} onChange={setSpeed} /></Field>
            <Field label="Language"><input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="auto (en, de, fa…)" className="w-full rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-xs outline-none focus:border-accent" /></Field>
          </div>
          <Field label="Voice style" hint="Describe delivery in words – engines that support voice design follow it."><input value={instruct} onChange={(e) => setInstruct(e.target.value)} placeholder="e.g. warm, calm, slight British accent" className="w-full rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-xs outline-none focus:border-accent" /></Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Play size={13} />} onClick={speak} disabled={busy || !text.trim()}>{busy ? 'Synthesising…' : 'Speak'}</Button>
            <Button icon={<ArrowRight size={13} />} onClick={use} title="Use this voice, engine and VoiceStudio STT in the Live Agent">Use in Live Agent</Button>
          </div>
          {err && <p className="text-xs text-bad">{err}</p>}
        </div>
        <div className="rounded-xl bg-inset p-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg3">Timings</div>
          {m ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Stat label="ttfb (voicelab)" value={Math.round(m.ttfbMs)} unit="ms" sub="first audio byte" tone={m.ttfbMs < 500 ? 'good' : m.ttfbMs < 1200 ? 'warn' : 'bad'} />
              <Stat label="ttfa (server)" value={m.ttfaMs != null ? Math.round(m.ttfaMs) : '—'} unit="ms" sub="VoiceStudio's own" />
              <Stat label="rtf" value={m.rtf != null ? m.rtf.toFixed(2) : '—'} sub="render ÷ audio (<1 = faster than speech)" tone={m.rtf != null ? (m.rtf < 1 ? 'good' : 'warn') : undefined} />
              <Stat label="audio" value={(m.audioMs / 1000).toFixed(1)} unit="s" sub={`total ${fmtMs(m.totalMs)}`} />
              <div className="col-span-2 flex gap-1.5"><Badge>{m.engine || 'engine'}</Badge><Badge tone={m.transport === 'ws' ? 'good' : 'warn'}>{m.transport === 'ws' ? 'WebSocket stream' : 'HTTP fallback'}</Badge></div>
              <p className="col-span-2 text-[11px] leading-snug text-fg3">Most local engines render a whole sentence before the first byte exists, so ttfa ≈ render time. VoiceLab hides it by speaking sentence by sentence while the LLM is still writing; a lighter engine (e.g. kittentts) trades voice quality for speed.</p>
            </div>
          ) : <p className="py-6 text-center text-xs text-fg3"><Waves className="mx-auto mb-2" size={20} />Press Speak to hear the voice and see how fast VoiceStudio produced it.</p>}
        </div>
      </div>
    </Card>
  )
}

function SelfTest() {
  const [r, setR] = useState<VoiceStudioSelfTest | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { setR(await api.voicestudioSelftest({})) } catch (e: any) { setR({ ok: false, error: String(e.message ?? e) } as VoiceStudioSelfTest) } setBusy(false) }
  return (
    <Card title="Round-trip self-test" sub="text → VoiceStudio TTS → VoiceStudio ASR → text" right={<Button size="sm" variant="primary" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run test'}</Button>}>
      {!r && <p className="text-xs text-fg3">Proves both directions work and measures them the way the agent would (the ASR leg receives 16 kHz audio, exactly like the pipeline’s STT).</p>}
      {r && !r.ok && <p className="text-xs text-bad">{r.error}</p>}
      {r?.ok && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-inset p-3 text-xs"><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg3">Said</div>{r.reference}</div>
            <div className="rounded-lg bg-inset p-3 text-xs"><div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-fg3">Heard back <Badge tone={r.match ? 'good' : 'warn'}>{r.match ? 'match' : 'differs'} · WER {(r.wer * 100).toFixed(0)}%</Badge></div>{r.heard || <i className="text-fg3">nothing</i>}</div>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label="tts ttfb" value={Math.round(r.tts.ttfb_ms)} unit="ms" />
            <Stat label="server ttfa" value={r.tts.server_ttfa_ms != null ? Math.round(r.tts.server_ttfa_ms) : '—'} unit="ms" />
            <Stat label="rtf" value={r.tts.rtf != null ? r.tts.rtf.toFixed(2) : '—'} />
            <Stat label="stt latency" value={Math.round(r.stt.latency_ms)} unit="ms" sub={`${(r.tts.audio_ms / 1000).toFixed(1)} s of audio`} />
            <Stat label="total" value={(r.total_ms / 1000).toFixed(1)} unit="s" />
          </div>
        </div>
      )}
    </Card>
  )
}

function HowItFits() {
  const rows: [string, string, string][] = [
    ['TTS', 'WebSocket /ws/tts → PCM16 24 kHz', 'Streams each sentence as it is rendered; reports ttfa_ms and RTF. Falls back to POST /v1/audio/speech.'],
    ['STT', 'POST /v1/audio/transcriptions', 'The utterance-so-far is decoded every ~0.7 s for interim text, and once more at the first pause so the turn detector reads fresh words.'],
    ['Voices', 'GET /v1/audio/voices', 'Your cloned and designed profiles appear in the voice picker; `voice_id` is the profile id or name.'],
    ['Agent', 'LK_STT / LK_TTS = voicestudio', 'The LiveKit agent talks to the same OpenAI-compatible endpoints, so with LK_LLM=ollama it is fully local.'],
  ]
  return (
    <Card title="How VoiceLab uses it" pad={false}>
      <table className="w-full text-[12.5px]"><tbody>{rows.map(([a, b, c]) => <tr key={a} className="border-b border-line align-top last:border-0"><td className="px-4 py-2.5 font-semibold">{a}</td><td className="py-2.5 pr-3 font-mono text-[11.5px] text-fg2">{b}</td><td className="py-2.5 pr-4 text-fg2">{c}</td></tr>)}</tbody></table>
      <p className="border-t border-line px-4 py-3 text-[11.5px] leading-snug text-fg3">VoiceStudio is a separate program (AGPL-3.0); VoiceLab only talks to it over HTTP/WebSocket and never ships or imports its code. Model weights have their own licences – e.g. OmniVoice is non-commercial (CC-BY-NC) – so check them before commercial use.</p>
    </Card>
  )
}
