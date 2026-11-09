/**
 * Deterministic packet-level model of Lesson 2.
 *
 * One stream of 20 ms audio packets is sent client → server over the SAME lossy path twice:
 *   • TCP (WebSocket): reliable + in-order. A lost packet blocks everything behind it
 *     (head-of-line blocking) until the retransmission arrives.
 *   • UDP (WebRTC):    packets are handed over as they arrive; the app (a jitter buffer + packet-loss
 *     concealment) decides what to do about holes. Nothing ever stalls.
 * The model is simplified on purpose (fast-retransmit + exponential RTO, one fixed jitter buffer)
 * – it illustrates the mechanism, it is not a network emulator.
 */
export const PKT_MS = 20

export interface NetParams { rtt: number; jitter: number; loss: number; burst: boolean; seconds: number; jb: number; seed: number }

export interface TcpPkt { i: number; send: number; first: number; arrive: number; deliver: number; retx: number; delay: number }
export interface UdpPkt { i: number; send: number; arrive: number | null; deadline: number; late: boolean; lost: boolean; delay: number }
export interface PlayCell { i: number; start: number; end: number; kind: 'ok' | 'glitch' }
export interface Stall { at: number; dur: number }
export interface Stats { mean: number; p95: number; max: number; stalls: number; stallMs: number; glitches: number; delivered: number }

export interface Sim {
  N: number; totalMs: number
  tcp: { pkts: TcpPkt[]; play: PlayCell[]; stalls: Stall[]; stats: Stats }
  udp: { pkts: UdpPkt[]; play: PlayCell[]; stalls: Stall[]; stats: Stats }
}

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] ?? 0 }

export function simulate(p: NetParams): Sim {
  const N = Math.round((p.seconds * 1000) / PKT_MS)
  const R = rng(p.seed)
  const loss = p.loss / 100

  // shared network behaviour so the comparison is apples to apples
  const lost: boolean[] = []
  const delay: number[] = []
  let bad = false
  const pBadToGood = 1 / 4 // mean burst of ~4 packets
  const pGoodToBad = p.burst ? (loss * pBadToGood) / Math.max(1e-6, 0.8 - loss) : 0
  for (let i = 0; i < N; i++) {
    if (p.burst) {
      bad = bad ? R() > pBadToGood : R() < pGoodToBad
      lost.push(R() < (bad ? 0.8 : 0))
    } else lost.push(R() < loss)
    delay.push(p.rtt / 2 + p.jitter * 0.7 * -Math.log(1 - R() * 0.999))
  }

  // ---------------------------------------------------------------- UDP / WebRTC
  const base = p.rtt / 2 + p.jitter * 0.7
  const udpPkts: UdpPkt[] = []
  const udpPlay: PlayCell[] = []
  const udpLat: number[] = []
  let glitches = 0
  for (let i = 0; i < N; i++) {
    const send = i * PKT_MS
    const arrive = lost[i] ? null : send + delay[i]
    const deadline = send + base + p.jb
    const late = arrive !== null && arrive > deadline
    udpPkts.push({ i, send, arrive, deadline, late, lost: lost[i], delay: delay[i] })
    const bad = lost[i] || late
    if (bad) glitches++
    udpPlay.push({ i, start: deadline, end: deadline + PKT_MS, kind: bad ? 'glitch' : 'ok' })
    udpLat.push(deadline - send)
  }

  // ---------------------------------------------------------------- TCP / WebSocket
  const tcpPkts: TcpPkt[] = []
  let prevDeliver = 0
  const rto = Math.max(200, 2 * p.rtt)
  for (let i = 0; i < N; i++) {
    const send = i * PKT_MS
    const first = send + delay[i]
    let arrive = first
    let retx = 0
    let isLost = lost[i]
    while (isLost && retx < 6) {
      retx++
      arrive += retx === 1 ? p.rtt + 3 * PKT_MS : rto * 2 ** (retx - 2) // fast retransmit, then RTO back-off
      isLost = R() < loss
    }
    const deliver = Math.max(arrive, prevDeliver) // in-order delivery => head-of-line blocking
    prevDeliver = deliver
    tcpPkts.push({ i, send, first, arrive, deliver, retx, delay: delay[i] })
  }
  const tcpPlay: PlayCell[] = []
  const tcpStalls: Stall[] = []
  const tcpLat: number[] = []
  let end = tcpPkts[0].deliver + p.jb
  for (let i = 0; i < N; i++) {
    const start = Math.max(tcpPkts[i].deliver, end)
    if (i > 0 && start - end > 3) tcpStalls.push({ at: end, dur: start - end })
    tcpPlay.push({ i, start, end: start + PKT_MS, kind: 'ok' })
    tcpLat.push(start - tcpPkts[i].send)
    end = start + PKT_MS
  }

  const mk = (lat: number[], stalls: Stall[], g: number): Stats => ({
    mean: lat.reduce((a, b) => a + b, 0) / lat.length, p95: pct(lat, 0.95), max: Math.max(...lat),
    stalls: stalls.length, stallMs: stalls.reduce((a, s) => a + s.dur, 0), glitches: g, delivered: N,
  })
  return {
    N,
    totalMs: Math.max(end, udpPlay[N - 1].end) + 200,
    tcp: { pkts: tcpPkts, play: tcpPlay, stalls: tcpStalls, stats: mk(tcpLat, tcpStalls, 0) },
    udp: { pkts: udpPkts, play: udpPlay, stalls: [], stats: mk(udpLat, [], glitches) },
  }
}

/* ------------------------------------------------------------------------------------------
   Payload size: why WebRTC's built-in Opus matters. 48 kHz / 16-bit mono PCM vs Opus.
------------------------------------------------------------------------------------------- */
export function payload(seconds: number, opusKbps: number, rawRate = 48000) {
  const raw = seconds * rawRate * 2
  const opus = (seconds * opusKbps * 1000) / 8
  return { raw, opus, ratio: opus / raw }
}

/* ------------------------------------------------------------------------------------------
   HTTP request/response vs streaming, time from "user stops talking" to "first audio heard".
------------------------------------------------------------------------------------------- */
export interface Server { stt: number; llmTtft: number; llmTotal: number; ttsTotal: number; ttfb: number; endpointing: number }
export function httpTurn(rtt: number, seconds: number, s: Server, upMbps = 4, downMbps = 10) {
  const upBytes = seconds * 16000 * 2
  const downBytes = 6 * 24000 * 2
  return [
    { label: 'TCP + TLS handshake', ms: 2 * rtt, why: 'new connection per request' },
    { label: 'Upload recorded file', ms: rtt / 2 + (upBytes * 8) / (upMbps * 1000), why: `${Math.round(upBytes / 1000)} kB over ${upMbps} Mbps` },
    { label: 'Server: STT (whole file)', ms: s.stt, why: 'cannot start until upload ends' },
    { label: 'Server: LLM (full reply)', ms: s.llmTotal, why: 'waits for the last token' },
    { label: 'Server: TTS (full reply)', ms: s.ttsTotal, why: 'waits for the whole text' },
    { label: 'Download audio file', ms: rtt / 2 + (downBytes * 8) / (downMbps * 1000), why: `${Math.round(downBytes / 1000)} kB over ${downMbps} Mbps` },
  ]
}
export function streamingTurn(rtt: number, s: Server) {
  return [
    { label: 'Endpointing', ms: s.endpointing, why: 'VAD timer + turn detector' },
    { label: 'STT final', ms: s.stt * 0.25, why: 'most text already streamed in' },
    { label: 'LLM TTFT', ms: s.llmTtft, why: 'first token only' },
    { label: 'TTS TTFB', ms: s.ttfb, why: 'first audio byte only' },
    { label: 'Network (one way)', ms: rtt / 2 + 20, why: 'UDP, no handshake' },
  ]
}

/* ------------------------------------------------------------------------------------------
   Public internet vs. a private, globally distributed mesh (LiveKit Cloud idea). Illustrative.
------------------------------------------------------------------------------------------- */
export function route(km: number, congestion: number) {
  const fiber = km / 200 // ms one-way at ~2/3 c
  const c = congestion / 100
  const publicMs = fiber * 1.8 + c * (10 + 0.5 * fiber)
  const hop1 = 7 + c * 5
  const backbone = fiber * 1.15
  const hop2 = 4
  const meshMs = hop1 + backbone + hop2
  return { fiber, publicMs, hop1, backbone, hop2, meshMs, reduction: 1 - meshMs / publicMs }
}
