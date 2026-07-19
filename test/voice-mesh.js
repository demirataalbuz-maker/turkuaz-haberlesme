// 5+1 oda sesli sohbet kabul testi.
//
// Varsayilan olarak 6 ayri Electron istemcisi gercek Turkuaz sunuculariyla,
// yerel Hyperswarm bootstrap uzerinden ayni odaya girer. Chromium'un sahte
// mikrofonu kullanilir; WebRTC/Voice kodu mock'lanmaz. Her istemcide diger
// 5 katilimcinin baglantisi, canli ses izleri ve gelen RTP baytlari dogrulanir.
//
// 10 kisi icin: TURKUAZ_VOICE_CLIENTS=10 npm run test:voice:mesh
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const net = require('net')
const dgram = require('dgram')
const DHT = require('hyperdht')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const CLIENT_COUNT = Number.parseInt(process.env.TURKUAZ_VOICE_CLIENTS || '6', 10)
const START_TIMEOUT = Number.parseInt(process.env.TURKUAZ_VOICE_START_TIMEOUT || '90000', 10)
const MESH_TIMEOUT = Number.parseInt(process.env.TURKUAZ_VOICE_MESH_TIMEOUT || '120000', 10)

if (!Number.isInteger(CLIENT_COUNT) || CLIENT_COUNT < 2 || CLIENT_COUNT > 10) {
  console.error('TURKUAZ_VOICE_CLIENTS 2 ile 10 arasinda olmali')
  process.exit(2)
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function freeTcpPort (used) {
  for (let i = 0; i < 40; i++) {
    const port = 20000 + Math.floor(Math.random() * 30000)
    if (used.has(port)) continue
    const ok = await new Promise(resolve => {
      const server = net.createServer()
      server.unref()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (ok) { used.add(port); return port }
  }
  throw new Error('bos TCP portu bulunamadi')
}

async function freeUdpPort () {
  for (let i = 0; i < 40; i++) {
    const port = 20000 + Math.floor(Math.random() * 30000)
    const ok = await new Promise(resolve => {
      const socket = dgram.createSocket('udp4')
      socket.unref()
      socket.once('error', () => resolve(false))
      socket.bind(port, '127.0.0.1', () => socket.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error('bos UDP portu bulunamadi')
}

function getJSON (url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (err) { reject(err) }
      })
    })
    req.setTimeout(1200, () => req.destroy(new Error('HTTP zaman asimi')))
    req.on('error', reject)
  })
}

class ServerDriver {
  constructor (client) {
    this.client = client
    this.state = null
  }

  async connect () {
    const deadline = Date.now() + START_TIMEOUT
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${this.client.port}`)
          const timer = setTimeout(() => {
            ws.terminate()
            reject(new Error('WS zaman asimi'))
          }, 1200)
          ws.once('open', () => { clearTimeout(timer); this.ws = ws; resolve() })
          ws.once('error', err => { clearTimeout(timer); reject(err) })
        })
        this.ws.on('message', data => {
          let msg
          try { msg = JSON.parse(data.toString()) } catch { return }
          if (msg.t === 'state') this.state = msg
        })
        // Sunucu baglanti acilir acilmaz ilk state'i yolluyor; dinleyici ile
        // open olayi arasindaki yarisi ortadan kaldirmak icin tekrar iste.
        this.send({ t: '__ready' })
        return
      } catch {}
      await sleep(300)
    }
    throw new Error(`${this.client.label}: yerel sunucu acilmadi\n${this.client.logs()}`)
  }

  send (obj) { this.ws.send(JSON.stringify(obj)) }

  async waitState (description, predicate, timeout = START_TIMEOUT) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.state && predicate(this.state)) return this.state
      await sleep(250)
    }
    throw new Error(`${this.client.label}: ${description} beklenirken zaman asimi; state=${JSON.stringify(this.state)}`)
  }

  close () {
    try { this.ws.close() } catch {}
  }
}

class PageDriver {
  constructor (client) {
    this.client = client
    this.nextId = 0
    this.pending = new Map()
  }

  async connect () {
    const appUrl = `http://127.0.0.1:${this.client.port}`
    const deadline = Date.now() + START_TIMEOUT
    while (Date.now() < deadline) {
      try {
        const targets = await getJSON(`http://127.0.0.1:${this.client.debugPort}/json/list`)
        const target = targets.find(item => item.type === 'page' && item.url.startsWith(appUrl))
        if (target) {
          await new Promise((resolve, reject) => {
            const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
            ws.once('open', () => { this.ws = ws; resolve() })
            ws.once('error', reject)
          })
          this.ws.on('message', data => {
            const msg = JSON.parse(data.toString())
            const pending = msg.id && this.pending.get(msg.id)
            if (!pending) return
            this.pending.delete(msg.id)
            pending.resolve(msg)
          })
          return
        }
      } catch {}
      await sleep(300)
    }
    throw new Error(`${this.client.label}: CDP sayfasi bulunamadi\n${this.client.logs()}`)
  }

  command (method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.client.label}: CDP ${method} zaman asimi`))
      }, 20000)
      this.pending.set(id, {
        resolve: result => { clearTimeout(timer); resolve(result) }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const response = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (response.result && response.result.exceptionDetails) {
      const detail = response.result.exceptionDetails
      const reason = detail.exception && (detail.exception.description || detail.exception.value)
      throw new Error(`${this.client.label}: renderer hatasi: ${reason || detail.text || JSON.stringify(detail.exception)}`)
    }
    return response.result && response.result.result
      ? response.result.result.value
      : undefined
  }

  async waitEval (description, expression, timeout = START_TIMEOUT) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression)) return
      } catch {}
      await sleep(250)
    }
    throw new Error(`${this.client.label}: renderer ${description} beklenirken zaman asimi`)
  }

  close () {
    try { this.ws.close() } catch {}
  }
}

function startApp (client, tempRoot, bootstrapPort) {
  let output = ''
  const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [
    '.',
    `--remote-debugging-port=${client.debugPort}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage'
  ], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      PORT: String(client.port),
      TURKUAZ_DATA: path.join(tempRoot, client.label),
      TURKUAZ_BOOTSTRAP: `127.0.0.1:${bootstrapPort}`,
      TURKUAZ_FAKE_MEDIA: '1',
      TURKUAZ_NO_DEFAULT_TURN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const collect = chunk => {
    output = (output + chunk.toString()).slice(-12000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  client.child = child
  client.logs = () => output
}

function stopApp (client) {
  if (!client.child || client.child.exitCode !== null) return
  try { process.kill(-client.child.pid, 'SIGKILL') } catch {
    try { client.child.kill('SIGKILL') } catch {}
  }
}

async function meshSnapshot (page) {
  return page.eval(`(async () => {
    const members = []
    for (const [code, member] of Voice.members) {
      const stats = await member.pc.getStats()
      let bytes = 0
      let packets = 0
      stats.forEach(row => {
        if (row.type === 'inbound-rtp' && row.kind === 'audio') {
          bytes += Number(row.bytesReceived || 0)
          packets += Number(row.packetsReceived || 0)
        }
      })
      members.push({
        code,
        connection: member.pc.connectionState,
        ice: member.pc.iceConnectionState,
        sendAudio: member.pc.getSenders().filter(s => s.track && s.track.kind === 'audio' && s.track.readyState === 'live').length,
        receiveAudio: member.pc.getReceivers().filter(r => r.track && r.track.kind === 'audio' && r.track.readyState === 'live').length,
        bytes,
        packets
      })
    }
    return {
      room: Voice.room,
      mic: !!(Voice.mic && Voice.mic.getAudioTracks().some(t => t.readyState === 'live')),
      members
    }
  })()`)
}

function snapshotReady (snapshot, expectedCodes) {
  if (!snapshot || !snapshot.room || !snapshot.mic || snapshot.members.length !== expectedCodes.length) return false
  const actualCodes = snapshot.members.map(member => member.code).sort()
  const wantedCodes = [...expectedCodes].sort()
  if (actualCodes.some((code, i) => code !== wantedCodes[i])) return false
  return snapshot.members.every(member =>
    member.connection === 'connected' &&
    member.sendAudio >= 1 &&
    member.receiveAudio >= 1 &&
    member.bytes > 0 &&
    member.packets > 0
  )
}

async function main () {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turkuaz-voice-mesh-'))
  const clients = Array.from({ length: CLIENT_COUNT }, (_, index) => ({
    index,
    label: `oyuncu-${index + 1}`
  }))
  const usedPorts = new Set()
  let bootstrap
  let globalTimer

  try {
    for (const client of clients) {
      client.port = await freeTcpPort(usedPorts)
      client.debugPort = await freeTcpPort(usedPorts)
    }
    const bootstrapPort = Number.parseInt(process.env.TEST_BOOTSTRAP_PORT || '', 10) || await freeUdpPort()
    bootstrap = DHT.bootstrapper(bootstrapPort, '127.0.0.1')
    await bootstrap.ready()

    globalTimer = setTimeout(() => {
      console.error(`FAIL: test ${Math.ceil((START_TIMEOUT + MESH_TIMEOUT) / 1000)} saniyede tamamlanamadi`)
      for (const client of clients) stopApp(client)
      process.exit(1)
    }, START_TIMEOUT + MESH_TIMEOUT + 30000)
    globalTimer.unref()

    console.log(`--- ${CLIENT_COUNT} Electron istemcisi baslatiliyor (${CLIENT_COUNT - 1}+1 ses hedefi)`)
    for (const client of clients) startApp(client, tempRoot, bootstrapPort)

    await Promise.all(clients.map(async client => {
      client.server = new ServerDriver(client)
      await client.server.connect()
      await client.server.waitState('ilk state', state => !!state.me)
      client.server.send({ t: 'set-profile', name: `Oyuncu ${client.index + 1}` })
      await client.server.waitState('profil', state => state.me.name === `Oyuncu ${client.index + 1}`)
      client.code = client.server.state.me.code
    }))
    console.log('PASS: tum masaustu istemcileri ve yerel P2P kimlikleri hazir')

    const owner = clients[0]
    owner.server.send({ t: 'create-room', name: '5+1 Kabul Odasi' })
    await owner.server.waitState('oda olusturma', state => state.rooms.length === 1)
    const invite = owner.server.state.rooms[0].invite

    for (const client of clients.slice(1)) {
      client.server.send({ t: 'join-room', code: invite, name: '5+1 Kabul Odasi' })
      await client.server.waitState('odaya katilma', state => state.rooms.length === 1)
    }
    await Promise.all(clients.map(client => client.server.waitState(
      `${CLIENT_COUNT - 1} oda esini gorme`,
      state => state.rooms[0] && state.rooms[0].online === CLIENT_COUNT - 1,
      MESH_TIMEOUT
    )))
    console.log(`PASS: Hyperswarm oda topolojisi tam mesh (${CLIENT_COUNT * (CLIENT_COUNT - 1) / 2} P2P baglanti)`) 

    await Promise.all(clients.map(async client => {
      client.page = new PageDriver(client)
      await client.page.connect()
      await client.page.waitEval(
        'uygulama ve oda state hazirligi',
        `typeof Voice !== 'undefined' && !!window.TurkuazSettings && typeof state !== 'undefined' && state.rooms.length === 1`
      )
      await client.page.eval(`(() => {
        TurkuazSettings.set('noise', 'standard')
        const room = state.rooms[0]
        if (!room) throw new Error('oda renderer state icinde yok')
        openRoom(room)
        return true
      })()`)
    }))

    // Sirali giris, ilk SDP tekliflerinin ayni anda carpismasini azaltir; gercek
    // kullanicilarin kanala arka arkaya girmesine de daha yakindir.
    for (const client of clients) {
      const joined = await client.page.eval(`Voice.join().then(() => !!Voice.room)`)
      if (!joined) throw new Error(`${client.label}: Voice.join odaya giremedi`)
      await sleep(350)
    }

    console.log(`--- her istemcide ${CLIENT_COUNT - 1} WebRTC ses bagi ve RTP akisi bekleniyor`)
    const snapshots = new Map()
    const deadline = Date.now() + MESH_TIMEOUT
    let allReady = false
    while (Date.now() < deadline) {
      allReady = true
      for (const client of clients) {
        const snapshot = await meshSnapshot(client.page)
        snapshots.set(client.label, snapshot)
        const expectedCodes = clients.filter(other => other !== client).map(other => other.code)
        if (!snapshotReady(snapshot, expectedCodes)) allReady = false
      }
      if (allReady) break
      await sleep(1000)
    }

    if (!allReady) {
      const diagnostics = [...snapshots.entries()].map(([label, snapshot]) => ({ label, ...snapshot }))
      throw new Error('ses mesh hazir olmadi:\n' + JSON.stringify(diagnostics, null, 2))
    }

    for (const client of clients) {
      const snapshot = snapshots.get(client.label)
      const totalBytes = snapshot.members.reduce((sum, member) => sum + member.bytes, 0)
      console.log(`PASS: ${client.label} -> ${snapshot.members.length} bagli peer, ${snapshot.members.length} canli ses izi, ${totalBytes} gelen bayt`)
    }
    console.log(`\n=== ${CLIENT_COUNT - 1}+1 SES MESH KABUL TESTI GECTI ===`)
  } finally {
    if (globalTimer) clearTimeout(globalTimer)
    for (const client of clients) {
      if (client.page) client.page.close()
      if (client.server) client.server.close()
      stopApp(client)
    }
    if (bootstrap) await bootstrap.destroy().catch(() => {})
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error('FAIL:', err && err.stack ? err.stack : err)
  process.exitCode = 1
})
