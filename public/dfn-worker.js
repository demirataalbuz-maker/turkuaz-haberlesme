// DeepFilterNet3 gürültü temizleme — Worker tarafı.
// AudioWorklet (dfn-worklet.js) MessageChannel ile DOĞRUDAN buraya bağlanır:
// 480 örneklik (10 ms) kare gelir → ONNX modeli çalışır → temiz kare geri
// döner. Ana thread yalnız kurulumda aracıdır; ses yolu üzerinde değildir.
// Model tüm DSP boru hattını içerir (bkz. vendor/dfn/PROVENANCE.md);
// çalıştırıcı onnxruntime-web (wasm) — tamamen yerel, CDN yok.
/* global ort, importScripts */
importScripts('vendor/ort/ort.wasm.min.js') // sade wasm paketi (WebGPU/jsep yok — küçük ve yerel)

ort.env.wasm.wasmPaths = new URL('vendor/ort/', self.location.href).href
ort.env.wasm.numThreads = 1 // tek kare 10 ms bütçesine tek thread'de sığıyor (~1.5 ms)
ort.env.wasm.simd = true

const FRAME = 480
const STATE_SIZE = 45304

let session = null
let states = null
let attenLim = null
let port = null
let busy = false
const queue = [] // inference bitmeden yeni kare gelirse (nadiren) kısa kuyruk
const stats = { n: 0, total: 0, max: 0 }

async function init (msg) {
  session = await ort.InferenceSession.create(msg.model, { executionProviders: ['wasm'] })
  states = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE])
  attenLim = new ort.Tensor('float32', new Float32Array([0]), [])
  // Isınma turu: ilk çalıştırma wasm derlemesi yüzünden yavaştır, sese yansımasın
  const warm = new ort.Tensor('float32', new Float32Array(FRAME), [FRAME])
  await session.run({ input_frame: warm, states, atten_lim_db: attenLim })
  states = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE])
}

async function handleFrame (buf) {
  if (!(buf instanceof ArrayBuffer) || !session) return
  if (busy) {
    queue.push(buf)
    if (queue.length > 4) queue.shift() // gecikme birikmesin: en eskiyi at
    return
  }
  busy = true
  let cur = buf
  while (cur) {
    try {
      const t0 = performance.now()
      const input = new ort.Tensor('float32', new Float32Array(cur, 0, FRAME), [FRAME])
      const out = await session.run({ input_frame: input, states, atten_lim_db: attenLim })
      states = out.out_states
      const dt = performance.now() - t0
      stats.n++; stats.total += dt; if (dt > stats.max) stats.max = dt
      // Ping-pong: gelen buffer'ın içine temiz sesi yazıp geri transfer et (sıfır kopya/GC)
      new Float32Array(cur, 0, FRAME).set(out.enhanced_audio_frame.data.subarray(0, FRAME))
      port.postMessage(cur, [cur])
    } catch (e) {
      // tek kare hatası akışı öldürmesin; kare düşer, worklet sessizlikle kapatır
    }
    cur = queue.shift()
  }
  busy = false
}

onmessage = (e) => {
  const m = e.data
  if (!m) return
  if (m.t === 'init') {
    port = m.port
    port.onmessage = (ev) => handleFrame(ev.data)
    init(m).then(() => postMessage('ready'))
      .catch((err) => postMessage({ t: 'fail', err: String((err && err.message) || err) }))
  } else if (m.t === 'stats') {
    postMessage({ t: 'stats', frames: stats.n, avgMs: stats.n ? stats.total / stats.n : 0, maxMs: stats.max })
  }
}
