// Turkuaz mobil P2P çekirdeği — Bare runtime'ında (BareKit worklet) çalışır.
// TÜM mesajlaşma mantığı lib/core.js'te — masaüstündeki server.js ile AYNI kod.
// Buradaki tek iş: BareKit.IPC üzerinden satır-bazlı JSON köprüsü kurmak
// (masaüstünde bu köprünün karşılığı Express+WebSocket).
//
// Not: worklet içinde IPC, global `BareKit` nesnesinden gelir (react-native-bare-kit).
/* global BareKit, Bare */
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Store from '../../lib/store.js'
import coremod from '../../lib/core.js'

const { createCore } = coremod
const { IPC } = BareKit

// ---- arayüze (WebView) mesaj: satır-bazlı JSON ----
function ui (obj) { try { IPC.write(JSON.stringify(obj) + '\n') } catch {} }

// Yazılabilir veri dizini: worklet argümanı > HOME > Android uygulama dizini
function pickDataDir () {
  const cands = []
  try { if (Bare.argv && Bare.argv[0] && Bare.argv[0].startsWith('/')) cands.push(Bare.argv[0]) } catch {}
  try { cands.push(path.join(os.homedir(), 'turkuaz-data')) } catch {}
  cands.push('/data/data/dev.turkuaz.app/files/turkuaz-data') // applicationId'den deterministik
  for (const dir of cands) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '.w'), '1') // gerçekten yazılabilir mi?
      return dir
    } catch {}
  }
  throw new Error('yazılabilir veri dizini bulunamadı: ' + cands.join(', '))
}

let core = null
try {
  const DATA = pickDataDir()
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
