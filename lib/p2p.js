// P2P katmanı: Hyperswarm ile merkezi sunucusuz bağlantı.
// Peer'lar birbirini dağıtık DHT üzerinden topic hash'leriyle bulur,
// aradaki bağlantı uçtan uca şifrelidir (Noise protokolü).
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const NS = 'turkuaz/v1'

function topicOf (...parts) {
  const h = crypto.createHash('sha256')
  h.update(NS)
  for (const p of parts) h.update(p)
  return h.digest()
}

// İki arkadaşın DM topic'i: iki public key'in sıralı hash'i.
// İkisi de aynı topic'e katılınca DHT üzerinden birbirlerini bulurlar.
function dmTopic (pubA, pubB) {
  const [a, b] = [pubA, pubB].sort()
  return topicOf('dm', a, b)
}

// Herkesin "posta kutusu" topic'i: kodunu bilen biri buradan
// arkadaşlık isteği yollayabilir.
function inboxTopic (pub) { return topicOf('inbox', pub) }

// Oda topic'i: oda kodunu bilen herkes katılabilir.
function roomTopic (code) { return topicOf('room', code) }

class P2P extends EventEmitter {
  constructor ({ seed, bootstrap }) {
    super()
    this.keyPair = DHT.keyPair(Buffer.from(seed, 'hex'))
    this.publicKey = this.keyPair.publicKey.toString('hex')
    this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap })
    this.conns = new Map() // peerHex -> { conn, name, rooms:Set<topicHex> }
    this.hello = { name: '', avatar: '', status: '', friends: new Set(), rooms: new Set() }
    this.swarm.on('connection', (conn) => this._onConnection(conn))
  }

  _onConnection (conn) {
    // Kimlik = bağlantının Noise public key'i; taklit edilemez.
    const peer = conn.remotePublicKey.toString('hex')
    const old = this.conns.get(peer)
    if (old) { try { old.conn.destroy() } catch {} }

    const entry = { conn, name: null, rooms: new Set() }
    this.conns.set(peer, entry)

    conn.on('error', () => {})
    conn.on('close', () => {
      if (this.conns.get(peer) === entry) {
        this.conns.delete(peer)
        this.emit('peer-close', peer)
      }
    })

    // Satır bazlı JSON çerçeveleme
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (buf.length > 1e6) { conn.destroy(); return }
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        this._onMessage(peer, entry, msg)
      }
    })

    this._sendHello(entry, peer)
    this.emit('peer-open', peer)
  }

  _sendHello (entry, peer) {
    this._write(entry.conn, {
      t: 'hello',
      v: 2,
      name: this.hello.name,
      avatar: this.hello.avatar,
      status: this.hello.status,
      friend: this.hello.friends.has(peer),
      rooms: [...this.hello.rooms]
    })
  }

  _onMessage (peer, entry, msg) {
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'hello') {
      entry.name = typeof msg.name === 'string' ? msg.name.slice(0, 64) : null
      entry.rooms = new Set(
        Array.isArray(msg.rooms) ? msg.rooms.filter(r => typeof r === 'string').slice(0, 200) : []
      )
      this.emit('hello', peer, {
        name: entry.name,
        avatar: typeof msg.avatar === 'string' ? msg.avatar.slice(0, 8) : '',
        status: typeof msg.status === 'string' ? msg.status.slice(0, 100) : '',
        friend: !!msg.friend,
        rooms: entry.rooms
      })
      return
    }
    this.emit('message', peer, msg)
  }

  _write (conn, obj) {
    try { conn.write(JSON.stringify(obj) + '\n') } catch {}
  }

  // Hello bilgimiz değişince (isim, arkadaş listesi, odalar) herkese tekrar duyur.
  announce ({ name, avatar, status, friends, rooms }) {
    if (name !== undefined) this.hello.name = name
    if (avatar !== undefined) this.hello.avatar = avatar
    if (status !== undefined) this.hello.status = status
    if (friends !== undefined) this.hello.friends = new Set(friends)
    if (rooms !== undefined) this.hello.rooms = new Set(rooms)
    for (const [peer, entry] of this.conns) this._sendHello(entry, peer)
  }

  join (topicBuf) { this.swarm.join(topicBuf, { server: true, client: true }) }
  joinClient (topicBuf) { this.swarm.join(topicBuf, { server: false, client: true }) }
  async leave (topicBuf) { try { await this.swarm.leave(topicBuf) } catch {} }

  sendToPeer (peerHex, obj) {
    const entry = this.conns.get(peerHex)
    if (!entry) return false
    this._write(entry.conn, obj)
    return true
  }

  broadcastRoom (topicHex, obj) {
    let n = 0
    for (const entry of this.conns.values()) {
      if (entry.rooms.has(topicHex)) { this._write(entry.conn, obj); n++ }
    }
    return n
  }

  peerInRoom (peerHex, topicHex) {
    const entry = this.conns.get(peerHex)
    return !!entry && entry.rooms.has(topicHex)
  }

  peerName (peerHex) {
    const entry = this.conns.get(peerHex)
    return (entry && entry.name) || null
  }

  roomPeerCount (topicHex) {
    let n = 0
    for (const e of this.conns.values()) if (e.rooms.has(topicHex)) n++
    return n
  }

  roomPeers (topicHex) {
    const out = []
    for (const [peer, e] of this.conns) if (e.rooms.has(topicHex)) out.push(peer)
    return out
  }

  isOnline (peerHex) { return this.conns.has(peerHex) }

  async destroy () { await this.swarm.destroy() }
}

module.exports = { P2P, dmTopic, inboxTopic, roomTopic }
