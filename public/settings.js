// Turkuaz ayarlar ekranı — Discord-tarzı: solda kategori listesi, sağda panel.
// Ses/görüntü tercihleri localStorage'da tutulur; Voice ve CallMgr canlı uygular.
/* global Voice, CallMgr, state, send, openProfile, copyText, esc */
(function () {
  const KEY = 'turkuaz.settings'
  const DEFAULTS = {
    micId: '', spkId: '', camId: '', inVol: 100, outVol: 100,
    noise: 'standard', screenRes: '720', screenFps: 15, screenAudio: false
  }
  let settings = load()

  function load () {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')) } catch { return Object.assign({}, DEFAULTS) }
  }
  function persist () { try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {} }

  window.TurkuazSettings = {
    get () { return settings },
    set (k, v) { settings[k] = v; persist() }
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

  function open (cat) {
    cur = cat || 'av'
    renderNav()
    renderPanel()
    $('settings').classList.remove('hidden')
  }
  function close () {
    stopMicTest()
    $('settings').classList.add('hidden')
  }

  function renderNav () {
    const nav = $('set-nav')
    nav.innerHTML = ''
    for (const c of CATS) {
      const el = document.createElement('div')
      el.className = 'set-cat' + (c.id === cur ? ' active' : '')
      el.innerHTML = `<span class="ic">${c.icon}</span><span>${c.label}</span>`
      el.onclick = () => { if (cur !== c.id) { stopMicTest(); cur = c.id; renderNav(); renderPanel() } }
      nav.appendChild(el)
    }
  }

  function renderPanel () {
    const p = $('set-panel')
    if (cur === 'av') return renderAV(p)
    if (cur === 'account') return renderAccount(p)
    if (cur === 'appearance') return renderSimple(p, 'Görünüm', 'Şu an tek tema var: koyu turkuaz. Açık tema ve mesaj yoğunluğu (rahat/sıkışık) yol haritasında.')
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
      selectEl(opt(spks, 'Hoparlör'), settings.spkId, v => { TurkuazSettings.set('spkId', v); Voice.setSink && Voice.setSink(v); CallMgr.setSink && CallMgr.setSink(v) })))
    p.appendChild(gDev)

    // Gürültü engelleme (AI)
    const gNoise = group('GÜRÜLTÜ ENGELLEME')
    gNoise.appendChild(row('Mod',
      selectEl([
        { value: 'off', label: 'Kapalı' },
        { value: 'standard', label: 'Standart' },
        { value: 'strong', label: 'Güçlü — AI (RNNoise)' }
      ], settings.noise || 'standard', v => TurkuazSettings.set('noise', v)),
      'AI modu klavye/fan/arka plan sesini bastırır. Değişiklik bir sonraki katılım/aramada geçerli.'))
    const cores = navigator.hardwareConcurrency || '?'
    const mem = navigator.deviceMemory ? ('~' + navigator.deviceMemory + ' GB') : '?'
    const sys = document.createElement('div'); sys.className = 'set-note-box'
    sys.innerHTML = `Sistem: <b>${cores}</b> çekirdek · <b>${mem}</b> RAM. AI gürültü engelleme (RNNoise) hafiftir, her cihazda çalışır. Daha güçlü <b>DeepFilterNet</b> (~137 MB) güçlü makineler için isteğe bağlı indirilecek — yakında.`
    gNoise.appendChild(sys)
    p.appendChild(gNoise)

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
    testBtn.textContent = '🎙️ Testi başlat'
    const meter = document.createElement('div')
    meter.className = 'set-meter'
    meter.innerHTML = '<div class="set-meter-fill" id="set-meter-fill"></div>'
    testBtn.onclick = () => {
      if (testStream) { stopMicTest(); testBtn.textContent = '🎙️ Testi başlat' } else { startMicTest(); testBtn.textContent = '⏹️ Testi durdur' }
    }
    const tr = document.createElement('div'); tr.className = 'set-row'
    const tl = document.createElement('div'); tl.className = 'set-label'
    tl.innerHTML = '<div>Konuş, çubuk oynasın</div><div class="set-hint">Seçtiğin mikrofon ve giriş seviyesiyle.</div>'
    const trc = document.createElement('div'); trc.append(testBtn, meter)
    tr.append(tl, trc); gTest.appendChild(tr)
    p.appendChild(gTest)

    // Kamera
    const gCam = group('KAMERA')
    gCam.appendChild(row('Kamera cihazı',
      selectEl(opt(cams, 'Kamera'), settings.camId, v => { TurkuazSettings.set('camId', v) }),
      'Değişiklik kamerayı bir sonraki açışta geçerli.'))
    p.appendChild(gCam)

    // Ekran paylaşımı
    const gScr = group('EKRAN PAYLAŞIMI')
    gScr.appendChild(row('Çözünürlük',
      selectEl([{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }, { value: 'source', label: 'Kaynak (tam)' }], settings.screenRes, v => TurkuazSettings.set('screenRes', v))))
    gScr.appendChild(row('Kare hızı (FPS)',
      selectEl([{ value: '15', label: '15 fps' }, { value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }], String(settings.screenFps), v => TurkuazSettings.set('screenFps', Number(v)))))
    const scrAudio = document.createElement('label'); scrAudio.className = 'set-switch'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!settings.screenAudio
    cb.onchange = () => TurkuazSettings.set('screenAudio', cb.checked)
    scrAudio.append(cb, Object.assign(document.createElement('span'), { className: 'set-track' }))
    gScr.appendChild(row('Ekran sesini de paylaş', scrAudio, 'Linux\'ta ekran sesi yakalama sınırlı olabilir.'))
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
    editBtn.onclick = () => { close(); openProfile() }
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
  function renderPrivacy (p) {
    p.innerHTML = '<h2>Gizlilik</h2>'
    const g = group('BAĞLANTI (ICE / TURN)')
    const ice = Array.isArray(state.ice) ? state.ice : []
    const turn = ice.filter(s => JSON.stringify(s.urls).includes('turn')).length
    const box = document.createElement('div'); box.className = 'set-note-box'
    box.innerHTML = turn
      ? `Ses/görüntü için TURN röle etkin (${turn} kayıt). Farklı ağlardaki iki PC arasında doğrudan bağlantı kurulamazsa medya bu röleden geçer; içerik DTLS-SRTP ile şifreli kaldığı için röle görmez.`
      : 'Şu an yalnızca STUN var (doğrudan bağlantı). Farklı ağlardaysanız kamera/ses bağlanmayabilir — <code>ice.json</code> ile TURN ekleyebilirsin.'
    g.appendChild(box)
    p.appendChild(g)
  }

  // ---------- Gelişmiş ----------
  function renderAdvanced (p) {
    p.innerHTML = '<h2>Gelişmiş</h2>'
    const g = group('UYGULAMA')
    const box = document.createElement('div'); box.className = 'set-note-box'
    box.innerHTML = `Sürüm bilgisi ve otomatik güncelleme masaüstü penceresinde (tepsi menüsü) yönetilir.
      Veri klasörü ve <code>ice.json</code> yeri README'de. Kimliğini taşımak için sol alttaki ⇄ düğmesini kullan.`
    g.appendChild(box)
    p.appendChild(g)
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
  document.addEventListener('DOMContentLoaded', () => {
    const gear = $('btn-settings')
    if (gear) gear.onclick = () => open('av')
    const closeBtn = $('set-close')
    if (closeBtn) closeBtn.onclick = close
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings').classList.contains('hidden')) { e.stopPropagation(); close() }
  }, true)
})()
