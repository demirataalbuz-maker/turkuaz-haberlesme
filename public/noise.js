// AI gürültü engelleme — RNNoise (@jitsi/rnnoise-wasm) motoru.
// ES modül olarak yüklenir; klasik scriptlere window.RNNoise ile köprülenir.
// RNNoise 48 kHz'de 10 ms'lik (480 örnek) kareler işler; örnekler int16
// aralığında beklenir (bu yüzden ×32768 / ÷32768 ölçekleme).
import createRNNWasmModuleSync from './rnnoise-sync.js'

const FRAME = 480
let mod = null
try {
  mod = await createRNNWasmModuleSync()
} catch (e) { console.error('RNNoise yüklenemedi:', e) }

// Mikrofon zincirine takılacak bir işleme düğümü döndürür. İç tampon 512↔480
// arası köprüler (ScriptProcessor blok boyutu 2'nin kuvveti olmak zorunda).
function makeDenoiseNode (ctx) {
  if (!mod) return null
  const m = mod
  const state = m._rnnoise_create(0)
  const pIn = m._malloc(FRAME * 4)
  const pOut = m._malloc(FRAME * 4)
  const node = ctx.createScriptProcessor(512, 1, 1)
  let inQ = new Float32Array(0)
  let outQ = new Float32Array(0)
  const cat = (a, b) => { const c = new Float32Array(a.length + b.length); c.set(a); c.set(b, a.length); return c }
  node.onaudioprocess = (e) => {
    inQ = cat(inQ, e.inputBuffer.getChannelData(0))
    while (inQ.length >= FRAME) {
      const heap = m.HEAPF32
      const bIn = pIn >> 2
      for (let i = 0; i < FRAME; i++) heap[bIn + i] = inQ[i] * 32768
      m._rnnoise_process_frame(state, pOut, pIn)
      const bOut = pOut >> 2
      const den = new Float32Array(FRAME)
      for (let i = 0; i < FRAME; i++) den[i] = heap[bOut + i] / 32768
      outQ = cat(outQ, den)
      inQ = inQ.subarray(FRAME)
    }
    const out = e.outputBuffer.getChannelData(0)
    if (outQ.length >= out.length) { out.set(outQ.subarray(0, out.length)); outQ = outQ.subarray(out.length) } else { out.fill(0); out.set(outQ); outQ = new Float32Array(0) }
  }
  node._rnnoiseCleanup = () => { try { m._rnnoise_destroy(state); m._free(pIn); m._free(pOut) } catch {} }
  return node
}

window.RNNoise = { get ready () { return !!mod }, makeDenoiseNode }
