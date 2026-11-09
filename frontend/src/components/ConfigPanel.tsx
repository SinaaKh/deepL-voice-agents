import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { DEFAULT_CONFIG, type Persona, type ProviderInfo, type Providers, type SessionConfig } from '../lib/types'
import { Badge, Button, Field, LessonTag, Segmented, Select, Slider, Toggle, cx } from './ui'

type Upd = (fn: (c: SessionConfig) => void) => void

function Section({ title, lesson, children, open: o = false, badge }: { title: string; lesson?: number; children: ReactNode; open?: boolean; badge?: ReactNode }) {
  const [open, setOpen] = useState(o)
  return (
    <div className="border-b border-line last:border-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-inset/60">
        <span className="text-[13px] font-semibold">{title}</span>
        {lesson && <LessonTag n={lesson} />}
        {badge}
        <ChevronDown size={14} className={cx('ml-auto text-fg3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-3.5 px-4 pb-4 pt-1">{children}</div>}
    </div>
  )
}

const opts = (ps: ProviderInfo[]) => ps.map((p) => ({ value: p.id, label: p.label + (p.available ? '' : ' — unavailable'), disabled: !p.available }))

export function ConfigPanel({ cfg, onChange, providers, personas, live }: { cfg: SessionConfig; onChange: (c: SessionConfig) => void; providers: Providers | null; personas: Persona[]; live: boolean }) {
  const upd: Upd = (fn) => { const n = structuredClone(cfg); fn(n); onChange(n) }
  const P = providers
  const sttP = P?.stt.find((p) => p.id === cfg.stt.provider)
  const llmP = P?.llm.find((p) => p.id === cfg.llm.provider)
  const ttsP = P?.tts.find((p) => p.id === cfg.tts.provider)
  const persona = personas.find((p) => p.id === cfg.persona)
  const ok = (id: string, list: ProviderInfo[] | undefined) => !!list?.find((p) => p.id === id)?.available

  const presets: { id: string; label: string; need: () => string | null; apply: (c: SessionConfig) => void }[] = [
    { id: 'local', label: 'Local stack', need: () => (ok('whisper-local', P?.stt) && ok('ollama', P?.llm) && ok('piper', P?.tts) ? null : 'needs Whisper + Ollama + Piper'),
      apply: (c) => { c.stt = { provider: 'whisper-local', model: 'base.en', language: 'en' }; c.llm.provider = 'ollama'; c.llm.model = P?.llm.find((p) => p.id === 'ollama')?.default ?? ''; c.tts.provider = 'piper'; c.tts.voice_id = P?.tts.find((p) => p.id === 'piper')?.default ?? '' } },
    { id: 'sim', label: 'Simulated', need: () => null,
      apply: (c) => { c.stt = { provider: 'mock', model: '', language: 'en' }; c.llm.provider = 'mock'; c.llm.model = ''; c.tts.provider = 'mock'; c.tts.voice_id = 'a' } },
    { id: 'fast', label: 'Fast cloud', need: () => (ok('deepgram', P?.stt) && ok('groq', P?.llm) && ok('elevenlabs', P?.tts) ? null : 'needs Deepgram + Groq + ElevenLabs keys'),
      apply: (c) => { c.stt = { provider: 'deepgram', model: 'nova-3', language: 'en' }; c.llm.provider = 'groq'; c.llm.model = 'llama-3.3-70b-versatile'; c.tts.provider = 'elevenlabs'; c.tts.voice_id = 'CwhRBWXzGAHq8TQ4Fs17' } },
    { id: 'course', label: 'Course stack', need: () => (ok('openai', P?.stt) && ok('openai', P?.llm) && ok('elevenlabs', P?.tts) ? null : 'needs OpenAI + ElevenLabs keys'),
      apply: (c) => { c.stt = { provider: 'openai', model: 'gpt-4o-mini-transcribe', language: 'en' }; c.llm.provider = 'openai'; c.llm.model = 'gpt-4o-mini'; c.tts.provider = 'elevenlabs'; c.tts.voice_id = 'CwhRBWXzGAHq8TQ4Fs17' } },
  ]

  return (
    <div className="text-sm">
      <div className="border-b border-line px-4 py-3">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg3">Provider presets</div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => { const why = p.need(); return <Button key={p.id} size="sm" disabled={!!why} title={why ?? ''} onClick={() => upd(p.apply)}>{p.label}</Button> })}
          <Button size="sm" variant="ghost" onClick={() => onChange(structuredClone(DEFAULT_CONFIG))}>Reset</Button>
        </div>
        {live && <p className="mt-2 text-[11px] text-fg3">Most changes apply live; architecture and VAD engine need a reconnect.</p>}
      </div>

      <Section title="Architecture" lesson={1} open>
        <Segmented value={cfg.architecture} onChange={(v) => upd((c) => { c.architecture = v })} options={[
          { value: 'pipeline', label: 'Pipeline (STT→LLM→TTS)' },
          { value: 'realtime', label: 'Speech-to-speech', disabled: !P?.realtime.available, title: P?.realtime.reason },
        ]} />
        {cfg.architecture === 'realtime' ? (
          <>
            <Field label="Realtime model"><Select value={cfg.realtime_model} onChange={(v) => upd((c) => { c.realtime_model = v })} options={(P?.realtime.models ?? ['gpt-realtime']).map((m) => ({ value: m, label: m }))} /></Field>
            <Field label="Voice"><Select value={cfg.realtime_voice} onChange={(v) => upd((c) => { c.realtime_voice = v })} options={(P?.realtime.voices ?? ['marin']).map((m) => ({ value: m, label: m }))} /></Field>
          </>
        ) : (
          <p className="text-[11px] leading-snug text-fg3">Modular stages you can inspect, swap and budget independently – at the cost of orchestration and latency management.</p>
        )}
        {!P?.realtime.available && <p className="text-[11px] text-fg3">Speech-to-speech is disabled: {P?.realtime.reason}.</p>}
      </Section>

      <Section title="Use case" lesson={4} open badge={persona && <Badge tone="accent">budget → {persona.focus}</Badge>}>
        <Field label="Persona" hint="Different use cases spend the latency/cost budget on different layers (Lesson 4).">
          <Select value={cfg.persona} onChange={(v) => upd((c) => { c.persona = v; c.system_prompt = '' })} options={personas.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        {persona && <p className="text-[11px] leading-snug text-fg3">{persona.blurb}</p>}
        <Field label="System prompt" hint="Short, spoken-style replies are the cheapest latency optimisation: fewer tokens → earlier first sentence → earlier audio.">
          <textarea rows={5} value={cfg.system_prompt || persona?.system_prompt || ''} onChange={(e) => upd((c) => { c.system_prompt = e.target.value })}
            className="w-full resize-y rounded-lg border border-line-strong bg-inset px-2.5 py-2 text-[11.5px] leading-snug outline-none focus:border-accent" />
        </Field>
      </Section>

      {cfg.architecture === 'pipeline' && (
        <>
          <Section title="Voice activity detection" lesson={3}>
            <Field label="Engine" hint="Silero is a small neural binary classifier. The energy gate just thresholds loudness – try it with background noise to see why neural VAD matters."><Select value={cfg.vad.provider} onChange={(v) => upd((c) => { c.vad.provider = v as 'silero' | 'energy' })} options={opts(P?.vad ?? [])} /></Field>
            <Field label="Activation threshold" value={cfg.vad.threshold.toFixed(2)} hint="Speech probability above this counts as speech."><Slider value={cfg.vad.threshold} min={0.1} max={0.9} step={0.05} onChange={(v) => upd((c) => { c.vad.threshold = v })} /></Field>
            <Field label="Min speech (blocking)" value={`${cfg.vad.min_speech_ms} ms`} lesson={5} hint="VAD is intentionally blocking: audio is held back this long at the start of an utterance until we're sure it's speech (≈15–20 ms in the course). Lower = snappier, noisier."><Slider value={cfg.vad.min_speech_ms} min={32} max={320} step={32} onChange={(v) => upd((c) => { c.vad.min_speech_ms = v })} /></Field>
            <Field label="Min silence (debounce)" value={`${cfg.vad.min_silence_ms} ms`} hint="Silence needed before VAD reports 'speech ended' – shorter than the end-of-turn timer."><Slider value={cfg.vad.min_silence_ms} min={64} max={800} step={32} onChange={(v) => upd((c) => { c.vad.min_silence_ms = v })} /></Field>
            <Field label="Prefix padding" value={`${cfg.vad.prefix_padding_ms} ms`} hint="Audio kept from just before speech was detected, so STT doesn't miss the first syllable."><Slider value={cfg.vad.prefix_padding_ms} min={0} max={800} step={32} onChange={(v) => upd((c) => { c.vad.prefix_padding_ms = v })} /></Field>
          </Section>

          <Section title="Turn detection" lesson={3} open badge={<Badge>{cfg.turn.mode}</Badge>}>
            <Segmented value={cfg.turn.mode} onChange={(v) => upd((c) => { c.turn.mode = v })} options={[
              { value: 'vad', label: 'VAD timer' }, { value: 'semantic', label: 'VAD + semantic' }, { value: 'llm', label: 'LLM judge' },
            ]} />
            <p className="text-[11px] leading-snug text-fg3">
              {cfg.turn.mode === 'vad' && 'Signal only: when VAD flips to silence, a fixed timer starts. Pauses to think look the same as being done.'}
              {cfg.turn.mode === 'semantic' && 'Signal + semantics: a model reads the transcript and the last turns. If the thought looks unfinished, the VAD timer is extended.'}
              {cfg.turn.mode === 'llm' && 'Like semantic, but your chosen LLM judges completeness – flexible, but each judgement is an extra model call.'}
            </p>
            <Field label="Silence timer" value={`${cfg.turn.silence_timer_ms} ms`} hint="min_endpointing_delay: silence required before the turn ends."><Slider value={cfg.turn.silence_timer_ms} min={100} max={2000} step={50} onChange={(v) => upd((c) => { c.turn.silence_timer_ms = v })} /></Field>
            <Field label="Extended delay" value={`${cfg.turn.max_delay_ms} ms`} hint="max_endpointing_delay: how long to wait when the thought looks unfinished." ><Slider disabled={cfg.turn.mode === 'vad'} value={cfg.turn.max_delay_ms} min={500} max={6000} step={100} onChange={(v) => upd((c) => { c.turn.max_delay_ms = v })} /></Field>
            <Field label="Completeness threshold" value={cfg.turn.threshold.toFixed(2)} hint="P(end-of-turn) below this extends the timer."><Slider disabled={cfg.turn.mode === 'vad'} value={cfg.turn.threshold} min={0.1} max={0.9} step={0.05} onChange={(v) => upd((c) => { c.turn.threshold = v })} /></Field>
          </Section>

          <Section title="Interruptions (barge-in)" lesson={3}>
            <Toggle checked={cfg.interrupt.enabled} onChange={(v) => upd((c) => { c.interrupt.enabled = v })} label="Allow the user to interrupt" />
            <Field label="Min speech to interrupt" value={`${cfg.interrupt.min_duration_ms} ms`} hint="Shorter sounds ('uh-huh', coughs) are treated as backchannels and ignored."><Slider disabled={!cfg.interrupt.enabled} value={cfg.interrupt.min_duration_ms} min={0} max={1500} step={40} onChange={(v) => upd((c) => { c.interrupt.min_duration_ms = v })} /></Field>
            <p className="text-[11px] leading-snug text-fg3">Use headphones with a live mic, otherwise the agent can hear itself and interrupt itself.</p>
          </Section>

          <Section title="Speech-to-text" lesson={4} badge={sttP && <Badge tone={sttP.streaming ? 'good' : 'warn'}>{sttP.streaming ? 'streaming' : 'buffered'}</Badge>}>
            <Field label="Provider"><Select value={cfg.stt.provider} onChange={(v) => upd((c) => { c.stt.provider = v; c.stt.model = P?.stt.find((p) => p.id === v)?.default ?? '' })} options={opts(P?.stt ?? [])} /></Field>
            {!!sttP?.models?.length && <Field label="Model" hint="Bigger models transcribe specialised vocabulary better but add finalisation latency (tiny.en ≈ 2× faster than base.en on CPU)."><Select value={cfg.stt.model || sttP.default || ''} onChange={(v) => upd((c) => { c.stt.model = v })} options={sttP.models.map((m) => ({ value: m, label: m }))} /></Field>}
            {(cfg.stt.provider === 'whisper-local' || cfg.stt.provider === 'openai') && (
              <Field label="Vocabulary hint" lesson={4} hint="Domain-specific STT tuning: an initial prompt biases the recogniser toward your terms (menu items, drug names…). It also protects the semantic turn detector, which can only judge the words STT gives it – a mis-heard “table for” → “table saw” looks like a finished sentence.">
                <textarea rows={3} value={cfg.stt.prompt ?? ''} placeholder={persona?.stt_prompt || 'e.g. product names, jargon…'} onChange={(e) => upd((c) => { c.stt.prompt = e.target.value })}
                  className="w-full resize-y rounded-lg border border-line-strong bg-inset px-2.5 py-2 text-[11.5px] leading-snug outline-none focus:border-accent" />
              </Field>
            )}
            {cfg.stt.provider === 'mock' && <p className="text-[11px] text-warn">Scripted STT only “hears” scenarios – it cannot transcribe a live microphone.</p>}
          </Section>

          <Section title="Language model" lesson={4} badge={llmP && <Badge tone={llmP.local ? 'good' : 'neutral'}>{llmP.local ? 'local' : 'cloud'}</Badge>}>
            <Field label="Provider" hint="Groq / Cerebras / Together serve open models on ultra-fast inference hardware – the Lesson 1 'API routing' optimisation."><Select value={cfg.llm.provider} onChange={(v) => upd((c) => { c.llm.provider = v; c.llm.model = P?.llm.find((p) => p.id === v)?.default ?? '' })} options={opts(P?.llm ?? [])} /></Field>
            {cfg.llm.provider === 'mock' ? (
              <Field label="Latency profile" hint="Scripted replies with course-measured TTFT: gpt-4o ≈ 840 ms, gpt-4o-mini ≈ 420 ms. Swap profiles to reproduce the Lesson 5 experiment.">
                <Select value={cfg.llm.mock_profile} onChange={(v) => upd((c) => { c.llm.mock_profile = v })} options={Object.entries(llmP?.profiles ?? {}).map(([k, v]) => ({ value: k, label: `${k} · TTFT ${v.ttft_ms} ms · ${v.tps} tok/s` }))} />
              </Field>
            ) : (
              !!llmP?.models?.length && <Field label="Model"><Select value={cfg.llm.model || llmP.default || ''} onChange={(v) => upd((c) => { c.llm.model = v })} options={llmP.models.map((m) => ({ value: m, label: m }))} /></Field>
            )}
            <Field label="Temperature" value={cfg.llm.temperature.toFixed(1)}><Slider value={cfg.llm.temperature} min={0} max={1.2} step={0.1} onChange={(v) => upd((c) => { c.llm.temperature = v })} /></Field>
            <Field label="Max tokens" value={cfg.llm.max_tokens} hint="Hard cap on reply length – a blunt but effective guard against rambling answers."><Slider value={cfg.llm.max_tokens} min={32} max={600} step={8} onChange={(v) => upd((c) => { c.llm.max_tokens = v })} /></Field>
            <div className="space-y-1.5 border-t border-line pt-3">
              <Toggle checked={cfg.guardrails.enabled} onChange={(v) => upd((c) => { c.guardrails.enabled = v })} label={<span>Guardrails <span className="text-fg3">(content filter at the LLM layer)</span></span>} />
              {cfg.guardrails.enabled && <input value={cfg.guardrails.blocked_terms.join(', ')} onChange={(e) => upd((c) => { c.guardrails.blocked_terms = e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="blocked terms, comma separated" className="w-full rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-xs outline-none focus:border-accent" />}
            </div>
          </Section>

          <Section title="Text-to-speech" lesson={4} badge={ttsP && <Badge tone={ttsP.streaming ? 'good' : 'warn'}>{ttsP.streaming ? 'streaming' : 'renders whole sentence'}</Badge>}>
            <Field label="Provider"><Select value={cfg.tts.provider} onChange={(v) => upd((c) => { c.tts.provider = v; c.tts.voice_id = P?.tts.find((p) => p.id === v)?.default ?? '' })} options={opts(P?.tts ?? [])} /></Field>
            {ttsP?.note && <p className="text-[11px] text-warn">{ttsP.note}</p>}
            {!!ttsP?.voices?.length && <Field label="voice_id" hint="Swapping the voice_id switches the agent's persona instantly (Lesson 4: ElevenLabs 'Roger')."><Select value={cfg.tts.voice_id || ttsP.default || ''} onChange={(v) => upd((c) => { c.tts.voice_id = v })} options={ttsP.voices.map((v) => ({ value: v.id, label: v.label }))} /></Field>}
            <Field label="Speaking rate" value={`${cfg.tts.speed.toFixed(2)}×`}><Slider value={cfg.tts.speed} min={0.7} max={1.4} step={0.05} onChange={(v) => upd((c) => { c.tts.speed = v })} /></Field>
            <Field label="Sentence chunking" hint="When to hand text to TTS. 'eager' flushes the first clause as soon as it exists – lower TTFB, choppier prosody.">
              <Segmented size="sm" value={cfg.tts.chunking.strategy} onChange={(v) => upd((c) => { c.tts.chunking.strategy = v })} options={[{ value: 'sentence', label: 'full sentence' }, { value: 'eager', label: 'eager first clause' }]} />
            </Field>
            <Field label="Min chunk length" value={`${cfg.tts.chunking.min_chars} chars`}><Slider value={cfg.tts.chunking.min_chars} min={4} max={60} step={2} onChange={(v) => upd((c) => { c.tts.chunking.min_chars = v })} /></Field>
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-fg2">Pronunciation overrides <LessonTag n={4} /></div>
              <div className="space-y-1.5">
                {cfg.tts.pronunciations.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={p.match} onChange={(e) => upd((c) => { c.tts.pronunciations[i].match = e.target.value })} placeholder="written" className="w-1/2 rounded-md border border-line-strong bg-inset px-2 py-1 text-xs outline-none focus:border-accent" />
                    <span className="text-fg3">→</span>
                    <input value={p.say} onChange={(e) => upd((c) => { c.tts.pronunciations[i].say = e.target.value })} placeholder="spoken" className="w-1/2 rounded-md border border-line-strong bg-inset px-2 py-1 text-xs outline-none focus:border-accent" />
                    <button aria-label="Remove" onClick={() => upd((c) => { c.tts.pronunciations.splice(i, 1) })} className="text-fg3 hover:text-bad"><Trash2 size={13} /></button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => upd((c) => { c.tts.pronunciations.push({ match: '', say: '' }) })}>Add rule</Button>
              </div>
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
