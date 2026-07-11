// Bare duman testi: mobil çekirdeğin (lib/core.js) Bare runtime'ında GERÇEKTEN
// çalıştığını doğrular — telefondaki backend ile aynı kod yolu.
//   node test/bare-smoke.js
// Akış: yerel DHT bootstrap → 2 Bare süreci (Ali/Veli) → arkadaşlık → DM →
// teslim onayı (ack/pending) → oda kur/katıl → oda mesajı.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const DHT = require('hyperdht')

const ROOT = path.join(__dirname, '..')
const BARE = path.join(ROOT, 'node_modules', 'bare', 'bin', 'bare')
const BOOTSTRAP_PORT = parseInt(process.env.TEST_BOOTSTRAP_PORT || '49941', 10)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turkuaz-bare-'))

const procs = []
function fail (msg) {
  console.error('FAIL:', msg)
  for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
  process.exit(1)
}
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })

class BareUser {
  constructor (name) {
    this.name = name
    this.state = null
    this.msgs = []      // { conv, msg }
    this.raw = []
    this.waiters = []
    const dir = path.join(TMP, name)
    this.proc = spawn(process.execPath, [BARE, path.join(ROOT, 'test', 'bare-entry.mjs'), dir, String(BOOTSTRAP_PORT)], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'inherit']
    })
    procs.push(this.proc)
    let buf = ''
    this.proc.stdout.on('data', (c) => {
      buf += c.toString()
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        this._onMsg(m)
      }
    })
  }

  _onMsg (m) {
    this.raw.push(m)
    if (m.t === 'bare-error') fail(this.name + ' Bare çekirdeği çöktü:\n' + m.err)
    if (m.t === 'bare-ready') this.code = m.code
    if (m.t === 'state') this.state = m
    if (m.t === 'msg') this.msgs.push(m)
    for (const w of [...this.waiters]) {
      if (w.pred(this)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.tmo); w.res() }
    }
  }

  send (obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n') }

  wait (label, pred, ms = 30000) {
    if (pred(this)) return Promise.resolve()
    return new Promise((res) => {
      const w = { pred, res }
      w.tmo = setTimeout(() => {
        console.error('   son durum:', JSON.stringify(this.state && {
          friends: this.state.friends, rooms: this.state.rooms.map(r => ({ name: r.name, online: r.online })), pending: this.state.pending
        }))
        fail(this.name + ': "' + label + '" ' + (ms / 1000) + 's içinde olmadı')
      }, ms)
      this.waiters.push(w)
    })
  }

  kill () { try { this.proc.kill() } catch {} }
}

async function main () {
  console.log('--- yerel DHT bootstrap (port ' + BOOTSTRAP_PORT + ')')
  const bootstrap = DHT.bootstrapper(BOOTSTRAP_PORT, '127.0.0.1')
  await bootstrap.ready()

  console.log('--- 1) İki Bare çekirdeği başlıyor (telefondakiyle aynı kod)')
  const ali = new BareUser('ali')
  const veli = new BareUser('veli')
  await ali.wait('bare-ready', u => !!u.code, 20000)
  await veli.wait('bare-ready', u => !!u.code, 20000)
  console.log('PASS: iki çekirdek Bare üzerinde açıldı (' + ali.raw.find(m => m.t === 'bare-ready').bare + ')')

  ali.send({ t: 'set-profile', name: 'Ali' })
  veli.send({ t: 'set-profile', name: 'Veli' })

  console.log('--- 2) Arkadaşlık (istek + kabul)')
  ali.send({ t: 'add-friend', code: veli.code })
  await veli.wait('istek geldi', u => u.state && u.state.requests.some(r => r.code === ali.code))
  veli.send({ t: 'accept-request', code: ali.code })
  await ali.wait('arkadaş + çevrimiçi', u => u.state && u.state.friends.some(f => f.code === veli.code && f.status === 'friend' && f.online))
  await veli.wait('arkadaş + çevrimiçi', u => u.state && u.state.friends.some(f => f.code === ali.code && f.status === 'friend' && f.online))
  console.log('PASS: arkadaşlık Bare üzerinde kuruldu (DHT + Noise)')

  console.log('--- 3) DM + teslim onayı')
  ali.send({ t: 'send-dm', code: veli.code, text: 'selam telefon dünyası 🌍' })
  await veli.wait('DM geldi', u => u.msgs.some(m => m.conv === 'dm-' + ali.code && m.msg.text.includes('telefon dünyası')))
  await ali.wait('ack geldi (pending boş)', u => u.state && (u.state.pending[veli.code] || []).length === 0)
  console.log('PASS: DM iletildi + ack ile bekleyen listesi temizlendi')

  console.log('--- 4) Oda: kur, davetle katıl, mesaj yay')
  ali.send({ t: 'create-room', name: 'bare-oda' })
  await ali.wait('oda kuruldu', u => u.state && u.state.rooms.length === 1)
  const invite = ali.state.rooms[0].invite
  veli.send({ t: 'join-room', code: invite, name: 'bare-oda' })
  await ali.wait('Veli odada', u => u.state.rooms[0] && u.state.rooms[0].online >= 1)
  await veli.wait('Ali odada', u => u.state && u.state.rooms[0] && u.state.rooms[0].online >= 1)
  const topic = ali.state.rooms[0].topic
  veli.send({ t: 'send-room', topic, ch: 'genel', text: 'oda da çalışıyor 🎉' })
  await ali.wait('oda mesajı geldi', u => u.msgs.some(m => m.conv === 'room-' + topic && m.msg.text.includes('çalışıyor')))
  console.log('PASS: oda mesajı Bare çekirdekleri arasında yayıldı')

  console.log('--- 5) Geçmiş + arama çekirdekte')
  veli.send({ t: 'history', conv: 'dm-' + ali.code })
  await veli.wait('geçmiş geldi', u => u.raw.some(m => m.t === 'history' && m.conv === 'dm-' + ali.code && m.msgs.length >= 1))
  veli.send({ t: 'search', q: 'telefon' })
  await veli.wait('arama sonucu', u => u.raw.some(m => m.t === 'search-res' && m.results.length >= 1))
  console.log('PASS: geçmiş + yerel arama Bare üzerinde çalışıyor')

  console.log('\n=== BARE DUMAN TESTİ GEÇTİ ✅ (çekirdek telefon runtime\'ında çalışıyor) ===')
  ali.kill(); veli.kill()
  await bootstrap.destroy()
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
