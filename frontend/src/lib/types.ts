export interface VADConfig { provider: 'silero' | 'energy'; threshold: number; min_speech_ms: number; min_silence_ms: number; prefix_padding_ms: number }
export interface TurnConfig { mode: 'vad' | 'semantic' | 'llm'; silence_timer_ms: number; max_delay_ms: number; threshold: number }
export interface InterruptConfig { enabled: boolean; min_duration_ms: number }
export interface STTConfig { provider: string; model: string; language: string; prompt?: string }
export interface LLMConfig { provider: string; model: string; temperature: number; max_tokens: number; mock_profile: string }
export interface Pronunciation { match: string; say: string }
export interface TTSConfig {
  provider: string; voice_id: string; speed: number; model: string
  pronunciations: Pronunciation[]
  chunking: { strategy: 'sentence' | 'eager'; min_chars: number }
  /** VoiceStudio: describe the voice/style in words, and pin a language */
  instruct?: string
  language?: string
}
export interface SessionConfig {
  architecture: 'pipeline' | 'realtime'
  persona: string
  system_prompt: string
  vad: VADConfig
  turn: TurnConfig
  interrupt: InterruptConfig
  stt: STTConfig
  llm: LLMConfig
  tts: TTSConfig
  guardrails: { enabled: boolean; blocked_terms: string[] }
  realtime_model: string
  realtime_voice: string
}

export interface ProviderInfo {
  id: string; label: string; available: boolean; reason: string
  local?: boolean; streaming?: boolean; models?: string[]; default?: string
  voices?: { id: string; label: string }[]; note?: string
  profiles?: Record<string, { ttft_ms: number; tps: number; note: string }>
}
export interface Providers {
  keys: Record<string, boolean>
  vad: ProviderInfo[]; stt: ProviderInfo[]; llm: ProviderInfo[]; tts: ProviderInfo[]
  realtime: { available: boolean; reason: string; models: string[]; voices: string[] }
  livekit: { configured: boolean; url: string }
  voicestudio: VoiceStudioSummary
}
export interface VoiceStudioSummary {
  reachable: boolean; url: string; version: string | null; device: string | null; engines_loading: boolean; auth_required: boolean
  asr_engine: string | null; tts_engines: string[]; voices: number; error: string; hint: string; installed: boolean; home: string
}
export interface VoiceStudioStatus extends VoiceStudioSummary {
  features: Record<string, boolean>; probe_ms: number | null
  engines: { id: string; display_name?: string; available: boolean; reason?: string | null }[]
  voice_profiles: { voice_id: string; name: string; language?: string | null }[]
  models: string[]
}
export interface VoiceStudioSelfTest {
  ok: boolean; error?: string; reference: string; heard: string; wer: number; match: boolean; total_ms: number
  tts: { ttfb_ms: number; render_ms: number; audio_ms: number; sample_rate: number; server_ttfa_ms: number | null; rtf: number | null; engine: string | null; transport: string | null }
  stt: { latency_ms: number }
}
export interface Persona { id: string; name: string; focus: string; blurb: string; greeting: string; system_prompt: string; stt_prompt?: string }
export interface Scenario {
  id: string; name: string; lesson: string; persona: string; blurb: string
  suggest: Partial<Record<keyof SessionConfig, unknown>>; turns: number; script: string[]
}

/** Server -> dashboard events (see backend/voicelab/events.py) */
export interface Ev { type: string; t: number; [k: string]: any }

export type StageId = 'vad' | 'turn' | 'stt' | 'llm' | 'chunk' | 'tts' | 'play'
export interface BreakdownItem { stage: string; ms: number }
export interface Span { stage: string; start: number | null; end: number | null; label?: string }
export interface TurnMetrics {
  turn_id: number; kind: string; user_text: string; agent_text: string; interrupted: boolean
  response_latency_ms: number | null
  breakdown: BreakdownItem[]; spans: Span[]
  llm: { model: string; provider: string; ttft_ms: number | null; tokens_per_second: number | null; prompt_tokens: number; completion_tokens: number; rounds: number; estimated_usage: boolean }
  stt: { audio_ms?: number; streamed?: boolean; finalize_ms?: number; provider?: string }
  eou: { end_of_utterance_delay_ms: number | null; transcription_delay_ms: number | null; mode: string; extended: boolean; p_eot: number | null }
  tts: { provider?: string; streamed?: boolean; audio_ms?: number; ttfb_ms?: number; render_ms?: number; server?: { ttfa_ms?: number | null; rtf?: number | null; engine?: string | null; transport?: string | null } }
  guardrail: string
  vad: { min_speech_ms?: number; audio_total_ms?: number; audio_sent_to_stt_ms?: number }
}

export const DEFAULT_CONFIG: SessionConfig = {
  architecture: 'pipeline',
  persona: 'restaurant',
  system_prompt: '',
  vad: { provider: 'silero', threshold: 0.5, min_speech_ms: 64, min_silence_ms: 160, prefix_padding_ms: 320 },
  turn: { mode: 'semantic', silence_timer_ms: 500, max_delay_ms: 2500, threshold: 0.5 },
  interrupt: { enabled: true, min_duration_ms: 320 },
  stt: { provider: 'whisper-local', model: 'base.en', language: 'en' },
  llm: { provider: 'ollama', model: '', temperature: 0.4, max_tokens: 220, mock_profile: 'gpt-4o-mini' },
  tts: { provider: 'piper', voice_id: '', speed: 1, model: '', pronunciations: [{ match: 'Bella Notte', say: 'Bella Not-tay' }], chunking: { strategy: 'sentence', min_chars: 18 }, instruct: '', language: '' },
  guardrails: { enabled: false, blocked_terms: ['password', 'credit card number'] },
  realtime_model: 'gpt-realtime',
  realtime_voice: 'marin',
}
