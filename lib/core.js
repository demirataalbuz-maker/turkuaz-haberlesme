// Turkuaz ortak çekirdeği — masaüstü (server.js) ve mobil (mobile/backend/backend.mjs)
// AYNI mantığı buradan kullanır. Bu dosya taşıma (HTTP/WebSocket/BareKit-IPC)
// bilmez: arayüze giden her şey onUI ile dışarı verilir, arayüzden gelen her
// aksiyon handleUI(msg, reply) ile içeri alınır.
//
// Çalışma ortamı: Node/Electron VE Bare. O yüzden burada node:crypto/fs/path
// YOK — rastgelelik hypercore-crypto'dan, disk erişimi Store üzerinden.
const hcrypto = require('hypercore-crypto')
const { P2P, dmTopic, inboxTopic, roomTopic } = require('./p2p')

const MAX_FILE = 8 * 1024 * 1024 // 8 MB
const CHUNK = 48 * 1024

// Varsayılan ICE: çoklu STUN + ücretsiz public TURN röle (ayrıntı: server.js geçmişi).
const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
]

// node:crypto.randomUUID muadili (Bare'de node:crypto yok)
function uuid () {
  const b = hcrypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
}

/**
 * @param {object} opts
 * @param {Store}  opts.store       lib/store.js örneği (fs'i taşıyan taraf kurar)
 * @param {Array=} opts.bootstrap   DHT bootstrap listesi (test için)
 * @param {Array=} opts.iceServers  null/undefined → DEFAULT_ICE; [] → kapalı
 * @param {Function=} opts.log      log(...)
 * @param {Function=} opts.exit     import sonrası yeniden başlatma için
 */
function createCore ({ store, bootstrap, iceServers, version = '', log = () => {}, exit = () => {} } = {}) {
  let identity = store.loadIdentity()
  if (!identity) {
    identity = { name: '', avatar: '', status: '', seed: hcrypto.randomBytes(32).toString('hex') }
    store.saveIdentity(identity)
  }

  let friends = store.loadFriends()   // { code, name, avatar, status: pending-out|friend }
  let requests = store.loadRequests()
  let rooms = store.loadRooms()       // { code, name, topic, owner?, channels:[], mod? }
  let outbox = store.loadOutbox()     // code -> [wire items], her item.ack ile onaylanır
  let filesIdx = store.loadFiles()    // fid -> { fname, mime, size }
  let blocked = store.loadBlocked()

  for (const r of rooms) if (!r.channels) r.channels = ['genel']

  const ice = (iceServers === undefined || iceServers === null) ? DEFAULT_ICE : (iceServers.length ? iceServers : null)

  const seen = new Map()
  function seenSet (conv) {
    if (!seen.has(conv)) seen.set(conv, store.messageIds(conv))
    return seen.get(conv)
  }

  const p2p = new P2P({ seed: identity.seed, bootstrap })
  const myCode = p2p.publicKey

  function friendOf (code) { return friends.find(f => f.code === code) }
  function isBlocked (code) { return blocked.includes(code) }
  function roomOf (topic) { return rooms.find(r => r.topic === topic) }
  function isBanned (room, code) {
    return !!(room.mod && room.mod.banned.includes(code) && code !== room.owner)
  }

  function refreshHello () {
    p2p.announce({
      name: identity.name,
      avatar: identity.avatar,
      status: identity.status,
      friends: friends.map(f => f.code),
      rooms: rooms.map(r => r.topic)
    })
  }

  refreshHello()
  p2p.join(inboxTopic(myCode))
  for (const f of friends) {
    p2p.join(dmTopic(myCode, f.code))
    p2p.joinPeer(f.code)
    if (f.status === 'pending-out') p2p.joinClient(inboxTopic(f.code))
  }
  for (const r of rooms) p2p.join(Buffer.from(r.topic, 'hex'))

  // ---- arayüz yayını ----
  const uiListeners = new Set()
  function onUI (fn) { uiListeners.add(fn); return () => uiListeners.delete(fn) }
  function broadcast (obj) { for (const fn of uiListeners) { try { fn(obj) } catch {} } }
  function pushState () { broadcast(stateObj()) }
  function emitMsg (conv, msg) { broadcast({ t: 'msg', conv, msg }) }
  function notifyUI (title, body, conv) { broadcast({ t: 'notify', title, body, conv }) }

  // ---- dosya transferi (parça parça) ----
  const incoming = new Map() // fid -> { parts: [], n, got, ts }
  const MAX_CHUNKS = Math.ceil(MAX_FILE / CHUNK) + 1
  // Yarım kalan transferler bellekte sonsuza dek kalmasın: kötü niyetli bir
  // peer sahte fchunk'larla belleği şişiremesin diye 2 dk'da süpürülür.
  const incomingSweep = setInterval(() => {
    const now = Date.now()
    for (const [fid, inc] of incoming) {
      if (now - (inc.ts || 0) > 2 * 60 * 1000) incoming.delete(fid)
    }
  }, 30 * 1000)
  if (incomingSweep.unref) incomingSweep.unref()

  function sendFileChunks (peer, fid) {
    const buf = store.readFileBlob(fid)
    if (!buf) return false
    const n = Math.ceil(buf.length / CHUNK) || 1
    for (let i = 0; i < n; i++) {
      p2p.sendToPeer(peer, { t: 'fchunk', fid, i, n, data: buf.slice(i * CHUNK, (i + 1) * CHUNK).toString('base64') })
    }
    return true
  }

  function saveIncomingFile (fid, meta) {
    const inc = incoming.get(fid)
    if (!inc || inc.got !== inc.n) return false
    const buf = Buffer.concat(inc.parts.map(p => Buffer.from(p, 'base64')))
    incoming.delete(fid)
    if (buf.length > MAX_FILE) return false
    store.writeFileBlob(fid, buf)
    filesIdx[fid] = { fname: meta.fname, mime: meta.mime, size: buf.length }
    store.saveFiles(filesIdx)
    return true
  }

  // ---- oda geçmişi senkronu ----
  const histAsked = new Set()

  // ---- P2P olayları ----
  p2p.on('peer-open', (peer) => {
    const f = friendOf(peer)
    if (f && f.status === 'pending-out') {
      p2p.sendToPeer(peer, { t: 'friend-request', name: identity.name, avatar: identity.avatar })
    }
    if (f) flushOutbox(peer)
    pushState()
  })

  p2p.on('peer-close', () => pushState())

  p2p.on('hello', (peer, info) => {
    const f = friendOf(peer)
    if (f) {
      if (info.name) f.name = info.name
      f.avatar = info.avatar || f.avatar
      f.statusText = info.status || ''
      if (f.status === 'pending-out' && info.friend) f.status = 'friend'
      store.saveFriends(friends)
      flushOutbox(peer)
    }
    for (const r of rooms) {
      if (info.rooms.has(r.topic) && !histAsked.has(r.topic) && !isBanned(r, peer)) {
        histAsked.add(r.topic)
        p2p.sendToPeer(peer, { t: 'hist-req', room: r.topic, n: 400 })
      }
    }
    pushState()
  })

  p2p.on('message', (peer, msg) => {
    if (isBlocked(peer)) return // engellenen kişiden hiçbir şey kabul etme
    switch (msg.t) {
      case 'friend-request': {
        const f = friendOf(peer)
        if (f) {
          if (f.status !== 'friend') { f.status = 'friend'; store.saveFriends(friends) }
          p2p.sendToPeer(peer, { t: 'friend-accept', name: identity.name, avatar: identity.avatar })
        } else if (!requests.find(r => r.code === peer)) {
          requests.push({ code: peer, name: String(msg.name || '').slice(0, 64), avatar: String(msg.avatar || '').slice(0, 8), ts: Date.now() })
          store.saveRequests(requests)
          notifyUI('İstek', (msg.name || 'Biri') + ' arkadaşlık isteği gönderdi')
        }
        pushState()
        break
      }
      case 'friend-accept': {
        const f = friendOf(peer)
        if (f && f.status === 'pending-out') {
          f.status = 'friend'
          if (msg.name) f.name = String(msg.name).slice(0, 64)
          store.saveFriends(friends)
          flushOutbox(peer)
          pushState()
        }
        break
      }
      case 'group-invite': {
        const f = friendOf(peer)
        if (!f || typeof msg.invite !== 'string') return
        if (typeof msg.ack === 'string') p2p.sendToPeer(peer, { t: 'ack', id: msg.ack })
        joinRoomByCode(msg.invite, String(msg.name || 'grup').slice(0, 64))
        notifyUI('Grup', (f.name || 'Biri') + ' seni "' + String(msg.name || 'grup').slice(0, 40) + '" grubuna ekledi')
        break
      }
      case 'dm': {
        const f = friendOf(peer)
        if (!f || typeof msg.id !== 'string') return
        const conv = 'dm-' + peer
        p2p.sendToPeer(peer, { t: 'ack', id: msg.id })
        if (seenSet(conv).has(msg.id)) return
        const rec = {
          id: msg.id, from: peer, name: f.name || 'anon',
          text: typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '',
          ts: Number(msg.ts) || Date.now()
        }
        const dre = sanitizeRe(msg.re)
        if (dre) rec.re = dre
        store.appendMessage(conv, rec)
        seenSet(conv).add(msg.id)
        emitMsg(conv, foldOne(conv, rec))
        notifyUI(f.name || 'Mesaj', rec.text.slice(0, 120), conv)
        break
      }
      case 'dm-log': {
        const f = friendOf(peer)
        const ev = msg.ev
        if (!f || !ev || typeof ev.evId !== 'string' || ev.from !== peer) return
        const conv = 'dm-' + peer
        p2p.sendToPeer(peer, { t: 'ack', id: ev.evId })
        if (seenSet(conv).has(ev.evId)) return
        appendEvent(conv, ev)
        break
      }
      case 'dm-file': {
        const f = friendOf(peer)
        if (!f || typeof msg.id !== 'string' || typeof msg.fid !== 'string') return
        const conv = 'dm-' + peer
        if (seenSet(conv).has(msg.id)) { p2p.sendToPeer(peer, { t: 'ack', id: msg.id }); return }
        const meta = { fname: String(msg.fname || 'dosya').slice(0, 200), mime: String(msg.mime || 'application/octet-stream').slice(0, 100) }
        if (!saveIncomingFile(msg.fid, meta)) { p2p.sendToPeer(peer, { t: 'file-req', fid: msg.fid }); return }
        p2p.sendToPeer(peer, { t: 'ack', id: msg.id })
        const rec = {
          id: msg.id, from: peer, name: f.name || 'anon', text: '',
          file: { fid: msg.fid, ...meta, size: filesIdx[msg.fid].size },
          ts: Number(msg.ts) || Date.now()
        }
        store.appendMessage(conv, rec)
        seenSet(conv).add(msg.id)
        emitMsg(conv, foldOne(conv, rec))
        notifyUI(f.name || 'Dosya', '📎 ' + meta.fname, conv)
        break
      }
      case 'fchunk': {
        if (typeof msg.fid !== 'string' || typeof msg.data !== 'string') return
        const n = Number(msg.n)
        if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNKS) return // parça sayısı dosya limitiyle sınırlı
        let inc = incoming.get(msg.fid)
        if (!inc) {
          if (incoming.size >= 64) return // aynı anda en fazla 64 yarım transfer
          inc = { parts: [], n, got: 0, ts: Date.now() }
          incoming.set(msg.fid, inc)
        }
        inc.ts = Date.now()
        if (Number.isInteger(msg.i) && msg.i >= 0 && inc.parts[msg.i] === undefined && msg.i < inc.n && msg.data.length <= CHUNK * 2) {
          inc.parts[msg.i] = msg.data
          inc.got++
        }
        break
      }
      case 'file-req': {
        if (typeof msg.fid !== 'string' || !filesIdx[msg.fid]) return
        sendFileChunks(peer, msg.fid)
        p2p.sendToPeer(peer, { t: 'file-fin', fid: msg.fid, ...filesIdx[msg.fid] })
        break
      }
      case 'file-fin': {
        if (typeof msg.fid !== 'string') return
        if (saveIncomingFile(msg.fid, { fname: msg.fname, mime: msg.mime })) {
          broadcast({ t: 'file-ready', fid: msg.fid })
        }
        break
      }
      case 'room': {
        if (typeof msg.room !== 'string' || typeof msg.id !== 'string' || typeof msg.text !== 'string') return
        const r = roomOf(msg.room)
        if (!r || !p2p.peerInRoom(peer, msg.room) || isBanned(r, peer)) return
        const conv = 'room-' + msg.room
        if (seenSet(conv).has(msg.id)) return
        const ch = normCh(msg.ch)
        learnChannel(r, ch)
        const rec = {
          id: msg.id, from: peer, name: String(msg.name || 'anon').slice(0, 64),
          text: msg.text.slice(0, 4000), ch, ts: Number(msg.ts) || Date.now()
        }
        const rre = sanitizeRe(msg.re)
        if (rre) rec.re = rre
        store.appendMessage(conv, rec)
        seenSet(conv).add(msg.id)
        emitMsg(conv, foldOne(conv, rec))
        notifyUI('#' + r.name, rec.name + ': ' + rec.text.slice(0, 100), conv)
        break
      }
      case 'room-log': {
        const ev = msg.ev
        if (typeof msg.room !== 'string' || !ev || typeof ev.evId !== 'string' || ev.from !== peer) return
        const r = roomOf(msg.room)
        if (!r || !p2p.peerInRoom(peer, msg.room) || isBanned(r, peer)) return
        const conv = 'room-' + msg.room
        if (seenSet(conv).has(ev.evId)) return
        appendEvent(conv, ev)
        break
      }
      case 'room-file': {
        if (typeof msg.room !== 'string' || typeof msg.id !== 'string' || typeof msg.fid !== 'string') return
        const r = roomOf(msg.room)
        if (!r || !p2p.peerInRoom(peer, msg.room) || isBanned(r, peer)) return
        const conv = 'room-' + msg.room
        if (seenSet(conv).has(msg.id)) return
        const meta = { fname: String(msg.fname || 'dosya').slice(0, 200), mime: String(msg.mime || 'application/octet-stream').slice(0, 100) }
        if (!saveIncomingFile(msg.fid, meta)) { p2p.sendToPeer(peer, { t: 'file-req', fid: msg.fid }) }
        const ch = normCh(msg.ch)
        learnChannel(r, ch)
        const rec = {
          id: msg.id, from: peer, name: String(msg.name || 'anon').slice(0, 64), text: '', ch,
          file: { fid: msg.fid, ...meta, size: Number(msg.size) || 0 },
          ts: Number(msg.ts) || Date.now()
        }
        store.appendMessage(conv, rec)
        seenSet(conv).add(msg.id)
        emitMsg(conv, foldOne(conv, rec))
        break
      }
      case 'hist-req': {
        const r = roomOf(msg.room)
        if (!r || !p2p.peerInRoom(peer, msg.room) || isBanned(r, peer)) return
        if (r.mod) p2p.sendToPeer(peer, { t: 'mod', room: r.topic, banned: r.mod.banned, ts: r.mod.ts, sig: r.mod.sig })
        const lines = store.loadMessages('room-' + msg.room, Math.min(Number(msg.n) || 400, 1000))
        p2p.sendToPeer(peer, { t: 'hist-res', room: msg.room, lines })
        break
      }
      case 'hist-res': {
        const r = roomOf(msg.room)
        if (!r || !Array.isArray(msg.lines)) return
        const conv = 'room-' + msg.room
        let added = 0
        for (const l of msg.lines.slice(0, 1000)) {
          if (!l || typeof l !== 'object') continue
          const key = l.evId || l.id
          if (typeof key !== 'string' || seenSet(conv).has(key)) continue
          if (typeof l.from !== 'string' || isBanned(r, l.from)) continue
          if (l.ch) learnChannel(r, normCh(l.ch))
          store.appendMessage(conv, l)
          seenSet(conv).add(key)
          added++
        }
        if (added) broadcast({ t: 'history', conv, msgs: store.loadFolded(conv) })
        break
      }
      case 'mod': {
        const r = roomOf(msg.room)
        if (!r || !r.owner || !Array.isArray(msg.banned) || typeof msg.sig !== 'string') return
        if (r.mod && !(Number(msg.ts) > r.mod.ts)) return
        const banned = msg.banned.filter(b => /^[0-9a-f]{64}$/.test(b)).sort()
        const payload = Buffer.from(JSON.stringify({ room: r.topic, banned, ts: Number(msg.ts) }))
        let ok = false
        try { ok = hcrypto.verify(payload, Buffer.from(msg.sig, 'hex'), Buffer.from(r.owner, 'hex')) } catch {}
        if (!ok) return
        r.mod = { banned, ts: Number(msg.ts), sig: msg.sig }
        store.saveRooms(rooms)
        pushState()
        break
      }
      case 'typing': {
        const f = friendOf(peer)
        if (f) broadcast({ t: 'typing', conv: 'dm-' + peer, name: f.name || 'anon' })
        break
      }
      case 'rtc': {
        const shared = !!friendOf(peer) || rooms.some(r => p2p.peerInRoom(peer, r.topic) && !isBanned(r, peer))
        if (!shared || msg.data === undefined) return
        broadcast({ t: 'rtc', from: peer, data: msg.data })
        break
      }
      case 'room-ev': {
        if (typeof msg.room !== 'string' || !msg.ev || typeof msg.ev !== 'object') return
        const r = roomOf(msg.room)
        if (!r || !p2p.peerInRoom(peer, msg.room) || isBanned(r, peer)) return
        broadcast({ t: 'room-ev', room: msg.room, from: peer, name: p2p.peerName(peer) || 'anon', ev: msg.ev })
        break
      }
      case 'ack': {
        const q = outbox[peer]
        if (!q) return
        const before = q.length
        outbox[peer] = q.filter(m => m.ack !== msg.id)
        if (outbox[peer].length !== before) {
          store.saveOutbox(outbox)
          pushState() // önce güncel state (pending listesi) gitsin, sonra 'delivered'
          broadcast({ t: 'delivered', conv: 'dm-' + peer, id: msg.id })
        }
        break
      }
    }
  })

  // ---- yardımcılar ----
  function normCh (ch) {
    return String(ch || 'genel').toLowerCase().replace(/[^a-z0-9ğüşöçı_-]/g, '').slice(0, 24) || 'genel'
  }

  function sanitizeRe (re) {
    if (!re || typeof re !== 'object' || typeof re.id !== 'string') return undefined
    return { id: re.id.slice(0, 64), name: String(re.name || '').slice(0, 64), text: String(re.text || '').slice(0, 140) }
  }

  function learnChannel (r, ch) {
    if (!r.channels.includes(ch)) { r.channels.push(ch); store.saveRooms(rooms); pushState() }
  }

  function foldOne (conv, rec) { return { ...rec, reacts: {} } }

  function appendEvent (conv, ev) {
    const clean = {
      ev: ev.ev, evId: ev.evId, id: String(ev.id || ''), from: ev.from,
      name: String(ev.name || '').slice(0, 64), ts: Number(ev.ts) || Date.now()
    }
    if (ev.ev === 'react') clean.emoji = String(ev.emoji || '').slice(0, 8)
    if (ev.ev === 'edit') clean.text = String(ev.text || '').slice(0, 4000)
    if (!['react', 'edit', 'del', 'pin'].includes(clean.ev)) return
    store.appendMessage(conv, clean)
    seenSet(conv).add(clean.evId)
    broadcast({ t: 'msg-ev', conv, ev: clean })
  }

  function flushOutbox (code) {
    const q = outbox[code]
    if (!q || !q.length || !p2p.isOnline(code)) return
    for (const m of q) {
      if (m.t === 'dm-file') sendFileChunks(code, m.fid)
      p2p.sendToPeer(code, m)
    }
  }

  function queueDM (code, item) {
    if (!outbox[code]) outbox[code] = []
    outbox[code].push(item)
    store.saveOutbox(outbox)
    flushOutbox(code)
  }

  // ---- eylemler (arayüzden gelen) ----
  function addFriend (code) {
    code = String(code || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(code) || code === myCode || friendOf(code)) return
    const req = requests.find(r => r.code === code)
    if (req) return acceptRequest(code)
    friends.push({ code, name: '', avatar: '', status: 'pending-out' })
    store.saveFriends(friends)
    p2p.join(dmTopic(myCode, code))
    p2p.joinPeer(code)
    p2p.joinClient(inboxTopic(code))
    refreshHello()
    if (p2p.isOnline(code)) p2p.sendToPeer(code, { t: 'friend-request', name: identity.name, avatar: identity.avatar })
    pushState()
  }

  function acceptRequest (code) {
    const req = requests.find(r => r.code === code)
    if (!req) return
    requests = requests.filter(r => r.code !== code)
    store.saveRequests(requests)
    if (!friendOf(code)) {
      friends.push({ code, name: req.name, avatar: req.avatar || '', status: 'friend' })
      store.saveFriends(friends)
    }
    p2p.join(dmTopic(myCode, code))
    p2p.joinPeer(code)
    refreshHello()
    p2p.sendToPeer(code, { t: 'friend-accept', name: identity.name, avatar: identity.avatar })
    pushState()
  }

  function rejectRequest (code) {
    requests = requests.filter(r => r.code !== code)
    store.saveRequests(requests)
    pushState()
  }

  function blockUser (code) {
    code = String(code || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(code) || code === myCode) return
    if (!blocked.includes(code)) { blocked.push(code); store.saveBlocked(blocked) }
    requests = requests.filter(r => r.code !== code)
    store.saveRequests(requests)
    pushState()
  }
  function unblockUser (code) {
    blocked = blocked.filter(c => c !== code)
    store.saveBlocked(blocked)
    pushState()
  }

  function sendDM (code, text, re) {
    const f = friendOf(code)
    text = String(text || '').slice(0, 4000)
    if (!f || !text.trim()) return
    const id = uuid()
    const conv = 'dm-' + code
    re = sanitizeRe(re)
    const rec = { id, from: myCode, name: identity.name, text, ts: Date.now() }
    if (re) rec.re = re
    store.appendMessage(conv, rec)
    seenSet(conv).add(id)
    emitMsg(conv, foldOne(conv, rec))
    queueDM(code, { t: 'dm', id, ack: id, text, ts: rec.ts, re })
    pushState()
  }

  function sendFile (target, fname, mime, dataB64) {
    let buf
    try { buf = Buffer.from(String(dataB64), 'base64') } catch { return }
    if (!buf || !buf.length || buf.length > MAX_FILE) return
    const fid = uuid()
    store.writeFileBlob(fid, buf)
    fname = String(fname || 'dosya').slice(0, 200)
    mime = String(mime || 'application/octet-stream').slice(0, 100)
    filesIdx[fid] = { fname, mime, size: buf.length }
    store.saveFiles(filesIdx)
    const id = uuid()
    const ts = Date.now()
    const fileMeta = { fid, fname, mime, size: buf.length }

    if (target.code) { // DM
      const f = friendOf(target.code)
      if (!f) return
      const conv = 'dm-' + target.code
      const rec = { id, from: myCode, name: identity.name, text: '', file: fileMeta, ts }
      store.appendMessage(conv, rec)
      seenSet(conv).add(id)
      emitMsg(conv, foldOne(conv, rec))
      queueDM(target.code, { t: 'dm-file', id, ack: id, fid, fname, mime, ts })
    } else if (target.room) { // oda
      const r = roomOf(target.room)
      if (!r) return
      const ch = normCh(target.ch)
      const conv = 'room-' + target.room
      const rec = { id, from: myCode, name: identity.name, text: '', ch, file: fileMeta, ts }
      store.appendMessage(conv, rec)
      seenSet(conv).add(id)
      emitMsg(conv, foldOne(conv, rec))
      for (const peerHex of p2p.roomPeers(target.room)) {
        if (isBanned(r, peerHex)) continue
        sendFileChunks(peerHex, fid)
        p2p.sendToPeer(peerHex, { t: 'room-file', room: target.room, id, fid, fname, mime, size: buf.length, ch, name: identity.name, ts })
      }
    }
    pushState()
  }

  function sendEvent (conv, ev) { // react / edit / del / pin
    ev.evId = uuid()
    ev.from = myCode
    ev.name = identity.name
    ev.ts = Date.now()
    if (conv.startsWith('dm-')) {
      const code = conv.slice(3)
      if (!friendOf(code)) return
      appendEvent(conv, ev)
      queueDM(code, { t: 'dm-log', ack: ev.evId, ev })
    } else if (conv.startsWith('room-')) {
      const topic = conv.slice(5)
      if (!roomOf(topic)) return
      appendEvent(conv, ev)
      p2p.broadcastRoom(topic, { t: 'room-log', room: topic, ev })
    }
  }

  function joinRoomByCode (invite, name) {
    invite = String(invite || '').trim()
    const [code, owner] = invite.split('~')
    if (!/^[0-9a-f]{16,64}$/.test(code)) return
    if (owner && !/^[0-9a-f]{64}$/.test(owner)) return
    const topic = roomTopic(code).toString('hex')
    if (roomOf(topic)) return
    rooms.push({
      code,
      name: String(name || '').slice(0, 64) || 'oda-' + code.slice(0, 6),
      topic,
      owner: owner || undefined,
      channels: ['genel']
    })
    store.saveRooms(rooms)
    p2p.join(Buffer.from(topic, 'hex'))
    refreshHello()
    pushState()
  }

  function createRoom (name) {
    const code = hcrypto.randomBytes(16).toString('hex')
    joinRoomByCode(code + '~' + myCode, name)
  }

  function createGroup (name, memberCodes) {
    const code = hcrypto.randomBytes(16).toString('hex')
    const invite = code + '~' + myCode
    joinRoomByCode(invite, name)
    for (const mc of Array.isArray(memberCodes) ? memberCodes : []) {
      if (!friendOf(mc)) continue
      queueDM(mc, { t: 'group-invite', invite, name: String(name || 'grup').slice(0, 64), ack: uuid() })
    }
  }

  function leaveRoom (topic) {
    const r = roomOf(topic)
    if (!r) return
    rooms = rooms.filter(x => x.topic !== topic)
    store.saveRooms(rooms)
    p2p.leave(Buffer.from(topic, 'hex'))
    refreshHello()
    pushState()
  }

  function sendRoom (topic, ch, text, re) {
    const r = roomOf(topic)
    text = String(text || '').slice(0, 4000)
    if (!r || !text.trim()) return
    ch = normCh(ch)
    learnChannel(r, ch)
    const conv = 'room-' + topic
    const id = uuid()
    re = sanitizeRe(re)
    const rec = { id, from: myCode, name: identity.name, text, ch, ts: Date.now() }
    if (re) rec.re = re
    store.appendMessage(conv, rec)
    seenSet(conv).add(id)
    emitMsg(conv, foldOne(conv, rec))
    p2p.broadcastRoom(topic, { t: 'room', room: topic, id, name: identity.name, text, ch, ts: rec.ts, re })
  }

  function setBan (topic, code, on) {
    const r = roomOf(topic)
    if (!r || r.owner !== myCode || code === myCode) return
    const banned = new Set(r.mod ? r.mod.banned : [])
    if (on) banned.add(code); else banned.delete(code)
    const list = [...banned].sort()
    const ts = Date.now()
    const payload = Buffer.from(JSON.stringify({ room: topic, banned: list, ts }))
    const sig = hcrypto.sign(payload, p2p.keyPair.secretKey).toString('hex')
    r.mod = { banned: list, ts, sig }
    store.saveRooms(rooms)
    p2p.broadcastRoom(topic, { t: 'mod', room: topic, banned: list, ts, sig })
    pushState()
  }

  function search (q) {
    q = String(q || '').toLocaleLowerCase('tr').trim()
    if (q.length < 2) return []
    const out = []
    for (const conv of store.listConvs()) {
      for (const m of store.loadFolded(conv, 10000)) {
        if (m.deleted) continue
        const hay = (m.text + ' ' + (m.file ? m.file.fname : '')).toLocaleLowerCase('tr')
        if (hay.includes(q)) out.push({ conv, msg: m })
        if (out.length >= 50) return out
      }
    }
    return out
  }

  // ---- arayüz durumu ----
  function stateObj () {
    return {
      t: 'state',
      me: { name: identity.name, code: myCode, avatar: identity.avatar, status: identity.status },
      friends: friends.map(f => ({
        code: f.code, name: f.name, avatar: f.avatar || '', statusText: f.statusText || '',
        status: f.status, online: p2p.isOnline(f.code)
      })),
      requests,
      rooms: rooms.map(r => ({
        code: r.code, name: r.name, topic: r.topic,
        invite: r.code + (r.owner ? '~' + r.owner : ''),
        owner: r.owner || null, isOwner: r.owner === myCode,
        channels: r.channels, banned: r.mod ? r.mod.banned : [],
        online: p2p.roomPeerCount(r.topic),
        members: p2p.roomPeers(r.topic).map(code => ({ code, name: p2p.peerName(code) || 'anon' }))
      })),
      blocked,
      pending: Object.fromEntries(Object.entries(outbox).map(([k, v]) => [k, v.map(m => m.ack)])),
      ice: ice || undefined,
      version: version || undefined
    }
  }

  // ---- arayüz aksiyonları ----
  // reply: yalnızca isteği yapan istemciye yanıt (masaüstünde o ws; mobilde broadcast'la aynı)
  function handleUI (m, reply = broadcast) {
    switch (m.t) {
      case '__ready': reply(stateObj()); break
      case 'set-profile':
        if (m.name !== undefined) identity.name = String(m.name || '').trim().slice(0, 64)
        if (m.avatar !== undefined) identity.avatar = String(m.avatar || '').slice(0, 8)
        if (m.status !== undefined) identity.status = String(m.status || '').slice(0, 100)
        store.saveIdentity(identity)
        refreshHello()
        pushState()
        break
      case 'add-friend': addFriend(m.code); break
      case 'accept-request': acceptRequest(m.code); break
      case 'reject-request': rejectRequest(m.code); break
      case 'block': blockUser(m.code); break
      case 'unblock': unblockUser(m.code); break
      case 'create-room': createRoom(m.name); break
      case 'create-group': createGroup(m.name, m.members); break
      case 'join-room': joinRoomByCode(m.code, m.name); break
      case 'leave-room': leaveRoom(m.topic); break
      case 'send-dm': sendDM(m.code, m.text, m.re); break
      case 'send-room': sendRoom(m.topic, m.ch, m.text, m.re); break
      case 'send-file':
        if (m.code) sendFile({ code: m.code }, m.fname, m.mime, m.data)
        else if (m.room) sendFile({ room: m.room, ch: m.ch }, m.fname, m.mime, m.data)
        break
      case 'react':
        if (typeof m.conv === 'string' && typeof m.msgId === 'string') {
          sendEvent(m.conv, { ev: 'react', id: m.msgId, emoji: String(m.emoji || '👍').slice(0, 8) })
        }
        break
      case 'edit':
        if (typeof m.conv === 'string' && typeof m.msgId === 'string') {
          sendEvent(m.conv, { ev: 'edit', id: m.msgId, text: String(m.text || '').slice(0, 4000) })
        }
        break
      case 'del':
        if (typeof m.conv === 'string' && typeof m.msgId === 'string') {
          sendEvent(m.conv, { ev: 'del', id: m.msgId })
        }
        break
      case 'pin':
        if (typeof m.conv === 'string' && typeof m.msgId === 'string') {
          sendEvent(m.conv, { ev: 'pin', id: m.msgId })
        }
        break
      case 'typing':
        if (typeof m.to === 'string') p2p.sendToPeer(m.to, { t: 'typing' })
        break
      case 'call-log': { // arama kaydı: DM geçmişine YEREL not (karşıya gitmez, iki taraf kendi kaydını düşer)
        if (typeof m.code !== 'string' || !friendOf(m.code)) break
        const conv = 'dm-' + m.code
        const rec = { id: uuid(), from: myCode, name: identity.name, text: String(m.text || '').slice(0, 200), call: true, ts: Date.now() }
        store.appendMessage(conv, rec)
        seenSet(conv).add(rec.id)
        emitMsg(conv, foldOne(conv, rec))
        break
      }
      case 'ban': setBan(m.room, m.code, m.on !== false); break
      case 'add-channel': {
        const r = roomOf(m.room)
        if (r) learnChannel(r, normCh(m.ch))
        break
      }
      case 'rtc':
        if (typeof m.to === 'string' && m.data !== undefined) {
          p2p.sendToPeer(m.to, { t: 'rtc', data: m.data })
        }
        break
      case 'room-ev':
        if (typeof m.room === 'string' && roomOf(m.room) && m.ev) {
          p2p.broadcastRoom(m.room, { t: 'room-ev', room: m.room, ev: m.ev })
        }
        break
      case 'fetch-file':
        if (typeof m.fid === 'string' && typeof m.from === 'string') {
          const target = p2p.isOnline(m.from) ? m.from
            : (m.conv || '').startsWith('room-') ? p2p.roomPeers((m.conv || '').slice(5))[0] : null
          if (target) p2p.sendToPeer(target, { t: 'file-req', fid: m.fid })
        }
        break
      case 'file-data': { // mobil: dosya içeriğini data-URL olarak iste (HTTP yok)
        const meta = typeof m.fid === 'string' && /^[0-9a-f-]{36}$/.test(m.fid) ? filesIdx[m.fid] : null
        const buf = meta ? store.readFileBlob(m.fid) : null
        reply({ t: 'file-data', fid: m.fid, ok: !!buf, mime: meta ? meta.mime : '', data: buf ? buf.toString('base64') : '' })
        break
      }
      case 'search':
        reply({ t: 'search-res', q: m.q, results: search(m.q) })
        break
      case 'export':
        reply({ t: 'export-res', data: { turkuaz: 1, identity, friends, rooms } })
        break
      case 'import': {
        const d = m.data
        if (!d || d.turkuaz !== 1 || !d.identity || !/^[0-9a-f]{64}$/.test(d.identity.seed)) {
          reply({ t: 'import-res', ok: false })
          break
        }
        store.saveIdentity(d.identity)
        store.saveFriends(Array.isArray(d.friends) ? d.friends : [])
        store.saveRooms(Array.isArray(d.rooms) ? d.rooms : [])
        reply({ t: 'import-res', ok: true })
        setTimeout(() => exit(0), 800) // temiz kimlikle yeniden başlasın
        break
      }
      case 'history':
        if (typeof m.conv === 'string' && /^(dm|room)-[0-9a-f]+$/.test(m.conv)) {
          reply({ t: 'history', conv: m.conv, msgs: store.loadFolded(m.conv) })
        }
        break
    }
  }

  return {
    myCode,
    p2p,
    store,
    filesIdx: () => filesIdx,
    stateObj,
    handleUI,
    onUI,
    destroy: () => { clearInterval(incomingSweep); return p2p.destroy() }
  }
}

module.exports = { createCore, DEFAULT_ICE, uuid }
