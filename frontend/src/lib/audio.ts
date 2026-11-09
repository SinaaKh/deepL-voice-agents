/**
 * Browser audio I/O (Lesson 5: getUserMedia is the client-side WebRTC primitive for the mic).
 *
 *  Mic:    getUserMedia -> AudioWorklet -> 16 kHz mono PCM16 frames (20 ms) -> WebSocket
 *  Player: PCM16 chunks -> scheduled AudioBufferSources. Because every chunk is scheduled on the
 *          audio clock, `playedMs()` knows *exactly* how much audio the user has actually heard.
 *          That number is what lets the server truncate the LLM history after a barge-in
 *          (Lesson 3: the WebRTC-timestamp trick, reproduced over a WebSocket).
 */

const WORKLET = `
class MicProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.phase = 0; this.acc = 0; this.cnt = 0; this.out = new Int16Array(320); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.phase += 1;
      if (this.phase >= this.ratio) {
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0; this.cnt = 0; this.phase -= this.ratio;
        this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;
        if (this.n === 320) { const b = this.out.slice().buffer; this.port.postMessage(b, [b]); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
`

export class Mic {
  analyser: AnalyserNode
  private stream: MediaStream
  private node: AudioWorkletNode
  private src: MediaStreamAudioSourceNode

  private constructor(stream: MediaStream, src: MediaStreamAudioSourceNode, node: AudioWorkletNode, analyser: AnalyserNode) {
    this.stream = stream; this.src = src; this.node = node; this.analyser = analyser
  }

  static async start(ctx: AudioContext, onFrame: (b: ArrayBuffer) => void): Promise<Mic> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'mic-processor')
    node.port.onmessage = (e) => onFrame(e.data as ArrayBuffer)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    src.connect(node)
    src.connect(analyser)
    return new Mic(stream, src, node, analyser)
  }

  stop() {
    this.node.port.onmessage = null
    this.src.disconnect()
    this.node.disconnect()
    this.stream.getTracks().forEach((t) => t.stop())
  }
}

interface Scheduled { src: AudioBufferSourceNode; start: number; dur: number }

export class Player {
  analyser: AnalyserNode
  responseId = 0
  onReport: (responseId: number, playedMs: number) => void = () => {}
  onDone: (responseId: number) => void = () => {}
  private rate = 24000
  private next = 0
  private items: Scheduled[] = []
  private ended = false
  private timer: number | null = null
  private done = false

  private ctx: AudioContext

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.connect(ctx.destination)
  }

  startResponse(id: number, rate: number) {
    this.stopAll()
    this.responseId = id
    this.rate = rate
    this.next = 0
    this.ended = false
    this.done = false
    this.timer = window.setInterval(() => {
      if (this.items.length) this.onReport(this.responseId, this.playedMs())
    }, 100)
  }

  push(buf: ArrayBuffer) {
    const i16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2))
    if (!i16.length) return
    const f = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768
    const ab = this.ctx.createBuffer(1, f.length, this.rate)
    ab.copyToChannel(f, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = ab
    src.connect(this.analyser)
    const start = Math.max(this.ctx.currentTime + 0.03, this.next)
    src.start(start)
    this.next = start + ab.duration
    const it = { src, start, dur: ab.duration }
    this.items.push(it)
    src.onended = () => this.check()
  }

  endResponse() { this.ended = true; this.check() }

  private check() {
    if (this.ended && !this.done && this.ctx.currentTime >= this.next - 0.005 && this.items.length) {
      this.done = true
      this.finish()
    } else if (this.ended && !this.done) {
      window.setTimeout(() => this.check(), 50)
    }
  }

  private finish() {
    if (this.timer) window.clearInterval(this.timer)
    this.timer = null
    this.onDone(this.responseId)
  }

  /** Audio milliseconds of the current response that have actually been played out. */
  playedMs(): number {
    const now = this.ctx.currentTime
    let s = 0
    for (const it of this.items) s += Math.max(0, Math.min(it.dur, now - it.start))
    return s * 1000
  }

  /** Stop everything immediately (barge-in). Returns how much the user heard. */
  flush(): number {
    const p = this.playedMs()
    this.stopAll()
    return p
  }

  stopAll() {
    for (const it of this.items) { try { it.src.onended = null; it.src.stop() } catch { /* already stopped */ } }
    this.items = []
    if (this.timer) window.clearInterval(this.timer)
    this.timer = null
  }

  get playing() { return this.items.length > 0 && this.ctx.currentTime < this.next }
}
