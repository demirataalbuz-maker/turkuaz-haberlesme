// VAD downsample worklet: mikrofonu (bağlam örnekleme hızı, genelde 48kHz) 16kHz'e
// indirip 512 örneklik (32ms) kareler üretir → MessageChannel ile vad-worker.js'e.
// Ses YOLUNU DEĞİŞTİRMEZ — yalnız analiz için dallanır (çıkışı bağlanmaz).
// Doğrusal yeniden örnekleme; kesirli okuma konumu bloklar arası korunur.
class VadWorklet extends AudioWorkletProcessor {
  constructor () {
    super()
    this.step = sampleRate / 16000 // kaç kaynak örnek = 1 hedef (16kHz) örnek
    this.frame = new Float32Array(512)
    this.fi = 0
    this.readPos = 0   // kaynak akışında kesirli okuma konumu
    this.srcIndex = 0  // tüketilen toplam kaynak örnek sayısı
    this.prev = 0      // önceki bloğun son örneği (blok sınırı interpolasyonu)
    this.workerPort = null
    this.port.onmessage = (e) => { if (e.data && e.data.port) this.workerPort = e.data.port }
  }

  process (inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || !this.workerPort) { if (ch) { this.srcIndex += ch.length; this.prev = ch[ch.length - 1] } return true }
    const blockStart = this.srcIndex
    const blockEnd = this.srcIndex + ch.length
    while (this.readPos < blockEnd - 1) {
      const idx = this.readPos - blockStart
      const i0 = Math.floor(idx)
      const frac = idx - i0
      const s0 = i0 < 0 ? this.prev : ch[i0]
      const s1 = ch[i0 + 1]
      this.frame[this.fi++] = s0 + (s1 - s0) * frac
      if (this.fi === 512) {
        this.workerPort.postMessage(this.frame.slice(0)) // kopya (frame yeniden kullanılır)
        this.fi = 0
      }
      this.readPos += this.step
    }
    this.srcIndex = blockEnd
    this.prev = ch[ch.length - 1]
    return true
  }
}
registerProcessor('vad-worklet', VadWorklet)
