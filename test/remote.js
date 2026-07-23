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

console.log(fails ? ('SONUÇ: ' + fails + ' FAIL') : 'PASS: uzaktan kontrol — saf mantık + nazik kapanma')
process.exit(fails ? 1 : 0)
