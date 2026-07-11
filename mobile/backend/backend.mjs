// Turkuaz mobil P2P çekirdeği — Bare runtime'ında (BareKit worklet) çalışır.
// TÜM mesajlaşma mantığı lib/core.js'te — masaüstündeki server.js ile AYNI kod.
// Buradaki tek iş: BareKit.IPC üzerinden satır-bazlı JSON köprüsü kurmak
// (masaüstünde bu köprünün karşılığı Express+WebSocket).
import { IPC } from 'barekit'
import os from 'bare-os'
import path from 'bare-path'
import Store from '../../lib/store.js'
import coremod from '../../lib/core.js'

const { createCore } = coremod

// ---- arayüze (WebView) mesaj: satır-bazlı JSON ----
function ui (obj) { try { IPC.write(JSON.stringify(obj) + '\n') } catch {} }

let core = null
try {
  // Veri dizini: RN tarafı worklet argümanıyla geçebilir (Bare.argv[0]);
  // yoksa uygulamanın ev dizini (Android'de uygulamanın kendi alanı).
  const DATA = (typeof Bare !== 'undefined' && Bare.argv && Bare.argv[0]) ||
    path.join(os.homedir(), 'turkuaz-data')
  const store = new Store(DATA)
  core = createCore({ store }) // ICE varsayılanları çekirdekte (STUN + TURN)
  core.onUI(ui)
  ui({ t: 'log', msg: 'Turkuaz Bare çekirdeği hazır — kod: ' + core.myCode.slice(0, 12) + '… veri: ' + DATA })
} catch (e) {
  // başlatma hatası WebView konsolunda görünsün (cihazda teşhis için)
  ui({ t: 'log', level: 'error', msg: 'Çekirdek başlatılamadı: ' + ((e && e.stack) || e) })
}

// ---- arayüzden (WebView) gelen aksiyonlar ----
IPC.setEncoding('utf8')
let buf = ''
IPC.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (core) core.handleUI(m, ui)
  }
})
