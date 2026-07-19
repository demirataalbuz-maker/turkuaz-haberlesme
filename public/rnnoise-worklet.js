// AI gürültü engelleme — RNNoise'un AudioWorklet sürümü.
// noise.js'teki ScriptProcessor yolundan farkı: bu kod ayrı gerçek-zamanlı
// ses thread'inde çalışır; arayüz (balonlar/oyunlar/render) ana thread'i
// meşgul ettiğinde ses çıtırdamaz. noise.js eski tarayıcılar için yedek kalır.
// RNNoise 48 kHz'de 10 ms'lik (480 örnek) kareler işler; örnekler int16
// aralığında beklenir (×32768 / ÷32768 ölçekleme).
import createRNNWasmModuleSync from './rnnoise-sync.js'

const FRAME = 480
const BUF = 4800 // ~100 ms tampon; ses thread'inde yeniden ayırma (GC) olmasın

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor () {
    super()
    this._mod = null
    this._dead = false
    this._in = new Float32Array(BUF); this._inLen = 0
    this._out = new Float32Array(BUF); this._outLen = 0
    try {
      const ret = createRNNWasmModuleSync()
      if (ret && typeof ret.then === 'function') ret.then((m) => this._init(m)).catch(() => {})
      else this._init(ret)
    } catch {}
    this.port.onmessage = (e) => { if (e.data === 'destroy') this._destroy() }
  }

  _init (m) {
    if (this._dead || !m) return
    this._state = m._rnnoise_create(0)
    this._pIn = m._malloc(FRAME * 4)
    this._pOut = m._malloc(FRAME * 4)
    this._mod = m
  }

  _destroy () {
    this._dead = true
    const m = this._mod
    this._mod = null
    if (m) { try { m._rnnoise_destroy(this._state); m._free(this._pIn); m._free(this._pOut) } catch {} }
  }

  process (inputs, outputs) {
    if (this._dead) return false
    const inp = inputs[0] && inputs[0][0]
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    if (!this._mod) { if (inp) out.set(inp.subarray(0, out.length)); return true } // motor yüklenene dek düz geçiş
    if (inp && this._inLen + inp.length <= BUF) { this._in.set(inp, this._inLen); this._inLen += inp.length }
    const m = this._mod
    while (this._inLen >= FRAME && this._outLen + FRAME <= BUF) {
      const heap = m.HEAPF32
      const bIn = this._pIn >> 2
      for (let i = 0; i < FRAME; i++) heap[bIn + i] = this._in[i] * 32768
      m._rnnoise_process_frame(this._state, this._pOut, this._pIn)
      const bOut = this._pOut >> 2
      for (let i = 0; i < FRAME; i++) this._out[this._outLen + i] = heap[bOut + i] / 32768
      this._outLen += FRAME
      this._in.copyWithin(0, FRAME, this._inLen)
      this._inLen -= FRAME
    }
    if (this._outLen >= out.length) {
      out.set(this._out.subarray(0, out.length))
      this._out.copyWithin(0, out.length, this._outLen)
      this._outLen -= out.length
    } // yetmiyorsa çıktı sessiz kalır (yalnız ilk ~10 ms dolum gecikmesi)
    return true
  }
}

registerProcessor('rnnoise', RnnoiseProcessor)
