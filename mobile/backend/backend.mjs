// Turkuaz mobil P2P çekirdeği — Bare runtime'ında çalışır.
// Masaüstündeki server.js'in AYNISINI yapar; tek fark: Express/HTTP/WebSocket
// yok, arayüzle iletişim BareKit.IPC üzerinden satır-bazlı JSON ile.
//
// ⚠️ Bu, server.js'in mobil karşılığıdır. İdeali: server.js'teki olay
// işleyicilerini `lib/core.js`'e çıkarıp HEM server.js HEM burası kullansın
// (şu an mantık iki yerde — kopya riski). Aşağısı çekirdek akışı ve köprüyü
// gösterir; TÜM case'ler server.js ile birebir olmalı.

import { IPC } from 'barekit'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import p2pmod from '../../lib/p2p.js'
// lib/store.js Node 'fs'/'path' kullanır; Bare'de bunlar bare-fs/bare-path'e
// çözülür (bare-pack alias). Gerekirse store.js'i bare-fs ile ince bir sarmala al.
import Store from '../../lib/store.js'

const { P2P, dmTopic, inboxTopic, roomTopic } = p2pmod

// Veri dizini: mobil uygulamanın yazılabilir alanı (RN tarafından env ile geçilir)
const DATA = process.env.TURKUAZ_DATA || path.join(process.cwd(), 'turkuaz-data')
const store = new Store(DATA)

// ---- arayüze mesaj (WebView) ----
function ui (obj) { try { IPC.write(JSON.stringify(obj) + '\n') } catch {} }

// ---- kimlik + P2P (server.js ile aynı) ----
let identity = store.loadIdentity()
if (!identity) {
  identity = { name: '', avatar: '', status: '', seed: crypto.randomBytes(32).toString('hex') }
  store.saveIdentity(identity)
}
let friends = store.loadFriends()
let requests = store.loadRequests()
let rooms = store.loadRooms()
let outbox = store.loadOutbox()

const p2p = new P2P({ seed: identity.seed })
const myCode = p2p.publicKey
const friendOf = (c) => friends.find(f => f.code === c)
const roomOf = (t) => rooms.find(r => r.topic === t)

function refreshHello () {
  p2p.announce({
    name: identity.name, avatar: identity.avatar, status: identity.status,
    friends: friends.map(f => f.code), rooms: rooms.map(r => r.topic)
  })
}
refreshHello()
p2p.join(inboxTopic(myCode))
for (const f of friends) {
  p2p.join(dmTopic(myCode, f.code))
  if (f.status === 'pending-out') p2p.joinClient(inboxTopic(f.code))
}
for (const r of rooms) p2p.join(Buffer.from(r.topic, 'hex'))

function stateObj () {
  return {
    t: 'state',
    me: { name: identity.name, code: myCode, avatar: identity.avatar, status: identity.status },
    friends: friends.map(f => ({ code: f.code, name: f.name, avatar: f.avatar || '', statusText: f.statusText || '', status: f.status, online: p2p.isOnline(f.code) })),
    requests,
    rooms: rooms.map(r => ({ code: r.code, name: r.name, topic: r.topic, invite: r.code + (r.owner ? '~' + r.owner : ''), owner: r.owner || null, isOwner: r.owner === myCode, channels: r.channels || ['genel'], online: p2p.roomPeerCount(r.topic), members: p2p.roomPeers(r.topic).map(c => ({ code: c, name: p2p.peerName(c) || 'anon' })) })),
    blocked: store.loadBlocked(),
    pending: Object.fromEntries(Object.entries(outbox).map(([k, v]) => [k, v.map(m => m.ack)]))
  }
}
const pushState = () => ui(stateObj())

// ---- P2P olayları (server.js ile birebir olmalı) ----
p2p.on('peer-open', () => pushState())
p2p.on('peer-close', () => pushState())
p2p.on('hello', (peer, info) => {
  const f = friendOf(peer)
  if (f) {
    if (info.name) f.name = info.name
    if (f.status === 'pending-out' && info.friend) f.status = 'friend'
    store.saveFriends(friends)
  }
  pushState()
})
p2p.on('message', (peer, msg) => {
  // ⚠️ server.js'teki 'p2p.on(message)' switch'inin TAMAMI buraya gelmeli
  // (friend-request, friend-accept, dm, dm-log, dm-file, room, room-log,
  //  room-file, group-invite, mod, typing, rtc, room-ev, ack, hist-*, fchunk...).
  // Aşağıda örnek olarak temel DM akışı:
  if (msg.t === 'dm') {
    const f = friendOf(peer)
    if (!f || typeof msg.id !== 'string') return
    const conv = 'dm-' + peer
    p2p.sendToPeer(peer, { t: 'ack', id: msg.id })
    const rec = { id: msg.id, from: peer, name: f.name || 'anon', text: String(msg.text || '').slice(0, 4000), ts: Number(msg.ts) || Date.now() }
    store.appendMessage(conv, rec)
    ui({ t: 'msg', conv, msg: { ...rec, reacts: {} } })
  }
})

// ---- Arayüz aksiyonları (server.js'in ws.on('message') switch'i) ----
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
    handleAction(m)
  }
})

function handleAction (m) {
  // ⚠️ server.js'teki ws switch'in TAMAMI (set-profile, add-friend,
  // accept-request, create-room, create-group, send-dm, send-room, react,
  // edit, del, pin, block, history, export, import, rtc...) buraya.
  switch (m.t) {
    case '__ready': pushState(); break
    case 'set-profile':
      if (m.name !== undefined) identity.name = String(m.name || '').slice(0, 64)
      if (m.avatar !== undefined) identity.avatar = String(m.avatar || '').slice(0, 8)
      if (m.status !== undefined) identity.status = String(m.status || '').slice(0, 100)
      store.saveIdentity(identity); refreshHello(); pushState()
      break
    case 'history':
      if (typeof m.conv === 'string') ui({ t: 'history', conv: m.conv, msgs: store.loadFolded(m.conv) })
      break
    // ... server.js'teki diğer tüm case'ler ...
    default: break
  }
}

ui({ t: 'log', msg: 'Turkuaz Bare backend hazır — kod: ' + myCode.slice(0, 12) })
pushState()
