// Yerel depolama: her şey kullanıcının kendi diskinde durur.
// JSON dosyaları (kimlik, arkadaşlar, odalar) + mesajlar için JSONL (append-only).
// Mesaj günlüğü hem temel mesajları hem olayları (react/edit/del) tutar;
// okurken "katlanır" (fold): olaylar mesajların üzerine uygulanır.
// fs/path: masaüstünde (Node/Electron) builtin — telefonda (Bare) bare-fs/bare-path.
// Eşleme kök package.json "imports" alanında (Node yok sayar, Bare uygular).
const fs = require('fs')
const path = require('path')
const vault = require('./vault')

class Store {
  constructor (dir) {
    this.dir = dir
    // Kasa anahtarı (bkz. lib/vault.js). null = düz metin (kasa kurulmamış).
    // setKey ile takılır; takılıyken her yazma şifreli çıkar, her okuma hem
    // şifreli hem düz biçimi tanır (geçiş/migrasyon güvenli olsun diye).
    this.key = null
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  }

  setKey (key) { this.key = key }

  _file (name) { return path.join(this.dir, name) }

  _read (name, fallback) {
    try {
      let buf = fs.readFileSync(this._file(name))
      if (vault.isEnc(buf)) {
        if (!this.key) return fallback
        const plain = vault.decBuf(this.key, buf)
        if (!plain) return fallback
        buf = plain
      }
      return JSON.parse(buf.toString('utf8'))
    } catch { return fallback }
  }

  _write (name, value) {
    // Atomik yazma: önce geçici dosyaya, sonra adlandır (rename). Yazma
    // ortasında çökme/elektrik kesintisi eski dosyayı yarım bırakamaz —
    // identity.json bozulursa kullanıcının kimliği (seed) geri gelmez.
    const file = this._file(name)
    const tmp = file + '.tmp'
    let out = Buffer.from(JSON.stringify(value, null, 2))
    if (this.key) out = vault.encBuf(this.key, out)
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, file)
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
  // Dosya içerikleri (paylaşılan dosyalar) — çekirdek fs'e dokunmasın diye burada
  readFileBlob (fid) {
    try {
      const buf = fs.readFileSync(this.filePath(fid))
      if (vault.isEnc(buf)) return this.key ? vault.decBuf(this.key, buf) : null
      return buf
    } catch { return null }
  }

  writeFileBlob (fid, buf) {
    fs.writeFileSync(this.filePath(fid), this.key ? vault.encBuf(this.key, buf) : buf)
  }

  _msgFile (conv) { return path.join(this.dir, 'messages', conv + '.jsonl') }

  _encodeLine (str) { return this.key ? vault.encLine(this.key, str) : str }

  _decodeLine (line) {
    if (vault.isEncLine(line)) {
      if (!this.key) return null
      return vault.decLine(this.key, line)
    }
    return line
  }

  appendMessage (conv, msg) {
    fs.appendFileSync(this._msgFile(conv), this._encodeLine(JSON.stringify(msg)) + '\n')
  }

  loadMessages (conv, limit = 500) {
    try {
      const lines = fs.readFileSync(this._msgFile(conv), 'utf8').trim().split('\n')
      const arr = lines.map(l => {
        const s = this._decodeLine(l)
        if (!s) return null
        try { return JSON.parse(s) } catch { return null }
      }).filter(Boolean)
      return limit === Infinity ? arr : arr.slice(-limit)
    } catch { return [] }
  }

  // Kasa geçişi: tüm veriyi mevcut anahtarla okuyup newKey ile yeniden yaz.
  // newKey=null → düz metne dön (kasa kaldırma). Karışık durumlara dayanıklı:
  // okuma tarafı hem şifreli hem düz satır/dosya tanır, yarıda kesilse bile
  // tekrar çalıştırmak veriyi tamamlar.
  migrate (newKey) {
    const oldKey = this.key
    const jsons = ['identity.json', 'friends.json', 'requests.json', 'rooms.json', 'outbox.json', 'files.json', 'blocked.json']
    for (const n of jsons) {
      this.key = oldKey
      const v = this._read(n, undefined)
      if (v === undefined) continue
      this.key = newKey
      this._write(n, v)
    }
    for (const conv of this.listConvs()) {
      this.key = oldKey
      const msgs = this.loadMessages(conv, Infinity)
      this.key = newKey
      const file = this._msgFile(conv)
      const tmp = file + '.tmp'
      const body = msgs.map(m => this._encodeLine(JSON.stringify(m))).join('\n')
      fs.writeFileSync(tmp, body ? body + '\n' : '')
      fs.renameSync(tmp, file)
    }
    let fids = []
    try { fids = fs.readdirSync(path.join(this.dir, 'files')) } catch {}
    for (const fid of fids) {
      this.key = oldKey
      const buf = this.readFileBlob(fid)
      if (buf == null) continue
      this.key = newKey
      this.writeFileBlob(fid, buf)
    }
    this.key = newKey
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
