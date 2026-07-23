// Uzaktan kontrol (ekran paylaşımı üstünde). İki rol:
//   İZLEYEN  — karşının ekranını kontrol eder (fare/klavye yakalar, yollar)
//   PAYLAŞAN — kendi ekranını kontrol ettirir (onay verir, girdiyi OS'e uygular)
//
// Taşıma: Voice mesh'indeki 'turkuaz-ctrl' RTCDataChannel (JSON mesajlar).
// OS enjeksiyonu yalnız PAYLAŞAN tarafta ve yalnız masaüstünde olur
// (Electron + nut-js kurulu); native yoksa istek 'deny/unavailable' alır.
// İZLEYEN tarafta native gerekmez — girdiyi yakalayıp veri kanalından yollar.
//
// GÜVENLİK modeli:
//  - Kontrol yalnız açık onayla başlar; paylaşan her an durdurabilir.
//  - Paylaşan ekran paylaşımını bırakınca kontrol otomatik biter.
//  - Girdi yalnız aktif "controller" peer'dan kabul edilir; main tarafı da
//    ayrıca armed değilken her girdiyi reddeder (çift kapı).
//  - Aynı anda tek bir kişi kontrol edebilir.
(function () {
  const RC = {
    controllingCode: null,   // İZLEYEN: kontrol ettiğim peer (video ile)
    _controlVideo: null,
    _pendingReqTo: null,     // gönderdiğim isteğin hedefi (grant beklenen)
    controllerCode: null,    // PAYLAŞAN: beni kontrol eden peer
    _armed: false,           // PAYLAŞAN: OS enjeksiyonu açık mı
    _banner: null,
    _indicator: null,
    _lastMove: 0
  }

  const desktop = () => (typeof window !== 'undefined' && window.turkuazDesktop && window.turkuazDesktop.remote) || null
  let _availCache = null
  async function nativeAvailable () {
    if (!desktop()) return false
    if (_availCache !== null) return _availCache
    try { _availCache = await desktop().available() } catch { _availCache = false }
    return _availCache
  }

  function send (code, obj) { return window.Voice ? Voice.ctrlSend(code, obj) : false }

  // ---------- İZLEYEN tarafı ----------
  RC.canRequest = async function (code) {
    // İzleyen tarafta native GEREKMEZ: girdi yalnızca veri kanalından yollanır,
    // OS'e uygulama paylaşan tarafta olur. Paylaşanda native yoksa isteğe zaten
    // 'deny/unavailable' döner — burada peşinen gizlemeye gerek yok.
    return !!code
  }

  RC.requestControl = function (code, videoEl) {
    if (this.controllingCode) return
    this._pendingReqTo = code
    this._controlVideo = videoEl
    const myName = (typeof state !== 'undefined' && state.me && state.me.name) || 'Biri'
    if (!send(code, { c: 'req', name: myName })) {
      this._pendingReqTo = null
      if (window.toast) toast('Kontrol isteği gönderilemedi (bağlantı yok).', 'error')
    } else if (window.toast) toast('Kontrol isteği gönderildi — onay bekleniyor…', 'info')
  }

  RC._beginControlling = function (code) {
    this.controllingCode = code
    this._pendingReqTo = null
    const v = this._controlVideo
    if (!v) return
    this._attachCapture(v)
    this._showIndicator()
    if (window.toast) toast('Kontrol sende — bırakmak için Esc.', 'success')
  }

  RC.stopControlling = function (notify = true) {
    if (!this.controllingCode) return
    if (notify) send(this.controllingCode, { c: 'end' })
    this._detachCapture()
    this._hideIndicator()
    this.controllingCode = null
    this._controlVideo = null
  }

  // Video üstündeki fare/klavye olaylarını yakala → normalize et → yolla.
  // object-fit: contain letterbox'ı düzeltilir (gerçek görüntü kutusuna göre).
  RC._normXY = function (v, clientX, clientY) {
    const r = v.getBoundingClientRect()
    const vw = v.videoWidth || r.width
    const vh = v.videoHeight || r.height
    if (!vw || !vh || !r.width || !r.height) return null
    const scale = Math.min(r.width / vw, r.height / vh)
    const dw = vw * scale, dh = vh * scale
    const offX = (r.width - dw) / 2, offY = (r.height - dh) / 2
    const x = (clientX - r.left - offX) / dw
    const y = (clientY - r.top - offY) / dh
    if (x < 0 || x > 1 || y < 0 || y > 1) return null // letterbox kenarı — yok say
    return { x, y }
  }

  RC._attachCapture = function (v) {
    const code = this.controllingCode
    // Yakalanan girdi KARŞIYA gider, yerel OS'e DEĞİL: veri kanalından
    // {c:<tür>, ...} olarak yollanır, paylaşan tarafta armed ise uygulanır.
    // (Buradan desktop().input() çağırmak kendi makinemizi sürmek olurdu.)
    const inp = (ev) => {
      if (this.controllingCode !== code) return
      send(code, { c: ev.k, x: ev.x, y: ev.y, b: ev.b, dy: ev.dy, code: ev.code })
    }
    const h = {}
    h.move = (e) => {
      const now = performance.now()
      if (now - this._lastMove < 16) return // ~60/sn üst sınır
      this._lastMove = now
      const p = this._normXY(v, e.clientX, e.clientY)
      if (p) inp({ k: 'm', x: p.x, y: p.y })
    }
    h.down = (e) => { e.preventDefault(); const p = this._normXY(v, e.clientX, e.clientY); if (p) inp({ k: 'm', x: p.x, y: p.y }); inp({ k: 'd', b: e.button }) }
    h.up = (e) => { e.preventDefault(); inp({ k: 'u', b: e.button }) }
    h.wheel = (e) => { e.preventDefault(); inp({ k: 'w', dy: e.deltaY > 0 ? 3 : -3 }) }
    h.ctx = (e) => e.preventDefault()
    h.key = (e) => {
      if (e.key === 'Escape') { this.stopControlling(); return }
      e.preventDefault()
      inp({ k: e.type === 'keydown' ? 'kd' : 'ku', code: e.code })
    }
    v.addEventListener('pointermove', h.move)
    v.addEventListener('pointerdown', h.down)
    v.addEventListener('pointerup', h.up)
    v.addEventListener('wheel', h.wheel, { passive: false })
    v.addEventListener('contextmenu', h.ctx)
    window.addEventListener('keydown', h.key, true)
    window.addEventListener('keyup', h.key, true)
    v.style.cursor = 'crosshair'
    v.tabIndex = 0
    try { v.focus() } catch {}
    this._capture = { v, h }
  }
  RC._detachCapture = function () {
    const c = this._capture
    if (!c) return
    const { v, h } = c
    v.removeEventListener('pointermove', h.move)
    v.removeEventListener('pointerdown', h.down)
    v.removeEventListener('pointerup', h.up)
    v.removeEventListener('wheel', h.wheel)
    v.removeEventListener('contextmenu', h.ctx)
    window.removeEventListener('keydown', h.key, true)
    window.removeEventListener('keyup', h.key, true)
    v.style.cursor = ''
    this._capture = null
  }

  RC._showIndicator = function () {
    if (this._indicator) return
    const el = document.createElement('div')
    el.className = 'rc-indicator'
    el.innerHTML = '<span>🎮 Uzaktan kontrol sende</span><button>Bırak (Esc)</button>'
    el.querySelector('button').onclick = () => this.stopControlling()
    document.body.appendChild(el)
    this._indicator = el
  }
  RC._hideIndicator = function () { if (this._indicator) { this._indicator.remove(); this._indicator = null } }

  // ---------- PAYLAŞAN tarafı ----------
  RC._onRequest = async function (from) {
    // Ekran paylaşmıyorsam ya da native yoksa reddet
    if (!window.Voice || !Voice.amSharing() || !(await nativeAvailable())) return send(from, { c: 'deny', reason: 'unavailable' })
    if (this.controllerCode && this.controllerCode !== from) return send(from, { c: 'deny', reason: 'busy' })
    const name = Voice.memberName(from)
    this._consent(from, name)
  }

  RC._consent = function (from, name) {
    const back = document.createElement('div')
    back.className = 'modal-back'
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true')
    back.innerHTML =
      '<div class="modal rc-consent">' +
      '<h3>🎮 Uzaktan kontrol isteği</h3>' +
      '<p><b>' + esc(name) + '</b> ekranını uzaktan kontrol etmek istiyor. ' +
      'Kabul edersen faren ve klavyen üzerinde kontrol sahibi olur. İstediğin an durdurabilirsin.</p>' +
      '<div class="modal-btns"><button class="cancel">Reddet</button><button class="danger-btn">İzin ver</button></div>' +
      '</div>'
    document.body.appendChild(back)
    const close = () => back.remove()
    back.querySelector('.cancel').onclick = () => { send(from, { c: 'deny' }); close() }
    back.querySelector('.danger-btn').onclick = async () => { close(); await this._grant(from) }
    back.onclick = (e) => { if (e.target === back) { send(from, { c: 'deny' }); close() } }
  }

  RC._grant = async function (from) {
    const d = desktop()
    if (!d) return send(from, { c: 'deny', reason: 'unavailable' })
    let res = null
    try { res = await d.begin() } catch {}
    if (!res || !res.ok) { this._armed = false; return send(from, { c: 'deny', reason: 'unavailable' }) }
    this.controllerCode = from
    this._armed = true
    send(from, { c: 'grant' })
    this._showBanner(Voice.memberName(from))
    // Güvenlik hotkey: Ctrl+Alt+Esc ile anında kes
    this._revokeKey = (e) => { if (e.ctrlKey && e.altKey && e.key === 'Escape') this.revoke() }
    window.addEventListener('keydown', this._revokeKey, true)
  }

  RC.revoke = function (notify = true) {
    if (!this.controllerCode && !this._armed) return
    const who = this.controllerCode
    if (notify && who) send(who, { c: 'stop' })
    this.controllerCode = null
    this._armed = false
    try { desktop() && desktop().end() } catch {}
    this._hideBanner()
    if (this._revokeKey) { window.removeEventListener('keydown', this._revokeKey, true); this._revokeKey = null }
  }

  RC._showBanner = function (name) {
    if (this._banner) this._hideBanner()
    const el = document.createElement('div')
    el.className = 'rc-banner'
    el.innerHTML = '<span>🖥️ <b>' + esc(name) + '</b> ekranını kontrol ediyor</span>' +
      '<button>Durdur (Ctrl+Alt+Esc)</button>'
    el.querySelector('button').onclick = () => this.revoke()
    document.body.appendChild(el)
    this._banner = el
  }
  RC._hideBanner = function () { if (this._banner) { this._banner.remove(); this._banner = null } }

  // Paylaşan taraf ekran paylaşımını bırakınca çağrılır (voice.js)
  RC.onShareStopped = function () { if (this.controllerCode || this._armed) this.revoke() }

  // ---------- veri kanalı mesajları ----------
  RC.onMessage = function (from, raw) {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (!m || typeof m.c !== 'string') return
    switch (m.c) {
      // İZLEYEN'e gelenler
      case 'grant': if (this._pendingReqTo === from) this._beginControlling(from); break
      case 'deny':
        if (this._pendingReqTo === from) {
          this._pendingReqTo = null; this._controlVideo = null
          if (window.toast) toast(m.reason === 'busy' ? 'Şu an başkası kontrol ediyor.' : (m.reason === 'unavailable' ? 'Uzaktan kontrol kullanılamıyor.' : 'İstek reddedildi.'), 'error')
        }
        break
      case 'stop': // paylaşan kontrolü kesti
        if (this.controllingCode === from) { this.stopControlling(false); if (window.toast) toast('Kontrol karşı tarafça sonlandırıldı.', 'info') }
        break
      // PAYLAŞAN'a gelenler
      case 'req': this._onRequest(from); break
      case 'end': if (this.controllerCode === from) { this.revoke(false); if (window.toast) toast('Kontrol bırakıldı.', 'info') } break
      // girdi olayları — yalnız aktif controller'dan ve armed iken
      case 'm': case 'd': case 'u': case 'w': case 'kd': case 'ku':
        if (this._armed && this.controllerCode === from && desktop()) {
          desktop().input({ k: m.c, x: m.x, y: m.y, b: m.b, dy: m.dy, code: m.code })
        }
        break
    }
  }

  RC.onPeerGone = function (code) {
    if (this.controllingCode === code) this.stopControlling(false)
    if (this.controllerCode === code) this.revoke(false)
    if (this._pendingReqTo === code) { this._pendingReqTo = null; this._controlVideo = null }
  }

  window.RemoteControl = RC
})()
