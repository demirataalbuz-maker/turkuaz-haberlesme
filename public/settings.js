// Turkuaz ayarlar ekranı — Discord-tarzı: solda kategori listesi, sağda panel.
// Ses/görüntü tercihleri localStorage'da tutulur; Voice ve CallMgr canlı uygular.
/* global Voice, CallMgr, state, send, openProfile, copyText, esc */
(function () {
  const KEY = 'turkuaz.settings'
  const DEFAULTS = {
    micId: '', spkId: '', camId: '', camRes: '720', inVol: 100, outVol: 100,
    noise: 'standard', screenRes: '720', screenFps: 15, screenAudio: false,
    vidCodec: 'auto', voiceMode: 'flat', micHQ: false, micLimiter: true, lowLatency: false, noiseGate: false, smartGate: false, theme: 'dark', density: 'cozy', notif: true,
    joinLeaveSound: true, bubbleBumpSound: false,
    speakMode: 'open', vadSens: 50, pttKey: 'Space'
  }
  let settings = load()

  function load () {
    let s
    try { s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')) } catch { return Object.assign({}, DEFAULTS) }
    // Göç: ekran sesi sistem sesini (=çağrı sesini) de yakalayıp yankı yaptığı için
    // varsayılan kapatıldı. Eski kullanıcılarda bir kez kapat — yankı bug düzeltmesi.
    // Kullanıcı sonradan bilerek açarsa uyarıyı görür ve bu göç bir daha çalışmaz.
    if (!s._screenAudioMigrated) { s.screenAudio = false; s._screenAudioMigrated = true; try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {} }
    return s
  }
  function persist () { try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {} }

  window.TurkuazSettings = {
    get () { return settings },
    set (k, v) { settings[k] = v; persist() }
  }

  function setMediaSink (el, id) {
    if (!el || typeof el.setSinkId !== 'function') return Promise.resolve(false)
    try { return Promise.resolve(el.setSinkId(id || '')).then(() => true).catch(() => false) } catch { return Promise.resolve(false) }
  }

  function setModuleSink (mod, id) {
    if (!mod || typeof mod.setSink !== 'function') return Promise.resolve(false)
    try { return Promise.resolve(mod.setSink(id || '')).then(() => true).catch(() => false) } catch { return Promise.resolve(false) }
  }

  // Tek çıkış yönlendiricisi: oda/DM sesi, soundboard ve ekran paylaşımı
  // oynatıcıları aynı kayıtlı hoparlörü kullanır. Desteklemeyen tarayıcılarda
  // güvenli biçimde sistem varsayılanına düşer.
  function applyOutputSink (id, save) {
    id = String(id || '')
    if (save) window.TurkuazSettings.set('spkId', id)
    return Promise.all([
      setModuleSink(window.Voice, id),
      setModuleSink(window.CallMgr, id),
      setModuleSink(window.Soundboard, id),
      setMediaSink($('call-remote'), id)
    ])
  }

  window.TurkuazAudioOutput = {
    set (id) { return applyOutputSink(id, true) },
    apply () { return applyOutputSink(settings.spkId, false) }
  }

  const $ = (id) => document.getElementById(id)
  const CATS = [
    { id: 'av', label: 'Ses ve Görüntü', icon: '🎧' },
    { id: 'account', label: 'Hesabım', icon: '👤' },
    { id: 'appearance', label: 'Görünüm', icon: '🎨' },
    { id: 'privacy', label: 'Gizlilik', icon: '🛡️' },
    { id: 'advanced', label: 'Gelişmiş', icon: '⚙️' }
  ]
  let cur = 'av'
  let testStream = null
  let testRaf = null
  let labelsUnlocked = false
  let returnFocus = null

  function open (cat) {
    returnFocus = document.activeElement
    if (typeof closeDrawer === 'function') closeDrawer()
    cur = cat || 'av'
    renderNav()
    renderPanel()
    $('settings').classList.remove('hidden')
    $('settings').setAttribute('aria-hidden', 'false')
    if (typeof syncDialogInert === 'function') syncDialogInert()
    setTimeout(() => $('set-close').focus(), 0)
  }
  function close (restoreFocus = true) {
    stopMicTest()
    $('settings').classList.add('hidden')
    $('settings').setAttribute('aria-hidden', 'true')
    if (typeof syncDialogInert === 'function') syncDialogInert()
    if (restoreFocus) {
      setTimeout(() => {
        let target = returnFocus
        if (!target || !target.isConnected || target.disabled || target.closest('[inert]')) target = $('btn-menu')
        if (target && target.focus) target.focus()
      }, 0)
    }
  }

  function renderNav () {
    const nav = $('set-nav')
    nav.innerHTML = ''
    for (const c of CATS) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'set-cat' + (c.id === cur ? ' active' : '')
      el.id = 'set-tab-' + c.id
      el.setAttribute('role', 'tab')
      el.setAttribute('aria-selected', c.id === cur ? 'true' : 'false')
      el.setAttribute('aria-controls', 'set-panel')
      el.tabIndex = c.id === cur ? 0 : -1
      el.innerHTML = `<span class="ic">${c.icon}</span><span>${c.label}</span>`
      el.onclick = () => selectCategory(c.id, true)
      el.onkeydown = (e) => {
        const i = CATS.findIndex(x => x.id === c.id)
        let next = -1
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % CATS.length
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + CATS.length) % CATS.length
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = CATS.length - 1
        if (next >= 0) { e.preventDefault(); selectCategory(CATS[next].id, true) }
      }
      nav.appendChild(el)
    }
  }

  function selectCategory (id, focusTab) {
    if (cur !== id) { stopMicTest(); cur = id; renderNav(); renderPanel() }
    if (focusTab) setTimeout(() => $('set-tab-' + id)?.focus(), 0)
  }

  function renderPanel () {
    const p = $('set-panel')
    p.setAttribute('role', 'tabpanel')
    p.setAttribute('aria-labelledby', 'set-tab-' + cur)
    if (cur === 'av') return renderAV(p)
    if (cur === 'account') return renderAccount(p)
    if (cur === 'appearance') return renderAppearance(p)
    if (cur === 'privacy') return renderPrivacy(p)
    if (cur === 'advanced') return renderAdvanced(p)
  }

  // ---------- yardımcı bileşenler ----------
  function group (title) {
    const g = document.createElement('div')
    g.className = 'set-group'
    g.innerHTML = `<div class="set-gtitle">${title}</div>`
    return g
  }
  function row (label, control, hint) {
    const r = document.createElement('div')
    r.className = 'set-row'
    const l = document.createElement('div')
    l.className = 'set-label'
    l.innerHTML = `<div>${label}</div>${hint ? `<div class="set-hint">${hint}</div>` : ''}`
    r.append(l, control)
    return r
  }
  function selectEl (options, value, onChange) {
    const s = document.createElement('select')
    s.className = 'set-select'
    for (const o of options) {
      const opt = document.createElement('option')
      opt.value = o.value; opt.textContent = o.label
      if (o.value === value) opt.selected = true
      s.appendChild(opt)
    }
    s.onchange = () => onChange(s.value)
    return s
  }
  function slider (value, onInput, max) {
    const wrap = document.createElement('div')
    wrap.className = 'set-slider'
    const inp = document.createElement('input')
    inp.type = 'range'; inp.min = '0'; inp.max = String(max || 100); inp.value = String(value)
    const val = document.createElement('span')
    val.className = 'set-slval'; val.textContent = value + '%'
    inp.oninput = () => { val.textContent = inp.value + '%'; onInput(Number(inp.value)) }
    wrap.append(inp, val)
    return wrap
  }

  async function unlockLabels () {
    if (labelsUnlocked) return
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); labelsUnlocked = true } catch {}
  }

  async function listDevices () {
    try { return await navigator.mediaDevices.enumerateDevices() } catch { return [] }
  }

  // ---------- Ses ve Görüntü ----------
  async function renderAV (p) {
    p.innerHTML = '<h2>Ses ve Görüntü</h2>'
    await unlockLabels()
    const devs = await listDevices()
    if (cur !== 'av') return // panel değişmişse çık
    const mics = devs.filter(d => d.kind === 'audioinput')
    const spks = devs.filter(d => d.kind === 'audiooutput')
    const cams = devs.filter(d => d.kind === 'videoinput')
    const opt = (list, kind) => [{ value: '', label: 'Varsayılan' }].concat(
      list.map((d, i) => ({ value: d.deviceId, label: d.label || (kind + ' ' + (i + 1)) })))

    // Ses cihazları
    const gDev = group('SES CİHAZLARI')
    gDev.appendChild(row('Giriş cihazı (mikrofon)',
      selectEl(opt(mics, 'Mikrofon'), settings.micId, v => { TurkuazSettings.set('micId', v) }),
      'Değişiklik bir sonraki katılım/aramada geçerli.'))
    gDev.appendChild(row('Çıkış cihazı (hoparlör)',
      selectEl(opt(spks, 'Hoparlör'), settings.spkId, v => { window.TurkuazAudioOutput.set(v) })))
    p.appendChild(gDev)

    // Gürültü engelleme (AI)
    const gNoise = group('GÜRÜLTÜ ENGELLEME')
    gNoise.appendChild(row('Mod',
      selectEl([
        { value: 'off', label: 'Kapalı' },
        { value: 'standard', label: 'Standart' },
        { value: 'strong', label: 'Güçlü — AI (RNNoise, hafif)' },
        { value: 'dfn', label: 'En güçlü — AI+ (DeepFilterNet)' }
      ], settings.noise || 'standard', v => TurkuazSettings.set('noise', v)),
      '"En güçlü" klavye tıkırtısı ve ani sesleri de bastırır; konuşurken tek çekirdeğin ~%10-15\'ini kullanır. Değişiklik bir sonraki katılım/aramada geçerli.'))
    const cores = navigator.hardwareConcurrency || '?'
    const mem = navigator.deviceMemory ? ('~' + navigator.deviceMemory + ' GB') : '?'
    const sys = document.createElement('div'); sys.className = 'set-note-box'
    sys.innerHTML = `Sistem: <b>${cores}</b> çekirdek · <b>${mem}</b> RAM. İki AI motoru da pakete dahil, indirme yok: <b>RNNoise</b> (hafif, sabit uğultuda iyi) ve <b>DeepFilterNet3</b> (16 MB, klavye/ani seslerde belirgin üstün). DeepFilterNet açılamazsa otomatik RNNoise'a düşülür.`
    gNoise.appendChild(sys)
    p.appendChild(gNoise)

    // Ses kalitesi — stüdyo modu (AEC + AGC kapalı, ham temiz ses)
    const gHQ = group('SES KALİTESİ')
    const hqSwitch = document.createElement('label'); hqSwitch.className = 'set-switch'
    const hqCb = document.createElement('input'); hqCb.type = 'checkbox'; hqCb.checked = !!settings.micHQ
    hqCb.onchange = () => TurkuazSettings.set('micHQ', hqCb.checked)
    hqSwitch.append(hqCb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gHQ.appendChild(row('Stüdyo modu (yüksek kalite)', hqSwitch,
      'Yankı engelleme + otomatik kazancı kapatır → ham, pompalamayan, temiz ses. YALNIZ KULAKLIKLA kullan — hoparlörde yankı yapar. Bir sonraki katılım/aramada geçerli.'))
    gHQ.appendChild(row('Ses seviyesi dengeleme',
      selectEl([
        { value: 'off', label: 'Kapalı' },
        { value: 'normal', label: 'Normal (önerilen)' },
        { value: 'strong', label: 'Ses sabitleme — bağıran/fısıldayan aynı seviye' }
      ], (settings.micLimiter === false ? 'off' : (settings.micLimiter === 'strong' ? 'strong' : 'normal')),
      v => TurkuazSettings.set('micLimiter', v)),
      'Bağıran ve fısıldayan aynı seviyede duyulur (pompalamayan kompresör + limiter). "Ses sabitleme" en agresif — oyun için ideal, herkes tutarlı gelir. Bir sonraki katılım/aramada geçerli.'))
    p.appendChild(gHQ)

    // Oyun / düşük gecikme
    const gGame = group('OYUN / DÜŞÜK GECİKME')
    const llSwitch = document.createElement('label'); llSwitch.className = 'set-switch'
    const llCb = document.createElement('input'); llCb.type = 'checkbox'; llCb.checked = !!settings.lowLatency
    llCb.onchange = () => { TurkuazSettings.set('lowLatency', llCb.checked); if (window.Voice && Voice._applyLatencyMode) Voice._applyLatencyMode() }
    llSwitch.append(llCb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gGame.appendChild(row('Düşük gecikme modu 🎮', llSwitch,
      'Jitter buffer\'ı kısar → minimum gecikme (rekabetçi oyun). Ödün: dalgalı ağda biraz daha çıtırtı olabilir. Anında geçerli.'))
    const ngSwitch = document.createElement('label'); ngSwitch.className = 'set-switch'
    const ngCb = document.createElement('input'); ngCb.type = 'checkbox'; ngCb.checked = !!settings.noiseGate
    ngCb.onchange = () => TurkuazSettings.set('noiseGate', ngCb.checked)
    ngSwitch.append(ngCb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gGame.appendChild(row('Noise gate 🔇', ngSwitch,
      'Konuşmadığında mikrofonu tam keser → kimse klavyeni/fanını duymaz. Konuşunca anında açılır. Bir sonraki katılım/aramada geçerli.'))
    // Akıllı gate (VAD) — deneysel
    const sgSwitch = document.createElement('label'); sgSwitch.className = 'set-switch'
    const sgCb = document.createElement('input'); sgCb.type = 'checkbox'; sgCb.checked = !!settings.smartGate
    sgCb.onchange = () => TurkuazSettings.set('smartGate', sgCb.checked)
    sgSwitch.append(sgCb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gGame.appendChild(row('Akıllı gate — VAD 🧠 (deneysel)', sgSwitch,
      'Noise gate açıkken çalışır. "Yüksek mi?" yerine "gerçekten insan sesi mi?" der (Silero yapay sinir ağı) → yüksek klavye takırtısını bile keser, kısık konuşmayı yakalar. Yüklenemezse otomatik olarak normal gate\'e döner. Bir sonraki katılım/aramada geçerli.'))
    p.appendChild(gGame)

    // Sesli sohbet modu (konumsal oturma odası / düz konuşma)
    const gVoice = group('SESLİ SOHBET MODU')
    gVoice.appendChild(row('Mod',
      selectEl([
        { value: 'flat', label: 'Düz konuşma — herkes eşit (varsayılan)' },
        { value: 'spatial', label: 'Konumsal — oturma odası (HRTF, isteğe bağlı)' }
      ], settings.voiceMode || 'flat', v => {
        TurkuazSettings.set('voiceMode', v)
        if (window.Voice && Voice.room) Voice.setVoiceMode(v) // odadaysan anında geç
      }),
      'Düz: normal grup araması, herkes eşit seviyede — varsayılan. Konumsal: balonunu sürükle, sesler yönünden gelir (kulaklık önerilir). Anında geçerli.'))
    // Katıl/ayrıl bildirim sesi (#15)
    const jlSwitch = document.createElement('label'); jlSwitch.className = 'set-switch'
    const jlCb = document.createElement('input'); jlCb.type = 'checkbox'; jlCb.checked = settings.joinLeaveSound !== false
    jlCb.onchange = () => TurkuazSettings.set('joinLeaveSound', jlCb.checked)
    jlSwitch.append(jlCb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gVoice.appendChild(row('Katılma/ayrılma sesi 🔔', jlSwitch,
      'Biri sesli sohbete katılınca (yükselen) veya çıkınca (alçalan) kısa bir bildirim sesi — TeamSpeak tarzı. Anında geçerli.'))
    // Balon çarpışma sesi (#12) — varsayılan kapalı
    const bbSwitch = document.createElement('label'); bbSwitch.className = 'set-switch'
    const bbCb = document.createElement('input'); bbCb.type = 'checkbox'; bbCb.checked = !!settings.bubbleBumpSound
    bbCb.onchange = () => TurkuazSettings.set('bubbleBumpSound', bbCb.checked)
    bbSwitch.append(bbCb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gVoice.appendChild(row('Balon çarpışma sesi', bbSwitch,
      'Konumsal modda balonlar birbirine değince "toink" sesi. Varsayılan kapalı — rahatsız edici olabilir.'))
    p.appendChild(gVoice)

    // Konuşma modu (açık / ses etkinliği / bas-konuş)
    const gSpeak = group('KONUŞMA MODU')
    gSpeak.appendChild(row('Mod',
      selectEl([
        { value: 'open', label: 'Açık (hep yayınla)' },
        { value: 'vad', label: 'Ses etkinliği' },
        { value: 'ptt', label: 'Bas-konuş' }
      ], settings.speakMode || 'open',
      v => { TurkuazSettings.set('speakMode', v); if (window.Voice && Voice.room) Voice._startGate(); renderPanel() }),
      'Odada mikrofonun ne zaman yayınlayacağı. Değişiklik anında geçerli.'))
    if ((settings.speakMode || 'open') === 'vad') {
      gSpeak.appendChild(row('Hassasiyet',
        slider(settings.vadSens || 50, v => { TurkuazSettings.set('vadSens', v) }),
        'Yüksek = daha sessiz seslere açılır.'))
    }
    if ((settings.speakMode || 'open') === 'ptt') {
      const keyBtn = document.createElement('button'); keyBtn.className = 'set-btn'
      keyBtn.textContent = settings.pttKey || 'Space'
      keyBtn.onclick = () => {
        keyBtn.textContent = 'bir tuşa bas…'
        const cap = (e) => { e.preventDefault(); TurkuazSettings.set('pttKey', e.code); keyBtn.textContent = e.code; document.removeEventListener('keydown', cap, true); if (window.Voice && Voice.room) Voice._startGate() }
        document.addEventListener('keydown', cap, true)
      }
      gSpeak.appendChild(row('Tuş', keyBtn, 'Basılı tuttukça yayınlarsın (pencere önde iken).'))
    }
    p.appendChild(gSpeak)

    // Ses seviyeleri
    const gVol = group('SES SEVİYESİ')
    gVol.appendChild(row('Giriş ses seviyesi',
      slider(settings.inVol, v => { TurkuazSettings.set('inVol', v); Voice.setInputVolume && Voice.setInputVolume(v); CallMgr.setInputVolume && CallMgr.setInputVolume(v) }, 200),
      'Mikrofon kazancı — 100% normal, üstü yükseltir.'))
    gVol.appendChild(row('Çıkış ses seviyesi',
      slider(settings.outVol, v => { TurkuazSettings.set('outVol', v); Voice.setOutputVolume && Voice.setOutputVolume(v); CallMgr.setOutputVolume && CallMgr.setOutputVolume(v) })))
    p.appendChild(gVol)

    // Mikrofon testi
    const gTest = group('MİKROFON TESTİ')
    const testBtn = document.createElement('button')
    testBtn.className = 'set-btn'
    testBtn.textContent = '🎧 Kendini dinle'
    const meter = document.createElement('div')
    meter.className = 'set-meter'
    meter.innerHTML = '<div class="set-meter-fill" id="set-meter-fill"></div>'
    let selfTesting = false
    testBtn.onclick = async () => {
      const fill = $('set-meter-fill')
      if (selfTesting) {
        if (window.Voice) await Voice.micSelfTestStop()
        selfTesting = false; testBtn.textContent = '🎧 Kendini dinle'
        if (fill) fill.style.width = '0%'
      } else {
        if (!window.Voice) return
        testBtn.disabled = true; testBtn.textContent = '⏳ Hazırlanıyor…'
        const ok = await Voice.micSelfTest(lvl => { if (fill) fill.style.width = lvl + '%' })
        testBtn.disabled = false
        if (ok) { selfTesting = true; testBtn.textContent = '⏹️ Durdur' } else { testBtn.textContent = '🎧 Kendini dinle' }
      }
    }
    const tr = document.createElement('div'); tr.className = 'set-row'
    const tl = document.createElement('div'); tl.className = 'set-label'
    tl.innerHTML = '<div>Kendini duy 🎧</div><div class="set-hint">Karşının duyduğu sesi — <b>gürültü engelleme + akıllı seviye + stüdyo modu dahil</b> — sen duyarsın. <b>KULAKLIK tak</b> (hoparlörde yankı yapar). Ayarları değiştir, farkı anında duy.</div>'
    const trc = document.createElement('div'); trc.append(testBtn, meter)
    tr.append(tl, trc); gTest.appendChild(tr)
    p.appendChild(gTest)

    // Kamera
    const gCam = group('KAMERA')
    gCam.appendChild(row('Kamera cihazı',
      selectEl(opt(cams, 'Kamera'), settings.camId, v => { TurkuazSettings.set('camId', v) }),
      'Değişiklik kamerayı bir sonraki açışta geçerli.'))
    gCam.appendChild(row('Kamera çözünürlüğü',
      selectEl([
        { value: '480', label: '480p — hafif · ~0.8 Mbps/izleyici' },
        { value: '720', label: '720p — önerilen · ~1.5 Mbps/izleyici' },
        { value: '1080', label: '1080p — ~2.5 Mbps/izleyici' }
      ], settings.camRes || '720', v => TurkuazSettings.set('camRes', v)),
      'Kameran bu çözünürlüğü desteklemiyorsa en yakınına düşer. Bir sonraki açışta geçerli.'))
    p.appendChild(gCam)

    // Ekran paylaşımı
    const gScr = group('EKRAN PAYLAŞIMI')
    gScr.appendChild(row('Çözünürlük',
      selectEl([
        { value: '720', label: '720p — zayıf internet · ~2.5 Mbps/izleyici' },
        { value: '1080', label: '1080p — önerilen · ~5 Mbps/izleyici' },
        { value: '1440', label: '1440p (2K) — ~8 Mbps/izleyici' },
        { value: '2160', label: '2160p (4K) — ~14 Mbps/izleyici · birebir için' },
        { value: 'source', label: 'Kaynak (tam) — ~8 Mbps/izleyici' }
      ], settings.screenRes, v => TurkuazSettings.set('screenRes', v)),
      'Rakamlar izleyici BAŞINA upload: odada 4 kişi izliyorsa ×4. Hattın yetmezse Turkuaz görüntüyü kendiliğinden kısar — ses hep önceliklidir.'))
    gScr.appendChild(row('Kare hızı (FPS)',
      selectEl([
        { value: '15', label: '15 fps — kod/belge (en hafif)' },
        { value: '30', label: '30 fps — video izletme' },
        { value: '60', label: '60 fps — oyun (bant + işlemci ×1.4)' }
      ], String(settings.screenFps), v => TurkuazSettings.set('screenFps', Number(v)))))
    const scrAudio = document.createElement('label'); scrAudio.className = 'set-switch'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!settings.screenAudio
    cb.onchange = () => TurkuazSettings.set('screenAudio', cb.checked)
    scrAudio.append(cb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gScr.appendChild(row('Ekran sesini de paylaş', scrAudio, '⚠️ Sistem sesinin TAMAMINI yakalar — sesli sohbetteki konuşmalar da yayına gider, karşı taraf kendini duyar (yankı). Sadece bir oyunun/videonun sesini paylaşmak için aç, sonra kapat. Varsayılan kapalı.'))
    gScr.appendChild(row('Video codec',
      selectEl([
        { value: 'auto', label: 'Otomatik (VP8/VP9)' },
        { value: 'h264', label: 'H264 — GPU dostu · oyun oynarken önerilir' },
        { value: 'av1', label: 'AV1 — en net görüntü · güçlü işlemci ister' }
      ], settings.vidCodec || 'auto', v => TurkuazSettings.set('vidCodec', v)),
      'Kamera ve ekran görüntüsünün sıkıştırma biçimi. H264 çoğu ekran kartında donanımla kodlanır: oyun FPS\'i düşmez. Bir sonraki katılım/aramada geçerli.'))
    p.appendChild(gScr)
  }

  function startMicTest () {
    navigator.mediaDevices.getUserMedia((window.TurkuazSettings && buildTestConstraints()) || { audio: true }).then(stream => {
      testStream = stream
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      testStream._ctx = ctx
      const src = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain(); gain.gain.value = (Number(settings.inVol) || 100) / 100
      const an = ctx.createAnalyser(); an.fftSize = 256
      src.connect(gain); gain.connect(an)
      const buf = new Uint8Array(an.fftSize)
      const fill = $('set-meter-fill')
      const tick = () => {
        an.getByteTimeDomainData(buf)
        let dev = 0
        for (const v of buf) dev = Math.max(dev, Math.abs(v - 128))
        if (fill) fill.style.width = Math.min(100, (dev / 90) * 100) + '%'
        testRaf = requestAnimationFrame(tick)
      }
      tick()
    }).catch(() => {})
  }
  function buildTestConstraints () {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    if (settings.micId) audio.deviceId = { exact: settings.micId }
    return { audio }
  }
  function stopMicTest () {
    if (testRaf) { cancelAnimationFrame(testRaf); testRaf = null }
    if (testStream) {
      testStream.getTracks().forEach(t => t.stop())
      if (testStream._ctx) testStream._ctx.close().catch(() => {})
      testStream = null
    }
    if (window.Voice && Voice.micSelfTestStop) Voice.micSelfTestStop() // panel kapanınca "kendini duy"u da durdur
    const fill = $('set-meter-fill'); if (fill) fill.style.width = '0%'
  }

  // ---------- Hesabım ----------
  function renderAccount (p) {
    p.innerHTML = '<h2>Hesabım</h2>'
    const g = group('KİMLİK')
    const info = document.createElement('div'); info.className = 'set-account'
    info.innerHTML = `
      <div class="set-acc-name">${esc(state.me.name || 'isimsiz')}</div>
      <div class="set-acc-status">${esc(state.me.status || 'çevrimiçi')}</div>`
    const editBtn = document.createElement('button'); editBtn.className = 'set-btn primary'; editBtn.textContent = 'Profili düzenle'
    editBtn.onclick = () => {
      close(false)
      ;(window.innerWidth < 761 ? $('btn-menu') : $('btn-settings')).focus()
      openProfile()
    }
    info.appendChild(editBtn)
    g.appendChild(info)
    p.appendChild(g)

    const gc = group('ARKADAŞ KODUN')
    const codeRow = document.createElement('div'); codeRow.className = 'set-coderow'
    const code = document.createElement('code'); code.className = 'set-code'; code.textContent = state.me.code || ''
    const cpy = document.createElement('button'); cpy.className = 'set-btn'; cpy.textContent = 'Kopyala'
    cpy.onclick = () => copyText(state.me.code, cpy, 'Kopyalandı ✓', 'Kopyala')
    codeRow.append(code, cpy)
    gc.appendChild(codeRow)
    p.appendChild(gc)
  }

  // ---------- Gizlilik ----------
  // Kasa (disk şifreleme) durumu: sunucudan gelir (tq-vault-info olayı app.js'ten)
  let vaultProtected = null
  window.addEventListener('tq-vault-info', (e) => {
    vaultProtected = !!e.detail.protected
    if (cur === 'privacy' && !$('settings').classList.contains('hidden')) renderPanel()
  })
  window.addEventListener('tq-pass-res', (e) => {
    const m = e.detail || {}
    if (m.ok) {
      vaultProtected = !!m.protected
      if (typeof toast === 'function') toast(m.protected ? 'Disk şifreleme açık — veriler artık şifreli yazılıyor.' : 'Disk şifreleme kapatıldı.', 'success')
    } else if (typeof toast === 'function') toast(m.err || 'Parola işlemi başarısız.', 'error')
    if (cur === 'privacy' && !$('settings').classList.contains('hidden')) renderPanel()
  })

  function vaultSection (p) {
    const g = group('DİSK ŞİFRELEME (KASA)')
    const note = document.createElement('div'); note.className = 'set-note-box'
    if (vaultProtected === null) {
      note.textContent = 'Durum kontrol ediliyor…'
      g.appendChild(note); p.appendChild(g)
      send({ t: 'vault-info' })
      return
    }
    note.innerHTML = vaultProtected
      ? 'Mesajların, kimliğin ve dosyaların diskte <b>şifreli</b> (Argon2id + XSalsa20-Poly1305). Uygulama her açılışta parola ister. <b>Parolayı unutursan veriler kurtarılamaz.</b>'
      : 'Verilerin şu an diskte <b>düz metin</b>. Parola belirlersen her şey şifrelenir; bilgisayarına fiziksel erişimi olan biri mesajlarını okuyamaz.'
    g.appendChild(note)

    const mkInput = (ph, ac) => {
      const i = document.createElement('input')
      i.type = 'password'; i.placeholder = ph; i.className = 'set-vault-inp'
      i.autocomplete = ac || 'new-password'
      return i
    }
    if (!vaultProtected) {
      const inp = mkInput('Yeni parola (en az 6 karakter)')
      const btn = document.createElement('button'); btn.className = 'set-btn'; btn.textContent = 'Şifrelemeyi aç'
      btn.onclick = () => {
        if ((inp.value || '').length < 6) return toast('Parola en az 6 karakter olmalı.', 'error')
        btn.disabled = true; btn.textContent = 'Şifreleniyor…'
        send({ t: 'set-pass', pass: inp.value })
      }
      const r = document.createElement('div'); r.className = 'set-coderow'
      r.append(inp, btn); g.appendChild(r)
    } else {
      const old1 = mkInput('Mevcut parola', 'current-password')
      const neu = mkInput('Yeni parola')
      const chg = document.createElement('button'); chg.className = 'set-btn'; chg.textContent = 'Parolayı değiştir'
      chg.onclick = () => {
        if ((neu.value || '').length < 6) return toast('Yeni parola en az 6 karakter olmalı.', 'error')
        chg.disabled = true; chg.textContent = 'Değiştiriliyor…'
        send({ t: 'set-pass', old: old1.value, pass: neu.value })
      }
      const r1 = document.createElement('div'); r1.className = 'set-coderow'
      r1.append(old1, neu, chg); g.appendChild(r1)

      const old2 = mkInput('Mevcut parola', 'current-password')
      const off = document.createElement('button'); off.className = 'set-btn danger'; off.textContent = 'Şifrelemeyi kapat'
      off.onclick = () => {
        if (!confirm('Disk şifreleme kapatılsın mı? Verilerin düz metne çevrilecek.')) return
        off.disabled = true; off.textContent = 'Çözülüyor…'
        send({ t: 'set-pass', old: old2.value, pass: '' })
      }
      const r2 = document.createElement('div'); r2.className = 'set-coderow'
      r2.append(old2, off); g.appendChild(r2)
    }
    p.appendChild(g)
  }

  function renderPrivacy (p) {
    p.innerHTML = '<h2>Gizlilik</h2>'
    vaultSection(p)
    const g = group('BAĞLANTI (ICE / TURN)')
    const ice = Array.isArray(state.ice) ? state.ice : []
    const turn = ice.filter(s => JSON.stringify(s.urls).includes('turn')).length
    const box = document.createElement('div'); box.className = 'set-note-box'
    box.innerHTML = turn
      ? `Ses/görüntü için TURN röle etkin (${turn} kayıt). Farklı ağlardaki iki PC arasında doğrudan bağlantı kurulamazsa medya bu röleden geçer; içerik DTLS-SRTP ile şifreli kaldığı için röle görmez.`
      : 'Şu an yalnızca STUN var (doğrudan bağlantı). Farklı ağlardaysanız kamera/ses bağlanmayabilir — <code>ice.json</code> ile TURN ekleyebilirsin.'
    g.appendChild(box)
    p.appendChild(g)

    const gb = group('ENGELLENENLER')
    const blk = state.blocked || []
    if (!blk.length) {
      const n = document.createElement('div'); n.className = 'set-note-box'; n.textContent = 'Kimseyi engellemedin.'
      gb.appendChild(n)
    } else {
      for (const code of blk) {
        const r2 = document.createElement('div'); r2.className = 'set-coderow'
        const c = document.createElement('code'); c.className = 'set-code'; c.textContent = code.slice(0, 16) + '…'
        const b = document.createElement('button'); b.className = 'set-btn'; b.textContent = 'Engeli kaldır'
        b.onclick = () => { send({ t: 'unblock', code }); b.textContent = 'kaldırıldı'; b.disabled = true }
        r2.append(c, b); gb.appendChild(r2)
      }
    }
    p.appendChild(gb)
  }

  // ---------- Gelişmiş ----------
  function renderAdvanced (p) {
    p.innerHTML = '<h2>Gelişmiş</h2>'
    const gv = group('SÜRÜM')
    const ver = state.version || window.__TQ_MOBILE_VER || '?'
    const platform = window.TurkuazNative ? 'Android' : 'Masaüstü'
    const vrow = document.createElement('div'); vrow.className = 'set-coderow'
    vrow.innerHTML = `<code class="set-code">Turkuaz ${esc(String(ver))} · ${platform}</code>`
    const cpy = document.createElement('button'); cpy.className = 'set-btn'; cpy.textContent = 'Kopyala'
    cpy.onclick = () => copyText('Turkuaz ' + ver + ' (' + platform + ')', cpy, 'Kopyalandı ✓', 'Kopyala')
    vrow.appendChild(cpy)
    gv.appendChild(vrow)
    const vnote = document.createElement('div'); vnote.className = 'set-note-box'
    vnote.innerHTML = window.TurkuazNative
      ? 'Yeni sürüm çıkınca uygulama açılışta üstte bildirir. En güncel APK: GitHub Releases.'
      : 'Yeni sürüm arka planda indirilir. Hazır olunca bildirimden veya aşağıdaki düğmeden yeniden başlatıp kurabilirsin.'
    gv.appendChild(vnote)

    if (window.turkuazDesktop && window.turkuazDesktop.updates) {
      const urow = document.createElement('div'); urow.className = 'set-coderow'
      const ust = document.createElement('span'); ust.id = 'set-update-status'; ust.className = 'set-code'
      ust.textContent = 'Güncelleme durumu yükleniyor…'
      const check = document.createElement('button'); check.id = 'set-update-check'; check.className = 'set-btn'
      check.textContent = 'Güncellemeleri denetle'
      check.onclick = () => window.TurkuazUpdates && window.TurkuazUpdates.check().catch(() => {})
      const install = document.createElement('button'); install.id = 'set-update-install'; install.className = 'set-btn primary'
      install.textContent = 'Yeniden başlat ve güncelle'; install.hidden = true
      install.onclick = () => window.TurkuazUpdates && window.TurkuazUpdates.install().catch(() => {})
      urow.append(ust, check, install)
      gv.appendChild(urow)
      setTimeout(() => { if (window.TurkuazUpdates) window.TurkuazUpdates.sync() }, 0)
    }
    p.appendChild(gv)

    const g = group('UYGULAMA')
    const box = document.createElement('div'); box.className = 'set-note-box'
    box.innerHTML = `Veri klasörü ve <code>ice.json</code> yeri README'de. Kimliğini taşımak için sol alttaki ⇄ düğmesini kullan.`
    g.appendChild(box)
    p.appendChild(g)
  }

  // ---------- Görünüm ----------
  // Vurgu renkleri: --tq (ana), --tq-soft (arka plan tonu), --grad (degrade).
  // "turkuaz" varsayılan — CSS'teki değerlere döner (özellik temizlenir).
  const ACCENTS = [
    { id: 'turkuaz', label: 'Turkuaz', tq: '#2dd4bf', grad: 'linear-gradient(135deg, #5eead4, #0ea5e9)' },
    { id: 'mavi', label: 'Mavi', tq: '#38bdf8', grad: 'linear-gradient(135deg, #7dd3fc, #2563eb)' },
    { id: 'mor', label: 'Mor', tq: '#a78bfa', grad: 'linear-gradient(135deg, #c4b5fd, #7c3aed)' },
    { id: 'yesil', label: 'Yeşil', tq: '#4ade80', grad: 'linear-gradient(135deg, #86efac, #059669)' },
    { id: 'turuncu', label: 'Turuncu', tq: '#fb923c', grad: 'linear-gradient(135deg, #fdba74, #ea580c)' },
    { id: 'pembe', label: 'Pembe', tq: '#f472b6', grad: 'linear-gradient(135deg, #f9a8d4, #db2777)' }
  ]
  function hexToSoft (hex) {
    const n = parseInt(hex.slice(1), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, .14)`
  }
  function applyAppearance () {
    const r = document.documentElement
    r.setAttribute('data-theme', settings.theme || 'dark')
    r.setAttribute('data-density', settings.density || 'cozy')
    const acc = ACCENTS.find(a => a.id === settings.accent)
    if (acc && acc.id !== 'turkuaz') {
      r.style.setProperty('--tq', acc.tq)
      r.style.setProperty('--tq-soft', hexToSoft(acc.tq))
      r.style.setProperty('--grad', acc.grad)
    } else {
      r.style.removeProperty('--tq')
      r.style.removeProperty('--tq-soft')
      r.style.removeProperty('--grad')
    }
  }
  function renderAppearance (p) {
    p.innerHTML = '<h2>Görünüm</h2>'
    const gt = group('TEMA')
    gt.appendChild(row('Tema',
      selectEl([{ value: 'dark', label: 'Koyu' }, { value: 'light', label: 'Açık' }], settings.theme || 'dark',
        v => { TurkuazSettings.set('theme', v); applyAppearance() })))
    gt.appendChild(row('Mesaj yoğunluğu',
      selectEl([{ value: 'cozy', label: 'Rahat' }, { value: 'compact', label: 'Sıkışık' }], settings.density || 'cozy',
        v => { TurkuazSettings.set('density', v); applyAppearance() })))
    // Vurgu rengi seçici (uygulama adına yakışır 😄)
    const accWrap = document.createElement('div'); accWrap.className = 'set-accents'
    for (const a of ACCENTS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'set-accent' + ((settings.accent || 'turkuaz') === a.id ? ' active' : '')
      b.style.background = a.grad
      b.title = a.label
      b.setAttribute('aria-label', 'Vurgu rengi: ' + a.label)
      b.onclick = () => { TurkuazSettings.set('accent', a.id); applyAppearance(); renderPanel() }
      accWrap.appendChild(b)
    }
    gt.appendChild(row('Vurgu rengi', accWrap, 'Düğme, bağlantı ve vurgu renklerini değiştirir.'))
    p.appendChild(gt)
    const gn = group('BİLDİRİMLER')
    const sw = document.createElement('label'); sw.className = 'set-switch'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = settings.notif !== false
    cb.onchange = () => TurkuazSettings.set('notif', cb.checked)
    sw.append(cb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gn.appendChild(row('Masaüstü bildirimleri', sw, 'Uygulama arkadayken gelen mesaj bildirimi göster.'))
    p.appendChild(gn)
  }

  function renderSimple (p, title, text) {
    p.innerHTML = `<h2>${title}</h2>`
    const g = group(title.toUpperCase())
    const box = document.createElement('div'); box.className = 'set-note-box'; box.textContent = text
    g.appendChild(box)
    p.appendChild(g)
  }

  // ---------- bağla ----------
  window.TurkuazSettings.open = open
  window.TurkuazSettings.apply = applyAppearance
  applyAppearance() // kayıtlı tema/yoğunluğu açılışta uygula
  document.addEventListener('DOMContentLoaded', () => {
    const gear = $('btn-settings')
    if (gear) gear.onclick = () => open('av')
    const closeBtn = $('set-close')
    if (closeBtn) closeBtn.onclick = close
    window.TurkuazAudioOutput.apply()
  })
  document.addEventListener('keydown', (e) => {
    if ($('settings').classList.contains('hidden') || $('settings').inert) return
    if (e.key === 'Escape') { e.stopPropagation(); close(); return }
    if (e.key !== 'Tab') return
    const focusable = [...$('settings').querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && !el.closest('.hidden') && el.tabIndex >= 0 && el.getClientRects().length > 0)
    if (!focusable.length) { e.preventDefault(); return }
    const first = focusable[0]; const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    else if (!$('settings').contains(document.activeElement)) { e.preventDefault(); first.focus() }
  }, true)
})()
