import { Mic, MicOff, Play, PlugZap, Power, RotateCcw, Scissors, Square, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ConfigPanel } from '../components/ConfigPanel'
import { LatencyBar, LatencyHistory, TurnTimerBar, VadTrace, Waterfall } from '../components/charts'
import { EventLog, MetricsPanel, PipelineDiagram, Transcript } from '../components/live'
import { Badge, Button, Card, LessonTag, Segmented, STAGE, Stat, Toggle, cx, fmtMs } from '../components/ui'
import { fitConfig, mergeSuggest, useConfig, useMeta } from '../lib/config'
import { store, useSession } from '../lib/session'
import type { StageId } from '../lib/types'

export default function LiveAgent() {
  const [cfg, setCfg] = useConfig()
  const { providers, personas, scenarios, error, refresh } = useMeta()
  const status = useSession((s) => s.status)
  const err = useSession((s) => s.error)
  const loading = useSession((s) => s.loading)
  const user = useSession((s) => s.userState)
  const agent = useSession((s) => s.agentState)
  const conv = useSession((s) => s.conv)
  const metrics = useSession((s) => s.metrics)
  const rtt = useSession((s) => s.rtt)
  const gate = useSession((s) => s.gate)
  const llmModel = useSession((s) => s.llmModel)
  const vadImpl = useSession((s) => s.vadImpl)
  const scenario = useSession((s) => s.scenario)
  const micOn = useSession((s) => s.micOn)
  const micRequested = useSession((s) => s.micRequested)
  const arch = useSession((s) => s.architecture)
  const [useMic, setUseMic] = useState(true)
  const [greet, setGreet] = useState(true)
  const [selected, setSelected] = useState<number | null>(null)
  const [tab, setTab] = useState<'metrics' | 'waterfall' | 'history' | 'barge' | 'events'>('metrics')
  const live = status === 'live'
  const busy = status === 'connecting' || status === 'loading'

  // adapt saved config to what this machine actually has (once providers are known)
  useEffect(() => { if (providers) setCfg(fitConfig(cfg, providers)) }, [providers]) // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (c: typeof cfg) => { setCfg(c); if (live && c.architecture === cfg.architecture && c.vad.provider === cfg.vad.provider) store.updateConfig(c) }

  const start = async () => store.connect(cfg, { mic: useMic, greet })
  const stop = () => store.disconnect()
  const sel = useMemo(() => metrics.find((m) => m.turn_id === selected) ?? metrics.at(-1), [metrics, selected])

  const runScenario = async (id: string) => {
    if (!live) {
      await store.connect(cfg, { mic: false, greet: true })
      await new Promise<void>((res) => { const off = store.subscribe(() => { if (store.getState().status === 'live') { off(); res() } else if (store.getState().status === 'error') { off(); res() } }) })
    }
    store.runScenario(id)
  }

  const sub = useMemo<Partial<Record<StageId, string>>>(() => ({
    vad: `${cfg.vad.provider} · thr ${cfg.vad.threshold}`,
    stt: `${cfg.stt.provider}${cfg.stt.model ? ' ' + cfg.stt.model : ''}`,
    turn: `${cfg.turn.mode} · ${cfg.turn.silence_timer_ms} ms`,
    llm: cfg.llm.provider === 'mock' ? `sim ${cfg.llm.mock_profile}` : `${cfg.llm.provider} ${live ? llmModel : cfg.llm.model}`.trim(),
    chunk: cfg.tts.chunking.strategy,
    tts: `${cfg.tts.provider}`,
    play: 'AudioContext',
  }), [cfg, live, llmModel])

  const savedPct = gate.total > 0 ? Math.round(100 - (gate.sent / gate.total) * 100) : null

  return (
    <div className="grid h-full grid-cols-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
      {/* ------------------------------------------------ left: configuration */}
      <Card title="Configuration" icon={<Wand2 size={14} />} pad={false} className="xl:h-[calc(100vh-6.5rem)] xl:overflow-y-auto">
        {providers ? (
          <ConfigPanel cfg={cfg} onChange={onChange} providers={providers} personas={personas} live={live} />
        ) : (
          <div className="p-4 text-sm text-fg2">
            {error ? <><b className="text-bad">Backend not reachable.</b> <span className="text-fg3">{error}</span><div className="mt-2"><Button size="sm" onClick={refresh}>Retry</Button></div></> : 'Loading providers…'}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------ right: the call */}
      <div className="min-w-0 space-y-4 xl:h-[calc(100vh-6.5rem)] xl:overflow-y-auto xl:pr-1">
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-3 p-3">
            {live || busy ? (
              <Button variant="danger" icon={<Power size={14} />} onClick={stop}>End session</Button>
            ) : (
              <Button variant="primary" icon={<PlugZap size={14} />} onClick={start} disabled={!providers}>Start session</Button>
            )}
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg2">
              <Toggle checked={useMic} onChange={setUseMic} disabled={live || busy} label={useMic ? <span className="flex items-center gap-1"><Mic size={13} />Mic</span> : <span className="flex items-center gap-1"><MicOff size={13} />No mic</span>} />
            </label>
            <Toggle checked={greet} onChange={setGreet} disabled={live || busy} label="Agent greets first" />
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <StatusPill status={status} loading={loading} />
              <Badge tone={user === 'speaking' ? 'accent' : 'neutral'}>user · {user}</Badge>
              <Badge tone={agent === 'speaking' ? 'good' : agent === 'thinking' ? 'warn' : 'neutral'}>agent · {agent}</Badge>
              {live && rtt != null && <Badge title="WebSocket round-trip (TCP). A WebRTC path would avoid head-of-line blocking – see the Transport Lab.">RTT {rtt} ms</Badge>}
              {live && vadImpl && <Badge>VAD {vadImpl}</Badge>}
            </div>
          </div>
          {status === 'error' && <div className="border-t border-line bg-bad/10 px-4 py-2 text-xs text-bad">{err}</div>}
          {live && micRequested && !micOn && <div className="border-t border-line bg-warn/10 px-4 py-2 text-xs text-warn">Microphone is not active – allow access in the browser, or use a scenario / typed message.</div>}
        </Card>

        <Card title="Pipeline" sub={arch === 'realtime' ? 'speech-to-speech' : 'cascaded: STT → LLM → TTS'} right={<LessonTag n={3}>execution flow</LessonTag>}>
          <PipelineDiagram sub={sub} />
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
        {arch === 'pipeline' && (
          <Card title="Voice activity & turn taking" sub="last 15 s" right={savedPct != null && live ? <Badge tone="good" title="Audio frames VAD kept away from STT – no transcription cost, no silence hallucinations (Lesson 4)">VAD gate · {savedPct}% not sent to STT</Badge> : undefined}>
            <VadTrace threshold={cfg.vad.threshold} />
            <div className="mt-2"><TurnTimerBar /></div>
          </Card>
        )}

        <Card title="Scenarios" sub="virtual callers speak into the pipeline in real time" pad={false}>
          <div className="flex gap-3 overflow-x-auto p-3">
            {scenarios.map((s) => (
              <div key={s.id} className="flex w-[210px] shrink-0 flex-col gap-1.5 rounded-lg border border-line p-2.5">
                <div className="text-[13px] font-semibold leading-tight">{s.name}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-fg3">{s.lesson}</div>
                <p className="flex-1 text-[11px] leading-snug text-fg3">{s.blurb}</p>
                <div className="flex gap-1.5">
                  {scenario?.id === s.id && scenario.running ? (
                    <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={() => store.stopScenario()}>Stop</Button>
                  ) : (
                    <Button size="sm" variant="primary" icon={<Play size={11} />} disabled={busy || !!scenario?.running} onClick={() => runScenario(s.id)}>Run</Button>
                  )}
                  <Button size="sm" title="Load the settings this scenario is designed to showcase" disabled={live} onClick={() => setCfg(mergeSuggest(cfg, s.suggest as Record<string, unknown>, s.persona))}>Apply settings</Button>
                </div>
              </div>
            ))}
            {scenarios.length === 0 && <div className="p-2 text-xs text-fg3">No scenarios loaded.</div>}
          </div>
        </Card>

        <Card title="Conversation" pad={false} className="flex min-h-[380px] flex-col" right={conv.length > 0 && !live ? <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => store.clearConversation()}>Clear</Button> : undefined}>
          <div className="flex-1 p-4">
            <Transcript items={conv} canSend={live} onSend={(t) => store.sendText(t)} selected={sel?.turn_id ?? null} onSelect={(id) => { setSelected(id); setTab('waterfall') }} />
          </div>
        </Card>
        </div>

      {/* ------------------------------------------------ telemetry (sticky) */}
      <div className="min-w-0 space-y-4 lg:sticky lg:top-0">
        <Card pad={false}>
          <div className="p-2"><Segmented size="sm" value={tab} onChange={setTab} options={[
            { value: 'metrics', label: 'Metrics' }, { value: 'waterfall', label: 'Waterfall' }, { value: 'history', label: 'History' }, { value: 'barge', label: 'Barge-in' }, { value: 'events', label: 'Events' },
          ]} /></div>
        </Card>

        {tab === 'metrics' && (
          <Card title={sel ? `Turn #${sel.turn_id}` : 'Latest turn'} sub={sel ? `“${sel.user_text.slice(0, 38)}${sel.user_text.length > 38 ? '…' : ''}”` : undefined} right={<LessonTag n={5}>metrics</LessonTag>}>
            {sel && sel.response_latency_ms != null && <div className="mb-3"><LatencyBar items={sel.breakdown} total={sel.response_latency_ms} /></div>}
            <MetricsPanel m={sel} />
          </Card>
        )}
        {tab === 'waterfall' && (
          <Card title="Streaming waterfall" sub="t = 0: user stops talking" right={<LessonTag n={5} />}>
            {sel && sel.spans.length ? <Waterfall m={sel} /> : <div className="py-8 text-center text-xs text-fg3">Run a turn to see which stages overlap.</div>}
            <p className="mt-2 text-[11px] leading-snug text-fg3">STT runs <i>during</i> speech; the LLM streams tokens while TTS is already synthesising; playout starts at the first audio byte. The only unavoidable serial wait is <b>endpointing → TTFT → TTFB</b>.</p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{(['endpointing', 'stt', 'llm_ttft', 'tool', 'tts_ttfb', 'playout'] as const).map((k) => <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-fg2"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: STAGE[k].color }} />{STAGE[k].label}</span>)}</div>
          </Card>
        )}
        {tab === 'history' && (
          <Card title="Response latency per turn" sub="stacked critical path">
            <LatencyHistory metrics={metrics} />
            <div className="mt-3 overflow-x-auto"><table className="w-full text-[11px]"><thead><tr className="text-left text-fg3"><th className="py-1 pr-2 font-medium">#</th><th className="font-medium">said</th><th className="text-right font-medium">TTFT</th><th className="text-right font-medium">TTFB</th><th className="text-right font-medium">total</th></tr></thead>
              <tbody>{metrics.slice().reverse().map((m) => <tr key={m.turn_id} onClick={() => { setSelected(m.turn_id); setTab('metrics') }} className="cursor-pointer border-t border-line hover:bg-inset"><td className="num py-1 pr-2">{m.turn_id}</td><td className="max-w-[140px] truncate">{m.user_text}</td><td className="num text-right">{m.llm.ttft_ms != null ? Math.round(m.llm.ttft_ms) : '—'}</td><td className="num text-right">{m.tts.ttfb_ms != null ? Math.round(m.tts.ttfb_ms) : '—'}</td><td className="num text-right font-medium">{fmtMs(m.response_latency_ms)}</td></tr>)}</tbody></table></div>
          </Card>
        )}
        {tab === 'barge' && <BargeIn />}
        {tab === 'events' && <Card title="Event stream" sub="what the dashboard sees" pad><EventLog /></Card>}
      </div>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ status, loading }: { status: string; loading: Record<string, string> }) {
  const pending = Object.entries(loading).filter(([, v]) => v === 'loading').map(([k]) => k)
  const map: Record<string, { t: 'neutral' | 'good' | 'warn' | 'bad'; l: string }> = {
    idle: { t: 'neutral', l: 'offline' }, connecting: { t: 'warn', l: 'connecting…' }, loading: { t: 'warn', l: pending.length ? `loading ${pending.join(', ')}…` : 'starting…' },
    live: { t: 'good', l: 'live' }, error: { t: 'bad', l: 'error' },
  }
  const m = map[status]
  return <Badge tone={m.t} className={cx(status === 'live' && 'pulse')}>{m.l}</Badge>
}

/** What a barge-in did: how much audio was heard, what got cut, and the history the LLM now sees. */
function BargeIn() {
  const ev = useSession((s) => s.lastInterrupt)
  const conv = useSession((s) => s.conv)
  const lastAgent = [...conv].reverse().find((c) => c.role === 'agent' && c.interrupted)
  if (!ev) {
    return (
      <Card title="Interruption inspector" right={<LessonTag n={3}>context sync</LessonTag>}>
        <div className="space-y-2 py-4 text-center text-xs text-fg3"><Scissors className="mx-auto" size={22} />Run the <b>Barge-in</b> scenario, or talk over the agent. The inspector shows exactly which audio the user heard and how the LLM history was truncated to match.</div>
      </Card>
    )
  }
  const total = Math.max(1, ev.audio_sent_ms)
  const played = Math.min(ev.played_ms, total)
  const sents: { text: string; start_ms: number; dur_ms: number; synth: boolean }[] = ev.sentences ?? []
  return (
    <Card title="Interruption inspector" sub={ev.reason} right={<LessonTag n={3}>context sync</LessonTag>}>
      <div className="grid grid-cols-3 gap-3"><Stat label="audio generated" value={(total / 1000).toFixed(1)} unit="s" /><Stat label="user heard" value={(played / 1000).toFixed(1)} unit="s" tone="good" /><Stat label="never heard" value={((total - played) / 1000).toFixed(1)} unit="s" tone="bad" /></div>
      <div className="mt-3">
        <div className="relative h-9 overflow-hidden rounded-lg bg-inset">
          {sents.filter((s) => s.synth).map((s, i) => (
            <div key={i} className="absolute inset-y-1 rounded-[5px] border border-line-strong/60 bg-surface" style={{ left: `${(s.start_ms / total) * 100}%`, width: `calc(${(s.dur_ms / total) * 100}% - 2px)` }} title={s.text} />
          ))}
          <div className="absolute inset-y-1 left-0 rounded-l-[5px] bg-play/40" style={{ width: `${(played / total) * 100}%` }} />
          <div className="absolute inset-y-0 w-0.5 bg-bad" style={{ left: `${(played / total) * 100}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-fg3"><span>0 s</span><span className="font-medium text-bad">✂ interrupted at {(played / 1000).toFixed(2)} s</span><span>{(total / 1000).toFixed(1)} s</span></div>
      </div>
      <div className="mt-3 space-y-2 text-xs">
        <div><div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-fg3">LLM history now ends with (heard)</div><div className="rounded-lg bg-inset p-2 leading-snug">{ev.heard_text || <i className="text-fg3">nothing – interrupted before the first word</i>}</div></div>
        <div><div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-fg3">Dropped (generated but unheard)</div><div className="rounded-lg bg-inset p-2 leading-snug text-fg3 line-through decoration-bad/60">{ev.unheard_text || '—'}</div></div>
      </div>
      <p className="mt-3 text-[11px] leading-snug text-fg3">Without this sync the LLM would believe the user heard all {sents.length || ''} sentences and answer follow-ups like “what was the last option?” from text they never heard. Queued audio dropped: <span className="num">{ev.dropped_bytes ?? 0} B</span>.{lastAgent ? '' : ''}</p>
    </Card>
  )
}
