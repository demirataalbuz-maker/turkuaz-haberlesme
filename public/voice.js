// Turkuaz ses/görüntü: oda sesli sohbeti (konumsal ses), ekran paylaşımı
// ve DM birebir arama. Medya WebRTC ile DOĞRUDAN akar; sinyalleşme kendi
// şifreli P2P kanalımızdan taşınır.
/* global state, send, activeConv, colorOf, initialOf, esc, avatarOf, $ */

const RTC_CFG = {
  // STUN sadece "dış IP'm ne?" der; üzerinden veri akmaz. Aynı ağda hiç kullanılmaz.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun.cloudflare.com:3478'] }
  ]
}
// CGNAT / simetrik NAT arkasında STUN yetmez; kullanıcı veri klasörüne
// ice.json koyarsa (TURN dahil) onu kullan — server state ile gönderir.
function rtcConfig () {
  return (Array.isArray(state.ice) && state.ice.length) ? { iceServers: state.ice } : RTC_CFG
}

// ---- ayarlardan medya kısıtları (cihaz seçimi, ekran çözünürlüğü/FPS/ses) ----
function _settings () { return (window.TurkuazSettings && TurkuazSettings.get()) || {} }
function micConstraints () {
  const s = _settings()
  // 'strong' (RNNoise) modda tarayıcının kendi gürültü bastırması kapalı — işi RNNoise yapar
  const audio = { echoCancellation: true, noiseSuppression: (s.noise || 'standard') === 'standard', autoGainControl: true }
  if (s.micId) audio.deviceId = { exact: s.micId }
  return { audio }
}
function camConstraints () {
  const s = _settings()
  const video = { width: { ideal: 640 }, height: { ideal: 480 } }
  if (s.camId) video.deviceId = { exact: s.camId }
  return { video }
}
function screenConstraints () {
  const s = _settings()
  const video = { frameRate: Number(s.screenFps) || 15 }
  if (s.screenRes && s.screenRes !== 'source') video.height = { ideal: s.screenRes === '1080' ? 1080 : 720 }
  return { video, audio: !!s.screenAudio }
}
// Ham mikrofonu WebAudio'dan geçirip giriş kazancı uygular; gönderilecek
// (işlenmiş) akışı döndürür. micRaw/inGain/ctx referanslarını obj'ye yazar.
async function buildMic (obj) {
  const raw = await navigator.mediaDevices.getUserMedia(micConstraints())
  obj.micRaw = raw
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!obj.ctx) obj.ctx = new Ctx({ sampleRate: 48000 }) // RNNoise 48 kHz ister
  try { obj.ctx.resume() } catch {}
  const src = obj.ctx.createMediaStreamSource(raw)
  obj.inGain = obj.ctx.createGain()
  obj.inGain.gain.value = (Number(_settings().inVol) || 100) / 100
  const dest = obj.ctx.createMediaStreamDestination()
  // AI gürültü engelleme (RNNoise): 'strong' modda ve motor hazırsa zincire gir
  let head = src
  if (_settings().noise === 'strong' && window.RNNoise && window.RNNoise.ready) {
    const dn = window.RNNoise.makeDenoiseNode(obj.ctx)
    if (dn) { src.connect(dn); head = dn; obj._denoise = dn }
  }
  head.connect(obj.inGain); obj.inGain.connect(dest)
  return dest.stream
}

const LR_SCALE = 8

// ============================================================
// Oda sesli sohbeti + oturma odası
// ============================================================
const Voice = {
  room: null,
  members: new Map(),
  myPos: null,
  mic: null,
  cam: null,
  screen: null,
  muted: false,
  ctx: null,
  master: null,
  hb: null,
  seen: new Map(),
  _myAnalyser: null,

  code () { return state.me.code },

  defaultPos (code) {
    let h = 0
    for (const c of code) h = (h * 33 + c.charCodeAt(0)) >>> 0
    return { x: 12 + (h % 77), y: 28 + ((h >> 7) % 46) }
  },

  seenMap (room) {
    if (!this.seen.has(room)) this.seen.set(room, new Map())
    return this.seen.get(room)
  },

  sendRtc (to, data) { send({ t: 'rtc', to, data }) },

  stateEv () {
    return {
      kind: 'voice', on: true, muted: this.muted, video: !!this.cam,
      screen: this.screen ? this.screen.id : null,
      avatar: state.me.avatar, pos: this.myPos
    }
  },

  sendState () {
    if (!this.room) return
    send({ t: 'room-ev', room: this.room, ev: this.stateEv() })
  },

  _posTimer: null,
  sendPos () {
    if (this._posTimer) return
    this._posTimer = setTimeout(() => {
      this._posTimer = null
      if (this.room) send({ t: 'room-ev', room: this.room, ev: { kind: 'pos', ...this.myPos } })
    }, 80)
  },

  async join () {
    if (!activeConv || activeConv.type !== 'room') return
    if (window.CallMgr && CallMgr.state) CallMgr.end()
    if (this.room) this.leave()
    try {
      this.ctx = new AudioContext({ sampleRate: 48000 })
      this.ctx.resume()
      this.mic = await buildMic(this) // ham mikrofon → (RNNoise) → giriş kazancı → gönderilen akış
    } catch (e) {
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
      alert('Mikrofona erişilemedi: ' + e.message); return
    }
    this.master = this.ctx.createGain()
    this.master.gain.value = (Number(_settings().outVol) || 100) / 100
    this.master.connect(this.ctx.destination)
    // kendi konuşma göstergem (giriş kazancından sonra)
    this._myAnalyser = this.ctx.createAnalyser()
    this._myAnalyser.fftSize = 256
    this.inGain.connect(this._myAnalyser)
    this.room = activeConv.topic
    this.muted = false
    this.myPos = this.defaultPos(this.code())
    this.sendState()
    this.hb = setInterval(() => this.sendState(), 8000)
    this._speakInt = setInterval(() => this.speakTick(), 180)
    this.sync()
  },

  leave () {
    if (!this.room) return
    send({ t: 'room-ev', room: this.room, ev: { kind: 'voice', on: false } })
    clearInterval(this.hb)
    clearInterval(this._speakInt)
    for (const code of [...this.members.keys()]) this.removeMember(code)
    for (const s of ['mic', 'micRaw', 'cam', 'screen']) {
      if (this[s]) { this[s].getTracks().forEach(t => t.stop()); this[s] = null }
    }
    if (this._denoise) { this._denoise._rnnoiseCleanup && this._denoise._rnnoiseCleanup(); this._denoise = null }
    this.inGain = null
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
    this.room = null
    this.myPos = null
    this._myBubble = null
    this.sync()
  },

  toggleMute () {
    if (!this.mic) return
    this.muted = !this.muted
    this.mic.getAudioTracks().forEach(t => { t.enabled = !this.muted })
    this.sendState()
    this.sync()
  },

  // ---- ayar ekranından canlı uygulanan ses kontrolleri ----
  setOutputVolume (pct) { if (this.master) this.master.gain.value = Math.max(0, Number(pct) || 0) / 100 },
  setInputVolume (pct) { if (this.inGain) this.inGain.gain.value = Math.max(0, Number(pct) || 0) / 100 },
  setSink (id) { try { if (this.ctx && this.ctx.setSinkId) this.ctx.setSinkId(id || '').catch(() => {}) } catch {} },

  // ---- kişi-bazlı ses (Discord gibi her katılımcı ayrı ayarlanır) ----
  _userVols: null,
  userVols () {
    if (!this._userVols) { try { this._userVols = JSON.parse(localStorage.getItem('turkuaz.uservol') || '{}') } catch { this._userVols = {} } }
    return this._userVols
  },
  memberVol (code) { const v = this.userVols()[code]; return v === undefined ? 1 : Math.max(0, Number(v)) / 100 },
  setMemberVolume (code, pct) {
    this.userVols()[code] = Number(pct)
    try { localStorage.setItem('turkuaz.uservol', JSON.stringify(this._userVols)) } catch {}
    const m = this.members.get(code)
    if (m && m.gain) m.gain.gain.value = Math.max(0, Number(pct) || 0) / 100
  },
  showVolPopover (code, bubbleEl) {
    const old = this.el('lr-volpop'); if (old) old.remove()
    const m = this.members.get(code)
    const cur = Math.round(this.memberVol(code) * 100)
    const pop = document.createElement('div')
    pop.id = 'lr-volpop'; pop.className = 'lr-volpop'
    pop.innerHTML = `<div class="lr-volname">${esc((m && m.name) || 'kişi')}</div>
      <div class="lr-volrow"><span>🔊</span><input type="range" min="0" max="200" value="${cur}"><span class="v">${cur}%</span></div>`
    const stage = this.el('lr-stage'); stage.appendChild(pop)
    pop.style.left = bubbleEl.style.left; pop.style.top = bubbleEl.style.top
    const range = pop.querySelector('input'); const vlabel = pop.querySelector('.v')
    range.oninput = () => { vlabel.textContent = range.value + '%'; this.setMemberVolume(code, range.value) }
    const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', off, true) } }
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0)
  },

  async toggleCam () {
    if (!this.room) return
    if (!this.cam) {
      try {
        this.cam = await navigator.mediaDevices.getUserMedia(camConstraints())
      } catch (e) { alert('Kameraya erişilemedi: ' + e.message); return }
      const track = this.cam.getVideoTracks()[0]
      track.onended = () => { if (this.cam) this.toggleCam() }
      for (const m of this.members.values()) m.pc.addTrack(track, this.mic)
    } else {
      this._removeVideoSenders(t => this.cam.getTracks().includes(t))
      this.cam.getTracks().forEach(t => t.stop())
      this.cam = null
    }
    this.sendState()
    this.sync()
  },

  async toggleScreen () {
    if (!this.room) return
    if (!this.screen) {
      try {
        this.screen = await navigator.mediaDevices.getDisplayMedia(screenConstraints())
      } catch { return }
      const track = this.screen.getVideoTracks()[0]
      track.onended = () => { if (this.screen) this.toggleScreen() }
      for (const m of this.members.values()) m.pc.addTrack(track, this.screen)
    } else {
      this._removeVideoSenders(t => this.screen.getTracks().includes(t))
      this.screen.getTracks().forEach(t => t.stop())
      this.screen = null
    }
    this.sendState()
    this.sync()
  },

  _removeVideoSenders (match) {
    for (const m of this.members.values()) {
      for (const s of m.pc.getSenders()) {
        if (s.track && match(s.track)) { try { m.pc.removeTrack(s) } catch {} }
      }
    }
  },

  ensureMember (code, name) {
    let m = this.members.get(code)
    if (m) { if (name) m.name = name; return m }
    m = {
      code,
      name: name || 'anon',
      avatar: '',
      pos: this.defaultPos(code),
      muted: false, video: false,
      streams: {},          // streamId -> MediaStream
      screenSid: null,
      srcNode: null, panner: null, analyser: null, audioEl: null,
      bubble: null, makingOffer: false,
      polite: this.code() > code
    }
    this.members.set(code, m)
    this.createPC(m)
    this.sync()
    return m
  },

  createPC (m) {
    const pc = new RTCPeerConnection(rtcConfig())
    m.pc = pc
    for (const track of this.mic.getTracks()) pc.addTrack(track, this.mic)
    if (this.cam) pc.addTrack(this.cam.getVideoTracks()[0], this.mic)
    if (this.screen) pc.addTrack(this.screen.getVideoTracks()[0], this.screen)

    pc.onicecandidate = (e) => this.sendRtc(m.code, { kind: 'ice', cand: e.candidate })
    pc.onnegotiationneeded = async () => {
      // Açılış glare'ini kökten önle: iki taraf da aynı anda teklif atarsa
      // kibar tarafın rollback'i sonrası Chromium'da ICE toplama takılabiliyor.
      // Kibar taraf İLK teklifi hiç atmaz — parçaları zaten answer'a biner;
      // sonradan gerekirse (remoteDescription varken) teklif atabilir.
      if (m.polite && !pc.remoteDescription) return
      try {
        m.makingOffer = true
        await pc.setLocalDescription()
        this.sendRtc(m.code, { kind: 'sdp', desc: pc.localDescription })
      } catch (e) { console.error(e) } finally { m.makingOffer = false }
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      if (!m.streams[stream.id]) {
        m.streams[stream.id] = stream
        stream.onaddtrack = () => this.refreshMedia(m)
        stream.onremovetrack = () => this.refreshMedia(m)
      }
      this.refreshMedia(m)
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') m.restarted = false
      if (st === 'failed') {
        // İlk çare: aynı bağlantıda ICE'ı tazele; ikinci kez düşerse üyeyi çıkar
        // (karşı tarafın 8 sn'lik durum kalp atışı üyeyi yeniden kurar = tekrar dene)
        if (!m.restarted) { m.restarted = true; try { pc.restartIce() } catch { this.removeMember(m.code); return } } else { this.removeMember(m.code); return }
      } else if (st === 'closed') { this.removeMember(m.code); return }
      this.sync()
    }
  },

  mainStream (m) {
    for (const [id, s] of Object.entries(m.streams)) if (id !== m.screenSid) return s
    return null
  },
  screenStream (m) { return (m.screenSid && m.streams[m.screenSid]) || null },

  refreshMedia (m) {
    if (!this.ctx) return
    const main = this.mainStream(m)
    if (!m.srcNode && main && main.getAudioTracks().length) {
      // Chrome tuhaflığı: uzak ses bir media elemanına bağlanmadan WebAudio'ya akmaz
      m.audioEl = new Audio()
      m.audioEl.srcObject = main
      m.audioEl.muted = true
      m.audioEl.play().catch(() => {})
      m.panner = new PannerNode(this.ctx, {
        panningModel: 'HRTF', distanceModel: 'inverse',
        refDistance: 2, maxDistance: 40, rolloffFactor: 1.4
      })
      m.srcNode = this.ctx.createMediaStreamSource(main)
      m.analyser = this.ctx.createAnalyser()
      m.analyser.fftSize = 256
      m.gain = this.ctx.createGain()
      m.gain.gain.value = this.memberVol(m.code) // kişi-bazlı ses
      m.srcNode.connect(m.analyser)
      m.srcNode.connect(m.panner)
      m.panner.connect(m.gain)
      m.gain.connect(this.master)
      this.updatePanner(m)
    }
    m.video = !!(main && main.getVideoTracks().some(t => t.readyState === 'live'))
    this.updateBubble(m)
    this.sync()
  },

  removeMember (code) {
    const m = this.members.get(code)
    if (!m) return
    try { m.pc.close() } catch {}
    try { m.srcNode && m.srcNode.disconnect() } catch {}
    try { m.panner && m.panner.disconnect() } catch {}
    try { m.gain && m.gain.disconnect() } catch {}
    if (m.audioEl) { m.audioEl.srcObject = null; m.audioEl = null }
    if (m.bubble) m.bubble.remove()
    this.members.delete(code)
    this.sync()
  },

  updatePanner (m) {
    if (!m.panner || !this.myPos || !this.ctx) return
    const t = this.ctx.currentTime
    m.panner.positionX.setTargetAtTime((m.pos.x - this.myPos.x) / LR_SCALE, t, 0.05)
    m.panner.positionY.setTargetAtTime(0, t, 0.05)
    m.panner.positionZ.setTargetAtTime((m.pos.y - this.myPos.y) / LR_SCALE, t, 0.05)
  },
  updateAllPanners () { for (const m of this.members.values()) this.updatePanner(m) },

  // konuşma göstergesi
  _level (an) {
    if (!an) return 0
    const buf = new Uint8Array(an.fftSize)
    an.getByteTimeDomainData(buf)
    let dev = 0
    for (const v of buf) dev = Math.max(dev, Math.abs(v - 128))
    return dev
  },
  speakTick () {
    if (this._myBubble) this._myBubble.classList.toggle('speaking', !this.muted && this._level(this._myAnalyser) > 10)
    for (const m of this.members.values()) {
      if (m.bubble) m.bubble.classList.toggle('speaking', this._level(m.analyser) > 10)
    }
  },

  onRtc ({ from, data }) {
    if (!data) return
    const k = data.kind || ''
    if (k.startsWith('call') || data.scope === 'call') return CallMgr.onRtc(from, data)
    if (!this.room || from === this.code()) return
    if (k === 'hello') {
      const m = this.ensureMember(from, data.name)
      m.muted = !!data.muted
      m.avatar = data.avatar || ''
      m.screenSid = data.screen || null
      if (data.pos) { m.pos = data.pos; this.updatePanner(m) }
      this.updateBubble(m)
      this.sync()
      return
    }
    if (k === 'bye') { this.removeMember(from); return }
    const m = this.members.get(from)
    if (!m) return
    if (k === 'sdp') this.onSdp(m, data.desc)
    if (k === 'ice') { try { m.pc.addIceCandidate(data.cand || undefined).catch(() => {}) } catch {} }
  },

  async onSdp (m, desc) {
    const pc = m.pc
    try {
      const collision = desc.type === 'offer' && (m.makingOffer || pc.signalingState !== 'stable')
      if (collision && !m.polite) return
      await pc.setRemoteDescription(desc)
      if (desc.type === 'offer') {
        await pc.setLocalDescription()
        this.sendRtc(m.code, { kind: 'sdp', desc: pc.localDescription })
      }
    } catch (e) { console.error('sdp', e) }
  },

  onRoomEv ({ room, from, name, ev }) {
    if (!ev || from === this.code()) return
    const rr = state.rooms.find(r => r.topic === room)
    if (rr && rr.banned && rr.banned.includes(from)) return
    if (ev.kind === 'voice') {
      if (ev.on) this.seenMap(room).set(from, name)
      else this.seenMap(room).delete(from)
      if (this.room === room) {
        if (!ev.on) { this.removeMember(from); return }
        const m = this.ensureMember(from, name)
        m.muted = !!ev.muted
        m.avatar = ev.avatar || m.avatar
        m.screenSid = ev.screen || null
        if (ev.pos) { m.pos = ev.pos; this.updatePanner(m) }
        this.updateBubble(m)
        this.sendRtc(from, { kind: 'hello', name: state.me.name, avatar: state.me.avatar, muted: this.muted, screen: this.screen ? this.screen.id : null, pos: this.myPos })
        this.sync()
      } else this.sync()
      return
    }
    if (ev.kind === 'pos' && this.room === room) {
      const m = this.members.get(from)
      if (!m) return
      m.pos = { x: Number(ev.x) || 0, y: Number(ev.y) || 0 }
      this.updatePanner(m)
      this.positionBubble(m)
    }
  },

  // ---- arayüz ----
  el (id) { return document.getElementById(id) },

  sync () {
    const lr = this.el('livingroom')
    if (!lr) return
    const inRoomView = activeConv && activeConv.type === 'room'
    lr.classList.toggle('hidden', !inRoomView)
    this.syncTheater(inRoomView)
    if (!inRoomView) return
    const topic = activeConv.topic
    const active = this.room === topic

    this.el('lr-overlay').classList.toggle('hidden', active)
    this.el('lr-controls').classList.toggle('hidden', !active)
    if (!active) {
      const inside = [...this.seenMap(topic).values()]
      this.el('lr-who').textContent = inside.length
        ? 'İçeride: ' + inside.join(', ')
        : 'Henüz kimse yok — ilk katılan sen ol'
      this.el('lr-stage').querySelectorAll('.lr-bubble').forEach(b => b.remove())
      this._myBubble = null
      return
    }

    const mic = this.el('btn-mic')
    mic.textContent = this.muted ? '🔇 Sesi aç' : '🎙️ Sustur'
    mic.classList.toggle('on', this.muted)
    const cam = this.el('btn-cam')
    cam.textContent = this.cam ? '📷 Kamerayı kapat' : '📷 Kamera'
    cam.classList.toggle('on', !!this.cam)
    const scr = this.el('btn-screen')
    scr.textContent = this.screen ? '🖥️ Paylaşımı durdur' : '🖥️ Ekran paylaş'
    scr.classList.toggle('on', !!this.screen)

    this.renderMyBubble()
    for (const m of this.members.values()) this.updateBubble(m)
  },

  syncTheater (inRoomView) {
    const th = this.el('theater')
    if (!th) return
    let stream = null; let label = ''
    if (inRoomView && this.room === activeConv.topic) {
      for (const m of this.members.values()) {
        const s = this.screenStream(m)
        if (s && s.getVideoTracks().some(t => t.readyState === 'live')) { stream = s; label = m.name + ' ekranını paylaşıyor'; break }
      }
      if (!stream && this.screen) { stream = this.screen; label = 'Ekranını paylaşıyorsun' }
    }
    th.classList.toggle('hidden', !stream)
    const v = this.el('theater-video')
    if (stream && v.srcObject !== stream) v.srcObject = stream
    if (!stream) v.srcObject = null
    this.el('theater-label').textContent = label
  },

  makeBubble (code, name, avatar, mine) {
    const b = document.createElement('div')
    b.className = 'lr-bubble' + (mine ? ' me' : '')
    const face = avatar
      ? `<div class="lr-face" style="background:var(--bg3);font-size:38px">${avatar}<video autoplay playsinline muted></video><span class="lr-initial" style="display:none"></span></div>`
      : `<div class="lr-face" style="background:${colorOf(code)}"><video autoplay playsinline muted></video><span class="lr-initial">${initialOf(name, code)}</span></div>`
    b.innerHTML = face + '<div class="lr-name"></div>'
    this.el('lr-stage').appendChild(b)
    if (mine) this.makeDraggable(b)
    else b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showVolPopover(code, b) })
    // çift tıkla → kamerayı/görüntüyü tam ekran
    b.addEventListener('dblclick', () => {
      const v = b.querySelector('video')
      if (v && b.querySelector('.lr-face').classList.contains('has-video') && v.requestFullscreen) v.requestFullscreen().catch(() => {})
    })
    return b
  },

  positionBubble (m) {
    if (m.bubble) { m.bubble.style.left = m.pos.x + '%'; m.bubble.style.top = m.pos.y + '%' }
  },

  updateBubble (m) {
    if (this.room == null) return
    if (!activeConv || activeConv.type !== 'room' || activeConv.topic !== this.room) return
    if (!m.bubble || !m.bubble.isConnected) m.bubble = this.makeBubble(m.code, m.name, m.avatar, false)
    this.positionBubble(m)
    // Medya bağlantısı kurulana kadar ⏳, koparsa ⚠️ — "ses/görüntü niye yok"u görünür kıl
    const st = m.pc.connectionState
    const mark = st === 'connected' ? '' : (st === 'failed' || st === 'disconnected' ? ' ⚠️' : ' ⏳')
    m.bubble.title = mark ? 'medya bağlantısı: ' + st + ' — NAT/güvenlik duvarı engelliyor olabilir (README: ice.json)' : ''
    m.bubble.querySelector('.lr-name').textContent = m.name + (m.muted ? ' 🔇' : '') + mark
    const face = m.bubble.querySelector('.lr-face')
    const vid = m.bubble.querySelector('video')
    const main = this.mainStream(m)
    face.classList.toggle('has-video', m.video)
    if (m.video && main && vid.srcObject !== main) vid.srcObject = main
    if (!m.video) vid.srcObject = null
  },

  _myBubble: null,
  renderMyBubble () {
    if (!this._myBubble || !this._myBubble.isConnected) {
      this._myBubble = this.makeBubble(this.code(), state.me.name, state.me.avatar, true)
    }
    const b = this._myBubble
    b.style.left = this.myPos.x + '%'
    b.style.top = this.myPos.y + '%'
    b.querySelector('.lr-name').textContent = (state.me.name || 'sen') + ' (sen)' + (this.muted ? ' 🔇' : '')
    const vid = b.querySelector('video')
    b.querySelector('.lr-face').classList.toggle('has-video', !!this.cam)
    if (this.cam && vid.srcObject !== this.cam) vid.srcObject = this.cam
    if (!this.cam) vid.srcObject = null
  },

  makeDraggable (b) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      b.setPointerCapture(e.pointerId)
      const stage = this.el('lr-stage')
      const move = (ev) => {
        const r = stage.getBoundingClientRect()
        this.myPos = {
          x: Math.min(96, Math.max(4, ((ev.clientX - r.left) / r.width) * 100)),
          y: Math.min(88, Math.max(10, ((ev.clientY - r.top) / r.height) * 100))
        }
        b.style.left = this.myPos.x + '%'
        b.style.top = this.myPos.y + '%'
        this.updateAllPanners()
        this.sendPos()
      }
      const up = () => {
        b.removeEventListener('pointermove', move)
        b.removeEventListener('pointerup', up)
        this.sendState()
      }
      b.addEventListener('pointermove', move)
      b.addEventListener('pointerup', up)
    })
  }
}

// ============================================================
// DM birebir arama
// ============================================================
const CallMgr = {
  peer: null, peerName: '', state: null, // 'out' | 'in' | 'active'
  pc: null, mic: null, cam: null, screen: null,
  streams: {}, remoteScreenSid: null,
  polite: false, makingOffer: false,
  ringCtx: null, ringInt: null, tmo: null, t0: 0, timeInt: null, audioEl: null,

  sendRtc (to, data) { send({ t: 'rtc', to, data }) },
  friendName (code) {
    const f = state.friends.find(x => x.code === code)
    return f ? (f.name || 'anon') : 'anon'
  },

  async start (code) {
    if (this.state) return
    if (Voice.room) Voice.leave()
    try {
      this.mic = await buildMic(this) // cihaz seçimi + AGC + giriş kazancı
    } catch (e) { alert('Mikrofona erişilemedi: ' + e.message); return }
    this.peer = code
    this.peerName = this.friendName(code)
    this.state = 'out'
    this.polite = state.me.code > code
    this.sendRtc(code, { kind: 'call-req', name: state.me.name })
    this.showRing(this.peerName, 'aranıyor...', false)
    this.startRing(420, 1.1)
    this.tmo = setTimeout(() => this.end(), 35000)
  },

  onRtc (from, data) {
    switch (data.kind) {
      case 'call-req': {
        if (this.state) { this.sendRtc(from, { kind: 'call-reject', busy: true }); return }
        this.peer = from
        this.peerName = String(data.name || this.friendName(from)).slice(0, 64)
        this.state = 'in'
        this.polite = state.me.code > from
        this.showRing(this.peerName, 'seni arıyor...', true)
        this.startRing(520, 0.5)
        this.tmo = setTimeout(() => this.reject(), 35000)
        break
      }
      case 'call-accept': if (this.state === 'out' && from === this.peer) this.begin(); break
      case 'call-reject':
        if (from === this.peer && this.state) {
          this.cleanup()
          alert(data.busy ? 'Meşgul.' : 'Aramayı reddetti.')
        }
        break
      case 'call-end': if (from === this.peer) this.cleanup(); break
      case 'call-state':
        if (from === this.peer) { this.remoteScreenSid = data.screen || null; this.renderVideos() }
        break
      case 'sdp': if (from === this.peer && this.pc) this.onSdp(data.desc); break
      case 'ice': if (from === this.peer && this.pc) { try { this.pc.addIceCandidate(data.cand || undefined).catch(() => {}) } catch {} } break
    }
  },

  async accept () {
    try {
      this.mic = await buildMic(this) // cihaz seçimi + AGC + giriş kazancı
    } catch (e) { alert('Mikrofon yok: ' + e.message); this.reject(); return }
    this.sendRtc(this.peer, { kind: 'call-accept' })
    this.begin()
  },

  reject () {
    if (this.peer) this.sendRtc(this.peer, { kind: 'call-reject' })
    this.cleanup()
  },

  begin () {
    this.stopRing()
    clearTimeout(this.tmo)
    document.getElementById('modal-ring').classList.add('hidden')
    this.state = 'active'
    this.makePC()
    this.t0 = Date.now()
    document.getElementById('call-widget').classList.remove('hidden')
    document.getElementById('call-name').textContent = this.peerName
    this.timeInt = setInterval(() => {
      const el = document.getElementById('call-time')
      const st = this.pc ? this.pc.connectionState : ''
      if (st && st !== 'connected') {
        el.textContent = (st === 'failed' || st === 'disconnected') ? 'bağlantı sorunu ⚠️' : 'bağlanıyor…'
        return
      }
      const s = Math.floor((Date.now() - this.t0) / 1000)
      el.textContent =
        String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
    }, 1000)
    this.renderVideos()
  },

  makePC () {
    const pc = new RTCPeerConnection(rtcConfig())
    this.pc = pc
    for (const t of this.mic.getTracks()) pc.addTrack(t, this.mic)
    pc.onicecandidate = (e) => this.sendRtc(this.peer, { kind: 'ice', scope: 'call', cand: e.candidate })
    pc.onnegotiationneeded = async () => {
      // Oda tarafındaki glare önlemiyle aynı: kibar taraf ilk teklifi beklesin
      if (this.polite && !pc.remoteDescription) return
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        this.sendRtc(this.peer, { kind: 'sdp', scope: 'call', desc: pc.localDescription })
      } catch (e) { console.error(e) } finally { this.makingOffer = false }
    }
    pc.ontrack = (e) => {
      const s = e.streams[0]
      if (!s) return
      if (!this.streams[s.id]) {
        this.streams[s.id] = s
        s.onaddtrack = () => this.renderVideos()
        s.onremovetrack = () => this.renderVideos()
      }
      if (s.getAudioTracks().length && !this.audioEl) {
        this.audioEl = new Audio()
        this.audioEl.srcObject = s
        this.audioEl.volume = Math.min(1, (Number(_settings().outVol) || 100) / 100)
        const sp = _settings().spkId
        if (sp && this.audioEl.setSinkId) this.audioEl.setSinkId(sp).catch(() => {})
        this.audioEl.play().catch(() => {})
      }
      this.renderVideos()
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') this._restarted = false
      if (st === 'failed') {
        if (!this._restarted) { this._restarted = true; try { pc.restartIce() } catch { this.cleanup() } } else this.cleanup()
      } else if (st === 'closed') this.cleanup()
    }
  },

  async onSdp (desc) {
    const pc = this.pc
    try {
      const collision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable')
      if (collision && !this.polite) return
      await pc.setRemoteDescription(desc)
      if (desc.type === 'offer') {
        await pc.setLocalDescription()
        this.sendRtc(this.peer, { kind: 'sdp', scope: 'call', desc: pc.localDescription })
      }
    } catch (e) { console.error('call sdp', e) }
  },

  renderVideos () {
    const remote = document.getElementById('call-remote')
    const local = document.getElementById('call-local')
    let rs = null
    // ekran paylaşımı varsa onu, yoksa kamerayı göster
    if (this.remoteScreenSid && this.streams[this.remoteScreenSid]) rs = this.streams[this.remoteScreenSid]
    else {
      for (const s of Object.values(this.streams)) {
        if (s.getVideoTracks().some(t => t.readyState === 'live')) { rs = s; break }
      }
    }
    remote.classList.toggle('on', !!rs)
    if (rs && remote.srcObject !== rs) remote.srcObject = rs
    if (!rs) remote.srcObject = null
    const ls = this.cam
    local.classList.toggle('on', !!ls)
    if (ls && local.srcObject !== ls) local.srcObject = ls
    if (!ls) local.srcObject = null
    document.getElementById('call-mute').classList.toggle('on', this.mutedFlag)
    document.getElementById('call-cam').classList.toggle('on', !!this.cam)
    document.getElementById('call-screen').classList.toggle('on', !!this.screen)
  },

  mutedFlag: false,
  toggleMute () {
    if (!this.mic) return
    this.mutedFlag = !this.mutedFlag
    this.mic.getAudioTracks().forEach(t => { t.enabled = !this.mutedFlag })
    this.renderVideos()
  },
  setOutputVolume (pct) { if (this.audioEl) this.audioEl.volume = Math.min(1, Math.max(0, (Number(pct) || 0) / 100)) },
  setInputVolume (pct) { if (this.inGain) this.inGain.gain.value = Math.max(0, Number(pct) || 0) / 100 },
  setSink (id) { try { if (this.audioEl && this.audioEl.setSinkId) this.audioEl.setSinkId(id || '').catch(() => {}) } catch {} },
  async toggleCam () {
    if (!this.pc) return
    if (!this.cam) {
      try { this.cam = await navigator.mediaDevices.getUserMedia(camConstraints()) } catch { return }
      this.pc.addTrack(this.cam.getVideoTracks()[0], this.mic)
    } else {
      this._dropSenders(this.cam)
      this.cam.getTracks().forEach(t => t.stop())
      this.cam = null
    }
    this.renderVideos()
  },
  async toggleScreen () {
    if (!this.pc) return
    if (!this.screen) {
      try { this.screen = await navigator.mediaDevices.getDisplayMedia(screenConstraints()) } catch { return }
      const tr = this.screen.getVideoTracks()[0]
      tr.onended = () => { if (this.screen) this.toggleScreen() }
      this.pc.addTrack(tr, this.screen)
      this.sendRtc(this.peer, { kind: 'call-state', screen: this.screen.id })
    } else {
      this._dropSenders(this.screen)
      this.screen.getTracks().forEach(t => t.stop())
      this.screen = null
      this.sendRtc(this.peer, { kind: 'call-state', screen: null })
    }
    this.renderVideos()
  },
  _dropSenders (stream) {
    for (const s of this.pc.getSenders()) {
      if (s.track && stream.getTracks().includes(s.track)) { try { this.pc.removeTrack(s) } catch {} }
    }
  },

  end () {
    if (this.peer) this.sendRtc(this.peer, { kind: 'call-end' })
    this.cleanup()
  },

  cleanup () {
    this.stopRing()
    clearTimeout(this.tmo)
    clearInterval(this.timeInt)
    if (this.pc) { try { this.pc.close() } catch {}; this.pc = null }
    for (const s of ['mic', 'micRaw', 'cam', 'screen']) {
      if (this[s]) { this[s].getTracks().forEach(t => t.stop()); this[s] = null }
    }
    if (this._denoise) { this._denoise._rnnoiseCleanup && this._denoise._rnnoiseCleanup(); this._denoise = null }
    this.inGain = null
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null }
    this.streams = {}
    this.remoteScreenSid = null
    this.mutedFlag = false
    this._restarted = false
    this.state = null
    this.peer = null
    document.getElementById('call-widget').classList.add('hidden')
    document.getElementById('modal-ring').classList.add('hidden')
  },

  showRing (name, sub, incoming) {
    document.getElementById('ring-name').textContent = name
    document.getElementById('ring-sub').textContent = sub
    document.getElementById('btn-ring-accept').style.display = incoming ? '' : 'none'
    document.getElementById('modal-ring').classList.remove('hidden')
  },

  startRing (freq, gap) {
    try {
      this.ringCtx = new AudioContext()
      const beep = () => {
        if (!this.ringCtx) return
        const o = this.ringCtx.createOscillator()
        const g = this.ringCtx.createGain()
        g.gain.setValueAtTime(0.07, this.ringCtx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.001, this.ringCtx.currentTime + 0.4)
        o.frequency.value = freq
        o.connect(g).connect(this.ringCtx.destination)
        o.start(); o.stop(this.ringCtx.currentTime + 0.45)
      }
      beep()
      this.ringInt = setInterval(beep, gap * 1000)
    } catch {}
  },
  stopRing () {
    clearInterval(this.ringInt)
    if (this.ringCtx) { this.ringCtx.close().catch(() => {}); this.ringCtx = null }
  }
}

window.Voice = Voice
window.CallMgr = CallMgr

document.addEventListener('DOMContentLoaded', () => {
  Voice.el('btn-voice-join').onclick = () => Voice.join()
  Voice.el('btn-voice-leave').onclick = () => Voice.leave()
  Voice.el('btn-mic').onclick = () => Voice.toggleMute()
  Voice.el('btn-cam').onclick = () => Voice.toggleCam()
  Voice.el('btn-screen').onclick = () => Voice.toggleScreen()
  document.getElementById('btn-ring-accept').onclick = () => CallMgr.accept()
  document.getElementById('btn-ring-reject').onclick = () => (CallMgr.state === 'out' ? CallMgr.end() : CallMgr.reject())
  document.getElementById('call-mute').onclick = () => CallMgr.toggleMute()
  document.getElementById('call-cam').onclick = () => CallMgr.toggleCam()
  document.getElementById('call-screen').onclick = () => CallMgr.toggleScreen()
  document.getElementById('call-end').onclick = () => CallMgr.end()

  // ---- tam ekran ----
  const fs = (el) => { if (el && el.srcObject && el.requestFullscreen) el.requestFullscreen().catch(() => {}) }
  const theaterVid = document.getElementById('theater-video')
  const theaterFull = document.getElementById('theater-full')
  if (theaterFull) theaterFull.onclick = () => fs(theaterVid)
  if (theaterVid) theaterVid.ondblclick = () => fs(theaterVid)
  const callRemote = document.getElementById('call-remote')
  if (callRemote) callRemote.ondblclick = () => fs(callRemote)
})

window.addEventListener('beforeunload', () => {
  if (Voice.room) Voice.leave()
  if (CallMgr.state) CallMgr.end()
})
