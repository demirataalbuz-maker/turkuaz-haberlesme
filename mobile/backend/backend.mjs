// Turkuaz mobil P2P çekirdeği — Bare runtime'ında (BareKit worklet) çalışır.
// TÜM mesajlaşma mantığı lib/core.js'te — masaüstündeki server.js ile AYNI kod.
//
// Açılış AŞAMALI ve KARA KUTULUDUR: her adım hem arayüze loglanır hem diske
// yazılır (boot-stage.txt). Native bir çökme uygulamayı anında kapatırsa,
// bir SONRAKİ açılışta "önceki açılış şu aşamada kalmış" diye görünür —
// uzaktan teşhis böyle yapılır. Ağır modüller (sodium/udx/hyperswarm) tek tek
// dinamik import edilir ki suçlu izole olsun.
/* global BareKit, Bare */
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'

const IPC = (typeof BareKit !== 'undefined' && BareKit.IPC) || null

function ui (obj) {
  const s = JSON.stringify(obj)
  if (IPC) { try { IPC.write(s + '\n') } catch {} } else { try { console.log(s) } catch {} }
}
const log = (msg, level) => ui({ t: 'log', level: level || 'info', msg })

// Yazılabilir veri dizini: worklet argümanı > HOME > Android uygulama dizini
function pickDataDir () {
  const cands = []
  try { if (Bare.argv && Bare.argv[0] && Bare.argv[0].startsWith('/')) cands.push(Bare.argv[0]) } catch {}
  try { cands.push(path.join(os.homedir(), 'turkuaz-data')) } catch {}
  cands.push('/data/data/dev.turkuaz.app/files/turkuaz-data') // applicationId'den deterministik
  for (const dir of cands) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '.w'), '1')
      return dir
    } catch {}
  }
  throw new Error('yazılabilir veri dizini bulunamadı: ' + cands.join(', '))
}

let core = null
let stageFile = null
function stage (s) {
  log('aşama: ' + s)
  if (stageFile) { try { fs.writeFileSync(stageFile, s) } catch {} }
}

async function main () {
  const DATA = pickDataDir()
  stageFile = path.join(DATA, 'boot-stage.txt')
  // kara kutu: önceki açılış yarıda mı kalmış?
  try {
    const prev = fs.readFileSync(stageFile, 'utf8').trim()
    if (prev && prev !== 'hazir') {
      log('⚠️ ÖNCEKİ açılış "' + prev + '" aşamasında yarıda kalmış — çökme büyük olasılıkla o adımda. Bu logu kopyalayıp gönder.', 'error')
    }
  } catch {}
  stage('veri-dizini (' + DATA + ')')
  stage('store-modul')
  const { default: Store } = await import('../../lib/store.js')
  stage('sodium-native (kripto)')
  await import('sodium-native')
  stage('udx-native (ağ)')
  await import('udx-native')
  stage('hyperswarm (DHT)')
  await import('hyperswarm')
  stage('cekirdek-modul')
  const { default: coremod } = await import('../../lib/core.js')
  stage('store-ac')
  const store = new Store(DATA)
  stage('cekirdek-baslat (DHT açılıyor)')
  core = coremod.createCore({ store }) // ICE varsayılanları çekirdekte
  core.onUI(ui)
  stage('hazir')
  log('Turkuaz Bare çekirdeği hazır — kod: ' + core.myCode.slice(0, 12) + '… veri: ' + DATA)
  ui(core.stateObj()) // ilk durumu kendiliğinden gönder (__ready beklenmez — gecikmeli başlatmada kaybolabiliyor)
}

// ---- arayüzden (WebView) gelen aksiyonlar — hat her durumda açık ----
if (IPC) {
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
      else if (m.t === '__ready') log('çekirdek daha hazır değil — aşamalar yukarıda', 'info')
    }
  })
}

main().catch((e) => log('Çekirdek başlatılamadı: ' + ((e && e.stack) || e), 'error'))
