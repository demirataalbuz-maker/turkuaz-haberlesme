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
function micConstraints (forceStandard = false) {
  const s = _settings()
  // Stüdyo (yüksek kalite) modu: AEC + AGC kapalı → ham, temiz, pompalamayan ses.
  // AEC kapalı olduğu için YALNIZ kulaklıkta güvenli (hoparlörde yankı yapar).
  const hq = !!s.micHQ
  const limiter = s.micLimiter !== false && s.micLimiter !== 'off' // dengeleme açıksa tarayıcı AGC'yi biz devralırız
  // 'strong' (RNNoise) modda tarayıcının kendi gürültü bastırması kapalı — işi RNNoise yapar
  const audio = {
    echoCancellation: !hq,
    noiseSuppression: forceStandard || (s.noise || 'standard') === 'standard',
    // Klasik modda kendi kompresör/limiter'ımız YOK, o yüzden seviye işini
    // tarayıcının AGC'sine bırakırız. Gelişmiş modda dengeleme açıksa AGC
    // kapanır ki çift işleme olmasın.
    autoGainControl: !hq && (isClassicAudio() || !limiter)
  }
  if (s.micId) audio.deviceId = { exact: s.micId }
  return { audio }
}
function camConstraints () {
  const s = _settings()
  const h = { 480: 480, 720: 720, 1080: 1080 }[s.camRes] || 480
  // 480p kameralar 4:3, HD kameralar 16:9 çeker
  const video = { width: { ideal: h === 480 ? 640 : Math.round(h * 16 / 9) }, height: { ideal: h } }
  if (s.camId) video.deviceId = { exact: s.camId }
  return { video }
}
function screenConstraints () {
  const s = _settings()
  const video = { frameRate: Number(s.screenFps) || 15 }
  const res = { 720: 720, 1080: 1080, 1440: 1440, 2160: 2160 }[s.screenRes]
  if (res) video.height = { ideal: res } // 'source' → sınırsız (kaynak çözünürlüğü)
  return { video, audio: !!s.screenAudio }
}
// Ekran paylaşımı bitrate hedefi: çözünürlük + FPS ayarına göre. Mesh'te bu
// değer HER katılımcıya ayrı gönderilir; sınır yoksa yüksek çözünürlük
// upload'u doldurup herkesin sesini bozar.
function videoBitrate (isScreen) {
  const s = _settings()
  if (!isScreen) return { 480: 800000, 720: 1500000, 1080: 2500000 }[s.camRes] || 800000
  const base = { 720: 2500000, 1080: 5000000, 1440: 8000000, 2160: 14000000, source: 8000000 }[s.screenRes || '720'] || 2500000
  const fps = Number(s.screenFps) || 15
  return Math.round(base * (fps >= 60 ? 1.4 : fps >= 30 ? 1 : 0.7))
}
// Ekran akışı: birden çok ekran varsa kendi seçicimizi göster (Electron preload),
// yoksa/tek ekransa getDisplayMedia'ya düş (tarayıcı + tek ekran için güvenli).
async function getScreenStream () {
  const stream = await getScreenStreamRaw()
  // Ekran içeriği çoğunlukla metin/arayüz: encoder netliği korusun,
  // bant genişliği daralınca çözünürlük yerine FPS'ten fedakârlık etsin.
  for (const t of stream.getVideoTracks()) { try { t.contentHint = 'detail' } catch {} }
  return stream
}
async function getScreenStreamRaw () {
  const c = screenConstraints()
  if (window.turkuazDesktop && window.turkuazDesktop.getSources) {
    let sources = []
    try { sources = await window.turkuazDesktop.getSources() } catch {}
    if (sources && sources.length > 1) {
      const id = await pickScreen(sources)
      if (!id) throw new Error('picker-iptal')
      // Uzaktan kontrol bu ekranın sınırlarına göre eşleme yapacak
      const picked = sources.find(s => s.id === id)
      Voice._sharedDisplayId = (picked && picked.displayId) || null
      const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: c.video.frameRate } }
      if (c.video.height) video.mandatory.maxHeight = c.video.height.ideal
      if (c.audio) {
        // Sistem sesi (Windows'ta loopback) — aynı istekte audio da desktop'tan
        try { return await navigator.mediaDevices.getUserMedia({ video, audio: { mandatory: { chromeMediaSource: 'desktop' } } }) } catch {}
        // ses yakalanamıyorsa (Linux/mac) sessiz paylaşıma düş
      }
      return await navigator.mediaDevices.getUserMedia({ video })
    }
  }
  // Tek ekran / tarayıcı yolu: hangi ekran olduğunu bilmiyoruz → birincil varsay
  Voice._sharedDisplayId = null
  try {
    return await navigator.mediaDevices.getDisplayMedia(c)
  } catch (e) {
    // sesli istek desteklenmiyorsa (platform) sessiz dene
    if (c.audio) return await navigator.mediaDevices.getDisplayMedia({ video: c.video })
    throw e
  }
}
function pickScreen (sources) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement
    const back = document.createElement('div'); back.className = 'modal-back'
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', 'Paylaşılacak ekranı seç')
    const modal = document.createElement('div'); modal.className = 'modal'; modal.style.width = '640px'
    modal.innerHTML = '<h2>Hangi ekranı paylaşayım?</h2><div class="screen-grid"></div><div class="modal-btns"><button class="cancel">Vazgeç</button></div>'
    const grid = modal.querySelector('.screen-grid')
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      back.remove()
      if (typeof syncDialogInert === 'function') syncDialogInert()
      setTimeout(() => {
        const top = typeof topVisibleModal === 'function' && topVisibleModal()
        if (top) {
          const target = typeof modalFocusables === 'function' && modalFocusables(top)[0]
          if (target) target.focus()
        } else if (returnFocus && returnFocus.isConnected && !returnFocus.closest('[inert]') && returnFocus.focus) returnFocus.focus()
      }, 0)
      resolve(value)
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && (typeof topVisibleModal !== 'function' || topVisibleModal() === back)) {
        e.preventDefault(); e.stopImmediatePropagation(); finish(null)
      }
    }
    for (const s of sources) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'screen-opt'
      item.setAttribute('aria-label', s.name + ' ekranını paylaş')
      const img = document.createElement('img'); img.src = s.thumb; img.alt = ''
      const label = document.createElement('span'); label.textContent = s.name
      item.append(img, label)
      item.onclick = () => finish(s.id)
      grid.appendChild(item)
    }
    modal.querySelector('.cancel').onclick = () => finish(null)
    back.onclick = (e) => { if (e.target === back) finish(null) }
    document.addEventListener('keydown', onKey, true)
    back.appendChild(modal); document.body.appendChild(back)
    if (typeof syncDialogInert === 'function') syncDialogInert()
    setTimeout(() => grid.querySelector('.screen-opt')?.focus(), 0)
  })
}
// RNNoise'un AudioWorklet modülünü bu context'e bir kez yükle.
// Worklet ayrı gerçek-zamanlı ses thread'inde çalışır: arayüz/oyun ana
// thread'i meşgul edince ScriptProcessor'daki gibi çıtırdamaz.
async function ensureRnnWorklet (ctx) {
  if (ctx._rnnWorklet === undefined) {
    try { await ctx.audioWorklet.addModule('rnnoise-worklet.js'); ctx._rnnWorklet = true } catch { ctx._rnnWorklet = false }
  }
  return ctx._rnnWorklet
}
// DeepFilterNet3 düğümü: worklet köprüsü + model worker'ı birlikte kurar.
// Başarısızlıkta null döner; buildMic RNNoise'a düşer. (Model ~16 MB pakete
// gömülü — vendor/dfn/; çalıştırıcı vendor/ort/ — CDN'e çıkılmaz.)
async function makeDfnNode (ctx) {
  try {
    if (!ctx._dfnModule) { await ctx.audioWorklet.addModule('dfn-worklet.js'); ctx._dfnModule = true }
    const worker = new Worker('dfn-worker.js')
    const ready = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('model 15 sn içinde yüklenemedi')), 15000)
      worker.onmessage = (e) => {
        if (e.data === 'ready') { clearTimeout(to); resolve() }
        else if (e.data && e.data.t === 'fail') { clearTimeout(to); reject(new Error(e.data.err)) }
      }
      worker.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'dfn-worker yüklenemedi')) }
    })
    const ch = new MessageChannel()
    worker.postMessage({ t: 'init', model: 'vendor/dfn/denoiser_model.onnx', port: ch.port2 }, [ch.port2])
    await ready
    const node = new AudioWorkletNode(ctx, 'dfn-bridge', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    node.port.postMessage({ t: 'connect', port: ch.port1 }, [ch.port1])
    node._dfnWorker = worker
    node._rnnoiseCleanup = () => {
      try { node.port.postMessage('destroy') } catch {}
      try { worker.terminate() } catch {}
    }
    return node
  } catch (e) {
    console.error('DeepFilterNet yüklenemedi:', e)
    return null
  }
}
// Ham mikrofonu WebAudio'dan geçirip giriş kazancı uygular; gönderilecek
// (işlenmiş) akışı döndürür. micRaw/inGain/ctx referanslarını obj'ye yazar.
async function buildMic (obj) {
  const noiseMode = _settings().noise || 'standard'
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!obj.ctx) obj.ctx = new Ctx({ sampleRate: 48000 }) // RNNoise/DFN 48 kHz ister
  try { obj.ctx.resume() } catch {}
  // Tercih sırası: DeepFilterNet → RNNoise worklet → ScriptProcessor → tarayıcı NS
  let dfnNode = null
  if (noiseMode === 'dfn') {
    dfnNode = await makeDfnNode(obj.ctx)
    if (!dfnNode && window.toast) toast('DeepFilterNet başlatılamadı; RNNoise kullanılıyor.', 'warn', 5000)
  }
  const wantsStrong = noiseMode === 'strong' || (noiseMode === 'dfn' && !dfnNode)
  const workletOk = wantsStrong && await ensureRnnWorklet(obj.ctx)
  const rnnoiseReady = !!dfnNode || workletOk || !!(window.RNNoise && window.RNNoise.ready)
  let constraints = micConstraints(wantsStrong && !rnnoiseReady)
  let raw
  try {
    raw = await navigator.mediaDevices.getUserMedia(constraints)
  } catch (err) {
    // Kaydedilmiş cihaz çıkarılmış/değişmiş olabilir. Oyun başlayınca kullanıcıyı
    // ayarlara mahkûm etmeden varsayılan mikrofona güvenli biçimde düş.
    if (!_settings().micId) throw err
    constraints = micConstraints(wantsStrong && !rnnoiseReady)
    delete constraints.audio.deviceId
    raw = await navigator.mediaDevices.getUserMedia(constraints)
    if (window.toast) toast('Seçili mikrofon bulunamadı; varsayılan mikrofon kullanılıyor.', 'warn', 5000)
  }
  obj.micRaw = raw
  const src = obj.ctx.createMediaStreamSource(raw)
  obj.inGain = obj.ctx.createGain()
  obj.inGain.gain.value = (Number(_settings().inVol) || 100) / 100
  const dest = obj.ctx.createMediaStreamDestination()
  // AI gürültü engelleme: DFN → RNNoise worklet → ScriptProcessor sırasıyla
  let head = src
  if (dfnNode) {
    src.connect(dfnNode); head = dfnNode; obj._denoise = dfnNode
  }
  if (head === src && wantsStrong && workletOk) {
    try {
      const dn = new AudioWorkletNode(obj.ctx, 'rnnoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      dn._rnnoiseCleanup = () => { try { dn.port.postMessage('destroy') } catch {} }
      src.connect(dn); head = dn; obj._denoise = dn
    } catch {}
  }
  if (head === src && wantsStrong && window.RNNoise && window.RNNoise.ready) {
    const dn = window.RNNoise.makeDenoiseNode(obj.ctx)
    if (dn) { src.connect(dn); head = dn; obj._denoise = dn }
  }
  if (head === src && wantsStrong && window.toast) {
    toast('AI gürültü engelleme henüz hazır değil; bu katılımda standart koruma kullanılıyor.', 'warn', 5000)
  }
  head.connect(obj.inGain)
  // KLASİK MOD: gürültü engelleme (yukarıdaki DFN/RNNoise/tarayıcı NS) AYNEN
  // kalır — asıl istenen zaten oydu. Atlanan şey SEVİYE ZİNCİRİ: yüksek-geçiren
  // filtre + kompresör + makeup kazanç + brickwall limiter + kapı. Sesi ezen,
  // üst üste binince boğuklaştıran katman buydu; gürültü engelleme değil.
  if (isClassicAudio()) {
    obj.inGain.connect(dest)
    obj._gateOutNode = obj.inGain
    attachMonitor(obj)
    return dest.stream
  }
  // Akıllı seviye normalizasyonu: pompalayan tarayıcı AGC yerine hafif kompresör
  // (kısık konuşanı kaldırır) + limiter (tepeleri yakalar). Tutarlı, rahat seviye
  // ve pompalama YOK. micLimiter açıkken tarayıcı AGC kapalıdır (çift işleme olmaz).
  // Ses seviyesi dengeleme: 'off' | 'normal' | 'strong' (ses sabitleme).
  // Eski boolean'dan göç: true→normal, false→off.
  const lvl = _settings().micLimiter === false ? 'off' : (_settings().micLimiter === 'strong' ? 'strong' : 'normal')
  let chainOut
  if (lvl !== 'off') {
    const strong = lvl === 'strong'
    // Yüksek-geçiren: 85Hz altı gürültüyü (uğultu, masa titreşimi, plozif) temizler
    // — sesi BOĞMADAN netleştirir (radyo/podcast standardı).
    const hpf = obj.ctx.createBiquadFilter()
    hpf.type = 'highpass'; hpf.frequency.value = 85; hpf.Q.value = 0.7
    const comp = obj.ctx.createDynamicsCompressor()
    if (strong) {
      // SES SABİTLEME: agresif — bağıran ve fısıldayan aynı seviyede çıkar (oyun için)
      comp.threshold.value = -34; comp.knee.value = 22; comp.ratio.value = 6; comp.attack.value = 0.008; comp.release.value = 0.3
    } else {
      // NORMAL: hafif, doğal — tepeleri toplar, kısıkları biraz kaldırır
      comp.threshold.value = -22; comp.knee.value = 26; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.26
    }
    const makeup = obj.ctx.createGain(); makeup.gain.value = strong ? 2.4 : 1.35
    // brickwall limiter: tepe aşımı olmadan yakalar → cızırtı/distortion yok
    const limiter = obj.ctx.createDynamicsCompressor()
    limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1
    obj.inGain.connect(hpf); hpf.connect(comp); comp.connect(makeup); makeup.connect(limiter)
    chainOut = limiter
  } else {
    chainOut = obj.inGain
  }
  // Noise gate (opsiyonel): konuşmayınca mikrofonu tam keser → kimse klavye/fan
  // duymaz. Konuşunca hızlı açılır, sustuktan sonra 220ms açık tutup yumuşak kapanır.
  if (_settings().noiseGate) {
    const gate = obj.ctx.createGain(); gate.gain.value = 0
    const gan = obj.ctx.createAnalyser(); gan.fftSize = 256
    // ÖN-BAKIŞ (lookahead): karar GİRİŞTEN anlık alınır ama kapıdan geçen sinyal
    // GECİKTİRİLİR. Böylece kapı, kelimenin ilk hecesi kapıya VARMADAN açılmış
    // olur. Bu olmadan yoklama (25ms) + rampa (~12ms) kadarlık bir pay kelime
    // başlarını yiyordu — "p/t/k/s" ünsüzleri kesiliyor diye duyulan şey buydu.
    const look = obj.ctx.createDelay(0.2)
    look.delayTime.value = GATE_LOOKAHEAD
    // Kapı kararı GİRİŞ enerjisinden alınır (limiter makeup'tan bağımsız → "ses
    // sabitleme" açıkken bile eşik tutarlı). Kapılanan sinyal işlenmiş chainOut.
    obj.inGain.connect(gan); chainOut.connect(look); look.connect(gate); gate.connect(dest)
    // Akıllı gate (opt-in, DENEYSEL): VAD hazırsa "insan sesi mi" kararı — yüksek ama
    // konuşma-olmayan sesi (klavye/fan) kesmede amplitüdden iyi. Hazır değilse/kapalıysa
    // amplitüde güvenli düşer (mevcut davranış).
    if (_settings().smartGate) startVad(obj)
    const buf = new Uint8Array(gan.fftSize)
    let openUntil = 0
    obj._ngInt = setInterval(() => {
      const now = performance.now()
      const sens = gateSens()
      let voice
      if (_settings().smartGate && obj._vadReady && (now - (obj._vadTs || 0) < 500)) {
        voice = (obj._vadProb || 0) > vadProbThreshold(sens)
      } else {
        gan.getByteTimeDomainData(buf)
        // TEPE yerine RMS: tek bir çıtırtı kapıyı açmasın, alçak sesli konuşma
        // da tepe düşük olsa bile enerjisiyle yakalansın (daha kararlı karar).
        let sum = 0
        for (const v of buf) { const d = (v - 128) / 128; sum += d * d }
        const rms = Math.sqrt(sum / buf.length)
        voice = rms > rmsThreshold(sens)
      }
      if (voice) openUntil = now + gateHold(sens)
      const open = now < openUntil
      // Kapanış rampası uzun: cümle sonu aniden kesilip "yutulmuş" gibi olmasın.
      try { gate.gain.setTargetAtTime(open ? 1 : 0, obj.ctx.currentTime, open ? 0.004 : 0.12) } catch {}
    }, 25)
    obj._gateOutNode = gate
  } else {
    chainOut.connect(dest)
    obj._gateOutNode = chainOut
  }
  attachMonitor(obj)
  return dest.stream
}

// Kendini dinleme (podcast modu): İŞLENMİŞ sesi kendi kulaklığına ver — yani
// karşı tarafın DUYDUĞUNUN aynısını duyarsın. Yalnız kulaklıkta güvenli;
// hoparlörde mikrofona geri kaçar (uğultu/feedback).
function attachMonitor (obj) {
  obj._monitorGain = obj.ctx.createGain()
  obj._monitorGain.gain.value = monitorGain()
  obj._gateOutNode.connect(obj._monitorGain)
  obj._monitorGain.connect(obj.ctx.destination)
}

// Ses işleme modu. Varsayılan 'classic' — özel zincir yok.
function isClassicAudio () { return (_settings().audioMode || 'classic') !== 'advanced' }

// ---- gürültü kapısı ayarları ----
// Kapının hassasiyeti ARTIK AYARLANABİLİR. Önceden eşikler koda gömülüydü
// (rms yerine tepe > 7/128 ≈ -25 dBFS ve VAD > 0.5); ayarlardaki hassasiyet
// kaydırıcısı ise yalnız "sesle konuş" modunu etkiliyordu, kapıyı DEĞİL.
// Alçak sesli konuşan biri kapıya takılıyor ve düzeltemiyordu.
const GATE_LOOKAHEAD = 0.02 // 20ms ön-bakış (kelime başları kesilmesin)
function gateSens () {
  const v = Number(_settings().gateSens)
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50
}
// Hassasiyet yüksek → eşik DÜŞÜK (fısıltıyı bile geçirir, gürültü de geçebilir).
// Ölçek RMS; eski kod TEPE değerine bakıyordu (7/128 ≈ 0.055 tepe ≈ 0.018 RMS,
// konuşma için ~3 tepe/RMS oranıyla). Bu yüzden eğri şöyle kuruldu:
//   sens=0   → ~0.015  (eski davranışın sıkı ucu)
//   sens=50  → ~0.008  (varsayılan: eskisinin ~2 katı müsamahalı)
//   sens=100 → ~0.001  (fısıltı bile geçer)
function rmsThreshold (sens) { return 0.001 + (100 - sens) * 0.00014 }
function vadProbThreshold (sens) { return Math.max(0.15, Math.min(0.85, 0.9 - sens * 0.006)) }
// Hassasiyet yüksek → daha uzun açık tut (cümle içi duraklamada kapanmasın)
function gateHold (sens) { return 180 + sens * 3 }
function monitorGain () {
  const s = _settings()
  if (!s.monitor) return 0
  const v = Number(s.monitorVol)
  return (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 60) / 100
}
// Monitör tap'i MediaStreamDestination'dan ÖNCE olduğu için, gönderilen track'i
// kapatmak (susturma/PTT) kendi kulaklığındaki sesi susturmaz. Karşı taraf seni
// duymuyorken sen kendini duyuyor olursan yanıltıcı olur → mikrofon fiilen
// kapalıyken monitörü de sustur.
function applyMonitor (obj) {
  if (!obj || !obj._monitorGain || !obj.ctx) return
  const off = obj.muted || obj.mutedFlag || obj._gateOpen === false
  const g = off ? 0 : monitorGain()
  try { obj._monitorGain.gain.setTargetAtTime(g, obj.ctx.currentTime, 0.03) } catch { obj._monitorGain.gain.value = g }
}

const LR_SCALE = 8
const VOICE_HEARTBEAT_MS = 5000
const VOICE_STALE_MS = 18000
const VOICE_STATS_MS = 4000
// Faz 2 — yakınlık-tabanlı ses budama (yalnız kalabalık + konumsal modda)
const PRUNE_MIN = 12   // bu kişi sayısının ALTINDA budama YOK (herkes birbirini duyar)
const AUDIBLE_IN = 40  // sahne-yüzdesi mesafesi: bu altına gelince duyulmaya başlar
const AUDIBLE_OUT = 52 // bu üstüne çıkınca kesilir (histerezis — sınırda titremesin)
// Faz 2 — isimli bölgeler (sahnede sabit alanlar; konum senkron olduğu için
// herkes aynı bölgeleri ve kimin nerede olduğunu hesaplar — yeni protokol yok).
// ŞİMDİLİK RAFTA: kafa karıştırıcı bulundu. true yapınca tüm bölge mantığı
// (çizim + ses çarpanı + bölge-bazlı duyulurluk) geri gelir; kod korunuyor.
const ZONES_ON = false
const ZONES = [
  { id: 'sohbet', name: 'Sohbet', emoji: '☕', x: 5, y: 12, w: 40, h: 36 },
  { id: 'oyun', name: 'Oyun', emoji: '🎮', x: 55, y: 12, w: 40, h: 36 },
  { id: 'chill', name: 'Chill', emoji: '🎧', x: 30, y: 60, w: 40, h: 32 }
]
const ZONE_SAME = 1.15 // aynı bölge: net + hafif yüksek
const ZONE_CROSS = 0.2 // farklı bölge: boğuk (duvar arkası hissi)

// Adaptif ses bitrate'i: AZ kişide yüksek kalite (neredeyse şeffaf), kalabalıkta
// mesh uplink'ini koru. Kalite katmanı — kimseyi zorlamaz, bant varken kullanır.
function audioBitrate () {
  const n = (window.Voice && Voice.members) ? Voice.members.size : 1
  if (n <= 1) return 128000 // 1:1 — neredeyse şeffaf
  if (n <= 3) return 96000
  if (n <= 6) return 72000
  return 56000 // kalabalık — toplam uplink'i tut
}
function tuneAudioSender (sender) {
  if (!sender || !sender.getParameters || !sender.setParameters) return
  try {
    const p = sender.getParameters()
    if (!p.encodings || !p.encodings.length) p.encodings = [{}]
    p.encodings[0].maxBitrate = audioBitrate()
    sender.setParameters(p).catch(() => {})
  } catch {}
}

// Opus SDP ince ayarı: FEC (kayıpta çıtırtı yok, gecikme maliyeti sıfır) + mono
// (ses zaten mono, bant verimli). Ödünsüz kalite/sağlamlık kazancı. Güvenli:
// hata olursa orijinal SDP döner.
function tuneOpusSdp (sdp) {
  try {
    const rtp = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)
    if (!rtp) return sdp
    const pt = rtp[1]
    const fmtpRe = new RegExp('(a=fmtp:' + pt + ' )([^\\r\\n]*)')
    if (fmtpRe.test(sdp)) {
      return sdp.replace(fmtpRe, (all, pre, params) => {
        let p = params
        if (!/useinbandfec=/.test(p)) p += ';useinbandfec=1'
        if (!/stereo=/.test(p)) p += ';stereo=0'
        return pre + p
      })
    }
    return sdp.replace(rtp[0], rtp[0] + '\r\na=fmtp:' + pt + ' minptime=10;useinbandfec=1;stereo=0')
  } catch { return sdp }
}
// setLocalDescription() yerine: teklifi/yanıtı oluştur → Opus'u ayarla → uygula.
async function setLocalMunged (pc, kind) {
  const desc = kind === 'answer' ? await pc.createAnswer() : await pc.createOffer()
  try { desc.sdp = tuneOpusSdp(desc.sdp) } catch {}
  await pc.setLocalDescription(desc)
}

// Video göndericileri (kamera/ekran) için üst sınır: ses göndericisindeki
// 64k sınırının video karşılığı. scale, ağ kötüleşince kademeli kısmak için.
function tuneVideoSender (sender, isScreen, scale = 1) {
  if (!sender || !sender.getParameters || !sender.setParameters) return
  try {
    const p = sender.getParameters()
    if (!p.encodings || !p.encodings.length) p.encodings = [{}]
    // Ekranda çözünürlüğü koru (metin okunsun), kamerada dengeli davran.
    // AMA biri ekranımızı kontrol ediyorsa tam tersi: akıcılık > netlik.
    // Kontrol altındayken düşen FPS doğrudan "geç tepki veren fare" demek.
    const beingControlled = !!(window.RemoteControl && RemoteControl._armed)
    // Kontrol altında kare hızı yükseldiği için bitrate de yükselmeli, yoksa
    // encoder aynı bütçeyi daha çok kareye böler → her kare bulanıklaşır.
    const boost = isScreen && beingControlled ? 1.6 : 1
    p.encodings[0].maxBitrate = Math.max(150000, Math.round(videoBitrate(isScreen) * scale * boost))
    p.degradationPreference = !isScreen ? 'balanced' : (beingControlled ? 'maintain-framerate' : 'maintain-resolution')
    sender.setParameters(p).catch(() => {})
  } catch {}
}

// Video codec tercihi: 'h264' çoğu ekran kartında DONANIMLA kodlanır → oyun
// oynarken ekran paylaşımı işlemciyi yemez. 'av1' aynı bitrate'te en net
// görüntü ama yazılım kodlar (güçlü PC ister). 'auto' = tarayıcı varsayılanı.
// addTrack'ten hemen sonra, teklif (offer) oluşmadan çağrılmalı.
function preferVideoCodec (pc) {
  const want = _settings().vidCodec
  if (!want || want === 'auto') return
  if (!window.RTCRtpTransceiver || !RTCRtpTransceiver.prototype.setCodecPreferences) return
  let caps
  try { caps = RTCRtpSender.getCapabilities('video') } catch { return }
  if (!caps || !caps.codecs || !caps.codecs.length) return
  const mime = ('video/' + want).toLowerCase()
  const preferred = caps.codecs.filter(c => c.mimeType.toLowerCase() === mime)
  if (!preferred.length) return // bu codec yoksa varsayılanda kal
  const rest = caps.codecs.filter(c => c.mimeType.toLowerCase() !== mime)
  for (const t of pc.getTransceivers()) {
    if (t.sender && t.sender.track && t.sender.track.kind === 'video') {
      try { t.setCodecPreferences(preferred.concat(rest)) } catch {}
    }
  }
}

// Opus RED (yedekli kodlama): ses paketini önceki karelerle birlikte gönderir →
// kayıpta çıtırtı olmaz (FEC'in üstüne bir kat zırh). Tarayıcı desteklemezse
// sessizce atlar. Bant biraz artar ama adaptif bitrate dengeliyor.
function preferAudioRed (pc) {
  if (!window.RTCRtpTransceiver || !RTCRtpTransceiver.prototype.setCodecPreferences) return
  let caps
  try { caps = RTCRtpReceiver.getCapabilities('audio') } catch { return }
  if (!caps || !caps.codecs || !caps.codecs.length) return
  const red = caps.codecs.find(c => /(^|\/)red$/i.test(c.mimeType) || /audio\/red/i.test(c.mimeType))
  if (!red) return // RED yok → varsayılanda kal
  const opus = caps.codecs.filter(c => /opus/i.test(c.mimeType))
  const rest = caps.codecs.filter(c => c !== red && !/opus/i.test(c.mimeType))
  const ordered = [red, ...opus, ...rest]
  for (const t of pc.getTransceivers()) {
    if (t.sender && t.sender.track && t.sender.track.kind === 'audio') {
      try { t.setCodecPreferences(ordered) } catch {}
    }
  }
}

// Alıcı audio jitter buffer hedefi: düşük gecikme modunda ~50ms (Chrome adaptif
// varsayılanından düşük → minimum gecikme), kapalıyken varsayılana bırak (null).
// playoutDelayHint (saniye) eski tarayıcı yedeği.
function applyReceiverLatency (pc, low) {
  if (!pc || !pc.getReceivers) return
  const ms = low ? 50 : null
  for (const r of pc.getReceivers()) {
    if (!r.track || r.track.kind !== 'audio') continue
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms } catch {}
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = ms == null ? null : ms / 1000 } catch {}
  }
}

// Uzaktan kontrol açıkken VİDEO tamponunu da sıfıra çek. WebRTC varsayılan
// olarak akıcılık için ~100ms+ biriktirir; izlerken iyi, kontrol ederken en
// büyük gecikme kaynağı bu. Kontrol bitince varsayılana (null) döneriz.
function applyVideoLatency (pc, controlling) {
  if (!pc || !pc.getReceivers) return
  const ms = controlling ? 0 : null
  for (const r of pc.getReceivers()) {
    if (!r.track || r.track.kind !== 'video') continue
    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms } catch {}
    try { if ('playoutDelayHint' in r) r.playoutDelayHint = ms == null ? null : 0 } catch {}
  }
}

// Silero VAD (opt-in akıllı gate, DENEYSEL): obj.inGain'i taplar, "konuşma olasılığı"nı
// obj._vadProb'a yazar. Analiz-only worklet → 0-kazanç sink → dest (grafik pull etsin).
// Her adım try/catch — yüklenemez/hata verirse gate sessizce amplitüde düşer. Ses
// yolu VAD'den GEÇMEZ (ek gecikme yok). vendor/vad/PROVENANCE.md
function startVad (obj) {
  if (obj._vadStarted || !obj.ctx || !obj.inGain) return
  obj._vadStarted = true; obj._vadReady = false
  ;(async () => {
    try {
      const ctx = obj.ctx
      if (!ctx._vadModule) { await ctx.audioWorklet.addModule('vad-worklet.js'); ctx._vadModule = true }
      const worker = new Worker('vad-worker.js')
      const node = new AudioWorkletNode(ctx, 'vad-worklet', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination)
      const ch = new MessageChannel()
      worker.postMessage({ port: ch.port2 }, [ch.port2])
      node.port.postMessage({ port: ch.port1 }, [ch.port1])
      worker.postMessage({ t: 'init', model: 'vendor/vad/silero_vad.onnx' })
      worker.onmessage = (e) => {
        const m = e.data
        if (m && m.ready) obj._vadReady = true
        else if (m && typeof m.prob === 'number') { obj._vadProb = m.prob; obj._vadTs = performance.now() }
        else if (m && m.error) obj._vadReady = false
      }
      worker.onerror = () => { obj._vadReady = false }
      obj.inGain.connect(node); node.connect(sink)
      obj._vadNode = node; obj._vadWorker = worker; obj._vadSink = sink
    } catch { obj._vadReady = false; obj._vadStarted = false }
  })()
}
function stopVad (obj) {
  try { if (obj._vadNode) { obj._vadNode.disconnect(); obj._vadNode = null } } catch {}
  try { if (obj._vadSink) { obj._vadSink.disconnect(); obj._vadSink = null } } catch {}
  try { if (obj._vadWorker) { obj._vadWorker.terminate(); obj._vadWorker = null } } catch {}
  obj._vadStarted = false; obj._vadReady = false
}

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
  deafened: false,
  _vch: 'genel', // içinde bulunduğum ses kanalı (aynı oda içinde mesh partition)
  ctx: null,
  master: null,
  hb: null,
  statsTimer: null,
  joining: false,
  seen: new Map(),
  _myAnalyser: null,
  _watching: new Set(),        // izlediğim yayınların anahtarları (üye kodu | 'me')
  _streamPanels: new Map(),    // anahtar -> { el, video, label }

  code () { return state.me.code },

  defaultPos (code) {
    let h = 0
    for (const c of code) h = (h * 33 + c.charCodeAt(0)) >>> 0
    // `>>` 32 bit hash'in yüksek biti set olduğunda negatif değer üretir ve
    // balonu sahnenin üstüne taşır. Unsigned kaydırma + güvenli kenar payları.
    return { x: 14 + (h % 73), y: 27 + ((h >>> 7) % 43) }
  },

  seenMap (room) {
    if (!this.seen.has(room)) this.seen.set(room, new Map())
    return this.seen.get(room)
  },
  markSeen (room, code, name, vch) {
    const prev = this.seenMap(room).get(code)
    this.seenMap(room).set(code, { name: name || 'anon', lastSeen: Date.now(), vch: vch || (prev && prev.vch) || 'genel' })
  },
  pruneSeen () {
    const now = Date.now()
    let changed = false
    for (const [room, peers] of this.seen) {
      for (const [code, info] of peers) {
        if (now - (info.lastSeen || 0) <= VOICE_STALE_MS) continue
        const member = room === this.room && this.members.get(code)
        // Aktif WebRTC sesi çalışıyorsa yalnız heartbeat gecikmiştir; kesme.
        if (member && member.pc && member.pc.connectionState === 'connected') continue
        peers.delete(code)
        if (member) this.removeMember(code)
        changed = true
      }
      if (!peers.size) this.seen.delete(room)
    }
    if (changed) this.sync()
  },

  sendRtc (to, data) { send({ t: 'rtc', to, data: { ...data, room: this.room } }) },

  stateEv () {
    return {
      kind: 'voice', on: true, muted: this.muted, video: !!this.cam,
      screen: this.screen ? this.screen.id : null, vch: this._vch,
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

  async join (vch) {
    if (!activeConv || activeConv.type !== 'room') return
    vch = vch || 'genel'
    if (this.joining) return
    if (this.room === activeConv.topic && this._vch === vch) return // zaten bu ses kanalındayım
    this.joining = true
    this.sync()
    if (window.CallMgr && CallMgr.state) CallMgr.end()
    if (this.room) this.leave() // başka oda VEYA aynı odada farklı ses kanalı → önce ayrıl
    this._pendingVch = vch
    try {
      this.ctx = new AudioContext({ sampleRate: 48000 })
      await this.ctx.resume()
      this.mic = await buildMic(this) // ham mikrofon → (RNNoise) → giriş kazancı → gönderilen akış
      this.setSink(_settings().spkId || '')
    } catch (e) {
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
      this.joining = false
      this.sync()
      const message = 'Mikrofona erişilemedi: ' + e.message
      if (window.toast) toast(message, 'error', 6000); else alert(message)
      return
    }
    this.master = this.ctx.createGain()
    this.master.gain.value = (Number(_settings().outVol) || 100) / 100
    this.master.connect(this.ctx.destination)
    // kendi konuşma göstergem (giriş kazancından sonra)
    this._myAnalyser = this.ctx.createAnalyser()
    this._myAnalyser.fftSize = 256
    this.inGain.connect(this._myAnalyser)
    this.room = activeConv.topic
    this._vch = this._pendingVch || 'genel' // hangi ses kanalındayım (mesh partition)
    this._roomJoinTs = Date.now() // ilk kadro sesini bastırmak için (#15)
    this.muted = false
    this.myPos = this.defaultPos(this.code())
    const rawTrack = this.micRaw && this.micRaw.getAudioTracks()[0]
    if (rawTrack) {
      rawTrack.onended = () => {
        if (!this.room) return
        if (window.toast) toast('Mikrofon bağlantısı kesildi; sesli sohbetten ayrıldın.', 'error', 6000)
        this.leave()
      }
    }
    this.sendState()
    this.hb = setInterval(() => this.sendState(), VOICE_HEARTBEAT_MS)
    this.statsTimer = setInterval(() => this.sampleStats(), VOICE_STATS_MS)
    this._speakInt = setInterval(() => this.speakTick(), 180)
    this._startGate() // konuşma moduna göre mikrofon kapısı
    this.joining = false
    if (window.toast) toast('Sesli sohbete bağlandın.', 'success')
    this._maybeHeadphoneTip()
    this.sync()
  },

  // Konumsal moda ilk girişte (oturum başına bir kez, "bir daha gösterme"li)
  // kulaklık öner — hoparlörde HRTF yön/mesafe hissi zayıflar.
  _maybeHeadphoneTip () {
    if (this.flat() || this._hpTipShown) return
    this._hpTipShown = true
    try { if (localStorage.getItem('turkuaz.hpTipHide') === '1') return } catch {}
    setTimeout(() => {
      if (!this.room || this.flat() || !window.toast) return
      toast('🎧 Konumsal ses en iyi kulaklıkla — hoparlörde yön/mesafe zayıflar. İstersen Ayarlar\'dan 💬 Düz mod\'a geç.', 'info', 7000)
      try { localStorage.setItem('turkuaz.hpTipHide', '1') } catch {} // bir kez göster, bir daha nag etme
    }, 1200)
  },

  leave () {
    if (!this.room) return
    if (window.Games) Games.onVoiceLeave() // oyun açıksa kapat (oyuncuysak herkes için bitir)
    send({ t: 'room-ev', room: this.room, ev: { kind: 'voice', on: false } })
    clearInterval(this.hb)
    clearInterval(this.statsTimer)
    this.statsTimer = null
    clearInterval(this._speakInt)
    this._stopGate()
    this._clearStreamPanels()
    for (const code of [...this.members.keys()]) this.removeMember(code)
    for (const s of ['mic', 'micRaw', 'cam', 'screen']) {
      if (this[s]) { this[s].getTracks().forEach(t => { t.onended = null; t.stop() }); this[s] = null }
    }
    if (this._denoise) { this._denoise._rnnoiseCleanup && this._denoise._rnnoiseCleanup(); this._denoise = null }
    if (this._ngInt) { clearInterval(this._ngInt); this._ngInt = null }
    stopVad(this)
    this.inGain = null
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
    this.room = null
    this._vch = 'genel'; this._pendingVch = null
    this.joining = false
    this.myPos = null
    this._myBubble = null
    this._focusCode = null
    this.sync()
  },

  toggleMute () {
    if (!this.mic) return
    // Sağırken mikrofonu açmak sağırlığı da kaldırır (Discord davranışı)
    if (this.deafened && this.muted) return this.toggleDeafen()
    this.muted = !this.muted
    this._micGate(this._gateOpen !== false)
    this.sendState()
    this.sync()
  },

  // Sağırlaştırma (deafen): kimseyi duyma + mikrofonu da kapat (#18).
  _applyMasterGain () {
    if (this.master) this.master.gain.value = this.deafened ? 0 : (Number(_settings().outVol) || 100) / 100
    for (const m of this.members.values()) this._applyElVolume(m) // düz-mod audioEl'leri de
  },
  toggleDeafen () {
    if (!this.room) return
    this.deafened = !this.deafened
    if (this.deafened) {
      this._wasMutedBeforeDeafen = this.muted
      if (!this.muted && this.mic) { this.muted = true; this._micGate(this._gateOpen !== false); this.sendState() }
    } else if (!this._wasMutedBeforeDeafen && this.muted && this.mic) {
      this.muted = false; this._micGate(this._gateOpen !== false); this.sendState()
    }
    this._applyMasterGain()
    this.sync()
  },

  // ---- konuşma modu: mikrofon kapısı (açık / ses etkinliği / bas-konuş) ----
  _gateOpen: true,
  _micGate (open) {
    this._gateOpen = open
    if (this.mic) this.mic.getAudioTracks().forEach(t => { t.enabled = open && !this.muted })
    applyMonitor(this) // susturulmuş/kapalıyken kendini duyma
  },
  _startGate () {
    this._stopGate()
    const S = () => (window.TurkuazSettings && TurkuazSettings.get()) || {}
    const mode = S().speakMode || 'open'
    if (mode === 'open') { this._micGate(true); return }
    if (mode === 'vad') {
      this._micGate(false)
      let lastVoice = 0
      this._gateInt = setInterval(() => {
        const lvl = this._level(this._myAnalyser)
        const thr = 4 + (100 - (Number(S().vadSens) || 50)) * 0.4 // hassasiyet yüksek → eşik düşük
        const now = Date.now()
        if (lvl > thr) lastVoice = now
        this._micGate(now - lastVoice < 350) // 350ms hangover
      }, 60)
    } else if (mode === 'ptt') {
      this._micGate(false)
      const key = () => S().pttKey || 'Space'
      this._pttDown = (e) => {
        if (e.code !== key()) return
        const t = e.target && e.target.tagName
        if (t === 'INPUT' || t === 'TEXTAREA') return
        e.preventDefault(); this._micGate(true)
      }
      this._pttUp = (e) => { if (e.code === key()) this._micGate(false) }
      // Pencere odağı oyun/Alt+Tab nedeniyle giderken keyup kaybolursa mikrofon
      // açık takılmasın. Global basılı-tut PTT gelene kadar güvenli davranış bu.
      this._pttBlur = () => this._micGate(false)
      document.addEventListener('keydown', this._pttDown)
      document.addEventListener('keyup', this._pttUp)
      window.addEventListener('blur', this._pttBlur)
    }
  },
  _stopGate () {
    if (this._gateInt) { clearInterval(this._gateInt); this._gateInt = null }
    if (this._pttDown) { document.removeEventListener('keydown', this._pttDown); this._pttDown = null }
    if (this._pttUp) { document.removeEventListener('keyup', this._pttUp); this._pttUp = null }
    if (this._pttBlur) { window.removeEventListener('blur', this._pttBlur); this._pttBlur = null }
  },

  // ---- ayar ekranından canlı uygulanan ses kontrolleri ----
  setOutputVolume (pct) {
    if (this.master) this.master.gain.value = Math.max(0, Number(pct) || 0) / 100
    for (const m of this.members.values()) this._applyElVolume(m) // düz-mod audioEl'leri de güncelle
  },
  setInputVolume (pct) { if (this.inGain) this.inGain.gain.value = Math.max(0, Number(pct) || 0) / 100 },
  setSink (id) {
    try { if (this.ctx && this.ctx.setSinkId) this.ctx.setSinkId(id || '').catch(() => {}) } catch {}
    // izlenen yayın panellerini de yeni hoparlöre yönlendir
    for (const p of this._streamPanels.values()) {
      try { if (p.video.setSinkId) p.video.setSinkId(id || '').catch(() => {}) } catch {}
    }
  },

  // ---- Discord-tarzı mikrofon testi (kendini duy) ----
  // Gerçek GÖNDERİM zincirinden (DFN/RNNoise + akıllı seviye + stüdyo modu) geçip
  // karşının duyacağı sesi SEN duyarsın → ikinci kişiye gerek yok, tüm ses işlemeyi
  // tek başına test edersin. Kulaklık şart (hoparlörde geri besleme yankısı yapar).
  async micSelfTest (onLevel) {
    await this.micSelfTestStop()
    const obj = {}
    let stream
    try { stream = await buildMic(obj) } catch (e) {
      if (window.toast) toast('Mikrofona erişilemedi: ' + e.message, 'error', 5000)
      return false
    }
    this._test = obj
    const back = new Audio(); back.srcObject = stream; back.play().catch(() => {})
    try { const spk = _settings().spkId; if (spk && back.setSinkId) back.setSinkId(spk).catch(() => {}) } catch {}
    obj._testBack = back
    const an = obj.ctx.createAnalyser(); an.fftSize = 256
    obj.ctx.createMediaStreamSource(stream).connect(an)
    const buf = new Uint8Array(an.fftSize)
    const tick = () => {
      an.getByteTimeDomainData(buf)
      let dev = 0; for (const v of buf) dev = Math.max(dev, Math.abs(v - 128))
      if (onLevel) onLevel(Math.min(100, (dev / 90) * 100))
      obj._testRaf = requestAnimationFrame(tick)
    }
    tick()
    return true
  },
  async micSelfTestStop () {
    const obj = this._test
    if (!obj) return
    this._test = null
    if (obj._testRaf) cancelAnimationFrame(obj._testRaf)
    if (obj._testBack) { try { obj._testBack.pause() } catch {}; obj._testBack.srcObject = null; obj._testBack = null }
    try { if (obj.micRaw) obj.micRaw.getTracks().forEach(t => t.stop()) } catch {}
    if (obj._denoise && obj._denoise._rnnoiseCleanup) { try { obj._denoise._rnnoiseCleanup() } catch {} }
    if (obj._ngInt) { clearInterval(obj._ngInt); obj._ngInt = null }
    stopVad(obj)
    try { if (obj.ctx) await obj.ctx.close() } catch {}
  },

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
    if (m) {
      if (m.gain) m.gain.gain.value = Math.max(0, Number(pct) || 0) / 100 // konumsal yol (senkron: UI/test okur)
      this._applyElVolume(m) // düz-mod doğrudan oynatma yolu
    }
  },

  // ---- konuşana odak: bir kişiye tıkla → onu yükselt, ötekileri kıs ----
  _focusCode: null,
  // Odak + bölge modülasyonu SADECE spatialGain'e uygulanır; kişi-bazlı ses
  // (m.gain) ayrı ve dokunulmaz — böylece ses ayarı = base × (odak×bölge).
  applyGains () {
    for (const m of this.members.values()) {
      if (!m.spatialGain) continue
      const focused = this._focusCode === m.code
      const f = this._focusCode ? (focused ? 1.35 : 0.18) : 1
      // odaktakini net duymak istiyorsun → farklı bölgede olsa bile bölge cezası yok
      const z = focused ? 1 : this.zoneFactor(m)
      m.spatialGain.gain.setTargetAtTime(f * z, this.ctx ? this.ctx.currentTime : 0, 0.08)
    }
  },
  toggleFocus (code) {
    this._focusCode = this._focusCode === code ? null : code
    this.applyGains()
    for (const m of this.members.values()) {
      if (m.bubble) m.bubble.classList.toggle('focused', this._focusCode === m.code)
      if (m.bubble) m.bubble.classList.toggle('ducked', !!this._focusCode && this._focusCode !== m.code)
    }
  },
  showVolPopover (code, bubbleEl) {
    const old = this.el('lr-volpop'); if (old) old.remove()
    const m = this.members.get(code)
    const cur = Math.round(this.memberVol(code) * 100)
    const pop = document.createElement('div')
    pop.id = 'lr-volpop'; pop.className = 'lr-volpop'
    pop.innerHTML = `<div class="lr-volname">${esc(this.dispName(m))}</div>
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
      } catch (e) {
        const message = 'Kameraya erişilemedi: ' + e.message
        if (window.toast) toast(message, 'error', 6000); else alert(message)
        return
      }
      const track = this.cam.getVideoTracks()[0]
      track.onended = () => { if (this.cam) this.toggleCam() }
      for (const m of this.members.values()) {
        tuneVideoSender(m.pc.addTrack(track, this.mic), false)
        preferVideoCodec(m.pc)
      }
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
        this.screen = await getScreenStream()
      } catch (e) {
        if (e && e.message !== 'picker-iptal' && window.toast) toast('Ekran paylaşımı başlatılamadı: ' + e.message, 'error', 6000)
        return
      }
      const track = this.screen.getVideoTracks()[0]
      track.onended = () => { if (this.screen) this.toggleScreen() }
      // tüm parçalar (sistem sesi dahil) gitsin
      for (const m of this.members.values()) {
        for (const t of this.screen.getTracks()) {
          const s = m.pc.addTrack(t, this.screen)
          if (t.kind === 'video') tuneVideoSender(s, true)
        }
        preferVideoCodec(m.pc)
      }
    } else {
      if (window.RemoteControl) RemoteControl.onShareStopped() // kontrol oturumu varsa kapat
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
      polite: this.code() > code,
      pendingIce: [], recoveryTimer: null, restarted: false,
      quality: 'connecting', rtt: null, jitter: null, loss: null, _packetBase: null,
      _audible: true // varsayılan duyulur → az kişide gereksiz replaceTrack yok
    }
    this.members.set(code, m)
    this.createPC(m)
    // İlk kadro sesini bastır: yalnız ben odadayken SONRADAN katılana çal (#15)
    if (Date.now() - (this._roomJoinTs || 0) > 2500) this._playJoinLeave(true)
    this.sync()
    return m
  },

  createPC (m) {
    const pc = new RTCPeerConnection(rtcConfig())
    m.pc = pc
    for (const track of this.mic.getTracks()) {
      const sender = pc.addTrack(track, this.mic)
      if (track.kind === 'audio') { tuneAudioSender(sender); m.micSender = sender } // budama için sakla
    }
    if (this.cam) tuneVideoSender(pc.addTrack(this.cam.getVideoTracks()[0], this.mic), false)
    if (this.screen) {
      for (const t of this.screen.getTracks()) {
        const s = pc.addTrack(t, this.screen)
        if (t.kind === 'video') tuneVideoSender(s, true)
      }
    }
    preferVideoCodec(pc)
    preferAudioRed(pc) // Opus RED — kayıp zırhı
    this._setupCtrlChannel(m) // uzaktan kontrol veri kanalı (ekran paylaşımı)

    pc.onicecandidate = (e) => this.sendRtc(m.code, { kind: 'ice', cand: e.candidate })
    pc.onnegotiationneeded = async () => {
      // Açılış glare'ini kökten önle: iki taraf da aynı anda teklif atarsa
      // kibar tarafın rollback'i sonrası Chromium'da ICE toplama takılabiliyor.
      // Kibar taraf İLK teklifi hiç atmaz — parçaları zaten answer'a biner;
      // sonradan gerekirse (remoteDescription varken) teklif atabilir.
      if (m.polite && !pc.remoteDescription) return
      try {
        m.makingOffer = true
        await setLocalMunged(pc, 'offer') // Opus FEC + mono
        this.sendRtc(m.code, { kind: 'sdp', desc: pc.localDescription })
      } catch (e) { console.error(e) } finally { m.makingOffer = false }
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      if (e.track && e.track.kind === 'audio') applyReceiverLatency(pc, !!_settings().lowLatency) // düşük gecikme modu
      if (!m.streams[stream.id]) {
        m.streams[stream.id] = stream
        stream.onaddtrack = () => this.refreshMedia(m)
        stream.onremovetrack = () => this.refreshMedia(m)
      }
      this.refreshMedia(m)
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') {
        m.restarted = false
        m.quality = 'good'
        clearTimeout(m.recoveryTimer)
        m.recoveryTimer = null
      }
      if (st === 'disconnected') {
        m.quality = 'warn'
        clearTimeout(m.recoveryTimer)
        m.recoveryTimer = setTimeout(() => {
          if (!this.members.has(m.code) || m.pc !== pc || pc.connectionState !== 'disconnected') return
          if (!m.restarted) {
            m.restarted = true
            try { pc.restartIce() } catch { this.removeMember(m.code) }
            this.sync()
          }
        }, 3500)
      }
      if (st === 'failed') {
        m.quality = 'bad'
        // İlk çare: aynı bağlantıda ICE'ı tazele; ikinci kez düşerse üyeyi çıkar
        // (karşı tarafın 8 sn'lik durum kalp atışı üyeyi yeniden kurar = tekrar dene)
        if (!m.restarted) { m.restarted = true; try { pc.restartIce() } catch { this.removeMember(m.code); return } } else { this.removeMember(m.code); return }
      } else if (st === 'closed') { this.removeMember(m.code); return }
      this.sync()
    }
  },

  // ---- uzaktan kontrol veri kanalı ----
  // Kontrol olayları (fare/klavye) düşük gecikmeli, sıralı bir RTCDataChannel
  // üzerinden gider (DHT sinyal rölesi değil). Kanalı tek taraf açsın diye
  // 'polite' kutupluluğu kullanılır: impolite (polite=false) taraf açar,
  // polite taraf ondatachannel ile alır. Böylece çift kanal olmaz.
  _setupCtrlChannel (m) {
    const pc = m.pc
    if (!m.polite) {
      try { this._wireCtrl(m, pc.createDataChannel('turkuaz-ctrl', { ordered: true })) } catch {}
    } else {
      pc.addEventListener('datachannel', (e) => {
        if (e.channel && e.channel.label === 'turkuaz-ctrl') this._wireCtrl(m, e.channel)
      })
    }
  },
  _wireCtrl (m, dc) {
    m.ctrlDC = dc
    dc.onmessage = (e) => { if (window.RemoteControl) RemoteControl.onMessage(m.code, e.data) }
    dc.onclose = () => { if (window.RemoteControl) RemoteControl.onPeerGone(m.code) }
  },
  // RemoteControl buradan mesaj yollar (JSON). Kanal hazır değilse false.
  ctrlSend (code, obj) {
    const m = this.members.get(code)
    if (m && m.ctrlDC && m.ctrlDC.readyState === 'open') {
      try { m.ctrlDC.send(JSON.stringify(obj)); return true } catch {}
    }
    return false
  },
  // Kontrol oturumu açılıp kapandığında çağrılır (RemoteControl).
  //  - İZLEYEN: gelen videonun jitter tamponunu sıfırla (en büyük gecikme payı)
  //  - PAYLAŞAN: göndericiyi akıcılık öncelikli moda al (maintain-framerate)
  onControlSession (active, peerCode) {
    for (const [code, m] of this.members) {
      if (!m.pc) continue
      if (!peerCode || code === peerCode) { try { applyVideoLatency(m.pc, active) } catch {} }
    }
    if (this.screen) {
      for (const [, m] of this.members) {
        if (!m.pc || !m.pc.getSenders) continue
        for (const s of m.pc.getSenders()) {
          if (s.track && s.track.kind === 'video' && this.screen.getTracks().includes(s.track)) {
            try { tuneVideoSender(s, true) } catch {}
          }
        }
      }
      // Kontrol altındayken ekran içeriği "hareket" gibi kodlansın (oyun/video)
      // ve kare hızı ayardan bağımsız olarak en az 60'a çıksın: 15 fps'te
      // uzaktan oyun oynanmaz, fare "yapış yapış" hissettirir. Kontrol bitince
      // kullanıcının kendi ayarına dönülür.
      const userFps = Number((window.TurkuazSettings && TurkuazSettings.get().screenFps) || 15)
      const fps = active ? Math.max(60, userFps) : userFps
      for (const t of this.screen.getVideoTracks()) {
        try { t.contentHint = active ? 'motion' : 'detail' } catch {}
        try { t.applyConstraints({ frameRate: fps }).catch(() => {}) } catch {}
      }
    }
  },
  // Kendini dinleme seviyesini canlı uygula (ayar değişince yeniden katılmaya gerek yok)
  refreshMonitor () { applyMonitor(this); applyMonitor(window.CallMgr) },
  // Kapı hassasiyeti zaten her döngüde ayardan okunuyor; bu yalnız geri bildirim
  // için (ve ileride ek durum gerekirse tek yer olsun diye).
  refreshGate () { return gateSens() },
  // O an ekran paylaşıyor muyum? (karşı taraf beni kontrol edebilsin diye şart)
  amSharing () { return !!this.screen },
  // Uzaktan kontrol imlecinin DOĞRU monitöre eşlenmesi için: hangi ekranı
  // paylaşıyoruz? (çoklu monitörde birincil varsayımı imleci yanlış ekrana atar)
  sharedDisplayId () { return this._sharedDisplayId || null },
  memberName (code) { const m = this.members.get(code); return m ? this.dispName(m) : 'Biri' },

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
      m.gain.gain.value = this.memberVol(m.code) // KİŞİ-BAZLI ses (senkron; ayar UI'ı + test bunu okur)
      m.gain.connect(this.master)
      m.spatialGain = this.ctx.createGain() // ODAK + BÖLGE modülasyonu (ayrı; yumuşak rampa)
      m.spatialGain.connect(m.gain)
      this.routeMember(m) // konumsal (panner) ya da düz (panner bypass) — moda göre
      this.updatePanner(m)
      this.applyGains() // odak/bölge aktifse yeni üye de doğru seviyeye otursun
    }
    m.video = !!(main && main.getVideoTracks().some(t => t.readyState === 'live'))
    this.updateBubble(m)
    this.sync()
  },

  removeMember (code) {
    const m = this.members.get(code)
    if (!m) return
    clearTimeout(m.recoveryTimer)
    try { m.pc.close() } catch {}
    try { m.srcNode && m.srcNode.disconnect() } catch {}
    try { m.panner && m.panner.disconnect() } catch {}
    try { m.spatialGain && m.spatialGain.disconnect() } catch {}
    try { m.gain && m.gain.disconnect() } catch {}
    if (m.audioEl) { m.audioEl.srcObject = null; m.audioEl = null }
    if (m.bubble) m.bubble.remove()
    this.members.delete(code)
    if (window.RemoteControl) RemoteControl.onPeerGone(code) // kontrol oturumu varsa kapat
    if (this._focusCode === code) { this._focusCode = null; this.applyGains() } // odaktaki ayrıldı
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
  updateAllProximity () { for (const m of this.members.values()) this.applyProximity(m) },

  // ---- Faz 2: yakınlık-tabanlı ses budama ----
  // Uzaktaki kişilere mikrofonu göndermeyi keser (replaceTrack(null)) → encode +
  // bant genişliği tasarrufu; simetrik olduğu için karşılıklı kesilir. GÜVENLİK:
  // yalnız kalabalık (>= PRUNE_MIN) + konumsal modda; az kişide/düz modda herkes
  // birbirini duyar (mevcut davranış). replaceTrack renegotiation gerektirmez.
  _micTrack () { return this.mic ? (this.mic.getAudioTracks()[0] || null) : null },
  updateAudible () {
    const crowded = this.members.size >= PRUNE_MIN && !this.flat() && !!this.myPos
    const myZone = crowded ? this.zoneOf(this.myPos) : null
    for (const m of this.members.values()) {
      let on = true
      if (crowded && m.pos) {
        const mz = this.zoneOf(m.pos)
        if (myZone && mz && myZone.id === mz.id) on = true // aynı bölge → mesafeye bakmadan duyulur
        else {
          const d = Math.hypot(m.pos.x - this.myPos.x, m.pos.y - this.myPos.y)
          on = (m._audible !== false) ? d <= AUDIBLE_OUT : d <= AUDIBLE_IN
        }
      }
      this._setAudible(m, on)
    }
    this.applyGains() // bölge çarpanları konuma bağlı → hareket sonrası tazele
  },
  _setAudible (m, on) {
    if (m._audible === on) return
    m._audible = on
    if (m.micSender) { try { m.micSender.replaceTrack(on ? this._micTrack() : null) } catch {} }
    if (m.bubble) m.bubble.classList.toggle('out-of-range', !on)
  },
  _audibleSoon () { clearTimeout(this._audTimer); this._audTimer = setTimeout(() => this.updateAudible(), 140) },

  // ---- Faz 2: isimli bölgeler ----
  zoneOf (pos) {
    if (!ZONES_ON || !pos) return null // raftayken bölge yok → zoneFactor 1, saf mesafe
    for (const z of ZONES) if (pos.x >= z.x && pos.x <= z.x + z.w && pos.y >= z.y && pos.y <= z.y + z.h) return z
    return null
  },
  // Ses çarpanı: aynı bölge net/yüksek, farklı bölge boğuk, açık alan nötr (mesafe)
  zoneFactor (m) {
    if (this.flat() || !this.myPos || !m.pos) return 1
    const mine = this.zoneOf(this.myPos); const theirs = this.zoneOf(m.pos)
    if (mine && theirs) return mine.id === theirs.id ? ZONE_SAME : ZONE_CROSS
    return 1 // biri/ikisi açık alanda ("koridor") → saf mesafe
  },
  // Sahnedeki sabit bölge kutularını (balonların arkasına) bir kez çiz, konumsal
  // modda göster; içinde bulunduğum bölgeyi vurgula.
  // Bölge kutularını çiz + hangi bölgedeysem ipucunu güncelle (canlı, sürüklerken de)
  _syncZoneHint () {
    this.renderZones()
    const hint = document.querySelector('#lr-controls .lr-hint')
    if (!hint) return
    if (this.flat()) { hint.textContent = 'Düz mod — herkes eşit seviyede'; return }
    if (!ZONES_ON) { hint.textContent = 'Balonunu sürükle — sesler bulunduğun yönden gelir'; return }
    const z = this.zoneOf(this.myPos)
    hint.textContent = z
      ? z.emoji + ' ' + z.name + ' bölgesindesin — aynı bölgedekiler net gelir'
      : 'Bir bölgeye gir → orası net; farklı bölge boğuk, açık alan mesafeye göre'
  },
  renderZones () {
    const stage = this.el('lr-stage')
    if (!stage) return
    if (!ZONES_ON) { stage.querySelectorAll('.lr-zones').forEach(z => z.remove()); return } // rafta: çizme
    let wrap = stage.querySelector('.lr-zones')
    if (!wrap) {
      wrap = document.createElement('div'); wrap.className = 'lr-zones'
      for (const z of ZONES) {
        const zd = document.createElement('div'); zd.className = 'lr-zone'; zd.dataset.zone = z.id; zd.dataset.emoji = z.emoji
        zd.style.left = z.x + '%'; zd.style.top = z.y + '%'; zd.style.width = z.w + '%'; zd.style.height = z.h + '%'
        const lbl = document.createElement('span'); lbl.className = 'lr-zone-label'; lbl.textContent = z.emoji + ' ' + z.name
        zd.appendChild(lbl); wrap.appendChild(zd)
      }
      stage.insertBefore(wrap, stage.firstChild)
    }
    const flat = this.flat()
    wrap.classList.toggle('hidden', flat)
    const mine = flat ? null : this.zoneOf(this.myPos)
    wrap.querySelectorAll('.lr-zone').forEach(zd => zd.classList.toggle('here', !!mine && zd.dataset.zone === mine.id))
  },

  // ---- sesli sohbet modu: 'spatial' (oturma odası, HRTF) | 'flat' (düz, eşit seviye) ----
  flat () { return (_settings().voiceMode || 'spatial') === 'flat' },
  // Bir üyenin ses grafiğini moda göre bağla. Konuşma göstergesi (analyser)
  // her modda takılı; fark panner'da: düz modda bypass → yön/mesafe yok.
  routeMember (m) {
    if (!m.srcNode || !m.gain || !m.analyser || !m.spatialGain) return
    try { m.srcNode.disconnect() } catch {}
    try { m.panner.disconnect() } catch {}
    m.srcNode.connect(m.analyser) // konuşma göstergesi her modda (canlı stream'i analiz eder, çıkışa bağlı olması gerekmez)
    if (this.flat()) {
      // DÜZ (varsayılan): WebAudio ÇIKIŞ zincirini baypas et — ses doğrudan
      // audioEl'den çalar → daha az tampon = düşük gecikme + az CPU. Ödünsüz.
      if (m.audioEl) { m.audioEl.muted = false; this._applyElVolume(m) }
    } else {
      // KONUMSAL: panner gerektiği için WebAudio zinciri çalar, audioEl susar
      if (m.audioEl) m.audioEl.muted = true
      m.srcNode.connect(m.panner); m.panner.connect(m.spatialGain)
    }
  },
  // Düz modda kullanıcı + ana sesi doğrudan audioEl.volume'a uygula (WebAudio yok)
  _applyElVolume (m) {
    if (!m.audioEl) return
    const master = this.master ? this.master.gain.value : 1
    m.audioEl.volume = Math.max(0, Math.min(1, this.memberVol(m.code) * master))
  },
  setVoiceMode (mode) {
    mode = mode === 'flat' ? 'flat' : 'spatial'
    if (window.TurkuazSettings) TurkuazSettings.set('voiceMode', mode)
    for (const m of this.members.values()) this.routeMember(m)
    this.sync() // ipucu + sürükle davranışı + düz-mod ızgarası güncellensin
  },
  // Düz modda balonları düzenli ortalı ızgaraya diz (konum sesi etkilemediği için)
  arrangeFlatGrid () {
    const bubbles = []
    if (this._myBubble) bubbles.push(this._myBubble)
    for (const m of this.members.values()) if (m.bubble && m.bubble.isConnected) bubbles.push(m.bubble)
    const n = bubbles.length
    if (!n) return
    const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt(n * 1.7))))
    const rows = Math.ceil(n / cols)
    bubbles.forEach((b, i) => {
      const col = i % cols; const row = Math.floor(i / cols)
      b.style.left = (((col + 0.5) / cols) * 100).toFixed(1) + '%'
      b.style.top = (26 + ((row + 0.5) / rows) * 52).toFixed(1) + '%'
    })
  },

  // ---- katıl/ayrıl bildirim sesi (TS-tarzı) — #15 ----
  // Katıldı: yükselen iki nota; ayrıldı: alçalan. Kısa, ayrı bir AudioContext'ten.
  _playJoinLeave (join) {
    if (!_settings().joinLeaveSound) return
    try {
      const C = window.AudioContext || window.webkitAudioContext
      const c = new C()
      const notes = join ? [523, 784] : [784, 523]
      notes.forEach((f, i) => {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f
        const g = c.createGain(); const t = c.currentTime + i * 0.11
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.13, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15)
        o.connect(g).connect(c.destination)
        o.start(t); o.stop(t + 0.17)
      })
      setTimeout(() => c.close().catch(() => {}), 600)
    } catch {}
  },

  // ---- balon çarpışması: üst üste binme yok, değince "toink" ----
  _toinkLast: null,
  _toink (code) {
    // Çarpışma sesi varsayılan KAPALI (#12): görsel itme kalır, ses rahatsız etmez.
    if (!_settings().bubbleBumpSound) return
    const now = Date.now()
    this._toinkLast = this._toinkLast || {}
    if (now - (this._toinkLast[code] || 0) < 450) return
    this._toinkLast[code] = now
    if (window.Soundboard) Soundboard.play('toink')
  },
  // Verilen (benim) pozisyonu diğer balonların dışına itele (px uzayında)
  clampPos (pos) {
    const stage = this.el('lr-stage')
    const r = stage && stage.getBoundingClientRect()
    if (!r || r.width < 10 || r.height < 10) {
      return { x: Math.min(88, Math.max(12, Number(pos.x) || 50)), y: Math.min(72, Math.max(27, Number(pos.y) || 50)) }
    }
    // 86px yüz + ad etiketi tamamen sahnede kalsın; kısa/dar pencerede payı
    // yüzdeye dinamik çevirerek sürüklenen balonların kesilmesini engelle.
    const padX = Math.min(24, Math.max(6, 50 / r.width * 100))
    const padTop = Math.min(40, Math.max(18, 50 / r.height * 100))
    const padBottom = Math.min(45, Math.max(20, 62 / r.height * 100))
    return {
      x: Math.min(100 - padX, Math.max(padX, Number(pos.x) || 50)),
      y: Math.min(100 - padBottom, Math.max(padTop, Number(pos.y) || 50))
    }
  },
  resolveCollision (pos, R = 80) {
    const stage = this.el('lr-stage')
    if (!stage) return this.clampPos(pos)
    const r = stage.getBoundingClientRect()
    if (r.width < 10 || r.height < 10) return this.clampPos(pos)
    let x = pos.x / 100 * r.width
    let y = pos.y / 100 * r.height
    for (let iter = 0; iter < 3; iter++) {
      let moved = false
      for (const m of this.members.values()) {
        if (!m.pos) continue
        const mx = m.pos.x / 100 * r.width
        const my = m.pos.y / 100 * r.height
        const dx = x - mx; const dy = y - my
        const d = Math.hypot(dx, dy)
        if (d >= R) continue
        if (d < 0.001) { x += R / 2; moved = true; continue }
        const k = (R - d) / d
        x += dx * k; y += dy * k
        moved = true
        this._toink(m.code)
      }
      if (!moved) break
    }
    return this.clampPos({ x: x / r.width * 100, y: y / r.height * 100 })
  },
  // Biri üstüme gelirse kendimi kenara kaydır (küçük histerezisle — ping-pong olmasın)
  avoidOverlap () {
    if (!this.myPos || !this.room) return
    const p = this.resolveCollision(this.myPos, 72)
    if (Math.abs(p.x - this.myPos.x) < 0.5 && Math.abs(p.y - this.myPos.y) < 0.5) return
    this.myPos = p
    if (this._myBubble) { this._myBubble.style.left = p.x + '%'; this._myBubble.style.top = p.y + '%' }
    this.updateAllPanners()
    this.sendPos()
  },

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
    const live = new Set() // hangi bölgelerde şu an konuşan var
    const meSpeaking = !this.muted && this._gateOpen !== false && this._level(this._myAnalyser) > 10
    if (this._myBubble) this._myBubble.classList.toggle('speaking', meSpeaking)
    if (meSpeaking) { const z = this.zoneOf(this.myPos); if (z) live.add(z.id) }
    for (const m of this.members.values()) {
      const sp = this._level(m.analyser) > 10
      if (m.bubble) m.bubble.classList.toggle('speaking', sp)
      if (sp && m.pos) { const z = this.zoneOf(m.pos); if (z) live.add(z.id) }
    }
    // Mekân canlansın: içinde konuşan olan bölge ışıldar
    const stage = this.el('lr-stage')
    if (stage && !this.flat()) stage.querySelectorAll('.lr-zone').forEach(zd => zd.classList.toggle('live', live.has(zd.dataset.zone)))
  },

  async sampleStats () {
    for (const m of this.members.values()) {
      const pc = m.pc
      if (!pc || pc.connectionState !== 'connected') continue
      try {
        const reports = await pc.getStats()
        let pair = null
        let inbound = null
        reports.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r
          if (r.type === 'inbound-rtp' && r.kind === 'audio' && !r.isRemote) inbound = r
        })
        m.rtt = pair && Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null
        m.jitter = inbound && Number.isFinite(inbound.jitter) ? inbound.jitter : null
        // Ağız-kulak gecikme tahmini: tek yön ağ (RTT/2) + jitter buffer + işleme payı
        let jbMs = 0
        if (inbound && Number.isFinite(inbound.jitterBufferDelay) && inbound.jitterBufferEmittedCount > 0) {
          jbMs = (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
        }
        m.latencyMs = (m.rtt != null) ? Math.round((m.rtt * 1000) / 2 + jbMs + 8) : null
        if (inbound) {
          const received = Number(inbound.packetsReceived) || 0
          const lost = Math.max(0, Number(inbound.packetsLost) || 0)
          if (m._packetBase) {
            const receivedDelta = Math.max(0, received - m._packetBase.received)
            const lostDelta = Math.max(0, lost - m._packetBase.lost)
            const totalDelta = receivedDelta + lostDelta
            m.loss = totalDelta ? (lostDelta / totalDelta) * 100 : 0
          }
          m._packetBase = { received, lost }
        }
        const bad = (m.rtt != null && m.rtt > 0.3) || (m.jitter != null && m.jitter > 0.05) || (m.loss != null && m.loss > 5)
        const warn = (m.rtt != null && m.rtt > 0.16) || (m.jitter != null && m.jitter > 0.03) || (m.loss != null && m.loss > 2)
        m.quality = bad ? 'bad' : (warn ? 'warn' : 'good')
        // Adaptif video: ağ kötüleşince bu peer'a giden videoyu kademeli kıs
        // (ses her zaman öncelikli), düzelince yavaşça geri aç.
        if (m.quality === 'bad') this._scaleVideo(m, Math.max(0.25, (m._vidScale || 1) / 2))
        else if (m.quality === 'good') this._scaleVideo(m, Math.min(1, (m._vidScale || 1) * 1.5))
      } catch {}
    }
    this.syncConnectionUI()
  },

  _scaleVideo (m, scale) {
    if (!m.pc || scale === (m._vidScale || 1)) return
    m._vidScale = scale
    for (const s of m.pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue
      const isScreen = !!(this.screen && this.screen.getTracks().includes(s.track))
      tuneVideoSender(s, isScreen, scale)
    }
  },

  connectionSnapshot () {
    const peers = [...this.members.values()]
    const connected = peers.filter(m => m.pc && m.pc.connectionState === 'connected').length
    let quality = 'good'
    if (this.joining) quality = 'connecting'
    else if (peers.some(m => m.quality === 'bad')) quality = 'bad'
    else if (connected < peers.length) quality = 'connecting'
    else if (peers.some(m => m.quality === 'warn')) quality = 'warn'
    const total = peers.length + 1
    const connectedTotal = connected + 1
    let statusText
    if (!peers.length) statusText = 'Tek başınasın · ses hazır'
    else if (connected < peers.length) statusText = `${connectedTotal}/${total} kişi bağlandı`
    else if (quality === 'bad') statusText = `${total} kişi · bağlantı zayıf`
    else if (quality === 'warn') statusText = `${total} kişi · bağlantı dalgalı`
    else statusText = `${total} kişi · bağlantı iyi`
    const lats = peers.map(m => m.latencyMs).filter(Number.isFinite)
    const rtts = peers.map(m => m.rtt).filter(Number.isFinite)
    const losses = peers.map(m => m.loss).filter(Number.isFinite)
    const ping = lats.length ? Math.max(...lats) : (rtts.length ? Math.round(Math.max(...rtts) * 1000) : null)
    const detail = [
      lats.length ? `gecikme ~${Math.max(...lats)} ms` : (rtts.length ? `RTT ${Math.round(Math.max(...rtts) * 1000)} ms` : ''),
      losses.length ? `kayıp %${Math.max(...losses).toFixed(1)}` : ''
    ].filter(Boolean).join(' · ')
    return { quality, statusText, detail, ping }
  },

  syncConnectionUI () {
    const dock = this.el('voice-dock')
    if (dock) {
      dock.classList.toggle('hidden', !this.room)
      if (this.room) {
        const summary = this.connectionSnapshot()
        const room = state.rooms.find(r => r.topic === this.room)
        dock.dataset.quality = summary.quality
        this.el('voice-dock-room').textContent = (room && room.name) || 'Sesli sohbet'
        this.el('voice-dock-status').textContent = summary.statusText + (summary.ping != null ? ' · ' + summary.ping + ' ms' : '')
        dock.title = summary.detail
        const mute = this.el('voice-dock-mute')
        mute.classList.toggle('muted', this.muted)
        mute.textContent = this.muted ? '🔇' : '🎙️'
        mute.setAttribute('aria-pressed', this.muted ? 'true' : 'false')
        mute.setAttribute('aria-label', this.muted ? 'Mikrofonun sesini aç' : 'Mikrofonu sustur')
      }
    }
    const indicator = this.el('lr-connection')
    if (indicator && this.room) {
      const summary = this.connectionSnapshot()
      indicator.dataset.quality = summary.quality
      // Ping'i doğrudan göster (#16) — sadece "iyi" değil, gerçek ms
      indicator.textContent = '● ' + summary.statusText + (summary.ping != null ? ' · ' + summary.ping + ' ms' : '')
      indicator.title = (summary.detail || '') + '  (çift tık: gecikme testi)'
      if (!indicator._latWired) {
        indicator._latWired = true
        indicator.style.cursor = 'pointer'
        indicator.addEventListener('dblclick', () => this.showLatencyTest())
      }
    }
  },

  // Gecikme testi (#16): taze RTT ölç, her kişinin ms'ini listele, yenile tuşu.
  showLatencyTest () {
    if (!this.room) return
    const old = document.getElementById('lat-test'); if (old) old.remove()
    const box = document.createElement('div'); box.id = 'lat-test'; box.className = 'lat-test'
    const render = () => {
      const rows = [...this.members.values()].map(m => {
        const ms = Number.isFinite(m.latencyMs) ? m.latencyMs : null
        const rtt = Number.isFinite(m.rtt) ? Math.round(m.rtt * 1000) : null
        const cls = ms == null ? 'na' : (ms < 60 ? 'good' : ms < 130 ? 'warn' : 'bad')
        const val = ms != null ? ms + ' ms' : (rtt != null ? 'RTT ' + rtt + ' ms' : 'ölçülüyor…')
        return `<div class="lt-row"><span>${esc(this.dispName(m))}</span><b class="lt-${cls}">${val}</b></div>`
      }).join('') || '<div class="lt-empty">Odada başka kimse yok</div>'
      box.innerHTML = `<div class="lt-head">📶 Gecikme testi<button class="lt-close" title="Kapat">✕</button></div>${rows}<button class="lt-again">🔄 Yeniden test et</button>`
      box.querySelector('.lt-close').onclick = () => box.remove()
      box.querySelector('.lt-again').onclick = () => { this.sampleStats(); setTimeout(render, 700) }
    }
    render()
    document.body.appendChild(box)
    this.sampleStats(); setTimeout(render, 700) // taze ölçüm
    setTimeout(() => document.addEventListener('pointerdown', function h (e) {
      if (!box.contains(e.target)) { box.remove(); document.removeEventListener('pointerdown', h) }
    }), 0)
  },

  onRtc ({ from, data }) {
    if (!data) return
    const k = data.kind || ''
    if (k.startsWith('call') || data.scope === 'call') return CallMgr.onRtc(from, data)
    if (!this.room || from === this.code()) return
    // Eski oda/oturumdan gecikmiş SDP ve ICE yeni odaya karışmasın.
    if (data.room && data.room !== this.room) return
    if (k === 'hello') {
      const hvch = data.vch || 'genel'
      this.markSeen(this.room, from, data.name, hvch)
      if (hvch !== this._vch) { if (this.members.has(from)) this.removeMember(from); this.sync(); return } // farklı ses kanalı
      const m = this.ensureMember(from, data.name)
      m.muted = !!data.muted
      // uzak avatar: emoji VEYA güvenli raster resim data-URL'i (≤20KB); render avatarHTML'de doğrulanır
      m.avatar = (window.isImgAvatar && isImgAvatar(data.avatar) && data.avatar.length <= 20000) ? data.avatar : String(data.avatar || '').slice(0, 8)
      m.screenSid = data.screen || null
      if (data.pos) { m.pos = this.clampPos(data.pos); this.updatePanner(m); this.avoidOverlap() }
      this.updateBubble(m)
      this.sync()
      return
    }
    if (k === 'bye') { if (this.members.has(from)) this._playJoinLeave(false); this.removeMember(from); return }
    const m = this.members.get(from)
    if (!m) return
    if (k === 'sdp') this.onSdp(m, data.desc)
    if (k === 'ice' && !m.ignoreOffer) {
      if (!m.pc.remoteDescription) m.pendingIce.push(data.cand || null)
      else { try { m.pc.addIceCandidate(data.cand || undefined).catch(() => {}) } catch {} }
    }
  },

  async onSdp (m, desc) {
    const pc = m.pc
    if (!desc || !desc.type) return
    try {
      const collision = desc.type === 'offer' && (m.makingOffer || pc.signalingState !== 'stable')
      m.ignoreOffer = collision && !m.polite
      if (m.ignoreOffer) return
      await pc.setRemoteDescription(desc)
      const queued = m.pendingIce.splice(0)
      for (const cand of queued) {
        try { await pc.addIceCandidate(cand || undefined) } catch {}
      }
      if (desc.type === 'offer') {
        await setLocalMunged(pc, 'answer') // Opus FEC + mono
        this.sendRtc(m.code, { kind: 'sdp', desc: pc.localDescription })
      }
    } catch (e) { console.error('sdp', e) }
  },

  onRoomEv ({ room, from, name, ev }) {
    if (!ev || from === this.code()) return
    const rr = state.rooms.find(r => r.topic === room)
    if (rr && rr.banned && rr.banned.includes(from)) return
    if (ev.kind === 'voice') {
      const evch = ev.vch || 'genel'
      if (ev.on) this.markSeen(room, from, name, evch)
      else this.seenMap(room).delete(from)
      if (this.room === room) {
        // Farklı ses kanalındaysa mesh'e ALMA (ayrı ses alanı). Bende varken karşıya
        // geçtiyse çıkar. Aynı kanaldaysa bağlan. (seen'de yine görünür — liste için.)
        if (!ev.on || evch !== this._vch) { if (this.members.has(from)) this.removeMember(from); this.sync(); return }
        const m = this.ensureMember(from, name)
        m.muted = !!ev.muted
        m.avatar = ev.avatar ? ((window.isImgAvatar && isImgAvatar(ev.avatar) && ev.avatar.length <= 20000) ? ev.avatar : String(ev.avatar).slice(0, 8)) : m.avatar
        m.screenSid = ev.screen || null
        if (ev.pos) { m.pos = this.clampPos(ev.pos); this.updatePanner(m) }
        this.updateBubble(m)
        this.sendRtc(from, { kind: 'hello', name: state.me.name, avatar: state.me.avatar, muted: this.muted, screen: this.screen ? this.screen.id : null, pos: this.myPos, vch: this._vch })
        this.sync()
      } else this.sync()
      return
    }
    if (ev.kind === 'pos' && this.room === room) {
      const m = this.members.get(from)
      if (!m) return
      m.pos = this.clampPos({ x: Number(ev.x) || 0, y: Number(ev.y) || 0 })
      this.updatePanner(m)
      this._audibleSoon() // bu kişi yaklaştı/uzaklaştı → duyulurluğu tazele
      if (this.flat()) { this.arrangeFlatGrid(); return } // düz modda ızgara sabit
      this.applyProximity(m)
      this.positionBubble(m)
      this.avoidOverlap() // üstüme geldiyse kenara kay (toink)
    }
  },

  // ---- arayüz ----
  el (id) { return document.getElementById(id) },

  sync () {
    this.syncConnectionUI()
    if (window.refreshSidebarRoom) window.refreshSidebarRoom() // ses kanalı katılımcı listesi canlı
    const lr = this.el('livingroom')
    if (!lr) return
    const inRoomView = activeConv && activeConv.type === 'room'
    lr.classList.toggle('hidden', !inRoomView)
    this.syncStreams(inRoomView)
    if (!inRoomView) return
    const topic = activeConv.topic
    const active = this.room === topic
    const join = this.el('btn-voice-join')
    join.disabled = this.joining
    join.textContent = this.joining ? '⏳ Ses hazırlanıyor…' : '🎧 Sesli sohbete katıl'

    lr.classList.toggle('lr-idle', !active) // katılmadan önce sahne kompakt
    this.el('lr-overlay').classList.toggle('hidden', active)
    this.el('lr-controls').classList.toggle('hidden', !active)
    if (!active) {
      const inside = [...this.seenMap(topic).values()].map(x => x.name)
      this.el('lr-who').textContent = inside.length
        ? 'İçeride: ' + inside.join(', ')
        : 'Henüz kimse yok — ilk katılan sen ol'
      this.el('lr-stage').querySelectorAll('.lr-bubble').forEach(b => b.remove())
      this.el('lr-stage').querySelectorAll('.lr-zones').forEach(z => z.remove()) // bölgeleri de kaldır
      this._myBubble = null
      return
    }

    const mic = this.el('btn-mic')
    mic.textContent = '🎙️'
    mic.classList.toggle('muted', this.muted)
    mic.title = this.muted ? 'Mikrofonu aç (Ctrl+Shift+M)' : 'Mikrofonu sustur (Ctrl+Shift+M)'
    mic.setAttribute('aria-pressed', this.muted ? 'true' : 'false')
    const deaf = this.el('btn-deafen')
    if (deaf) {
      deaf.textContent = '🎧'
      deaf.classList.toggle('deafened', this.deafened)
      deaf.title = this.deafened ? 'Sağırlığı kaldır (Ctrl+Shift+D)' : 'Sağırlaştır — kimseyi duyma (Ctrl+Shift+D)'
      deaf.setAttribute('aria-pressed', this.deafened ? 'true' : 'false')
    }
    const cam = this.el('btn-cam')
    cam.textContent = '📷'
    cam.title = this.cam ? 'Kamerayı kapat' : 'Kamera'
    cam.classList.toggle('on', !!this.cam)
    const scr = this.el('btn-screen')
    scr.textContent = '🖥️'
    scr.title = this.screen ? 'Paylaşımı durdur' : 'Ekran paylaş'
    scr.classList.toggle('on', !!this.screen)

    this.renderMyBubble()
    for (const m of this.members.values()) this.updateBubble(m)

    // mod: düz → balonları ızgaraya diz + ipucunu değiştir; konumsal → sürükle
    const flat = this.flat()
    const stage = this.el('lr-stage')
    if (stage) stage.classList.toggle('flat', flat)
    if (flat) this.arrangeFlatGrid()
    this._syncZoneHint()
    const mb = this.el('btn-voicemode')
    if (mb) {
      mb.textContent = flat ? '🛋️' : '💬'
      mb.title = flat ? 'Konumsal (oturma odası) moduna geç' : 'Düz konuşma moduna geç'
      mb.setAttribute('aria-label', mb.title)
      mb.classList.toggle('on', !flat)
    }
    this._audibleSoon() // üyelik/mod değişince budamayı tazele
    if (this._lastTuneN !== this.members.size) { this._lastTuneN = this.members.size; this._retuneAudio() } // kişi sayısına göre bitrate
  },
  _retuneAudio () {
    for (const m of this.members.values()) {
      if (!m.pc || !m.pc.getSenders) continue
      for (const s of m.pc.getSenders()) if (s.track && s.track.kind === 'audio') tuneAudioSender(s)
    }
  },
  // Düşük gecikme modu: alıcı jitter buffer hedefini kısar → minimum gecikme
  // (rekabetçi oyun). ÖDÜN: dalgalı ağda biraz daha çıtırtı riski. Opt-in.
  _applyLatencyMode () {
    const low = !!_settings().lowLatency
    for (const m of this.members.values()) {
      if (!m.pc || !m.pc.getReceivers) continue
      applyReceiverLatency(m.pc, low)
    }
    // Aktif 1-1 arama varsa ona da anında uygula
    if (window.CallMgr && CallMgr.pc) applyReceiverLatency(CallMgr.pc, low)
  },

  // ---- Yayın izleme: opt-in, çoklu, taşınabilir/boyutlandırılabilir paneller ----
  // Otomatik açılmaz; "İzle" çipine basınca panel açılır, ✕ ile çıkılır.
  syncStreams (inRoomView) {
    const bar = this.el('stream-bar')
    if (!bar) return
    const active = inRoomView && this.room === activeConv.topic
    const avail = active ? this._availableStreams() : []
    const availKeys = new Set(avail.map(a => a.key))
    // Artık yayında olmayan izlediklerimi bırak (yayan durdurdu/çıktı)
    for (const key of [...this._watching]) if (!availKeys.has(key)) this._unwatchStream(key)
    // Çubuk: izlenmeyen her yayın için "İzle" çipi (opt-in — sormadan açmaz)
    bar.innerHTML = ''
    const chips = avail.filter(a => !this._watching.has(a.key))
    bar.classList.toggle('hidden', chips.length === 0)
    for (const a of chips) {
      const chip = document.createElement('button')
      chip.className = 'stream-chip' + (a.mine ? ' mine' : '')
      chip.innerHTML = a.mine
        ? '🖥️ Kendi ekranını önizle'
        : '▶️ <b>' + esc(a.name) + '</b> yayında — İzle'
      chip.onclick = () => this._watchStream(a.key)
      bar.appendChild(chip)
    }
    // İzlenen her yayın için panel garanti et + güncelle
    for (const a of avail) if (this._watching.has(a.key)) this._ensureStreamPanel(a)
  },

  _availableStreams () {
    const out = []
    for (const m of this.members.values()) {
      const s = this.screenStream(m)
      if (s && s.getVideoTracks().some(t => t.readyState === 'live')) {
        out.push({ key: m.code, name: this.dispName(m), stream: s, mine: false })
      }
    }
    if (this.screen) out.push({ key: 'me', name: 'Kendi ekranın', stream: this.screen, mine: true })
    return out
  },

  _watchStream (key) { this._watching.add(key); this.sync() },
  _unwatchStream (key) { this._watching.delete(key); this._removeStreamPanel(key) },
  _removeStreamPanel (key) {
    const p = this._streamPanels.get(key)
    if (!p) return
    try { if (document.fullscreenElement === p.el) document.exitFullscreen().catch(() => {}) } catch {}
    try { p.video.srcObject = null } catch {}
    p.el.remove()
    this._streamPanels.delete(key)
  },
  _clearStreamPanels () {
    for (const key of [...this._streamPanels.keys()]) this._removeStreamPanel(key)
    this._watching.clear()
    const bar = this.el('stream-bar'); if (bar) { bar.innerHTML = ''; bar.classList.add('hidden') }
  },

  _ensureStreamPanel (a) {
    let p = this._streamPanels.get(a.key)
    if (!p) { p = this._makeStreamPanel(a); this._streamPanels.set(a.key, p) }
    if (p.video.srcObject !== a.stream) p.video.srcObject = a.stream
    // Kendi ekranın sessiz (yankı yok); uzak yayının sesi panelden çalınır
    p.video.muted = a.mine || !a.stream.getAudioTracks().length
    if (!a.mine && p.video.setSinkId) p.video.setSinkId(_settings().spkId || '').catch(() => {})
    p.label.textContent = a.mine ? '🖥️ Kendi ekranın (önizleme)' : (a.name + ' — yayın')
  },

  _makeStreamPanel (a) {
    const el = document.createElement('div')
    el.className = 'stream-panel'
    const n = this._streamPanels.size
    el.style.left = (90 + n * 30) + 'px'
    el.style.top = (90 + n * 30) + 'px'
    el.innerHTML =
      '<div class="sp-head"><span class="sp-label"></span>' +
      '<span class="sp-actions">' +
      (!a.mine ? '<button class="sp-ctrl-req" title="Bu ekranı uzaktan kontrol et" hidden>🎮 Kontrol iste</button>' : '') +
      '<button class="sp-full" title="Büyüt / küçült (çift tıkla)">⛶</button>' +
      '<button class="sp-close" title="Yayından çık">✕</button>' +
      '</span></div>' +
      '<div class="sp-body"><video autoplay playsinline></video></div>' +
      '<div class="sp-ctrl">' +
      '<span class="sp-ico" title="Parlaklık">🔆</span><input class="sp-bright" type="range" min="30" max="170" value="100">' +
      '<span class="sp-ico" title="Ses">🔊</span><input class="sp-vol" type="range" min="0" max="150" value="100">' +
      '</div>' +
      // Her kenardan + köşeden boyutlandır (sağ/sol/üst/alt) — kullanıcı isteği
      '<div class="sp-rz sp-rz-n" data-dir="n"></div><div class="sp-rz sp-rz-s" data-dir="s"></div>' +
      '<div class="sp-rz sp-rz-e" data-dir="e"></div><div class="sp-rz sp-rz-w" data-dir="w"></div>' +
      '<div class="sp-rz sp-rz-ne" data-dir="ne"></div><div class="sp-rz sp-rz-nw" data-dir="nw"></div>' +
      '<div class="sp-rz sp-rz-se" data-dir="se"></div><div class="sp-rz sp-rz-sw" data-dir="sw"></div>'
    document.body.appendChild(el)
    const video = el.querySelector('video')
    const label = el.querySelector('.sp-label')
    const bright = el.querySelector('.sp-bright')
    const vol = el.querySelector('.sp-vol')
    video.volume = Math.min(1, (Number(_settings().outVol) || 100) / 100)
    // Parlaklık: izleyici tarafı, CSS filtresi (yayına dokunmaz) — #17
    const applyBright = () => { video.style.filter = 'brightness(' + (bright.value / 100) + ')' }
    bright.oninput = applyBright; applyBright()
    // Ses: panel-bazlı
    vol.oninput = () => { video.volume = Math.min(1, vol.value / 100) }
    // ✕ = yayından çık
    el.querySelector('.sp-close').onclick = () => this._unwatchStream(a.key)
    // Büyüt/küçült: gerçek Fullscreen API DEĞİL — CSS ile pencereyi doldur. Fullscreen
    // API donanım render yoluna geçip "sıçrama"ya yol açıyordu; küçükken çalışan yol
    // korunuyor → sıçrama yok. (Kullanıcı: "tam ekran sıçrıyor, küçükken sorun yok".)
    const full = el.querySelector('.sp-full')
    full.onclick = () => {
      const max = el.classList.toggle('maximized')
      full.textContent = max ? '🗗' : '⛶'
      full.title = max ? 'Küçült' : 'Büyüt'
    }
    video.ondblclick = () => full.click()
    // Uzaktan kontrol iste (yalnız uzak yayın + masaüstü + native varsa görünür)
    const req = el.querySelector('.sp-ctrl-req')
    if (req && !a.mine && window.RemoteControl) {
      RemoteControl.canRequest(a.key).then((ok) => { if (ok) req.hidden = false })
      req.onclick = () => RemoteControl.requestControl(a.key, video)
    }
    this._makePanelDraggable(el, el.querySelector('.sp-head'))
    for (const h of el.querySelectorAll('.sp-rz')) this._makePanelResize(el, h, h.dataset.dir)
    return { el, video, label }
  },

  _makePanelDraggable (el, handle) {
    let sx, sy, ox, oy, drag = false
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input') || el.classList.contains('maximized')) return
      drag = true; sx = e.clientX; sy = e.clientY
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top
      try { handle.setPointerCapture(e.pointerId) } catch {}
      el.classList.add('dragging')
    })
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return
      let x = ox + (e.clientX - sx); let y = oy + (e.clientY - sy)
      x = Math.max(0, Math.min(x, window.innerWidth - 90))
      y = Math.max(0, Math.min(y, window.innerHeight - 40))
      el.style.left = x + 'px'; el.style.top = y + 'px'
    })
    const end = (e) => { drag = false; el.classList.remove('dragging'); try { handle.releasePointerCapture(e.pointerId) } catch {} }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  },

  // Kenar/köşe boyutlandırma. dir = n/s/e/w kombinasyonu. Sol/üst çekişinde hem
  // boyut hem konum (left/top) ayarlanır ki karşı kenar sabit kalsın.
  _makePanelResize (el, handle, dir) {
    handle.addEventListener('pointerdown', (e) => {
      if (el.classList.contains('maximized')) return // büyükken boyutlandırma yok
      e.stopPropagation(); e.preventDefault()
      const r = el.getBoundingClientRect()
      const s = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top }
      const move = (ev) => {
        const dx = ev.clientX - s.x; const dy = ev.clientY - s.y
        let w = s.w; let h = s.h; let left = s.left; let top = s.top
        if (dir.includes('e')) w = Math.max(220, s.w + dx)
        if (dir.includes('s')) h = Math.max(150, s.h + dy)
        if (dir.includes('w')) { w = Math.max(220, s.w - dx); left = s.left + (s.w - w) }
        if (dir.includes('n')) { h = Math.max(150, s.h - dy); top = s.top + (s.h - h) }
        el.style.width = w + 'px'; el.style.height = h + 'px'
        el.style.left = left + 'px'; el.style.top = top + 'px'
      }
      const up = (ev) => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
    })
  },

  makeBubble (code, name, avatar, mine) {
    const b = document.createElement('div')
    b.className = 'lr-bubble' + (mine ? ' me' : '')
    // avatar UZAK peer'dan gelir (rtc hello). Emoji ham basılırsa <img onerror> ile
    // JS çalışabilir → esc şart. Resim avatarı yalnız güvenli raster data-URL (isImgAvatar).
    const isImg = window.isImgAvatar && isImgAvatar(avatar)
    const face = avatar
      ? `<div class="lr-face"${isImg ? '' : ' style="background:var(--bg3);font-size:38px"'}>${isImg ? `<img class="lr-face-img" src="${esc(avatar)}" alt="">` : esc(avatar)}<video autoplay playsinline muted></video><span class="lr-initial" style="display:none"></span></div>`
      : `<div class="lr-face" style="background:${colorOf(code)}"><video autoplay playsinline muted></video><span class="lr-initial">${esc(initialOf(name, code))}</span></div>`
    b.innerHTML = face + '<div class="lr-name"></div>'
    this.el('lr-stage').appendChild(b)
    if (mine) this.makeDraggable(b)
    else {
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showVolPopover(code, b) })
      // tek tık → konuşana odak (onu yükselt, ötekileri kıs). Sahneye sızıp
      // "oraya git"i tetiklemesin diye durdur.
      b.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFocus(code) })
    }
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

  // Görünen ad: ARKADAŞSA benim listemdeki adım (odada da tutarlı) — #11
  dispName (m) {
    if (!m) return 'kişi'
    return (window.nameForCode ? window.nameForCode(m.code, m.name) : m.name) || 'anon'
  },

  updateBubble (m) {
    if (this.room == null) return
    if (!activeConv || activeConv.type !== 'room' || activeConv.topic !== this.room) return
    if (!m.bubble || !m.bubble.isConnected) m.bubble = this.makeBubble(m.code, this.dispName(m), m.avatar, false)
    this.positionBubble(m)
    // Medya bağlantısı kurulana kadar ⏳, koparsa ⚠️ — "ses/görüntü niye yok"u görünür kıl
    const st = m.pc.connectionState
    const mark = st === 'connected' ? '' : (st === 'failed' || st === 'disconnected' ? ' ⚠️' : ' ⏳')
    m.bubble.title = mark ? 'medya bağlantısı: ' + st + ' — NAT/güvenlik duvarı engelliyor olabilir (README: ice.json)' : ''
    m.bubble.querySelector('.lr-name').textContent = this.dispName(m) + (m.muted ? ' 🔇' : '') + mark
    const face = m.bubble.querySelector('.lr-face')
    const vid = m.bubble.querySelector('video')
    const main = this.mainStream(m)
    face.classList.toggle('has-video', m.video)
    if (m.video && main && vid.srcObject !== main) vid.srcObject = main
    if (!m.video) vid.srcObject = null
    this.applyProximity(m)
  },
  // Görsel yakınlık ipucu: konumsal modda uzaktaki balon küçülüp soluklaşır
  // (sesin kısılmasını gözle eşler). Düz modda hepsi eşit.
  applyProximity (m) {
    if (!m.bubble) return
    if (this.flat() || !this.myPos || !m.pos) { m.bubble.style.setProperty('--prox', '1'); m.bubble.style.setProperty('--prox-op', '1'); return }
    const d = Math.hypot(m.pos.x - this.myPos.x, m.pos.y - this.myPos.y)
    const t = Math.min(1, d / 70) // 0 (bitişik) → 1 (uzak)
    m.bubble.style.setProperty('--prox', (1 - t * 0.32).toFixed(3)) // 1.0 → 0.68 ölçek
    m.bubble.style.setProperty('--prox-op', (1 - t * 0.42).toFixed(3)) // 1.0 → 0.58 saydamlık
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
      if (this.flat()) return // düz modda konum sesi etkilemez → sürükleme kapalı
      e.preventDefault()
      b.setPointerCapture(e.pointerId)
      const stage = this.el('lr-stage')
      const move = (ev) => {
        const r = stage.getBoundingClientRect()
        this.myPos = this.resolveCollision({ // diğer balonların üstüne binme, kenarlarından kay
          x: Math.min(96, Math.max(4, ((ev.clientX - r.left) / r.width) * 100)),
          y: Math.min(88, Math.max(10, ((ev.clientY - r.top) / r.height) * 100))
        })
        b.style.left = this.myPos.x + '%'
        b.style.top = this.myPos.y + '%'
        this.updateAllPanners()
        this.updateAllProximity() // ben hareket edince herkesin bana uzaklığı değişir
        this._audibleSoon()
        this._syncZoneHint() // hangi bölgedeyim → vurgu + ipucu canlı
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
  notifyIncoming () {
    try {
      const request = window.turkuazDesktop?.calls?.notifyIncoming?.(this.peerName)
      if (request && typeof request.catch === 'function') request.catch(() => {})
    } catch {}
  },
  clearIncomingNotification () {
    try {
      const request = window.turkuazDesktop?.calls?.clearIncoming?.()
      if (request && typeof request.catch === 'function') request.catch(() => {})
    } catch {}
  },
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
        this.notifyIncoming()
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
      case 'call-snd': // DM aramasında soundboard
        if (from === this.peer && this.state === 'active' && window.Soundboard) Soundboard.remote(String(data.id || ''), data.data)
        break
      case 'sdp': if (from === this.peer && this.pc) this.onSdp(data.desc); break
      case 'ice': if (from === this.peer && this.pc) { try { this.pc.addIceCandidate(data.cand || undefined).catch(() => {}) } catch {} } break
    }
  },

  async accept () {
    if (this.state !== 'in' || this._accepting) return
    // Zili ve zaman aşımını TIKLANIR TIKLANMAZ durdur: mikrofonun açılması
    // (izin penceresi / meşgul aygıt) uzayınca zil arkada çalmaya devam ediyor,
    // 35 sn dolunca da arama kendi kendine kapanıyordu.
    this._accepting = true
    this.clearIncomingNotification()
    this.stopRing()
    clearTimeout(this.tmo)
    document.getElementById('ring-sub').textContent = 'bağlanıyor…'
    document.getElementById('btn-ring-accept').style.display = 'none'
    let mic
    try {
      mic = await Promise.race([
        buildMic(this), // cihaz seçimi + AGC + giriş kazancı
        new Promise((_, rej) => setTimeout(() => rej(new Error('mikrofon 20 sn içinde açılamadı')), 20000))
      ])
    } catch (e) {
      this._accepting = false
      alert('Mikrofon yok: ' + e.message)
      this.reject()
      return
    }
    this._accepting = false
    if (this.state !== 'in') { // biz mikrofonu açarken arama sonlanmış
      try { mic.getTracks().forEach(t => t.stop()) } catch {}
      if (this.micRaw) { this.micRaw.getTracks().forEach(t => t.stop()); this.micRaw = null }
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
      return
    }
    this.mic = mic
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
    if (typeof hideModal === 'function') hideModal('modal-ring', false)
    else {
      document.getElementById('modal-ring').classList.add('hidden')
      document.getElementById('modal-ring').setAttribute('aria-hidden', 'true')
    }
    this.state = 'active'
    this.makePC()
    this.t0 = Date.now()
    const widget = document.getElementById('call-widget')
    widget.classList.remove('hidden')
    widget.setAttribute('aria-hidden', 'false')
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
    setTimeout(() => {
      if (!widget.inert) document.getElementById('call-end').focus()
      else {
        const settings = document.getElementById('settings')
        if (settings && !settings.classList.contains('hidden')) document.getElementById('set-close').focus()
      }
    }, 0)
  },

  makePC () {
    const pc = new RTCPeerConnection(rtcConfig())
    this.pc = pc
    for (const t of this.mic.getTracks()) pc.addTrack(t, this.mic)
    preferAudioRed(pc) // Opus RED — kayıp zırhı
    pc.onicecandidate = (e) => this.sendRtc(this.peer, { kind: 'ice', scope: 'call', cand: e.candidate })
    pc.onnegotiationneeded = async () => {
      // Oda tarafındaki glare önlemiyle aynı: kibar taraf ilk teklifi beklesin
      if (this.polite && !pc.remoteDescription) return
      try {
        this.makingOffer = true
        await setLocalMunged(pc, 'offer') // Opus FEC + mono
        this.sendRtc(this.peer, { kind: 'sdp', scope: 'call', desc: pc.localDescription })
      } catch (e) { console.error(e) } finally { this.makingOffer = false }
    }
    pc.ontrack = (e) => {
      const s = e.streams[0]
      if (!s) return
      if (e.track && e.track.kind === 'audio') applyReceiverLatency(pc, !!_settings().lowLatency) // düşük gecikme modu
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
        await setLocalMunged(pc, 'answer') // Opus FEC + mono
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
    // Ekran paylaşımının sistem sesi bu elemandan çalınır (mikrofon sesi ayrı
    // audioEl'de; kamera akışında videoyu açıp sesi çiftlememek için sessiz kal)
    remote.muted = !(rs && rs.id === this.remoteScreenSid && rs.getAudioTracks().length)
    remote.volume = Math.min(1, (Number(_settings().outVol) || 100) / 100)
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
    applyMonitor(this) // susturunca kendini de duyma
    this.renderVideos()
  },
  setOutputVolume (pct) { if (this.audioEl) this.audioEl.volume = Math.min(1, Math.max(0, (Number(pct) || 0) / 100)) },
  setInputVolume (pct) { if (this.inGain) this.inGain.gain.value = Math.max(0, Number(pct) || 0) / 100 },
  setSink (id) { try { if (this.audioEl && this.audioEl.setSinkId) this.audioEl.setSinkId(id || '').catch(() => {}) } catch {} },
  async toggleCam () {
    if (!this.pc) return
    if (!this.cam) {
      try { this.cam = await navigator.mediaDevices.getUserMedia(camConstraints()) } catch { return }
      tuneVideoSender(this.pc.addTrack(this.cam.getVideoTracks()[0], this.mic), false)
      preferVideoCodec(this.pc)
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
      try { this.screen = await getScreenStream() } catch { return }
      const tr = this.screen.getVideoTracks()[0]
      tr.onended = () => { if (this.screen) this.toggleScreen() }
      for (const t of this.screen.getTracks()) { // ses dahil
        const s = this.pc.addTrack(t, this.screen)
        if (t.kind === 'video') tuneVideoSender(s, true)
      }
      preferVideoCodec(this.pc)
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
    // Arama geçmişi: DM sohbetine yerel not düş (her iki taraf kendi kaydını tutar)
    if (this.peer && this.state) {
      let txt = null
      if (this.state === 'active' && this.t0) {
        const secs = Math.floor((Date.now() - this.t0) / 1000)
        txt = '📞 Görüşme · ' + Math.floor(secs / 60) + ' dk ' + (secs % 60) + ' sn'
      } else if (this.state === 'out') txt = '📞 Aradın · görüşme olmadı'
      else if (this.state === 'in') txt = '📞 Cevapsız arama'
      if (txt) { try { send({ t: 'call-log', code: this.peer, text: txt }) } catch {} }
    }
    const widget = document.getElementById('call-widget')
    const restoreCallFocus = widget.contains(document.activeElement)
    this.clearIncomingNotification()
    this.stopRing()
    clearTimeout(this.tmo)
    clearInterval(this.timeInt)
    if (this.pc) { try { this.pc.close() } catch {}; this.pc = null }
    for (const s of ['mic', 'micRaw', 'cam', 'screen']) {
      if (this[s]) { this[s].getTracks().forEach(t => t.stop()); this[s] = null }
    }
    if (this._denoise) { this._denoise._rnnoiseCleanup && this._denoise._rnnoiseCleanup(); this._denoise = null }
    if (this._ngInt) { clearInterval(this._ngInt); this._ngInt = null }
    stopVad(this)
    this.inGain = null
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null }
    this.streams = {}
    this.remoteScreenSid = null
    this.mutedFlag = false
    this._restarted = false
    this.state = null
    this.peer = null
    widget.classList.add('hidden')
    widget.setAttribute('aria-hidden', 'true')
    if (typeof hideModal === 'function') hideModal('modal-ring')
    else {
      document.getElementById('modal-ring').classList.add('hidden')
      document.getElementById('modal-ring').setAttribute('aria-hidden', 'true')
    }
    if (restoreCallFocus) setTimeout(() => document.getElementById('btn-menu').focus(), 0)
  },

  showRing (name, sub, incoming) {
    document.getElementById('ring-name').textContent = name
    document.getElementById('ring-sub').textContent = sub
    document.getElementById('btn-ring-accept').style.display = incoming ? '' : 'none'
    if (typeof showModal === 'function') showModal('modal-ring', incoming ? 'btn-ring-accept' : 'btn-ring-reject')
    else {
      document.getElementById('modal-ring').classList.remove('hidden')
      document.getElementById('modal-ring').setAttribute('aria-hidden', 'false')
    }
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
  Voice.el('btn-deafen') && (Voice.el('btn-deafen').onclick = () => Voice.toggleDeafen())
  Voice.el('btn-cam').onclick = () => Voice.toggleCam()
  Voice.el('btn-screen').onclick = () => Voice.toggleScreen()
  Voice.el('btn-voicemode').onclick = () => Voice.setVoiceMode(Voice.flat() ? 'spatial' : 'flat')
  // Boş sahneye tıkla/dokun → oraya git (mobilde sürüklemekten kolay; masaüstünde de çalışır).
  // Balona tıklama odak yaptığı için (stopPropagation) buraya düşmez.
  Voice.el('btn-voice-leave') && (function () {
    const stage = Voice.el('lr-stage')
    if (!stage) return
    stage.addEventListener('click', (e) => {
      if (!Voice.room || Voice.flat() || e.target.closest('.lr-bubble')) return
      const r = stage.getBoundingClientRect()
      if (r.width < 10) return
      Voice.myPos = Voice.resolveCollision({
        x: Math.min(96, Math.max(4, ((e.clientX - r.left) / r.width) * 100)),
        y: Math.min(88, Math.max(10, ((e.clientY - r.top) / r.height) * 100))
      })
      if (Voice._myBubble) { Voice._myBubble.style.left = Voice.myPos.x + '%'; Voice._myBubble.style.top = Voice.myPos.y + '%' }
      Voice.updateAllPanners(); Voice.updateAllProximity(); Voice._audibleSoon(); Voice._syncZoneHint(); Voice.sendPos(); Voice.sendState()
    })
  })()
  Voice.el('voice-dock-return').onclick = () => {
    const room = state.rooms.find(r => r.topic === Voice.room)
    if (room && typeof openRoom === 'function') openRoom(room)
  }
  Voice.el('voice-dock-mute').onclick = () => Voice.toggleMute()
  Voice.el('voice-dock-leave').onclick = () => Voice.leave()
  document.getElementById('btn-ring-accept').onclick = () => CallMgr.accept()
  document.getElementById('btn-ring-reject').onclick = () => (CallMgr.state === 'out' ? CallMgr.end() : CallMgr.reject())
  document.getElementById('call-mute').onclick = () => CallMgr.toggleMute()
  document.getElementById('call-cam').onclick = () => CallMgr.toggleCam()
  document.getElementById('call-screen').onclick = () => CallMgr.toggleScreen()
  document.getElementById('call-end').onclick = () => CallMgr.end()

  // ---- tam ekran (aç/kapa) ----
  const fs = (el) => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return }
    if (el && el.srcObject && el.requestFullscreen) el.requestFullscreen().catch(e => console.error('tam ekran:', e))
  }
  const callRemote = document.getElementById('call-remote')
  if (callRemote) callRemote.ondblclick = () => fs(callRemote)

  const toggleMuteShortcut = () => {
    if (Voice.room) Voice.toggleMute()
    else if (CallMgr.state === 'active') CallMgr.toggleMute()
  }
  // Electron globalShortcut uygulama odaktayken de çalışır; masaüstü köprüsü
  // varsa ayrıca keydown dinlemeyerek tek basışta iki kez tetiklenmeyi önle.
  const installLocalMuteShortcut = () => {
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && e.shiftKey && e.code === 'KeyM') || e.repeat) return
      e.preventDefault()
      toggleMuteShortcut()
    })
  }
  const toggleDeafenShortcut = () => { if (Voice.room) Voice.toggleDeafen() }
  const installLocalDeafenShortcut = () => {
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && e.shiftKey && e.code === 'KeyD') || e.repeat) return
      e.preventDefault()
      toggleDeafenShortcut()
    })
  }
  const shortcuts = window.turkuazDesktop?.shortcuts
  if (shortcuts?.onToggleMute) {
    shortcuts.onToggleMute(toggleMuteShortcut)
    if (shortcuts.isGlobalMuteActive) {
      shortcuts.isGlobalMuteActive().then(active => {
        if (!active) installLocalMuteShortcut()
      }).catch(installLocalMuteShortcut)
    } else installLocalMuteShortcut()
  } else installLocalMuteShortcut()
  if (shortcuts?.onToggleDeafen) {
    shortcuts.onToggleDeafen(toggleDeafenShortcut)
    if (shortcuts.isGlobalDeafenActive) {
      shortcuts.isGlobalDeafenActive().then(active => { if (!active) installLocalDeafenShortcut() }).catch(installLocalDeafenShortcut)
    } else installLocalDeafenShortcut()
  } else installLocalDeafenShortcut()
  setInterval(() => Voice.pruneSeen(), VOICE_HEARTBEAT_MS)
  Voice.sync()
})

window.addEventListener('beforeunload', () => {
  if (Voice.room) Voice.leave()
  if (CallMgr.state) CallMgr.end()
})
