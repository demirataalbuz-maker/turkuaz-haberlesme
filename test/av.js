// Görüntülü/sesli sohbet uçtan uca testi: iki Electron instance'ı sahte
// kamera/mikrofonla açılır (TURKUAZ_FAKE_MEDIA), CDP ile sayfa içinden
// Voice.join / toggleCam / toggleScreen ve DM araması sürülür; karşı tarafta
// GERÇEKTEN video çözülüyor mu (videoWidth > 0, framesDecoded) doğrulanır.
// Not: grafik oturum ister (pencereler kısa süreliğine açılır).
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const DHT = require('hyperdht')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(__dirname, 'tmp-av')
const BOOTSTRAP_PORT = parseInt(process.env.TEST_BOOTSTRAP_PORT || '49881', 10)

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const children = []
function cleanup (code) {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch {} } }
  process.exit(code)
}
function fail (msg) { console.error('FAIL:', msg); cleanup(1) }

function startApp (label, port, dbgPort) {
  const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), ['.', '--remote-debugging-port=' + dbgPort, '--no-sandbox'], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      TURKUAZ_DATA: path.join(TMP, label),
      TURKUAZ_BOOTSTRAP: '127.0.0.1:' + BOOTSTRAP_PORT,
      TURKUAZ_FAKE_MEDIA: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', d => {
    const s = d.toString()
    if (/FAIL|Uncaught|Error: /.test(s) && !/disk_cache|Role Conflict|AddIceCandidate/.test(s)) process.stderr.write(`[${label}!] ${s}`)
  })
  children.push(child)
  return child
}

function getJSON (url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = ''
      res.on('data', c => { b += c })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

// Chrome DevTools Protocol üzerinden sayfada JS çalıştıran mini sürücü
class Page {
  constructor (label, dbgPort, appUrl) { this.label = label; this.dbgPort = dbgPort; this.appUrl = appUrl; this.id = 0; this.pend = new Map() }
  async connect () {
    for (let i = 0; i < 60; i++) {
      try {
        const targets = await getJSON('http://127.0.0.1:' + this.dbgPort + '/json/list')
        const page = targets.find(t => t.type === 'page' && t.url.startsWith(this.appUrl))
        if (page) {
          await new Promise((res, rej) => {
            const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
            ws.on('open', () => { this.ws = ws; res() })
            ws.on('error', rej)
          })
          this.ws.on('message', d => {
            const m = JSON.parse(d.toString())
            if (m.id && this.pend.has(m.id)) { const { res } = this.pend.get(m.id); this.pend.delete(m.id); res(m) }
          })
          return
        }
      } catch {}
      await sleep(500)
    }
    fail(this.label + ': CDP hedefi bulunamadı')
  }
  cmd (method, params = {}) {
    const id = ++this.id
    return new Promise((res) => {
      this.pend.set(id, { res })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval (expr, opts = {}) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, ...opts })
    if (r.result && r.result.exceptionDetails) throw new Error(this.label + ' eval hata: ' + JSON.stringify(r.result.exceptionDetails.exception))
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  async waitEval (desc, expr, timeoutMs = 30000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (await this.eval(expr)) return true
      await sleep(500)
    }
    fail(`${this.label}: "${desc}" ${timeoutMs / 1000}s içinde olmadı`)
  }
}

// Sunucu WS sürücüsü (e2e.js'tekiyle aynı fikir)
class Srv {
  constructor (label, port) { this.label = label; this.port = port; this.state = null }
  async connect () {
    for (let i = 0; i < 80; i++) {
      try {
        await new Promise((res, rej) => {
          const ws = new WebSocket('ws://127.0.0.1:' + this.port)
          ws.on('open', () => { this.ws = ws; res() })
          ws.on('error', rej)
        })
        break
      } catch { await sleep(400) }
    }
    if (!this.ws) fail(this.label + ' web arayüzüne bağlanılamadı')
    this.ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.t === 'state') this.state = m })
  }
  send (o) { this.ws.send(JSON.stringify(o)) }
  async waitState (desc, pred, timeoutMs = 40000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (this.state && pred(this.state)) return
      await sleep(300)
    }
    fail(`${this.label}: "${desc}" olmadı`)
  }
}

async function main () {
  console.log('--- yerel DHT bootstrap')
  const bootstrap = DHT.bootstrapper(BOOTSTRAP_PORT, '127.0.0.1')
  await bootstrap.ready()

  console.log('--- iki Electron instance (Ayse:3411, Banu:3412)')
  startApp('ayse', 3411, 9331)
  startApp('banu', 3412, 9332)

  const sA = new Srv('ayse', 3411); const sB = new Srv('banu', 3412)
  await sA.connect(); await sB.connect()
  await sA.waitState('state', s => !!s.me)
  await sB.waitState('state', s => !!s.me)
  sA.send({ t: 'set-profile', name: 'Ayse' })
  sB.send({ t: 'set-profile', name: 'Banu' })
  const codeA = sA.state.me.code; const codeB = sB.state.me.code

  sA.send({ t: 'add-friend', code: codeB })
  await sB.waitState('istek geldi', s => s.requests.some(r => r.code === codeA))
  sB.send({ t: 'accept-request', code: codeA })
  await sA.waitState('arkadaş+online', s => s.friends.some(f => f.code === codeB && f.online))
  await sB.waitState('arkadaş+online', s => s.friends.some(f => f.code === codeA && f.online))

  sA.send({ t: 'create-room', name: 'avtest' })
  await sA.waitState('oda', s => s.rooms.length === 1)
  sB.send({ t: 'join-room', code: sA.state.rooms[0].invite, name: 'avtest' })
  await sA.waitState('B odada', s => s.rooms[0].online >= 1)
  await sB.waitState('A odada', s => s.rooms[0] && s.rooms[0].online >= 1)
  console.log('PASS: arkadaşlık + oda kuruldu')

  const pA = new Page('ayse', 9331, 'http://127.0.0.1:3411')
  const pB = new Page('banu', 9332, 'http://127.0.0.1:3412')
  await pA.connect(); await pB.connect()

  console.log('--- 1) Kopyalama butonu (pano izni)')
  await pA.cmd('Page.bringToFront')
  await sleep(600)
  // userGesture: gerçek kullanımda buton tıklaması bu jesti sağlar
  const clip = await pA.eval(`navigator.clipboard.writeText('turkuaz-test').then(() => 'OK').catch(e => 'ERR: ' + e.message)`, { userGesture: true })
  if (clip !== 'OK') fail('pano yazılamadı: ' + clip)
  console.log('PASS: navigator.clipboard.writeText çalışıyor')

  console.log('--- 2) Oda sesli sohbeti')
  // Teşhis kancası: rtc sinyal trafiğini ve konsol hatalarını topla
  const hook = `window._log = []; window._err = [];
    const _o = Voice.onRtc.bind(Voice);
    Voice.onRtc = (m) => { _log.push('rx:' + (m.data && m.data.kind)); return _o(m) };
    const _s = Voice.sendRtc.bind(Voice);
    Voice.sendRtc = (to, d) => { _log.push('tx:' + (d && d.kind)); return _s(to, d) };
    const _e = console.error.bind(console);
    console.error = (...a) => { _err.push(a.map(x => (x && x.message) || String(x)).join(' ').slice(0, 200)); _e(...a) };
    true`
  await pA.eval(hook); await pB.eval(hook)
  for (const p of [pA, pB]) {
    await p.waitEval('oda state geldi', `state.rooms.length === 1`)
    await p.eval(`(async () => { openRoom(state.rooms[0]); return true })()`)
  }
  await pA.eval(`Voice.join().then(() => true)`)
  await sleep(800)
  await pB.eval(`Voice.join().then(() => true)`)
  const connExpr = `Voice.members.size === 1 && [...Voice.members.values()].every(m => m.pc.connectionState === 'connected')`
  const diag = `JSON.stringify({ room: !!Voice.room, n: Voice.members.size, mem: [...Voice.members.values()].map(m => ({
    conn: m.pc.connectionState, ice: m.pc.iceConnectionState, gather: m.pc.iceGatheringState, sig: m.pc.signalingState,
    ld: m.pc.localDescription && m.pc.localDescription.type, rd: m.pc.remoteDescription && m.pc.remoteDescription.type })),
    log: window._log, err: window._err })`
  let okA = false; let okB = false
  for (let i = 0; i < 40 && !(okA && okB); i++) { okA = await pA.eval(connExpr); okB = await pB.eval(connExpr); await sleep(1000) }
  if (!(okA && okB)) {
    console.log('A diag:', await pA.eval(diag))
    console.log('B diag:', await pB.eval(diag))
    fail('oda sesli sohbeti bağlanamadı')
  }
  console.log('PASS: oda sesli sohbeti bağlandı')

  console.log('--- 2b) Ses gerçekten akıyor mu (giriş-kazancı işlenmiş mikrofon)')
  await sleep(2500)
  const audioBytes = await pB.eval(`(async () => {
    const m = [...Voice.members.values()][0]; if (!m) return -1
    const st = await m.pc.getStats(); let b = 0
    st.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') b = r.bytesReceived })
    return b
  })()`)
  if (!(audioBytes > 0)) fail('işlenmiş mikrofondan ses akmıyor (inbound audio bytes=' + audioBytes + ')')
  console.log('PASS: giriş-kazancı işlenmiş mikrofon sesi karşıya akıyor (' + audioBytes + ' bayt)')

  console.log('--- 2c) Ayarlar ekranı açılıyor + cihaz seçimleri doluyor')
  await pA.eval(`TurkuazSettings.open('av'); true`)
  await pA.waitEval('ayarlar açık', `!document.getElementById('settings').classList.contains('hidden')`, 6000)
  await pA.waitEval('AV paneli render oldu', `document.querySelectorAll('#set-panel .set-select').length >= 3`, 8000)
  const setInfo = await pA.eval(`JSON.stringify({
    cats: document.querySelectorAll('#set-nav .set-cat').length,
    selects: document.querySelectorAll('#set-panel .set-select').length,
    sliders: document.querySelectorAll('#set-panel input[type=range]').length,
    mics: document.querySelectorAll('#set-panel .set-select')[0].options.length
  })`)
  console.log('    ayar paneli:', setInfo)
  // çıkış ses seviyesini değiştir → Voice.master.gain uygulanmalı
  await pA.eval(`TurkuazSettings.set('outVol', 60); Voice.setOutputVolume(60); true`)
  const gain = await pA.eval(`Voice.master ? Math.round(Voice.master.gain.value * 100) : -1`)
  if (gain !== 60) fail('çıkış ses seviyesi uygulanmadı (gain=' + gain + ')')
  await pA.eval(`document.getElementById('set-close').click(); true`)
  await pA.waitEval('ayarlar kapandı', `document.getElementById('settings').classList.contains('hidden')`, 5000)
  console.log('PASS: ayarlar ekranı açılıp cihazları listeliyor, ses seviyesi canlı uygulanıyor')

  console.log('--- 3) Kamera odada')
  await pA.eval(`Voice.toggleCam().then(() => !!Voice.cam)`)
  await pB.waitEval('B, A\'nın kamerasını görüyor',
    `(() => { const m = [...Voice.members.values()][0]; return m && m.bubble && m.bubble.querySelector('video').videoWidth > 0 })()`, 20000)
  console.log('PASS: kamera görüntüsü karşı tarafta çözülüyor')

  console.log('--- 4) Ekran paylaşımı odada')
  await pA.eval(`Voice.toggleScreen().then(() => !!Voice.screen)`)
  await pB.waitEval('B tiyatroda ekranı görüyor',
    `!document.getElementById('theater').classList.contains('hidden') && document.getElementById('theater-video').videoWidth > 0`, 20000)
  console.log('PASS: ekran paylaşımı karşı tarafta oynuyor')

  console.log('--- 4b) Kişi-bazlı ses ayarı + tam ekran butonu')
  const volOk = await pB.eval(`(() => {
    const m = [...Voice.members.values()][0]; if (!m || !m.gain) return 'gain-yok'
    Voice.setMemberVolume(m.code, 40)
    return Math.round(m.gain.gain.value * 100)
  })()`)
  if (volOk !== 40) fail('kişi-bazlı ses uygulanmadı: ' + volOk)
  const fsBtn = await pB.eval(`!!document.getElementById('theater-full') && typeof document.getElementById('theater-video').requestFullscreen === 'function'`)
  if (!fsBtn) fail('tam ekran butonu/API yok')
  console.log('PASS: kişi-bazlı ses (üye gain=' + volOk + '%) + tam ekran hazır')

  console.log('--- 5) DM araması + kamera + ekran')
  await pA.eval(`Voice.leave(); true`)
  await pB.eval(`Voice.leave(); true`)
  await sleep(500)
  await pA.eval(`CallMgr.start('${codeB}'); true`)
  await pB.waitEval('çağrı geldi', `CallMgr.state === 'in'`, 15000)
  await pB.eval(`CallMgr.accept(); true`)
  const callConn = `CallMgr.pc && CallMgr.pc.connectionState === 'connected'`
  await pA.waitEval('A call connected', callConn, 30000)
  await pB.waitEval('B call connected', callConn, 30000)
  console.log('PASS: DM araması bağlandı')

  await pA.eval(`CallMgr.toggleCam().then(() => !!CallMgr.cam)`)
  await pB.waitEval('B, A\'nın kamerasını görüyor (DM)',
    `document.getElementById('call-remote').videoWidth > 0`, 20000)
  await pB.eval(`CallMgr.toggleCam().then(() => !!CallMgr.cam)`)
  await pA.waitEval('A, B\'nin kamerasını görüyor (DM)',
    `document.getElementById('call-remote').videoWidth > 0`, 20000)
  console.log('PASS: DM kamerası iki yönde de akıyor')

  await pA.eval(`CallMgr.toggleScreen().then(() => !!CallMgr.screen)`)
  await pB.waitEval('B, A\'nın ekranını görüyor (DM)',
    `CallMgr.remoteScreenSid && document.getElementById('call-remote').videoWidth >= 640`, 20000)
  console.log('PASS: DM ekran paylaşımı akıyor')

  console.log('\n=== A/V TESTLERİ GEÇTİ ✅ ===')
  await bootstrap.destroy()
  cleanup(0)
}

main().catch(e => { console.error(e); cleanup(1) })
