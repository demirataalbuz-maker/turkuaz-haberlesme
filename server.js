// Turkuaz — serversız P2P sohbet uygulaması (masaüstü giriş noktası).
// Bu process her kullanıcının KENDİ makinesinde çalışır:
//  - localhost'ta arayüzü sunar (Express + WebSocket)
//  - Tüm P2P/mesajlaşma mantığı lib/core.js'te (mobil de aynı çekirdeği kullanır)
const path = require('path')
const http = require('http')
const fs = require('fs')
const express = require('express')
const { WebSocketServer } = require('ws')
const Store = require('./lib/store')
const { createCore, DEFAULT_ICE } = require('./lib/core')

const PORT = parseInt(process.env.PORT || '3210', 10)
const DATA = process.env.TURKUAZ_DATA || process.env.PEERCORD_DATA || path.join(__dirname, 'data')
const BOOTSTRAP = (process.env.TURKUAZ_BOOTSTRAP || process.env.PEERCORD_BOOTSTRAP)
  ? (process.env.TURKUAZ_BOOTSTRAP || process.env.PEERCORD_BOOTSTRAP).split(',').map(s => {
      const [host, port] = s.trim().split(':')
      return { host, port: parseInt(port, 10) }
    })
  : undefined

// Özel ICE sunucuları: veri klasörüne ice.json koy ya da TURKUAZ_ICE ver.
// Yoksa varsayılan (STUN + public TURN röle) — kapatmak için TURKUAZ_NO_DEFAULT_TURN=1.
let iceServers = null
try {
  const raw = process.env.TURKUAZ_ICE || (fs.existsSync(path.join(DATA, 'ice.json')) && fs.readFileSync(path.join(DATA, 'ice.json'), 'utf8'))
  if (raw) {
    const parsed = JSON.parse(raw)
    iceServers = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.iceServers) ? parsed.iceServers : null)
  }
} catch (e) { console.error('ice.json okunamadı:', e.message) }
if (iceServers) console.log('Özel ICE sunucuları aktif (' + iceServers.length + ' kayıt)')
else if (!process.env.TURKUAZ_NO_DEFAULT_TURN) { iceServers = DEFAULT_ICE; console.log('Varsayılan ICE (STUN + public TURN röle) aktif') }
else { iceServers = []; console.log('TURN devre dışı (yalnızca doğrudan bağlantı)') }

const store = new Store(DATA)
const core = createCore({
  store,
  bootstrap: BOOTSTRAP,
  iceServers,
  version: require('./package.json').version,
  log: console.log,
  exit: (code) => process.exit(code)
})

// ---- web arayüzü (sadece localhost) ----
const app = express()
app.use(express.static(path.join(__dirname, 'public')))
app.get('/files/:fid', (req, res) => {
  const meta = core.filesIdx()[req.params.fid]
  if (!meta || !/^[0-9a-f-]{36}$/.test(req.params.fid)) return res.status(404).end()
  res.setHeader('Content-Type', meta.mime)
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.fname) + '"')
  res.sendFile(store.filePath(req.params.fid))
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 })
const clients = new Set()

// çekirdekten gelen her yayını bağlı tüm arayüzlere ilet
core.onUI((obj) => {
  const s = JSON.stringify(obj)
  for (const c of clients) { try { c.send(s) } catch {} }
})

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  const reply = (obj) => { try { ws.send(JSON.stringify(obj)) } catch {} }
  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(data.toString()) } catch { return }
    core.handleUI(m, reply)
  })
  ws.send(JSON.stringify(core.stateObj()))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('Turkuaz hazır    →  http://localhost:' + PORT)
  console.log('Arkadaş kodun    →  ' + core.myCode)
  console.log('Veri klasörü     →  ' + DATA)
})

process.on('SIGINT', async () => {
  console.log('\nkapanıyor...')
  await core.destroy()
  process.exit(0)
})
