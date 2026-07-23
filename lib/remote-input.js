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
function mapCoord (nx, ny, w, h) {
  const cx = Math.max(0, Math.min(1, Number(nx)))
  const cy = Math.max(0, Math.min(1, Number(ny)))
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return { x: Math.round(cx * (w - 1)), y: Math.round(cy * (h - 1)) }
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
    BracketLeft: K.LeftBracket, BracketRight: K.RightBracket, Backslash: K.Backslash
  }
  for (let i = 0; i <= 9; i++) { m['Digit' + i] = K['Num' + i]; m['Numpad' + i] = K['NumPad' + i] }
  for (let i = 65; i <= 90; i++) { const c = String.fromCharCode(i); m['Key' + c] = K[c] }
  for (let i = 1; i <= 12; i++) { m['F' + i] = K['F' + i] }
  return m
}

function mapKey (code) {
  const km = keyMap()
  if (!km) return null
  return km[String(code)] || null
}

// --- eylemler (yalnız main'den, oturum armed iken çağrılır) ---
async function moveTo (nx, ny, w, h) {
  const n = load(); if (!n) return
  const p = mapCoord(nx, ny, w, h); if (!p) return
  try { await n.mouse.setPosition(new n.Point(p.x, p.y)) } catch {}
}
async function button (down, b) {
  const n = load(); if (!n) return
  const btn = mapButton(b); if (btn == null) return
  try { down ? await n.mouse.pressButton(btn) : await n.mouse.releaseButton(btn) } catch {}
}
async function scroll (dy) {
  const n = load(); if (!n) return
  const amount = Math.max(-30, Math.min(30, Math.round(Number(dy) || 0)))
  try { amount > 0 ? await n.mouse.scrollDown(amount) : await n.mouse.scrollUp(-amount) } catch {}
}
async function key (down, code) {
  const n = load(); if (!n) return
  const k = mapKey(code); if (k == null) return
  try { down ? await n.keyboard.pressKey(k) : await n.keyboard.releaseKey(k) } catch {}
}

module.exports = {
  available, screenSize, mapCoord, mapButton, mapKey,
  moveTo, button, scroll, key, _keyMap: keyMap
}
