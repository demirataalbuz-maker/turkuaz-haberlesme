// Uçtan uca test: aynı makinede iki bağımsız PeerCord instance'ı başlatır
// (iki ayrı kullanıcı PC'si gibi — ayrı data klasörü, ayrı port) ve
// arkadaşlık isteği → kabul → DM → oda akışını doğrular.
// Test için yerel bir DHT bootstrap düğümü kullanılır; gerçek kullanımda
// Hyperswarm'ın küresel DHT'si devrededir.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const DHT = require('hyperdht')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(__dirname, 'tmp')
const BOOTSTRAP_PORT = parseInt(process.env.TEST_BOOTSTRAP_PORT || '49737', 10)

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const children = []
function cleanup (code) {
  for (const c of children) { try { c.kill('SIGKILL') } catch {} }
  process.exit(code)
}

function fail (msg) {
  console.error('FAIL:', msg)
  cleanup(1)
}

function startInstance (label, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      PEERCORD_DATA: path.join(TMP, label),
      PEERCORD_BOOTSTRAP: '127.0.0.1:' + BOOTSTRAP_PORT
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', d => process.stderr.write(`[${label}!] ${d}`))
  children.push(child)
  return child
}

class Client {
  constructor (label, port) {
    this.label = label
    this.port = port
    this.state = null
    this.msgs = []      // { conv, msg }
    this.events = []    // sunucudan gelen her şey
    this.waiters = []
  }

  async connect () {
    for (let i = 0; i < 40; i++) {
      try {
        await new Promise((resolve, reject) => {
          const ws = new WebSocket('ws://127.0.0.1:' + this.port)
          ws.on('open', () => { this.ws = ws; resolve() })
          ws.on('error', reject)
        })
        break
      } catch { await sleep(250) }
    }
    if (!this.ws) fail(this.label + ' web arayüzüne bağlanılamadı')
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      this.events.push(m)
      if (m.t === 'state') this.state = m
      if (m.t === 'msg') this.msgs.push(m)
      for (const w of [...this.waiters]) {
        if (w.pred(this)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve()
        }
      }
    })
  }

  send (obj) { this.ws.send(JSON.stringify(obj)) }

  waitFor (desc, pred, timeout = 60000) {
    if (pred(this)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(`${this.label}: "${desc}" ${timeout / 1000}s içinde gerçekleşmedi`), timeout)
      this.waiters.push({ pred, resolve: () => { clearTimeout(timer); resolve() } })
    })
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main () {
  console.log('--- yerel DHT bootstrap başlatılıyor')
  const bootstrap = DHT.bootstrapper(BOOTSTRAP_PORT, '127.0.0.1')
  await bootstrap.ready()

  console.log('--- iki instance başlatılıyor (Ali:3311, Veli:3312)')
  startInstance('ali', 3311)
  startInstance('veli', 3312)

  const ali = new Client('ali', 3311)
  const veli = new Client('veli', 3312)
  await ali.connect()
  await veli.connect()
  await ali.waitFor('state geldi', c => !!c.state)
  await veli.waitFor('state geldi', c => !!c.state)

  ali.send({ t: 'set-profile', name: 'Ali', avatar: '🦊' })
  veli.send({ t: 'set-profile', name: 'Veli', avatar: '🐺' })
  await ali.waitFor('isim kaydedildi', c => c.state.me.name === 'Ali')
  await veli.waitFor('isim kaydedildi', c => c.state.me.name === 'Veli')

  const aliCode = ali.state.me.code
  const veliCode = veli.state.me.code
  console.log('--- kodlar: ali=' + aliCode.slice(0, 12) + '… veli=' + veliCode.slice(0, 12) + '…')

  console.log('--- 1) Ali, Veli\'nin kodunu ekliyor (arkadaşlık isteği)')
  ali.send({ t: 'add-friend', code: veliCode })
  await veli.waitFor('istek Veli\'ye ulaştı', c => c.state.requests.some(r => r.code === aliCode))
  console.log('PASS: arkadaşlık isteği P2P olarak iletildi')

  console.log('--- 2) Veli isteği kabul ediyor')
  veli.send({ t: 'accept-request', code: aliCode })
  await ali.waitFor('Ali tarafında arkadaşlık kuruldu',
    c => c.state.friends.some(f => f.code === veliCode && f.status === 'friend' && f.online))
  await veli.waitFor('Veli tarafında arkadaşlık kuruldu',
    c => c.state.friends.some(f => f.code === aliCode && f.status === 'friend' && f.online))
  console.log('PASS: iki taraf da arkadaş ve çevrimiçi görünüyor')

  console.log('--- 3) Ali DM atıyor')
  ali.send({ t: 'send-dm', code: veliCode, text: 'selam veli, p2p calisiyor mu?' })
  await veli.waitFor('DM Veli\'ye ulaştı',
    c => c.msgs.some(m => m.conv === 'dm-' + aliCode && m.msg.text.includes('calisiyor')))
  console.log('PASS: DM dogrudan peer baglantisiyla ulasti')

  console.log('--- 4) Veli cevap veriyor')
  veli.send({ t: 'send-dm', code: aliCode, text: 'calisiyor knk, server da yok ustelik' })
  await ali.waitFor('cevap Ali\'ye ulaştı',
    c => c.msgs.some(m => m.conv === 'dm-' + veliCode && m.msg.text.includes('server da yok')))
  await ali.waitFor('ack geldi, outbox boş', c => !(c.state.pending[veliCode] || []).length)
  console.log('PASS: cift yonlu DM + teslim onayi (ack) calisiyor')

  console.log('--- 4.5) Yanıtla (reply)')
  const veliMsg = ali.msgs.find(m => m.conv === 'dm-' + veliCode && m.msg.text.includes('server da yok'))
  if (!veliMsg) fail('Ali, Veli\'nin mesajını bulamadı (yanıt için)')
  ali.send({ t: 'send-dm', code: veliCode, text: 'evet gordum knk', re: { id: veliMsg.msg.id, name: 'Veli', text: 'calisiyor knk, server da yok ustelik' } })
  await veli.waitFor('yanıt (re alanı) Veli\'ye ulaştı',
    c => c.msgs.some(m => m.conv === 'dm-' + aliCode && m.msg.re && m.msg.re.text.includes('server da yok') && m.msg.text.includes('evet gordum')))
  console.log('PASS: yanitla (reply) — alintili mesaj karsi tarafa re alaniyla ulasti')

  console.log('--- 4.6) Sabitleme (pin)')
  ali.send({ t: 'pin', conv: 'dm-' + veliCode, msgId: veliMsg.msg.id })
  await veli.waitFor('pin olayı Veli\'ye ulaştı',
    c => c.events.some(m => m.t === 'msg-ev' && m.ev.ev === 'pin' && m.ev.id === veliMsg.msg.id))
  console.log('PASS: sabitleme (pin) olayı P2P yayildi')

  console.log('--- 4.7) Engelleme (block)')
  ali.send({ t: 'block', code: veliCode })
  await ali.waitFor('Veli engellendi', c => (c.state.blocked || []).includes(veliCode))
  veli.send({ t: 'send-dm', code: aliCode, text: 'engelliyken attim bunu' })
  await sleep(3000)
  if (ali.msgs.some(m => m.msg.text && m.msg.text.includes('engelliyken attim'))) fail('engellinin mesajı Ali\'ye ulaştı!')
  ali.send({ t: 'unblock', code: veliCode })
  await ali.waitFor('engel kaldırıldı', c => !(c.state.blocked || []).includes(veliCode))
  console.log('PASS: engelleme — engellinin mesajlari dusuruluyor, engel kaldirilabiliyor')

  console.log('--- 5) Ali oda kuruyor, Veli oda koduyla katılıyor')
  ali.send({ t: 'create-room', name: 'lobi' })
  await ali.waitFor('oda kuruldu', c => c.state.rooms.length === 1)
  const room = ali.state.rooms[0]
  veli.send({ t: 'join-room', code: room.invite, name: 'lobi' })
  await ali.waitFor('Veli odada görünüyor', c => c.state.rooms[0] && c.state.rooms[0].online >= 1)
  await veli.waitFor('Ali odada görünüyor', c => c.state.rooms[0] && c.state.rooms[0].online >= 1)
  console.log('PASS: oda kodu ile katilim calisiyor')

  console.log('--- 6) Odaya mesaj')
  ali.send({ t: 'send-room', topic: room.topic, text: 'oda da calisiyor bu arada' })
  await veli.waitFor('oda mesajı Veli\'ye ulaştı',
    c => c.msgs.some(m => m.conv === 'room-' + room.topic && m.msg.text.includes('oda da calisiyor')))
  console.log('PASS: oda mesaji yayildi')

  console.log('--- 6.5) WebRTC sinyal aktarımı (rtc) + oda olayları (room-ev)')
  ali.send({ t: 'rtc', to: veliCode, data: { kind: 'ping', n: 1 } })
  await veli.waitFor('rtc mesajı Veli\'nin arayüzüne aktarıldı',
    c => c.events.some(m => m.t === 'rtc' && m.from === aliCode && m.data && m.data.kind === 'ping'))
  ali.send({ t: 'room-ev', room: room.topic, ev: { kind: 'pos', x: 42, y: 13 } })
  await veli.waitFor('room-ev Veli\'ye aktarıldı',
    c => c.events.some(m => m.t === 'room-ev' && m.from === aliCode && m.ev && m.ev.x === 42))
  console.log('PASS: rtc + room-ev aktarimi calisiyor (sesli sohbet sinyallesmesi hazir)')

  console.log('--- 7) Offline kuyruk: Veli kapanıyor, Ali mesaj atıyor, Veli geri geliyor')
  children[1].kill('SIGKILL')
  await ali.waitFor('Veli çevrimdışı görünüyor',
    c => c.state.friends.some(f => f.code === veliCode && !f.online), 30000)
  ali.send({ t: 'send-dm', code: veliCode, text: 'sen offlineken attim bunu' })
  await ali.waitFor('mesaj outbox\'ta bekliyor', c => (c.state.pending[veliCode] || []).length === 1)
  console.log('    Veli tekrar başlatılıyor...')
  startInstance('veli', 3312)
  const veli2 = new Client('veli2', 3312)
  await veli2.connect()
  await veli2.waitFor('offline mesaj teslim edildi',
    c => c.msgs.some(m => m.msg && m.msg.text === 'sen offlineken attim bunu') ||
         (c.state && fs.existsSync(path.join(TMP, 'veli', 'messages', 'dm-' + aliCode + '.jsonl')) &&
          fs.readFileSync(path.join(TMP, 'veli', 'messages', 'dm-' + aliCode + '.jsonl'), 'utf8').includes('offlineken')))
  await ali.waitFor('outbox boşaldı (teslim onaylandı)', c => !(c.state.pending[veliCode] || []).length)
  console.log('PASS: offline kuyruk — mesaj karsi taraf gelince teslim edildi')

  console.log('--- 8) Veri yerelliği: her kullanıcının verisi kendi klasöründe mi?')
  for (const who of ['ali', 'veli']) {
    const dir = path.join(TMP, who)
    if (!fs.existsSync(path.join(dir, 'identity.json'))) fail(who + ' identity.json yok')
    if (!fs.existsSync(path.join(dir, 'friends.json'))) fail(who + ' friends.json yok')
  }
  const aliHist = fs.readFileSync(path.join(TMP, 'ali', 'messages', 'dm-' + veliCode + '.jsonl'), 'utf8')
  if (!aliHist.includes('selam veli')) fail('Ali\'nin mesaj geçmişi diskte değil')
  console.log('PASS: tum veri kullanicilarin kendi data klasorlerinde')

  // Bundan sonrası yeni Turkuaz özellikleri (veli2 = yeniden doğan Veli)
  const v2 = veli2

  console.log('--- 9) Reaksiyon + düzenleme + silme')
  const firstDm = ali.msgs.find(m => m.conv === 'dm-' + veliCode && m.msg.text.includes('selam veli'))
  if (!firstDm) fail('Ali kendi ilk mesajını bulamadı')
  const msgId = firstDm.msg.id
  ali.send({ t: 'react', conv: 'dm-' + veliCode, msgId, emoji: '🔥' })
  await v2.waitFor('reaksiyon Veli\'ye ulaştı',
    c => c.events.some(m => m.t === 'msg-ev' && m.ev.ev === 'react' && m.ev.id === msgId && m.ev.emoji === '🔥'))
  ali.send({ t: 'edit', conv: 'dm-' + veliCode, msgId, text: 'selam veli, DUZENLENDI' })
  await v2.waitFor('düzenleme Veli\'ye ulaştı',
    c => c.events.some(m => m.t === 'msg-ev' && m.ev.ev === 'edit' && m.ev.id === msgId))
  v2.send({ t: 'history', conv: 'dm-' + aliCode })
  await v2.waitFor('katlanmış geçmişte düzenleme + reaksiyon görünüyor',
    c => c.events.some(m => m.t === 'history' && m.conv === 'dm-' + aliCode &&
      m.msgs.some(x => x.id === msgId && x.text.includes('DUZENLENDI') && x.reacts && x.reacts['🔥'])))
  console.log('PASS: react/edit olaylari P2P yayilip katlaniyor')

  console.log('--- 10) Dosya gönderme (DM)')
  const fileContent = 'turkuaz dosya testi - ' + 'x'.repeat(60000) // birden çok chunk
  ali.send({ t: 'send-file', code: veliCode, fname: 'not.txt', mime: 'text/plain', data: Buffer.from(fileContent).toString('base64') })
  await v2.waitFor('dosya mesajı Veli\'ye ulaştı',
    c => c.msgs.some(m => m.conv === 'dm-' + aliCode && m.msg.file && m.msg.file.fname === 'not.txt'))
  const fmsg = v2.msgs.find(m => m.msg.file && m.msg.file.fname === 'not.txt')
  const res = await fetch('http://127.0.0.1:3312/files/' + fmsg.msg.file.fid)
  const body = await res.text()
  if (body !== fileContent) fail('dosya içeriği bozuk geldi (' + body.length + ' bayt)')
  console.log('PASS: dosya parcali P2P transferle karsi diske indi')

  console.log('--- 11) Geçmiş senkronu: Can odaya sonradan katılıyor')
  startInstance('can', 3313)
  const can = new Client('can', 3313)
  await can.connect()
  await can.waitFor('state geldi', c => !!c.state)
  can.send({ t: 'set-profile', name: 'Can' })
  can.send({ t: 'join-room', code: room.invite, name: 'lobi' })
  await can.waitFor('Can odaya bağlandı', c => c.state.rooms.length && c.state.rooms[0].online >= 1)
  const canCode = can.state.me.code
  await can.waitFor('eski oda mesajları Can\'a senkronlandı',
    c => c.events.some(m => m.t === 'history' && m.conv === 'room-' + room.topic &&
      m.msgs.some(x => x.text && x.text.includes('oda da calisiyor'))))
  console.log('PASS: yeni katilan, eski mesajlari online uyelerden cekti')

  console.log('--- 12) İmzalı moderasyon: Ali (oda sahibi) Can\'ı yasaklıyor')
  ali.send({ t: 'ban', room: room.topic, code: canCode, on: true })
  await v2.waitFor('imzalı ban Veli\'ye ulaştı ve doğrulandı',
    c => c.state.rooms[0] && c.state.rooms[0].banned.includes(canCode))
  can.send({ t: 'send-room', topic: room.topic, ch: 'genel', text: 'ban yedim mi acaba' })
  await sleep(3500)
  if (v2.msgs.some(m => m.msg.text && m.msg.text.includes('ban yedim mi'))) {
    fail('banlı kullanıcının mesajı Veli\'ye ulaştı!')
  }
  console.log('PASS: banli kullanicinin mesajlari dusuruluyor (imza dogrulamali)')

  console.log('--- 13) Yerel arama')
  ali.send({ t: 'search', q: 'offlineken' })
  await ali.waitFor('arama sonucu geldi',
    c => c.events.some(m => m.t === 'search-res' && m.results.length >= 1))
  console.log('PASS: yerel gecmiste arama calisiyor')

  console.log('--- 14) Hesap taşıma (dışa aktarma)')
  ali.send({ t: 'export' })
  await ali.waitFor('export verisi geldi',
    c => c.events.some(m => m.t === 'export-res' && m.data && /^[0-9a-f]{64}$/.test(m.data.identity.seed) && Array.isArray(m.data.friends)))
  console.log('PASS: kimlik + arkadas listesi tasinabilir pakette')

  console.log('\n=== TÜM TESTLER GEÇTİ ✅ ===')
  await bootstrap.destroy()
  cleanup(0)
}

main().catch(e => { console.error(e); cleanup(1) })
