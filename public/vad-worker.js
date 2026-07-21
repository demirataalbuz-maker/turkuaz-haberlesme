// Silero VAD — Worker tarafı. vad-worklet.js'ten 512 örneklik (16kHz) kareler gelir,
// Silero v5 ONNX modeli "konuşma olasılığı" (0..1) üretir → ana thread'e döner.
// Karar ANA THREAD'de gate'i açıp kapatır; ses yolu VAD'den GEÇMEZ (sıfır ek gecikme).
// Çalıştırıcı onnxruntime-web (wasm) — tamamen yerel, CDN yok. Model: vendor/vad/PROVENANCE.md
/* global ort, importScripts */
importScripts('vendor/ort/ort.wasm.min.js')
ort.env.wasm.wasmPaths = new URL('vendor/ort/', self.location.href).href
ort.env.wasm.numThreads = 1
ort.env.wasm.simd = true

let session = null
let state = null
let framePort = null
let busy = false

function freshState () { return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]) }
function srTensor () { return new ort.Tensor('int64', BigInt64Array.from([16000n]), []) }

async function init (modelBuf) {
  session = await ort.InferenceSession.create(modelBuf, { executionProviders: ['wasm'] })
  state = freshState()
  // Isınma turu (ilk çalıştırma wasm derlemesi yüzünden yavaş)
  const warm = new ort.Tensor('float32', new Float32Array(512), [1, 512])
  const out = await session.run({ input: warm, state, sr: srTensor() })
  state = out.stateN
}

async function onFrame (arr) {
  if (!session || busy || !(arr instanceof Float32Array) || arr.length !== 512) return
  busy = true
  try {
    const input = new ort.Tensor('float32', arr, [1, 512])
    const out = await session.run({ input, state, sr: srTensor() })
    state = out.stateN
    self.postMessage({ prob: out.output.data[0] })
  } catch (e) { self.postMessage({ error: String((e && e.message) || e) }) }
  busy = false
}

self.onmessage = (e) => {
  const m = e.data
  if (m && m.t === 'init') {
    init(m.model).then(() => self.postMessage({ ready: true }))
      .catch(err => self.postMessage({ error: String((err && err.message) || err) }))
  } else if (m && m.port) {
    framePort = m.port
    framePort.onmessage = (ev) => onFrame(ev.data)
  } else if (m === 'reset') { state = freshState() }
}
