// Turkuaz — serversız P2P sohbet uygulaması (masaüstü giriş noktası).
// Bu process her kullanıcının KENDİ makinesinde çalışır:
//  - localhost'ta arayüzü sunar (Express + WebSocket)
//  - Tüm P2P/mesajlaşma mantığı lib/core.js'te (mobil de aynı çekirdeği kullanır)
const path = require('path')
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const { WebSocketServer } = require('ws')
const Store = require('./lib/store')
const vaultLib = require('./lib/vault')
const { createCore, DEFAULT_ICE } = require('./lib/core')
const { safeFetch } = require('./lib/urlguard')

// Son savunma hattı: yakalanmamış hata/reddetme uygulamayı ÖLDÜRMESİN — mesaj
// işleme ve disk yazma zaten sınırda try/catch ile korunuyor, bu ağ güvenliği.
process.on('uncaughtException', (e) => { console.error('yakalanmamış istisna:', (e && (e.stack || e.message)) || e) })
process.on('unhandledRejection', (e) => { console.error('ele alınmamış reddetme:', (e && (e.stack || e.message)) || e) })

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
// Kasa (disk şifreleme) kuruluysa çekirdek, doğru parola gelene kadar
// BAŞLATILMAZ: kimlik/mesajlar diskte şifreli, anahtar yok. Arayüz kilit
// ekranı gösterir; {t:'unlock'} doğrulanınca startCore() çalışır.
let core = null
function startCore () {
  core = createCore({
    store,
    bootstrap: BOOTSTRAP,
    iceServers,
    version: require('./package.json').version,
    log: console.log,
    exit: (code) => process.exit(code)
  })
  // çekirdekten gelen her yayını bağlı tüm arayüzlere ilet
  core.onUI((obj) => {
    const s = JSON.stringify(obj)
    for (const c of clients) { try { c.send(s) } catch {} }
  })
  console.log('Arkadaş kodun    →  ' + core.myCode)
}

// ---- web arayüzü (sadece localhost) ----
const app = express()
app.use(express.static(path.join(__dirname, 'public')))

// ---- WS oturum token'ı ----
// Origin kontrolü tek başına yetmez: Origin başlığı olmayan istemciler (curl,
// başka bir yerel süreç, WebSocket kütüphaneleri) serbestçe bağlanıp
// {t:'export'} ile kimlik seed'ini çekebilirdi. Her açılışta rastgele bir
// token üretilir; arayüz /token'dan alır, WS el sıkışmasında sunar.
// /token yanıtı CORS başlığı taşımadığından evil.com bu değeri OKUYAMAZ
// (same-origin policy); Sec-Fetch-Site kontrolü de tarayıcı içi cross-site
// istekleri ayrıca keser.
const WS_TOKEN = crypto.randomBytes(32).toString('hex')
function tokenOk (t) {
  const a = Buffer.from(String(t || ''))
  const b = Buffer.from(WS_TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT])
app.get('/token', (req, res) => {
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).end()
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).end()
  res.setHeader('Cache-Control', 'no-store')
  res.type('text/plain').send(WS_TOKEN)
})
// Karşıdan gelen dosyanın MIME'ı gönderenin beyanı — körü körüne güvenilmez.
// Yalnız bilinen zararsız türler tarayıcıda açılır (inline); geri kalan her şey
// (text/html, image/svg+xml dahil — ikisi de script çalıştırabilir) indirme
// olarak iner. nosniff: tarayıcı içeriği koklayıp türü "yükseltemesin".
const INLINE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'application/pdf'
])
app.get('/files/:fid', (req, res) => {
  if (!core) return res.status(404).end() // kasa kilitli
  const meta = core.filesIdx()[req.params.fid]
  if (!meta || !/^[0-9a-f-]{36}$/.test(req.params.fid)) return res.status(404).end()
  // Blob diskte şifreli olabilir → sendFile yerine store üzerinden oku
  // (store anahtar takılıysa şeffaf çözer)
  const buf = store.readFileBlob(req.params.fid)
  if (!buf) return res.status(404).end()
  const inline = INLINE_MIME.has(String(meta.mime || ''))
  res.setHeader('Content-Type', inline ? meta.mime : 'application/octet-stream')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(meta.fname) + '"')
  res.send(buf)
})

// ---- link önizleme ----
// Kartı GÖNDEREN kendi makinesinden üretir (og: etiketleri buradan çekilir) ve
// mesajın içinde yollar; alıcı siteye hiç bağlanmaz — IP'si sızmaz.
const PREV_UA = 'Mozilla/5.0 (X11; Linux x86_64) TurkuazPreview/1.0'
function deent (s) {
  const cp = (n) => (n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) ? String.fromCodePoint(n) : ''
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => cp(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
}
function metaOf (html, ...keys) {
  for (const k of keys) {
    const m = html.match(new RegExp('<meta\\s[^>]*(?:property|name)\\s*=\\s*["\']' + k + '["\'][^>]*>', 'i'))
    const c = m && m[0].match(/content\s*=\s*(["'])([\s\S]*?)\1/i)
    if (c && c[2].trim()) return deent(c[2]).trim()
  }
  return ''
}
async function readBody (r, max) {
  const reader = r.body && r.body.getReader ? r.body.getReader() : null
  if (!reader) return Buffer.alloc(0)
  const parts = []
  let len = 0
  while (len < max) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(Buffer.from(value))
    len += value.length
  }
  try { await reader.cancel() } catch {}
  return Buffer.concat(parts)
}
app.get('/preview', async (req, res) => {
  const fail = () => { try { res.json({ ok: false }) } catch {} }
  try {
    if (typeof fetch !== 'function') return fail()
    const u = new URL(String(req.query.url || ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail()
    const ac = new AbortController()
    const tm = setTimeout(() => ac.abort(), 6000)
    let page, html
    try {
      // safeFetch: her yönlendirme adımında iç ağ/loopback IP'lerini engeller (SSRF)
      const r = await safeFetch(u, { signal: ac.signal, headers: { 'user-agent': PREV_UA, accept: 'text/html,application/xhtml+xml' } })
      page = r.res; page._finalUrl = r.url
      if (!/text\/html|xhtml/.test(String(page.headers.get('content-type') || ''))) return fail()
      html = (await readBody(page, 400 * 1024)).toString('utf8')
    } finally { clearTimeout(tm) }
    const title = metaOf(html, 'og:title', 'twitter:title') || deent((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim()
    const desc = metaOf(html, 'og:description', 'twitter:description', 'description')
    const site = metaOf(html, 'og:site_name') || u.hostname
    if (!title && !desc) return fail()
    let img = ''
    const imgUrl = metaOf(html, 'og:image', 'og:image:url', 'twitter:image')
    if (imgUrl) {
      try {
        const iu = new URL(imgUrl, page._finalUrl || u)
        const ac2 = new AbortController()
        const tm2 = setTimeout(() => ac2.abort(), 6000)
        try {
          const ir = (await safeFetch(iu, { signal: ac2.signal, headers: { 'user-agent': PREV_UA } })).res
          const mime = String(ir.headers.get('content-type') || '').split(';')[0].trim()
          if (/^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) {
            const buf = await readBody(ir, 3 * 1024 * 1024)
            if (buf.length) img = 'data:' + mime + ';base64,' + buf.toString('base64')
          }
        } finally { clearTimeout(tm2) }
      } catch {}
    }
    res.json({ ok: true, url: page._finalUrl || String(u), title: title.slice(0, 200), desc: desc.slice(0, 300), site: site.slice(0, 100), img })
  } catch { fail() }
})

const server = http.createServer(app)
// WS güvenliği, iki katman:
//  1. Origin allowlist — kötü niyetli bir web sayfası (evil.com) tarayıcıdan
//     ws://127.0.0.1:PORT'a bağlanamasın (cross-site WebSocket hijacking).
//     Tarayıcı Origin başlığını JS ile taklit edemez.
//  2. Oturum token'ı — Origin göndermeyen istemciler (curl, yerel süreçler,
//     WS kütüphaneleri) için. Token, Sec-WebSocket-Protocol içinde
//     "turkuaz.tok.<hex>" olarak taşınır (URL'de taşınmaz: query string
//     loglara/geçmişe sızabilir). Token'sız veya yanlış token'lı hiçbir
//     bağlantı kabul edilmez.
const WS_PROTO = 'turkuaz.v1'
const WS_TOK_PREFIX = 'turkuaz.tok.'
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024 * 1024,
  handleProtocols: (protocols) => protocols.has(WS_PROTO) ? WS_PROTO : false,
  verifyClient: (info) => {
    const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin)
    if (origin && !ALLOWED_ORIGINS.has(origin)) return false
    const raw = String((info.req && info.req.headers && info.req.headers['sec-websocket-protocol']) || '')
    const offered = raw.split(',').map(s => s.trim())
    const tok = offered.find(p => p.startsWith(WS_TOK_PREFIX))
    return !!tok && tokenOk(tok.slice(WS_TOK_PREFIX.length))
  }
})
const clients = new Set()

// ---- kilit / parola yönetimi ----
// Bu mesajlar çekirdeğe gitmez; kasa (vault) sunucu katmanının işi.
//  unlock   {pass}        → kasayı aç, çekirdeği başlat
//  set-pass {pass, old}   → kasa kur / parola değiştir / (pass boşsa) kaldır
function handleVaultMsg (m, reply) {
  if (m.t === 'unlock') {
    if (core) return reply({ t: 'unlock-res', ok: true })
    const key = vaultLib.openVault(DATA, String(m.pass || ''))
    if (!key) return reply({ t: 'unlock-res', ok: false })
    store.setKey(key)
    startCore()
    reply({ t: 'unlock-res', ok: true })
    // kilit ekranında bekleyen TÜM pencereler taze state alsın
    const s = JSON.stringify(core.stateObj())
    for (const c of clients) { try { c.send(s) } catch {} }
    return
  }
  if (m.t === 'vault-info') {
    return reply({ t: 'vault-info', protected: vaultLib.hasVault(DATA) })
  }
  if (m.t === 'set-pass') {
    if (!core) return reply({ t: 'pass-res', ok: false, err: 'Önce kilidi aç' })
    const pass = String(m.pass || '')
    try {
      if (vaultLib.hasVault(DATA)) {
        // değişiklik/kaldırma için mevcut parola şart
        const oldKey = vaultLib.openVault(DATA, String(m.old || ''))
        if (!oldKey) return reply({ t: 'pass-res', ok: false, err: 'Mevcut parola yanlış' })
        if (!pass) {
          store.migrate(null)
          vaultLib.removeVault(DATA)
          return reply({ t: 'pass-res', ok: true, protected: false })
        }
        const newKey = vaultLib.createVault(DATA, pass)
        store.migrate(newKey)
        return reply({ t: 'pass-res', ok: true, protected: true })
      }
      if (!pass) return reply({ t: 'pass-res', ok: false, err: 'Parola boş olamaz' })
      if (pass.length < 6) return reply({ t: 'pass-res', ok: false, err: 'Parola en az 6 karakter olmalı' })
      const key = vaultLib.createVault(DATA, pass)
      store.migrate(key)
      return reply({ t: 'pass-res', ok: true, protected: true })
    } catch (e) {
      console.error('set-pass hata:', (e && e.message) || e)
      return reply({ t: 'pass-res', ok: false, err: 'İşlem başarısız' })
    }
  }
  return false // bu mesaj kasa ile ilgili değil
}

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  const reply = (obj) => { try { ws.send(JSON.stringify(obj)) } catch {} }
  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(data.toString()) } catch { return }
    try {
      if (handleVaultMsg(m, reply) !== false) return
      if (!core) return reply({ t: 'locked' }) // kilitliyken çekirdek mesajı yok
      core.handleUI(m, reply)
    } catch (e) { console.error('handleUI hata:', (e && e.message) || e) }
  })
  ws.send(JSON.stringify(core ? core.stateObj() : { t: 'locked' }))
})

// Kasa yoksa hemen başlat; varsa parola bekle (kilit ekranı)
if (!vaultLib.hasVault(DATA)) startCore()
else console.log('Veri kasası kilitli — arayüzden parolayla açılacak')

server.listen(PORT, '127.0.0.1', () => {
  console.log('Turkuaz hazır    →  http://localhost:' + PORT)
  console.log('Veri klasörü     →  ' + DATA)
})

process.on('SIGINT', async () => {
  console.log('\nkapanıyor...')
  if (core) await core.destroy()
  process.exit(0)
})
