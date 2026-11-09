import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { DEFAULT_CONFIG, type Persona, type Providers, type Scenario, type SessionConfig } from './types'

const KEY = 'voicelab.config.v1'

function load(): SessionConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return structuredClone(DEFAULT_CONFIG)
}

/** Session config shared across pages (the Architecture Lab can push a preset into it). */
export function useConfig(): [SessionConfig, (c: SessionConfig) => void] {
  const [cfg, setCfg] = useState<SessionConfig>(load)
  const set = useCallback((c: SessionConfig) => {
    setCfg(c)
    try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* private mode */ }
  }, [])
  useEffect(() => {
    const on = () => setCfg(load())
    window.addEventListener('voicelab-config', on)
    return () => window.removeEventListener('voicelab-config', on)
  }, [])
  return [cfg, set]
}

export function pushConfig(patch: (c: SessionConfig) => void) {
  const c = load()
  patch(c)
  try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* ignore */ }
  window.dispatchEvent(new Event('voicelab-config'))
}

let cache: { providers?: Providers; personas?: Persona[]; scenarios?: Scenario[] } = {}
let inflight: Promise<void> | null = null

export function useMeta() {
  const [, force] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (cache.providers) return
    inflight ??= Promise.all([api.providers(), api.personas(), api.scenarios()]).then(([providers, personas, scenarios]) => { cache = { providers, personas, scenarios } })
    inflight.then(() => force((x) => x + 1)).catch((e) => { inflight = null; setError(String(e.message ?? e)) })
  }, [])
  const refresh = useCallback(() => { cache = {}; inflight = null; force((x) => x + 1); setError(null) }, [])
  return { providers: cache.providers ?? null, personas: cache.personas ?? [], scenarios: cache.scenarios ?? [], error, refresh }
}

/** If the saved config points at something unavailable here, fall back to what works. */
export function fitConfig(c: SessionConfig, p: Providers): SessionConfig {
  const n = structuredClone(c)
  const avail = (list: { id: string; available: boolean }[], id: string) => list.find((x) => x.id === id)?.available
  if (!avail(p.stt, n.stt.provider) || !avail(p.llm, n.llm.provider) || !avail(p.tts, n.tts.provider)) {
    const local = avail(p.stt, 'whisper-local') && avail(p.llm, 'ollama') && avail(p.tts, 'piper')
    if (local) {
      n.stt = { provider: 'whisper-local', model: 'base.en', language: 'en' }
      n.llm.provider = 'ollama'; n.llm.model = p.llm.find((x) => x.id === 'ollama')?.default ?? ''
      n.tts.provider = 'piper'; n.tts.voice_id = p.tts.find((x) => x.id === 'piper')?.default ?? ''
    } else {
      n.stt = { provider: 'mock', model: '', language: 'en' }; n.llm.provider = 'mock'; n.tts.provider = 'mock'; n.tts.voice_id = 'a'
    }
  }
  if (n.architecture === 'realtime' && !p.realtime.available) n.architecture = 'pipeline'
  if (n.tts.provider === 'piper' && !n.tts.voice_id) n.tts.voice_id = p.tts.find((x) => x.id === 'piper')?.default ?? ''
  if (n.llm.provider === 'ollama' && !n.llm.model) n.llm.model = p.llm.find((x) => x.id === 'ollama')?.default ?? ''
  return n
}

export function mergeSuggest(c: SessionConfig, suggest: Record<string, unknown>, persona: string): SessionConfig {
  const n = structuredClone(c)
  n.persona = persona
  n.system_prompt = ''
  for (const [k, v] of Object.entries(suggest)) {
    if (k === 'persona') { n.persona = String(v); continue }
    const cur = (n as any)[k]
    ;(n as any)[k] = cur && typeof cur === 'object' && typeof v === 'object' ? { ...cur, ...(v as object) } : v
  }
  return n
}
