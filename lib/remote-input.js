// Uzaktan kontrol için OS seviyesinde girdi enjeksiyonu (ekran paylaşımı).
// Native bir modül (@nut-tree-fork/nut-js) TEMBEL yüklenir; kurulu değilse
// özellik nazikçe kapanır (uygulama çökmez, arayüz "desteklenmiyor" der).
//
// GÜVENLİK: Bu modül yalnızca electron-main tarafından, aktif ve kullanıcı
// onaylı bir kontrol oturumu varken çağrılır. Koordinatlar 0..1 normalize
// gelir, paylaşılan ekranın çözünürlüğüne göre haritalanır (URL/enjeksiyon
// riskini azaltmak için her değer sınırlanır ve doğrulanır).

let nut = null
let loadTried = false

function load () {
  if (loadTried) return nut
  loadTried = true
  // Test kancası: native kurulu olsa bile "yok" moduna zorla (nazik kapanma testi).
  if (process.env.TURKUAZ_DISABLE_NATIVE_INPUT) { nut = null; return nut }
  try {
    nut = require('@nut-tree-fork/nut-js')
    // Enjeksiyonlar mümkün olduğunca anlık olsun (varsayılan gecikmeleri sıfırla)
    if (nut.mouse && nut.mouse.config) nut.mouse.config.autoDelayMs = 0
    if (nut.keyboard && nut.keyboard.config) nut.keyboard.config.autoDelayMs = 0
  } catch { nut = null }
  return nut
}

function available () { return !!load() }

async function screenSize () {
  const n = load()
  if (!n) return null
  try { return { width: await n.screen.width(), height: await n.screen.height() } } catch { return null }
}

// Normalize (0..1) koordinatı ekran pikseline çevir + sınırla. Saf fonksiyon (test edilir).
// ox/oy: paylaşılan ekranın masaüstündeki sol-üst köşesi (çoklu monitör). Tek
// ekranda 0,0 — ikinci monitör paylaşıldığında imlecin yanlış ekrana düşmemesi
// için bounds.x/y buraya gelir.
function mapCoord (nx, ny, w, h, ox = 0, oy = 0) {
  const cx = Math.max(0, Math.min(1, Number(nx)))
  const cy = Math.max(0, Math.min(1, Number(ny)))
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return { x: Math.round(ox + cx * (w - 1)), y: Math.round(oy + cy * (h - 1)) }
}

// Tarayıcı fare düğmesi (0/1/2) → nut Button. Bilinmeyen reddedilir.
function mapButton (b) {
  const n = load()
  if (!n) return null
  const B = n.Button
  if (b === 0) return B.LEFT
  if (b === 1) return B.MIDDLE
  if (b === 2) return B.RIGHT
  return null
}

// Tarayıcı KeyboardEvent.code / .key → nut Key. Yalnız güvenli, bilinen tuşlar.
// Bilinmeyen tuş sessizce yok sayılır (rastgele enjeksiyon olmasın).
function keyMap () {
  const n = load()
  if (!n) return null
  const K = n.Key
  const m = {
    Enter: K.Enter, Escape: K.Escape, Backspace: K.Backspace, Tab: K.Tab, Space: K.Space,
    ArrowLeft: K.Left, ArrowRight: K.Right, ArrowUp: K.Up, ArrowDown: K.Down,
    Home: K.Home, End: K.End, PageUp: K.PageUp, PageDown: K.PageDown, Delete: K.Delete,
    ShiftLeft: K.LeftShift, ShiftRight: K.RightShift,
    ControlLeft: K.LeftControl, ControlRight: K.RightControl,
    AltLeft: K.LeftAlt, AltRight: K.RightAlt,
    MetaLeft: K.LeftSuper, MetaRight: K.RightSuper, CapsLock: K.CapsLock,
    Minus: K.Minus, Equal: K.Equal, Comma: K.Comma, Period: K.Period, Slash: K.Slash,
    Semicolon: K.Semicolon, Quote: K.Quote, Backquote: K.Grave,
    BracketLeft: K.LeftBracket, BracketRight: K.RightBracket, Backslash: K.Backslash,
    // Sistem/düzenleme tuşları
    Insert: K.Insert, PrintScreen: K.Print, ScrollLock: K.ScrollLock, Pause: K.Pause,
    NumLock: K.NumLock, ContextMenu: K.Menu,
    // Numpad işlemleri (rakamlar aşağıdaki döngüde)
    NumpadAdd: K.Add, NumpadSubtract: K.Subtract, NumpadMultiply: K.Multiply,
    NumpadDivide: K.Divide, NumpadDecimal: K.Decimal, NumpadEnter: K.Enter,
    NumpadEqual: K.NumPadEqual,
    // Medya tuşları
    AudioVolumeMute: K.AudioMute, AudioVolumeUp: K.AudioVolUp, AudioVolumeDown: K.AudioVolDown,
    MediaPlayPause: K.AudioPlay, MediaStop: K.AudioStop,
    MediaTrackNext: K.AudioNext, MediaTrackPrevious: K.AudioPrev
  }
  for (let i = 0; i <= 9; i++) { m['Digit' + i] = K['Num' + i]; m['Numpad' + i] = K['NumPad' + i] }
  for (let i = 65; i <= 90; i++) { const c = String.fromCharCode(i); m['Key' + c] = K[c] }
  for (let i = 1; i <= 12; i++) { m['F' + i] = K['F' + i] }
  return m
}

// DİKKAT: nut-js Key bir sayısal enum ve Key.Escape === 0. Burada `|| null`
// kullanmak Escape'i sessizce düşürürdü (v0.16.1'e kadarki hata) — bu yüzden
// varlık kontrolü açıkça undefined üzerinden yapılır.
function mapKey (code) {
  const km = keyMap()
  if (!km) return null
  const k = km[String(code)]
  return k === undefined ? null : k
}

// --- basılı durum takibi ---
// Oturum koparsa (ağ düştü, kullanıcı kesti, yayın kapandı) basılı kalan tuş
// karşı tarafın makinesinde kilitli kalır — Ctrl basılı kalmış bir masaüstü
// kullanılamaz hale gelir. Bu yüzden ne bastıysak sayıyoruz ve oturum biterken
// hepsini bırakıyoruz.
const heldKeys = new Set()
const heldButtons = new Set()

// --- eylemler (yalnız main'den, oturum armed iken çağrılır) ---
async function moveTo (nx, ny, w, h, ox = 0, oy = 0) {
  const n = load(); if (!n) return
  const p = mapCoord(nx, ny, w, h, ox, oy); if (!p) return
  try { await n.mouse.setPosition(new n.Point(p.x, p.y)) } catch {}
}
// Göreli hareket (oyun modu / pointer lock): imleci mevcut konumdan kaydırır.
// Mutlak konum yerine delta gelir; pointer-lock kullanan oyunlar böyle çalışır.
async function moveBy (dx, dy) {
  const n = load(); if (!n) return
  const ddx = Math.max(-2000, Math.min(2000, Math.round(Number(dx) || 0)))
  const ddy = Math.max(-2000, Math.min(2000, Math.round(Number(dy) || 0)))
  if (!ddx && !ddy) return
  try {
    const cur = await n.mouse.getPosition()
    await n.mouse.setPosition(new n.Point(cur.x + ddx, cur.y + ddy))
  } catch {}
}
async function button (down, b) {
  const n = load(); if (!n) return
  const btn = mapButton(b); if (btn == null) return
  try {
    if (down) { await n.mouse.pressButton(btn); heldButtons.add(btn) } else { await n.mouse.releaseButton(btn); heldButtons.delete(btn) }
  } catch {}
}
async function scroll (dy) {
  const n = load(); if (!n) return
  const amount = Math.max(-30, Math.min(30, Math.round(Number(dy) || 0)))
  try { amount > 0 ? await n.mouse.scrollDown(amount) : await n.mouse.scrollUp(-amount) } catch {}
}
async function key (down, code) {
  const n = load(); if (!n) return
  const k = mapKey(code); if (k == null) return
  try {
    if (down) { await n.keyboard.pressKey(k); heldKeys.add(k) } else { await n.keyboard.releaseKey(k); heldKeys.delete(k) }
  } catch {}
}

// Oturum sonunda çağrılır: basılı kalan her şeyi bırak (takılı tuş kalmasın).
async function releaseAll () {
  const n = load()
  if (!n) { heldKeys.clear(); heldButtons.clear(); return }
  for (const k of Array.from(heldKeys)) { try { await n.keyboard.releaseKey(k) } catch {} }
  for (const b of Array.from(heldButtons)) { try { await n.mouse.releaseButton(b) } catch {} }
  heldKeys.clear()
  heldButtons.clear()
}

function heldCount () { return heldKeys.size + heldButtons.size }

module.exports = {
  available, screenSize, mapCoord, mapButton, mapKey,
  moveTo, moveBy, button, scroll, key, releaseAll, heldCount, _keyMap: keyMap
}
