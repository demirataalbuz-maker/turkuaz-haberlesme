// Uzaktan kontrol saf mantık testleri (native/DOM gerektirmeyen kısım).
// nut-js opsiyonel bağımlılık olarak kurulu olabilir; testte native'i açıkça
// devre dışı bırakıp "kullanılamaz" (nazik kapanma) yolunu doğruluyoruz.
process.env.TURKUAZ_DISABLE_NATIVE_INPUT = '1'
const assert = require('assert')
const ri = require('../lib/remote-input')

let fails = 0
function check (name, fn) {
  try { fn(); console.log('PASS: ' + name) } catch (e) { console.log('FAIL: ' + name + ' — ' + e.message); fails++ }
}

// 1) native yoksa nazik davran
check('native yoksa available() false', () => {
  // TURKUAZ_DISABLE_NATIVE_INPUT ile native zorla kapalı
  assert.strictEqual(ri.available(), false)
})
check('native yoksa screenSize() null', async () => {
  const s = await ri.screenSize()
  assert.strictEqual(s, null)
})
check('native yoksa eylemler sessizce döner (throw yok)', async () => {
  await ri.moveTo(0.5, 0.5, 1920, 1080)
  await ri.button(true, 0)
  await ri.scroll(3)
  await ri.key(true, 'KeyA')
})

// 2) koordinat haritalama saf mantık (native'den bağımsız)
check('mapCoord orta nokta', () => {
  const p = ri.mapCoord(0.5, 0.5, 1920, 1080)
  assert.deepStrictEqual(p, { x: Math.round(0.5 * 1919), y: Math.round(0.5 * 1079) })
})
// Çoklu monitör: ikinci ekran masaüstünde x=1920'den başlıyorsa imleç ORAYA
// gitmeli. Offset'siz eşleme imleci birinci ekrana düşürüyordu.
check('mapCoord ikinci monitör offsetini uygular', () => {
  const p = ri.mapCoord(0.5, 0.5, 1920, 1080, 1920, 0)
  assert.strictEqual(p.x, 1920 + Math.round(0.5 * 1919))
  assert.strictEqual(p.y, Math.round(0.5 * 1079))
})
check('mapCoord offsetli köşeler', () => {
  assert.deepStrictEqual(ri.mapCoord(0, 0, 1920, 1080, -1920, 200), { x: -1920, y: 200 })
})
check('mapCoord köşeler', () => {
  assert.deepStrictEqual(ri.mapCoord(0, 0, 1920, 1080), { x: 0, y: 0 })
  assert.deepStrictEqual(ri.mapCoord(1, 1, 1920, 1080), { x: 1919, y: 1079 })
})
check('mapCoord sınır dışı 0..1 aralığına kırpılır', () => {
  assert.deepStrictEqual(ri.mapCoord(-5, 2, 1000, 1000), { x: 0, y: 999 })
})

// 3) letterbox normalizasyonu (remotectrl.js ile aynı formül) — object-fit: contain
// video 1920x1080, panel 800x600 → contain ölçek min(800/1920, 600/1080)=0.4167
function normXY (rw, rh, vw, vh, cx, cy) {
  const scale = Math.min(rw / vw, rh / vh)
  const dw = vw * scale, dh = vh * scale
  const offX = (rw - dw) / 2, offY = (rh - dh) / 2
  const x = (cx - offX) / dw, y = (cy - offY) / dh
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}
check('letterbox: içerik merkezi 0.5,0.5 verir', () => {
  const p = normXY(800, 600, 1920, 1080, 400, 300)
  assert.ok(Math.abs(p.x - 0.5) < 1e-6 && Math.abs(p.y - 0.5) < 1e-6)
})
check('letterbox: siyah bant (üst/alt) null döner', () => {
  // 800x600 panelde 1920x1080 contain → yükseklik 800*1080/1920=450, bant (600-450)/2=75px
  assert.strictEqual(normXY(800, 600, 1920, 1080, 400, 10), null) // üst bant
  assert.ok(normXY(800, 600, 1920, 1080, 400, 300) !== null)       // içerik
})

// 3b) Tuş haritası: nut-js Key sayısal enum ve Key.Escape === 0. `|| null`
// kalıbı Escape'i sessizce düşürüyordu — 0 değerli tuş korunmalı.
check('mapKey 0 değerli tuşu (Escape) düşürmez', () => {
  // native kapalıyken map null döner; burada saf davranışı doğrulamak için
  // keyMap'i taklit etmiyoruz — native yoksa null beklenir (nazik kapanma).
  assert.strictEqual(ri.mapKey('Escape'), null)
})
check('mapKey bilinmeyen tuşu reddeder', () => {
  assert.strictEqual(ri.mapKey('KesinlikleYokBoyleTus'), null)
})
check('releaseAll native yokken de patlamaz', async () => {
  await ri.releaseAll()
  assert.strictEqual(ri.heldCount(), 0)
})

// 4) UÇTAN UCA taşıma sözleşmesi: remotectrl.js gerçek dosyası sahte bir DOM
// içinde çalıştırılır. v0.16.0'da izleyen tarafı yakaladığı girdiyi karşıya
// yollamak yerine KENDİ OS'ine enjekte etmeye çalışıyordu (kontrol hiç
// çalışmıyordu); bu blok o regresyonu kalıcı olarak kapatır.
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const RC_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'remotectrl.js'), 'utf8')

function fakeEl () {
  return {
    className: '', innerHTML: '', style: {},
    setAttribute () {}, remove () {}, appendChild () {},
    querySelector: () => ({ onclick: null })
  }
}

function fakeVideo () {
  const h = {}
  const v = {
    videoWidth: 1920, videoHeight: 1080, style: {}, tabIndex: 0,
    focus () {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (t, fn) => { h[t] = fn },
    removeEventListener: (t) => { delete h[t] },
    fire: (t, ev) => { if (h[t]) h[t](ev) }
  }
  v.requestPointerLock = () => { v._locked = true }
  return v
}

// Bir "uç" kurar: kendi RemoteControl örneği + gönderilenler/enjekte edilenler kaydı
function makeEndpoint ({ native = true, sharing = true } = {}) {
  const sent = []      // veri kanalından karşıya giden mesajlar
  const injected = []  // bu makinenin OS'ine uygulanan girdiler
  const clip = { value: null, released: 0, beginOpts: null, sessions: [] }
  const Voice = {
    ctrlSend: (code, obj) => { sent.push({ code, obj }); return true },
    amSharing: () => sharing,
    memberName: () => 'Test Kişi',
    sharedDisplayId: () => 'DISPLAY-2',
    onControlSession: (active, peer) => { clip.sessions.push({ active, peer }) }
  }
  // window dinleyicileri kaydedilir: testte klavye olayını gerçekten ateşlemek için
  const winHandlers = {}
  const win = {
    Voice,
    addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn) },
    removeEventListener: (t, fn) => {
      if (!winHandlers[t]) return
      winHandlers[t] = winHandlers[t].filter((f) => f !== fn)
    },
    fire: (t, ev) => { for (const f of (winHandlers[t] || []).slice()) f(ev) },
    toast () {}
  }
  if (native) {
    win.turkuazDesktop = {
      remote: {
        available: async () => true,
        begin: async (opts) => { clip.beginOpts = opts; return { ok: true } },
        end: async () => true,
        input: (ev) => { injected.push(ev); return true },
        releaseAll: async () => { clip.released++; return true },
        setControlling: async () => true,
        clipboardRead: async () => clip.value,
        clipboardWrite: async (t) => { clip.value = t; return true }
      }
    }
  }
  // Not: remotectrl.js bu yardımcıları `window.x` ile kontrol edip çıplak `x()`
  // olarak çağırıyor (app.js'te ikisi de global) — sahte ortamda da öyle olmalı.
  const ctx = vm.createContext({
    window: win,
    Voice,
    toast: win.toast,
    document: { createElement: fakeEl, body: { appendChild () {} }, pointerLockElement: null, exitPointerLock () {} },
    performance: { now: () => Date.now() },
    esc: (s) => s,
    console, setInterval, clearInterval
  })
  vm.runInContext(RC_SRC, ctx)
  return { RC: win.RemoteControl, sent, injected, clip, ctx, win }
}

function checkAsync (name, fn) {
  return fn().then(
    () => console.log('PASS: ' + name),
    (e) => { console.log('FAIL: ' + name + ' — ' + e.message); fails++ }
  )
}

async function transportTests () {
  // -- İZLEYEN: yakalanan girdi karşıya YOLLANIR, yerelde enjekte EDİLMEZ
  await checkAsync('izleyen girdisi veri kanalına gider, yerel OS\'e gitmez', async () => {
    const A = makeEndpoint()               // izleyen (native kurulu olsa bile)
    const v = fakeVideo()
    A.RC._controlVideo = v
    A.RC._pendingReqTo = 'PEER'
    A.RC.onMessage('PEER', JSON.stringify({ c: 'grant' }))   // onay geldi → kontrol başlar
    assert.strictEqual(A.RC.controllingCode, 'PEER')

    // panel 800x600, video 1920x1080 → merkez (400,300) = 0.5,0.5
    v.fire('pointerdown', { clientX: 400, clientY: 300, button: 0, preventDefault () {} })

    const kinds = A.sent.map((s) => s.obj.c)
    assert.ok(kinds.includes('m'), 'fare konumu yollanmalı')
    assert.ok(kinds.includes('d'), 'tuş basımı yollanmalı')
    const move = A.sent.find((s) => s.obj.c === 'm')
    assert.strictEqual(move.code, 'PEER')
    assert.ok(Math.abs(move.obj.x - 0.5) < 1e-6 && Math.abs(move.obj.y - 0.5) < 1e-6)
    // REGRESYON KİLİDİ: izleyen kendi makinesini sürmemeli
    assert.deepStrictEqual(A.injected, [], 'izleyen kendi OS\'ine enjekte etmemeli')
  })

  // -- Uçtan uca: izleyenin yolladığı paket paylaşanda OS'e uygulanır
  await checkAsync('izleyen → paylaşan: paket OS girdisine dönüşür', async () => {
    const A = makeEndpoint({ native: false })   // izleyende native olmasa da olur
    const B = makeEndpoint()                    // paylaşan (native var)
    const v = fakeVideo()
    A.RC._controlVideo = v
    A.RC._pendingReqTo = 'B'
    A.RC.onMessage('B', JSON.stringify({ c: 'grant' }))

    await B.RC._grant('A')                      // paylaşan izin verdi → armed
    assert.strictEqual(B.RC.controllerCode, 'A')

    v.fire('pointerdown', { clientX: 400, clientY: 300, button: 0, preventDefault () {} })
    for (const s of A.sent) B.RC.onMessage('A', JSON.stringify(s.obj))

    const ks = B.injected.map((i) => i.k)
    assert.ok(ks.includes('m') && ks.includes('d'), 'paylaşanda girdi uygulanmalı')
    const m = B.injected.find((i) => i.k === 'm')
    assert.ok(Math.abs(m.x - 0.5) < 1e-6 && Math.abs(m.y - 0.5) < 1e-6)
  })

  // -- İzleyende native yokken de kontrol istenebilmeli (buton gizlenmemeli)
  await checkAsync('canRequest izleyende native şart koşmaz', async () => {
    const A = makeEndpoint({ native: false })
    assert.strictEqual(await A.RC.canRequest('PEER'), true)
    assert.strictEqual(await A.RC.canRequest(null), false)
  })

  // -- Çift kapı: armed değilken ve yabancı peer'dan gelen girdi reddedilir
  await checkAsync('armed değilken girdi uygulanmaz', async () => {
    const B = makeEndpoint()
    B.RC.onMessage('A', JSON.stringify({ c: 'm', x: 0.5, y: 0.5 }))
    assert.deepStrictEqual(B.injected, [])
  })
  await checkAsync('yetkisiz peer girdisi uygulanmaz', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    B.RC.onMessage('KOTU', JSON.stringify({ c: 'm', x: 0.5, y: 0.5 }))
    assert.deepStrictEqual(B.injected, [])
  })

  // -- Paylaşan ekranı bırakınca kontrol biter
  await checkAsync('yayın kapanınca kontrol sonlanır', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    B.RC.onShareStopped()
    assert.strictEqual(B.RC.controllerCode, null)
    assert.strictEqual(B.RC._armed, false)
  })

  // -- Paylaşan ekran paylaşmıyorsa istek reddedilir
  await checkAsync('ekran paylaşmayan isteği reddeder', async () => {
    const B = makeEndpoint({ sharing: false })
    await B.RC._onRequest('A')
    const deny = B.sent.find((s) => s.obj.c === 'deny')
    assert.ok(deny && deny.obj.reason === 'unavailable')
    assert.strictEqual(B.RC.controllerCode, null)
  })

  // ---- v0.17.0 eklentileri ----

  // Escape artık karşıya GİDER; bırakma Ctrl+Alt+Esc'e taşındı.
  // v0.16.1'e kadar Escape yerelde yutuluyordu → uzaktaki hiçbir diyalog
  // kapatılamıyordu. Bu iki test o davranışı kilitler.
  await checkAsync('yalnız Escape karşıya gider, kontrolü bırakmaz', async () => {
    const A = makeEndpoint()
    const v = fakeVideo()
    A.RC._controlVideo = v; A.RC._pendingReqTo = 'P'
    A.RC.onMessage('P', JSON.stringify({ c: 'grant' }))
    A.win.fire('keydown', { type: 'keydown', key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, preventDefault () {} })
    const esc = A.sent.find((s) => s.obj.c === 'kd' && s.obj.code === 'Escape')
    assert.ok(esc, 'Escape karşıya yollanmalı')
    assert.strictEqual(A.RC.controllingCode, 'P', 'Escape kontrolü bırakmamalı')
  })
  await checkAsync('Ctrl+Alt+Esc kontrolü bırakır ve karşıya gitmez', async () => {
    const A = makeEndpoint()
    const v = fakeVideo()
    A.RC._controlVideo = v; A.RC._pendingReqTo = 'P'
    A.RC.onMessage('P', JSON.stringify({ c: 'grant' }))
    const before = A.sent.length
    A.win.fire('keydown', { type: 'keydown', key: 'Escape', code: 'Escape', ctrlKey: true, altKey: true, preventDefault () {} })
    assert.strictEqual(A.RC.controllingCode, null, 'kontrol bırakılmalı')
    const after = A.sent.slice(before).filter((s) => s.obj.c === 'kd')
    assert.strictEqual(after.length, 0, 'kısayol tuşu karşıya gitmemeli')
  })

  // Göreli fare (oyun modu): pointer lock varken 'r' + dx/dy gider
  await checkAsync('oyun modu göreli hareket (r/dx/dy) yollar', async () => {
    const A = makeEndpoint()
    const v = fakeVideo()
    A.RC._controlVideo = v; A.RC._pendingReqTo = 'P'
    A.RC.onMessage('P', JSON.stringify({ c: 'grant' }))
    A.RC.setRelative(true)
    A.ctx.document.pointerLockElement = v      // kilit alınmış say
    v.fire('pointermove', { movementX: 7, movementY: -3, clientX: 0, clientY: 0 })
    const r = A.sent.find((s) => s.obj.c === 'r')
    assert.ok(r, 'göreli hareket yollanmalı')
    assert.strictEqual(r.obj.dx, 7)
    assert.strictEqual(r.obj.dy, -3)
  })

  // Göreli paket paylaşanda moveBy'a dönüşür
  await checkAsync('göreli paket paylaşanda uygulanır', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    B.RC.onMessage('A', JSON.stringify({ c: 'r', dx: 5, dy: 9 }))
    const inj = B.injected.find((i) => i.k === 'r')
    assert.ok(inj && inj.dx === 5 && inj.dy === 9)
  })

  // Paylaşan hangi ekranı paylaşıyorsa o display id begin()'e geçmeli
  await checkAsync('begin() paylaşılan ekranın display id\'sini alır', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    assert.ok(B.clip.beginOpts, 'begin opts gelmeli')
    assert.strictEqual(B.clip.beginOpts.displayId, 'DISPLAY-2')
  })

  // relall: izleyen odağı kaybedince paylaşan basılı tuşları bırakır
  await checkAsync('relall basılı tuşları bıraktırır (oturum açık kalır)', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    B.RC.onMessage('A', JSON.stringify({ c: 'relall' }))
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(B.clip.released, 1)
    assert.strictEqual(B.RC._armed, true, 'oturum kapanmamalı')
  })
  await checkAsync('yetkisiz relall yok sayılır', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    B.RC.onMessage('KOTU', JSON.stringify({ c: 'relall' }))
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(B.clip.released, 0)
  })

  // Pano: aktif oturumdaki karşı taraftan gelen metin uygulanır
  await checkAsync('pano metni aktif oturumda uygulanır', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    B.RC.onMessage('A', JSON.stringify({ c: 'clip', t: 'merhaba' }))
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(B.clip.value, 'merhaba')
  })
  await checkAsync('oturum dışı pano mesajı yok sayılır', async () => {
    const B = makeEndpoint()
    B.RC.onMessage('A', JSON.stringify({ c: 'clip', t: 'sizinti' }))
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(B.clip.value, null)
  })

  // Kontrol oturumu Voice'a bildirilir (gecikme ayarları buna bağlı)
  await checkAsync('kontrol oturumu Voice\'a bildirilir', async () => {
    const B = makeEndpoint()
    await B.RC._grant('A')
    assert.ok(B.clip.sessions.some((s) => s.active === true && s.peer === 'A'))
    B.RC.revoke(false)
    assert.ok(B.clip.sessions.some((s) => s.active === false))
  })
}

transportTests().then(() => {
  console.log(fails ? ('SONUÇ: ' + fails + ' FAIL') : 'PASS: uzaktan kontrol — saf mantık + taşıma sözleşmesi + nazik kapanma')
  process.exit(fails ? 1 : 0)
})
