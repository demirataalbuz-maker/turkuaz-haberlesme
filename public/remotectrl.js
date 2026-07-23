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
    relative: false,         // İZLEYEN: oyun modu (pointer lock + göreli fare)
    _banner: null,
    _indicator: null,
    _lastMove: 0,
    _clipTimer: null,
    _lastClip: null
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
    if (window.Voice && Voice.onControlSession) Voice.onControlSession(true, code)
    if (window.toast) toast('Kontrol sende — bırakmak için Ctrl+Alt+Esc.', 'success')
  }

  RC.stopControlling = function (notify = true) {
    if (!this.controllingCode) return
    if (notify) send(this.controllingCode, { c: 'end' })
    this._detachCapture()
    this._hideIndicator()
    if (window.Voice && Voice.onControlSession) Voice.onControlSession(false, this.controllingCode)
    this.controllingCode = null
    this._controlVideo = null
    this.relative = false
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
      send(code, { c: ev.k, x: ev.x, y: ev.y, dx: ev.dx, dy: ev.dy, b: ev.b, code: ev.code })
    }
    const h = {}
    h.move = (e) => {
      const now = performance.now()
      if (now - this._lastMove < 8) return // ~120/sn üst sınır (oyun için 60 azdı)
      this._lastMove = now
      // Oyun modu (pointer lock): mutlak konum yok, delta gönderilir. FPS/3B
      // oyunlar imleci yakaladığı için mutlak konumlama işe yaramıyor.
      if (this.relative && document.pointerLockElement === v) {
        const dx = e.movementX || 0, dy = e.movementY || 0
        if (dx || dy) inp({ k: 'r', dx, dy })
        return
      }
      const p = this._normXY(v, e.clientX, e.clientY)
      if (p) inp({ k: 'm', x: p.x, y: p.y })
    }
    h.down = (e) => {
      e.preventDefault()
      if (this.relative && document.pointerLockElement !== v) { try { v.requestPointerLock() } catch {}; return }
      if (!this.relative) { const p = this._normXY(v, e.clientX, e.clientY); if (p) inp({ k: 'm', x: p.x, y: p.y }) }
      inp({ k: 'd', b: e.button })
    }
    h.up = (e) => { e.preventDefault(); inp({ k: 'u', b: e.button }) }
    h.wheel = (e) => { e.preventDefault(); inp({ k: 'w', dy: e.deltaY > 0 ? 3 : -3 }) }
    h.ctx = (e) => e.preventDefault()
    h.key = (e) => {
      // Kontrolü bırakma: Ctrl+Alt+Esc (paylaşandaki kesme kısayolunun eşi).
      // Escape TEK BAŞINA artık karşıya GİDER — yoksa uzaktaki hiçbir diyalog
      // kapatılamıyordu (v0.16.1'e kadarki eksik).
      if (e.ctrlKey && e.altKey && e.key === 'Escape') { e.preventDefault(); this.stopControlling(); return }
      e.preventDefault()
      inp({ k: e.type === 'keydown' ? 'kd' : 'ku', code: e.code })
    }
    // Odak kaybında basılı tuşlar karşıda kilitli kalmasın
    h.blur = () => { if (this.controllingCode === code) send(code, { c: 'relall' }) }
    v.addEventListener('pointermove', h.move)
    v.addEventListener('pointerdown', h.down)
    v.addEventListener('pointerup', h.up)
    v.addEventListener('wheel', h.wheel, { passive: false })
    v.addEventListener('contextmenu', h.ctx)
    window.addEventListener('keydown', h.key, true)
    window.addEventListener('keyup', h.key, true)
    window.addEventListener('blur', h.blur)
    v.style.cursor = this.relative ? 'none' : 'crosshair'
    v.tabIndex = 0
    try { v.focus() } catch {}
    this._capture = { v, h }
    this._startClipboardSync()
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
    window.removeEventListener('blur', h.blur)
    v.style.cursor = ''
    try { if (document.pointerLockElement === v) document.exitPointerLock() } catch {}
    this._capture = null
    this._stopClipboardSync()
  }

  // Oyun modu: pointer lock + göreli fare. Video'ya tıklayınca imleç kilitlenir.
  RC.setRelative = function (on) {
    this.relative = !!on
    const c = this._capture
    if (!c) return
    c.v.style.cursor = this.relative ? 'none' : 'crosshair'
    if (!this.relative) { try { if (document.pointerLockElement === c.v) document.exitPointerLock() } catch {} }
  }

  // ---------- pano senkronu (iki yönlü, yalnız düz metin) ----------
  // Yerel pano değişince karşıya yollanır. Tarayıcı panoyu olay olarak
  // bildirmediği için kısa aralıkla yoklanır (masaüstünde Electron clipboard).
  RC._startClipboardSync = function () {
    const d = desktop()
    if (!d || !d.clipboardRead) return
    try { d.setControlling && d.setControlling(true) } catch {}
    this._clipTimer = setInterval(async () => {
      const peer = this.controllingCode || this.controllerCode
      if (!peer) return
      let t = null
      try { t = await d.clipboardRead() } catch {}
      if (typeof t !== 'string' || t === this._lastClip) return
      this._lastClip = t
      send(peer, { c: 'clip', t })
    }, 700)
  }
  RC._stopClipboardSync = function () {
    if (this._clipTimer) { clearInterval(this._clipTimer); this._clipTimer = null }
    this._lastClip = null
    const d = desktop()
    try { d && d.setControlling && d.setControlling(false) } catch {}
  }
  RC._applyClipboard = async function (text) {
    const d = desktop()
    if (!d || !d.clipboardWrite || typeof text !== 'string') return
    this._lastClip = text // kendi yazdığımızı geri yollamayalım (eko döngüsü)
    try { await d.clipboardWrite(text) } catch {}
  }

  RC._showIndicator = function () {
    if (this._indicator) return
    const el = document.createElement('div')
    el.className = 'rc-indicator'
    el.innerHTML = '<span>🎮 Uzaktan kontrol sende</span>' +
      '<button class="rc-game" title="Oyun modu: imleci kilitler, göreli fare gönderir">🕹️ Oyun modu</button>' +
      '<button class="rc-drop">Bırak (Ctrl+Alt+Esc)</button>'
    const gameBtn = el.querySelector('.rc-game')
    gameBtn.onclick = () => {
      this.setRelative(!this.relative)
      gameBtn.classList.toggle('on', this.relative)
      gameBtn.textContent = this.relative ? '🕹️ Oyun modu açık' : '🕹️ Oyun modu'
    }
    el.querySelector('.rc-drop').onclick = () => this.stopControlling()
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
    // Hangi ekranı paylaşıyorsak imleç O ekrana eşlensin (çoklu monitör).
    const displayId = (window.Voice && Voice.sharedDisplayId && Voice.sharedDisplayId()) || null
    try { res = await d.begin({ displayId }) } catch {}
    if (!res || !res.ok) { this._armed = false; return send(from, { c: 'deny', reason: 'unavailable' }) }
    this.controllerCode = from
    this._armed = true
    this._startClipboardSync()
    if (window.Voice && Voice.onControlSession) Voice.onControlSession(true, from)
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
    // end() main tarafında basılı kalan tuş/düğmeleri de bırakır
    try { desktop() && desktop().end() } catch {}
    this._stopClipboardSync()
    if (window.Voice && Voice.onControlSession) Voice.onControlSession(false, who)
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
      case 'm': case 'r': case 'd': case 'u': case 'w': case 'kd': case 'ku':
        if (this._armed && this.controllerCode === from && desktop()) {
          desktop().input({ k: m.c, x: m.x, y: m.y, dx: m.dx, dy: m.dy, b: m.b, code: m.code })
        }
        break
      // izleyen odağı kaybetti → basılı tuşları bırak (oturum açık kalır)
      case 'relall':
        if (this._armed && this.controllerCode === from && desktop() && desktop().releaseAll) {
          try { desktop().releaseAll() } catch {}
        }
        break
      // pano senkronu — iki yönlü, yalnız aktif oturumdaki karşı taraftan
      case 'clip':
        if ((this.controllerCode === from && this._armed) || this.controllingCode === from) {
          this._applyClipboard(m.t)
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
