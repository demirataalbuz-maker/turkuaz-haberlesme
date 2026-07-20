// DeepFilterNet köprüsü — AudioWorklet tarafı.
// Mikrofon örneklerini 480'lik karelere toplayıp MessageChannel üzerinden
// dfn-worker.js'e yollar, dönen temiz kareleri çıkışa akıtır. Model işi
// worker'da olduğu için gerçek-zamanlı ses thread'i hiç bloklanmaz.
// Buffer'lar ping-pong ile yeniden kullanılır: ses yolunda bellek ayırma yok.

const FRAME = 480
const OUT_BUF = 4800 // ~100 ms çıkış tamponu
const PRIME = 960 // akıtmaya başlamadan önce ~20 ms biriksin (worker gidiş-dönüş payı)

class DfnBridgeProcessor extends AudioWorkletProcessor {
  constructor () {
    super()
    this._in = new Float32Array(FRAME); this._inLen = 0
    this._out = new Float32Array(OUT_BUF); this._outLen = 0
    this._pool = [] // worker'dan dönen boş buffer'lar
    this._worker = null
    this._primed = false
    this._dead = false
    this.port.onmessage = (e) => {
      const m = e.data
      if (m && m.t === 'connect') {
        this._worker = m.port
        this._worker.onmessage = (ev) => this._onFrame(ev.data)
      } else if (m === 'destroy') {
        this._dead = true
        try { this._worker && this._worker.close() } catch {}
      }
    }
  }

  _onFrame (buf) {
    if (!(buf instanceof ArrayBuffer)) return
    const f = new Float32Array(buf, 0, FRAME)
    if (this._outLen + FRAME <= OUT_BUF) {
      this._out.set(f, this._outLen)
      this._outLen += FRAME
    }
    this._pool.push(buf)
  }

  process (inputs, outputs) {
    if (this._dead) return false
    const inp = inputs[0] && inputs[0][0]
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    // giriş → 480'lik karelere böl, worker'a transfer et
    if (inp && this._worker) {
      let off = 0
      while (off < inp.length) {
        const take = Math.min(FRAME - this._inLen, inp.length - off)
        this._in.set(inp.subarray(off, off + take), this._inLen)
        this._inLen += take; off += take
        if (this._inLen === FRAME) {
          let buf = this._pool.pop()
          if (!buf || buf.byteLength !== FRAME * 4) buf = new ArrayBuffer(FRAME * 4)
          new Float32Array(buf, 0, FRAME).set(this._in)
          try { this._worker.postMessage(buf, [buf]) } catch {}
          this._inLen = 0
        }
      }
    }
    // çıkış: önce küçük bir yastık dolsun, sonra kesintisiz akıt
    if (!this._primed) {
      if (this._outLen >= PRIME) this._primed = true
      else return true // yastık dolana dek sessizlik (~ilk 20-30 ms)
    }
    if (this._outLen >= out.length) {
      out.set(this._out.subarray(0, out.length))
      this._out.copyWithin(0, out.length, this._outLen)
      this._outLen -= out.length
    } else {
      this._primed = false // underrun: yastığı yeniden doldur
    }
    return true
  }
}

registerProcessor('dfn-bridge', DfnBridgeProcessor)
