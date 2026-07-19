// lib/core.js birim testleri — ağ YOK: p2p olayları elle tetiklenir, sahte
// bağlantılar Map'e doğrudan yazılır. Milisaniyeler içinde biter.
// Özellikle: dedup, engelleme, oda mesajı İMZALARI ve geçmiş (hist-res)
// sahteciliğinin reddi.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const hcrypto = require('hypercore-crypto')
const DHT = require('hyperdht')
const Store = require('../lib/store')
const { createCore } = require('../lib/core')

function tmpStore () {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'turkuaz-core-')))
}

// Sahte peer: gerçek anahtar çifti + core'un conns Map'ine sahte bağlantı
function fakePeer (core, rooms = []) {
  const kp = DHT.keyPair(hcrypto.randomBytes(32))
  const hex = kp.publicKey.toString('hex')
  const sent = []
  core.p2p.conns.set(hex, {
    conn: { write: (s) => sent.push(s), destroy () {} },
    name: 'peer',
    rooms: new Set(rooms)
  })
  return { hex, kp, sent }
}

// core.js'teki imza biçiminin birebir kopyası — biçim değişirse bu test kırılır
// (bilinçli: imza sözleşmesini sabitler)
const sign = (kp, parts) => hcrypto.sign(Buffer.from(parts.join('\n')), kp.secretKey).toString('hex')

async function main () {
  const store = tmpStore()
  const core = createCore({ store, bootstrap: [] })

  // ---- atomik yazma: .tmp artığı kalmaz, dosya geçerli JSON ----
  store.saveIdentity({ name: 'test', avatar: '', status: '', seed: 'ab'.repeat(32) })
  assert.ok(!fs.existsSync(path.join(store.dir, 'identity.json.tmp')), 'tmp dosyası kalmamalı')
  assert.equal(store.loadIdentity().name, 'test', 'identity geri okunmalı')

  // ---- DM dedup + engelleme ----
  const friend = fakePeer(core)
  core.handleUI({ t: 'add-friend', code: friend.hex })
  core.p2p.emit('message', friend.hex, { t: 'dm', id: 'm1', text: 'selam', ts: Date.now() })
  core.p2p.emit('message', friend.hex, { t: 'dm', id: 'm1', text: 'selam', ts: Date.now() })
  assert.equal(store.loadFolded('dm-' + friend.hex).length, 1, 'aynı id iki kez kaydedilmemeli')

  const enemy = fakePeer(core)
  core.handleUI({ t: 'add-friend', code: enemy.hex })
  core.handleUI({ t: 'block', code: enemy.hex })
  core.p2p.emit('message', enemy.hex, { t: 'dm', id: 'x1', text: 'spam', ts: Date.now() })
  assert.equal(store.loadFolded('dm-' + enemy.hex).length, 0, 'engellenenden mesaj kaydedilmemeli')

  // ---- arama kaydı ----
  core.handleUI({ t: 'call-log', code: friend.hex, text: '📞 Görüşme · 1 dk 2 sn' })
  const dm = store.loadFolded('dm-' + friend.hex)
  assert.ok(dm.some(m => m.call && m.text.startsWith('📞')), 'arama kaydı DM geçmişine düşmeli')

  // ---- oda: kendi mesajım imzalı yazılır ----
  core.handleUI({ t: 'create-room', name: 'testoda' })
  const topic = core.stateObj().rooms[0].topic
  core.handleUI({ t: 'send-room', topic, ch: 'genel', text: 'merhaba oda' })
  const myLine = store.loadMessages('room-' + topic, Infinity).find(l => l.text === 'merhaba oda')
  assert.ok(myLine && /^[0-9a-f]{128}$/.test(myLine.sig), 'kendi oda mesajım imzalı olmalı')

  // ---- hist-res: imzasız sahte satır REDDEDİLİR ----
  const victim = DHT.keyPair(hcrypto.randomBytes(32)).publicKey.toString('hex')
  const member = fakePeer(core, [topic])
  core.p2p.emit('message', member.hex, {
    t: 'hist-res',
    room: topic,
    lines: [{ id: 'forge1', from: victim, name: 'kurban', ch: 'genel', ts: Date.now(), text: 'bunu hiç yazmadım' }]
  })
  assert.ok(!store.loadFolded('room-' + topic).some(m => m.id === 'forge1'), 'imzasız geçmiş satırı reddedilmeli')

  // ---- hist-res: BAŞKASININ adına imzalı satır da reddedilir ----
  const ts2 = Date.now()
  const badSig = sign(member.kp, ['msg', topic, 'forge2', 'genel', String(ts2), 'kurban', 'yine sahte'])
  core.p2p.emit('message', member.hex, {
    t: 'hist-res',
    room: topic,
    lines: [{ id: 'forge2', from: victim, name: 'kurban', ch: 'genel', ts: ts2, text: 'yine sahte', sig: badSig }]
  })
  assert.ok(!store.loadFolded('room-' + topic).some(m => m.id === 'forge2'), 'yanlış anahtarla imzalı satır reddedilmeli')

  // ---- hist-res: yazarın GERÇEK imzasını taşıyan satır kabul edilir ----
  const author = DHT.keyPair(hcrypto.randomBytes(32))
  const authorHex = author.publicKey.toString('hex')
  const ts3 = Date.now()
  const goodSig = sign(author, ['msg', topic, 'real1', 'genel', String(ts3), 'yazar', 'gerçek mesaj'])
  core.p2p.emit('message', member.hex, {
    t: 'hist-res',
    room: topic,
    lines: [{ id: 'real1', from: authorHex, name: 'yazar', ch: 'genel', ts: ts3, text: 'gerçek mesaj', sig: goodSig }]
  })
  assert.ok(store.loadFolded('room-' + topic).some(m => m.id === 'real1'), 'doğru imzalı geçmiş satırı kabul edilmeli')

  // ---- canlı oda mesajı: imzasız da işlenir (kimlik bağlantıdan) ----
  core.p2p.emit('message', member.hex, { t: 'room', room: topic, id: 'live1', name: 'peer', text: 'canlı', ts: Date.now() })
  assert.ok(store.loadFolded('room-' + topic).some(m => m.id === 'live1'), 'canlı oda mesajı işlenmeli')

  // ---- fchunk: saçma parça sayısı transferi başlatamaz ----
  core.p2p.emit('message', member.hex, { t: 'fchunk', fid: 'f'.repeat(36), i: 0, n: 999999, data: 'aGk=' })
  core.p2p.emit('message', member.hex, { t: 'file-fin', fid: 'f'.repeat(36), fname: 'x', mime: 'text/plain' })
  assert.ok(!Object.keys(core.filesIdx()).length, 'limit üstü parça sayısıyla dosya oluşmamalı')

  await core.destroy()
  console.log('PASS: çekirdek — dedup, engelleme, arama kaydı, oda imzaları, geçmiş sahteciliği reddi')
  process.exit(0)
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })
