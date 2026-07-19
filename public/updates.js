// Masaüstü otomatik güncelleme arayüzü. Ağ/feed bilgisi renderer'a açılmaz;
// preload yalnız durum, manuel kontrol ve hazır güncellemeyi kurma eylemini verir.
(function () {
  const api = window.turkuazDesktop && window.turkuazDesktop.updates
  if (!api) return

  let state = { status: 'idle', currentVersion: '', version: null, percent: 0 }
  let dismissed = null
  let bar = null

  // "Tak diye" güncelleme: indirme bitince kullanıcı butonu beklemeden, görünür
  // bir geri sayımla kendini kurar. Aktif arama/sesli sohbet varsa sayaç durur
  // (aramayı kesmeyiz); ✕ ile iptal edilirse kurulum normal çıkışa kalır.
  const AUTO_INSTALL_SECS = 15
  let autoTimer = null
  let autoLeft = 0
  function busyInCall () {
    return !!((window.Voice && window.Voice.room) || (window.CallMgr && window.CallMgr.state))
  }
  function cancelAuto () {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
    autoLeft = 0
  }
  function startAuto () {
    if (autoTimer || state.status !== 'ready') return
    autoLeft = AUTO_INSTALL_SECS
    autoTimer = setInterval(() => {
      if (state.status !== 'ready') { cancelAuto(); render(); return }
      if (busyInCall()) { render(); return } // aramadayken bekle, bitince devam
      autoLeft--
      if (autoLeft <= 0) { cancelAuto(); api.install().catch(() => {}); return }
      render()
    }, 1000)
  }

  function keyOf (s) { return s.status + ':' + (s.version || '') }
  function percent (n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))) }
  function size (n) {
    n = Number(n) || 0
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return n ? n + ' B' : ''
  }

  function statusText (s) {
    switch (s.status) {
      case 'disabled': return s.reason || 'Otomatik güncelleme bu pakette kullanılamıyor.'
      case 'checking': return 'Güncellemeler denetleniyor…'
      case 'downloading': {
        const detail = s.total ? ' · ' + size(s.transferred) + ' / ' + size(s.total) : ''
        return 'Turkuaz v' + (s.version || '?') + ' indiriliyor · %' + percent(s.percent) + detail
      }
      case 'ready':
        if (autoTimer && busyInCall()) return 'Turkuaz v' + (s.version || '?') + ' hazır — arama bitince kurulacak.'
        if (autoTimer) return 'Turkuaz v' + (s.version || '?') + ' hazır — ' + autoLeft + ' sn içinde yeniden başlatılıyor…'
        return 'Turkuaz v' + (s.version || '?') + ' hazır — yeniden başlatınca kurulacak.'
      case 'installing': return 'Güncelleme kuruluyor, Turkuaz yeniden başlatılıyor…'
      case 'up-to-date': return 'Turkuaz güncel · v' + (s.currentVersion || '?')
      case 'error': return 'Güncelleme kontrol edilemedi: ' + (s.error || 'bilinmeyen hata')
      default: return 'Otomatik güncelleme açık · v' + (s.currentVersion || '?')
    }
  }

  function ensureBar () {
    if (bar) return bar
    bar = document.createElement('div')
    bar.id = 'update-bar'
    bar.className = 'desktop-update hidden'
    bar.setAttribute('role', 'status')
    bar.setAttribute('aria-live', 'polite')

    const icon = document.createElement('span')
    icon.className = 'update-icon'
    icon.textContent = '↻'
    const content = document.createElement('div')
    content.className = 'update-content'
    const text = document.createElement('div')
    text.className = 'update-text'
    const track = document.createElement('div')
    track.className = 'update-progress'
    const fill = document.createElement('div')
    fill.className = 'update-progress-fill'
    track.appendChild(fill)
    content.append(text, track)

    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'update-action'
    action.onclick = () => {
      if (state.status === 'ready') api.install().catch(() => {})
      else if (state.status === 'error') api.check().catch(() => {})
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'update-close'
    close.title = 'Sonra'
    close.textContent = '✕'
    close.onclick = () => {
      cancelAuto() // "Sonra" = geri sayımı durdur; kurulum normal çıkışta yapılır
      dismissed = keyOf(state)
      if (state.status !== 'ready') bar.classList.add('hidden')
      render()
    }
    bar.append(icon, content, action, close)
    document.body.appendChild(bar)
    return bar
  }

  function syncSettings () {
    const text = document.getElementById('set-update-status')
    if (text) text.textContent = statusText(state)
    const check = document.getElementById('set-update-check')
    if (check) {
      check.disabled = ['disabled', 'checking', 'downloading', 'ready', 'installing'].includes(state.status)
      check.textContent = state.status === 'checking' ? 'Denetleniyor…' : 'Güncellemeleri denetle'
    }
    const install = document.getElementById('set-update-install')
    if (install) {
      install.hidden = state.status !== 'ready'
      install.disabled = state.status !== 'ready'
    }
  }

  function render () {
    const el = ensureBar()
    const visible = state.status === 'downloading' || state.status === 'ready' || state.status === 'installing' ||
      (state.manual && ['checking', 'up-to-date', 'error'].includes(state.status))
    const hidden = !visible || (dismissed === keyOf(state) && state.status !== 'ready')
    el.classList.toggle('hidden', hidden)
    el.dataset.status = state.status
    el.querySelector('.update-icon').textContent = state.status === 'ready' ? '✓' : (state.status === 'error' ? '!' : '↻')
    el.querySelector('.update-text').textContent = statusText(state)
    const progress = el.querySelector('.update-progress')
    progress.hidden = state.status !== 'downloading'
    el.querySelector('.update-progress-fill').style.width = percent(state.percent) + '%'
    const action = el.querySelector('.update-action')
    action.hidden = !['ready', 'error'].includes(state.status)
    action.textContent = state.status === 'ready' ? 'Yeniden başlat ve güncelle' : 'Tekrar dene'
    el.querySelector('.update-close').hidden = state.status === 'installing'
    syncSettings()
  }

  function setState (next) {
    const previousKey = keyOf(state)
    state = { ...state, ...(next || {}) }
    if (keyOf(state) !== previousKey) dismissed = null
    if (state.status === 'ready' && keyOf(state) !== previousKey) startAuto()
    if (state.status !== 'ready') cancelAuto()
    render()
  }

  window.TurkuazUpdates = {
    check: () => api.check().then((next) => { if (next && typeof next === 'object') setState(next); return next }),
    install: () => api.install(),
    getState: () => ({ ...state }),
    statusText: () => statusText(state),
    sync: syncSettings
  }

  api.onState(setState)
  api.getState().then(setState).catch(() => {})
})()
