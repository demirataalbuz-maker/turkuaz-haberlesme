// Yerel depolama: her şey kullanıcının kendi diskinde durur.
// JSON dosyaları (kimlik, arkadaşlar, odalar) + mesajlar için JSONL (append-only).
// Mesaj günlüğü hem temel mesajları hem olayları (react/edit/del) tutar;
// okurken "katlanır" (fold): olaylar mesajların üzerine uygulanır.
const fs = require('fs')
const path = require('path')

class Store {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  }

  _file (name) { return path.join(this.dir, name) }

  _read (name, fallback) {
    try { return JSON.parse(fs.readFileSync(this._file(name), 'utf8')) } catch { return fallback }
  }

  _write (name, value) {
    fs.writeFileSync(this._file(name), JSON.stringify(value, null, 2))
  }

  loadIdentity () { return this._read('identity.json', null) }
  saveIdentity (v) { this._write('identity.json', v) }

  loadFriends () { return this._read('friends.json', []) }
  saveFriends (v) { this._write('friends.json', v) }

  loadRequests () { return this._read('requests.json', []) }
  saveRequests (v) { this._write('requests.json', v) }

  loadRooms () { return this._read('rooms.json', []) }
  saveRooms (v) { this._write('rooms.json', v) }

  loadOutbox () { return this._read('outbox.json', {}) }
  saveOutbox (v) { this._write('outbox.json', v) }

  loadFiles () { return this._read('files.json', {}) }
  saveFiles (v) { this._write('files.json', v) }

  loadBlocked () { return this._read('blocked.json', []) }
  saveBlocked (v) { this._write('blocked.json', v) }
  filePath (fid) { return path.join(this.dir, 'files', fid) }

  _msgFile (conv) { return path.join(this.dir, 'messages', conv + '.jsonl') }

  appendMessage (conv, msg) {
    fs.appendFileSync(this._msgFile(conv), JSON.stringify(msg) + '\n')
  }

  loadMessages (conv, limit = 500) {
    try {
      const lines = fs.readFileSync(this._msgFile(conv), 'utf8').trim().split('\n')
      const arr = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      return limit === Infinity ? arr : arr.slice(-limit)
    } catch { return [] }
  }

  // Olayları mesajların üzerine uygula: react toggle, edit, del.
  loadFolded (conv, limit = 400) {
    const lines = this.loadMessages(conv, Infinity)
    const byId = new Map()
    const msgs = []
    for (const l of lines) {
      if (l.ev || !l.id || byId.has(l.id)) continue
      const m = { ...l, reacts: {} }
      byId.set(l.id, m)
      msgs.push(m)
    }
    for (const l of lines) {
      if (!l.ev) continue
      const t = byId.get(l.id)
      if (!t) continue
      if (l.ev === 'react' && typeof l.emoji === 'string') {
        const r = t.reacts[l.emoji] = t.reacts[l.emoji] || {}
        if (r[l.from]) delete r[l.from]
        else r[l.from] = l.name || 'anon'
        if (!Object.keys(r).length) delete t.reacts[l.emoji]
      } else if (l.ev === 'edit' && l.from === t.from && typeof l.text === 'string') {
        t.text = l.text; t.edited = true
      } else if (l.ev === 'del' && l.from === t.from) {
        t.deleted = true; t.text = ''; delete t.file
      } else if (l.ev === 'pin') {
        t.pinned = !t.pinned
      }
    }
    msgs.sort((a, b) => a.ts - b.ts)
    return msgs.slice(-limit)
  }

  // Tekrarları elemek için: hem mesaj id'leri hem olay id'leri
  messageIds (conv) {
    return new Set(this.loadMessages(conv, Infinity).map(m => m.evId || m.id).filter(Boolean))
  }

  listConvs () {
    try {
      return fs.readdirSync(path.join(this.dir, 'messages'))
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.slice(0, -6))
    } catch { return [] }
  }
}

module.exports = Store
