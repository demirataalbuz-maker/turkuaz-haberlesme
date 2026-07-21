// Turkuaz arayüzü. Taşıma katmanı (WebSocket / mobil köprü) transport.js'te;
// UI sadece window.send() ve Transport.onMessage() üzerinden konuşur.
let state = { me: { name: '', code: '', avatar: '', status: '' }, friends: [], requests: [], rooms: [], pending: {}, blocked: [] }
let activeConv = null            // { type:'dm', code } | { type:'room', topic }
let replyTarget = null           // yanıtlanan mesaj { id, name, text }
const activeChs = {}             // topic -> kanal adı
const histories = {}             // conv -> [msg] (katlanmış)
const loadLSMap = (key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
const unread = loadLSMap('turkuaz.unread')               // key -> sayı (dm: conv, oda: conv#ch)
const unreadMention = loadLSMap('turkuaz.unreadMention') // key -> beni anan mesaj sayısı (oda)
let unreadMarker = null          // { key, count, id? } — sohbet açılınca "YENİ" ayracının yeri
const typing = {}                // key -> { name, until }

const $ = (id) => document.getElementById(id)
const QUICK_EMOJI = ['👍', '❤️', '😂', '🔥', '😮']
const AVATARS = ['😀', '😎', '🦊', '🐱', '🐼', '🦁', '🐸', '👾', '🤖', '🐙', '🦄', '🐺', '🦅', '🐍', '⚡', '🌊', '🌙', '⭐', '🎮', '🎧', '⚔️', '🛡️', '🧿', '🍉']
const EMOJI_SET = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😏', '😴', '😢', '😭', '😡', '🥳', '😅', '😬', '🫡', '🤯', '👍', '👎', '👏', '🙏', '🙌', '💪', '🤝', '👀', '🔥', '⭐', '✨', '🎉', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '✅', '❌', '⚡', '🌊', '🌙', '☀️', '🎮', '🎧', '🚀']

// Gelen mesajları işle — taşıma (WebSocket / mobil köprü) transport.js'te.
Transport.onMessage((m) => {
    switch (m.t) {
      case 'state':
        state = m
        if (!gotState && window.TurkuazNative) { try { localStorage.setItem('tq.bootOk', 'ok') } catch {} }
        gotState = true
        render()
        break
      case 'log': onCoreLog(m); break
      case 'history':
        histories[m.conv] = m.msgs
        if (isActiveConv(m.conv)) renderMessages()
        break
      case 'msg': onIncomingMsg(m); break
      case 'msg-ev': applyEvent(m.conv, m.ev); break
      case 'delivered': {
        // Güncel 'state' bu mesajdan SONRA gelebiliyor — bekleyen kaydı yerelde
        // de düş ki mesaj ulaştığı halde ⏳ işareti asılı kalmasın.
        const dcode = m.conv.startsWith('dm-') ? m.conv.slice(3) : null
        if (dcode && state.pending[dcode]) state.pending[dcode] = state.pending[dcode].filter(x => x !== m.id)
        if (isActiveConv(m.conv)) renderMessages()
        break
      }
      case 'typing': onTyping(m.conv, m.name); break
      case 'notify': onNotify(m); break
      case 'file-ready': if (activeConv) renderMessages(); break
      case 'file-data': onFileData(m); break
      case 'search-res': renderSearchResults(m); break
      case 'export-res':
        $('export-box').value = btoa(unescape(encodeURIComponent(JSON.stringify(m.data))))
        break
      case 'import-res':
        alert(m.ok ? 'Hesap içe aktarıldı! Turkuaz şimdi kapanacak — tekrar açtığında yeni kimliğinle başlar.' : 'Geçersiz taşıma metni.')
        break
      case 'rtc': if (window.Voice) Voice.onRtc(m); break
      case 'room-ev': onRoomEv(m); break
    }
})
// send() ve Transport transport.js'te tanımlı (window.send / window.Transport).

let transportStatus = 'connecting'
function toast (message, kind = 'info', timeout = 3200) {
  const region = $('toast-region')
  if (!region || !message) return
  const item = document.createElement('div')
  item.className = 'toast ' + kind
  item.textContent = String(message)
  region.appendChild(item)
  requestAnimationFrame(() => item.classList.add('show'))
  setTimeout(() => {
    item.classList.remove('show')
    setTimeout(() => item.remove(), 180)
  }, timeout)
}
window.toast = toast

Transport.onStatus(({ status }) => {
  const previous = transportStatus
  transportStatus = status
  const online = status === 'online'
  const banner = $('connection-banner')
  if (banner) {
    banner.classList.toggle('hidden', online)
    banner.dataset.status = status
    $('connection-banner-text').textContent = status === 'connecting'
      ? 'Turkuaz başlatılıyor…'
      : status === 'reconnecting'
        ? 'Bağlantı yeniden kuruluyor — mesajların kısa süreliğine sırada tutuluyor.'
        : 'Bağlantı koptu — yeniden bağlanılıyor, mesajların sırada tutuluyor.'
  }
  const badge = document.querySelector('.p2p-badge')
  if (badge) {
    badge.dataset.status = status
    badge.title = online ? 'Yerel Turkuaz motoru bağlı' : 'Turkuaz motoruna yeniden bağlanılıyor'
  }
  if (online && (previous === 'offline' || previous === 'reconnecting')) toast('Bağlantı yeniden kuruldu.', 'success')
})

function persistUnread () {
  try {
    localStorage.setItem('turkuaz.unread', JSON.stringify(unread))
    localStorage.setItem('turkuaz.unreadMention', JSON.stringify(unreadMention))
  } catch {}
}
function syncUnreadUI () {
  const total = Object.values(unread).reduce((sum, value) => sum + (Number(value) || 0), 0)
  document.title = total ? `(${total}) Turkuaz` : 'Turkuaz'
}
function markRead (key) {
  if (unread[key]) delete unread[key]
  if (unreadMention[key]) delete unreadMention[key]
  persistUnread()
  syncUnreadUI()
}
// Sohbet açılırken okunmamış sayısını yakala: renderMessages "YENİ" ayracını
// buna göre çizer (ilk çizimde mesaj id'sine sabitlenir ki kaymasın).
function captureUnreadMarker (key) {
  unreadMarker = unread[key] ? { key, count: unread[key] } : null
}
function markActiveRead () {
  if (!activeConv || document.visibilityState !== 'visible' || !document.hasFocus()) return
  const key = activeConv.type === 'dm'
    ? 'dm-' + activeConv.code
    : 'room-' + activeConv.topic + '#' + activeCh(activeConv.topic)
  if (unread[key]) { markRead(key); render() }
}

function convId () {
  if (!activeConv) return null
  return activeConv.type === 'dm' ? 'dm-' + activeConv.code : 'room-' + activeConv.topic
}
function isActiveConv (conv) { return convId() === conv }
function activeCh (topic) { return activeChs[topic] || 'genel' }
function unreadKey (conv, ch) { return conv.startsWith('room-') ? conv + '#' + (ch || 'genel') : conv }

// Mesaj beni anıyor mu? (@isim — tam ad ya da ilk kelime, büyük/küçük duyarsız)
function mentionsMe (text) {
  const me = (state.me.name || '').trim().toLocaleLowerCase('tr')
  if (!me || !text) return false
  const low = String(text).toLocaleLowerCase('tr')
  return low.includes('@' + me) || low.split(/\s+/).includes('@' + me.split(/\s+/)[0])
}

// Bahsetme ping sesi (kısa iki ton)
let _pingCtx = null
function pingSound () {
  if (window.TurkuazSettings && TurkuazSettings.get().notif === false) return
  try {
    _pingCtx = _pingCtx || new (window.AudioContext || window.webkitAudioContext)()
    const c = _pingCtx; const t = c.currentTime
    for (const [f, dt] of [[880, 0], [1318, 0.09]]) {
      const o = c.createOscillator(); const g = c.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + dt)
      g.gain.exponentialRampToValueAtTime(0.1, t + dt + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.22)
      o.connect(g).connect(c.destination)
      o.start(t + dt); o.stop(t + dt + 0.25)
    }
  } catch {}
}

function onIncomingMsg (m) {
  if (!histories[m.conv]) histories[m.conv] = []
  histories[m.conv].push(m.msg)
  const mine = m.msg.from === state.me.code
  if (!mine && mentionsMe(m.msg.text)) pingSound()
  const visible = document.visibilityState === 'visible' && document.hasFocus() && isActiveConv(m.conv) &&
    (!m.conv.startsWith('room-') || (m.msg.ch || 'genel') === activeCh(m.conv.slice(5)))
  if (visible) renderMessages()
  else if (!mine) {
    const k = unreadKey(m.conv, m.msg.ch)
    unread[k] = (unread[k] || 0) + 1
    if (m.conv.startsWith('room-') && mentionsMe(m.msg.text)) unreadMention[k] = (unreadMention[k] || 0) + 1
    persistUnread()
    syncUnreadUI()
    render()
  }
}

function applyEvent (conv, ev) {
  const msgs = histories[conv]
  if (msgs) {
    const t = msgs.find(x => x.id === ev.id)
    if (t) {
      if (ev.ev === 'react') {
        t.reacts = t.reacts || {}
        const r = t.reacts[ev.emoji] = t.reacts[ev.emoji] || {}
        if (r[ev.from]) delete r[ev.from]; else r[ev.from] = ev.name || 'anon'
        if (!Object.keys(r).length) delete t.reacts[ev.emoji]
      } else if (ev.ev === 'edit' && ev.from === t.from) { t.text = ev.text; t.edited = true }
      else if (ev.ev === 'del' && ev.from === t.from) { t.deleted = true; t.text = ''; delete t.file }
      else if (ev.ev === 'pin') { t.pinned = !t.pinned }
    }
  }
  if (isActiveConv(conv)) renderMessages()
}

function onRoomEv (m) {
  if (m.ev && m.ev.kind === 'typing') {
    const k = 'room-' + m.room + '#' + (m.ev.ch || 'genel')
    typing[k] = { name: m.name, until: Date.now() + 3500 }
    renderTyping()
    return
  }
  if (m.ev && m.ev.kind === 'sndpad') { // soundboard: sadece aynı sesli sohbetteysek çal
    if (window.Voice && Voice.room === m.room && window.Soundboard) Soundboard.remote(String(m.ev.id || ''))
    return
  }
  if (m.ev && m.ev.kind === 'game') { // oyun modu olayları (davet/durum/pozisyon)
    if (window.Games) Games.onRoomEv(m)
    return
  }
  if (window.Voice) Voice.onRoomEv(m)
}

function onTyping (conv, name) {
  typing[conv] = { name, until: Date.now() + 3500 }
  renderTyping()
}

function renderTyping () {
  const bar = $('typing-bar')
  if (!activeConv) { bar.textContent = ''; return }
  const k = activeConv.type === 'dm' ? convId() : convId() + '#' + activeCh(activeConv.topic)
  const t = typing[k]
  if (t && t.until > Date.now()) {
    bar.innerHTML = `<b>${esc(t.name)}</b> yazıyor<span class="dots"></span>`
  } else bar.textContent = ''
}
setInterval(renderTyping, 1000)

function onNotify (m) {
  if (document.hasFocus()) return
  if (window.TurkuazSettings && TurkuazSettings.get().notif === false) return
  if (Notification.permission !== 'granted') return
  const n = new Notification(m.title, { body: m.body, silent: false })
  n.onclick = () => { window.focus(); if (m.conv) openConvById(m.conv) }
}

// ---- görsel yardımcılar ----
// Beyaz baş harfin her renkte okunabilmesi için paletin tamamı WCAG-kontrastlı koyu tonlarda.
const COLORS = ['#0f766e', '#0369a1', '#6d28d9', '#b45309', '#b91c1c', '#be185d', '#15803d', '#a16207']
function colorOf (code) {
  let h = 0
  for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
function initialOf (name, code) { return (name || code || '?').trim()[0].toUpperCase() }
// textContent→innerHTML yalnız <>& kaçırır; esc çıktısı ÖZNİTELİK bağlamında da
// (href="...", title="...") kullanıldığından tırnakları da kaçır — yoksa
// url/başlık içine sıkışan " ile onmouseover=... enjekte edilebilir (XSS).
function esc (s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;') }
function fmtTime (ts) { return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) }
function fmtDay (ts) { return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) }
function fmtSize (b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB' }
function shortCode (code) { return code.slice(0, 8) + '…' + code.slice(-6) }
function nameOf (f) { return f.name || 'anon-' + f.code.slice(0, 6) }

// Mesaj metni biçimlendirme: önce güvenli kaçış (esc), sonra hafif markdown.
// Kod blokları/inline kod önce yer-tutucuya alınır ki içlerinde biçimlendirme olmasın.
function fmt (raw) {
  let s = esc(raw)
  const blocks = []; const codes = []
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push(c); return ' B' + (blocks.length - 1) + ' ' })
  s = s.replace(/`([^`\n]+?)`/g, (_, c) => { codes.push(c); return ' C' + (codes.length - 1) + ' ' })
  s = s.replace(/(https?:\/\/[^\s<]+)/g, m => `<a class="msg-link" href="${m}" target="_blank" rel="noreferrer noopener">${m}</a>`)
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[\s(])_([^_\n]+?)_/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
  s = s.replace(/\|\|([^|\n]+?)\|\|/g, '<span class="spoiler" onclick="this.classList.add(\'shown\')">$1</span>')
  s = s.replace(/(^|\s)@([\wğüşöçıİĞÜŞÖÇ._-]{1,32})/g, (_, pre, name) => {
    const meN = (state.me.name || '').trim().toLocaleLowerCase('tr')
    const isMe = meN && [meN, meN.split(/\s+/)[0]].includes(name.toLocaleLowerCase('tr'))
    return `${pre}<span class="mention${isMe ? ' me' : ''}">@${name}</span>`
  })
  s = s.replace(/ C(\d+) /g, (_, i) => `<code>${codes[+i]}</code>`)
  s = s.replace(/ B(\d+) /g, (_, i) => `<pre class="codeblock"><code>${blocks[+i]}</code></pre>`)
  return s
}

// ---- link önizleme (gönderen üretir; alıcının IP'si siteye hiç gitmez) ----
// Yazarken URL görülünce arka planda /preview'dan ısıtılır; Enter'da hazırsa
// karta dönüşüp mesajla gider. Görsel canvas'ta küçültülür (JPEG ≤80 KB).
const PREV_IMG_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/
const prevDone = new Map() // url -> kart | null
const prevWait = new Map() // url -> Promise
function firstUrl (text) {
  const m = String(text || '').match(/https?:\/\/[^\s<]+/)
  return m ? m[0] : null
}
function shrinkPreviewImage (dataUri) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 420 / (img.width || 1))
      const cv = document.createElement('canvas')
      cv.width = Math.max(1, Math.round(img.width * scale))
      cv.height = Math.max(1, Math.round(img.height * scale))
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
      let out = ''
      try { out = cv.toDataURL('image/jpeg', 0.72) } catch {}
      resolve(out && out.length <= 80000 ? out : '')
    }
    img.onerror = () => resolve('')
    img.src = dataUri
  })
}
function fetchPreview (url) {
  if (window.TurkuazNative) return Promise.resolve(null) // mobil: HTTP ucu yok
  if (prevDone.has(url)) return Promise.resolve(prevDone.get(url))
  if (prevWait.has(url)) return prevWait.get(url)
  const p = (async () => {
    try {
      const r = await fetch('/preview?url=' + encodeURIComponent(url))
      const j = await r.json()
      if (!j || !j.ok) return null
      const prev = { url, title: j.title || '', desc: j.desc || '', site: j.site || '' }
      if (j.img) {
        const small = await shrinkPreviewImage(j.img)
        if (small) prev.img = small
      }
      return (prev.title || prev.desc) ? prev : null
    } catch { return null }
  })().then(v => {
    if (prevDone.size > 300) prevDone.clear()
    prevDone.set(url, v)
    prevWait.delete(url)
    return v
  })
  prevWait.set(url, p)
  return p
}
function prevHTML (p) {
  if (!p || !/^https?:\/\//i.test(p.url || '')) return ''
  const img = typeof p.img === 'string' && PREV_IMG_RE.test(p.img) ? p.img : ''
  return `<a class="msg-preview" href="${esc(p.url)}" target="_blank" rel="noreferrer noopener">
    ${p.site ? `<span class="mp-site">${esc(p.site)}</span>` : ''}
    ${p.title ? `<span class="mp-title">${esc(p.title)}</span>` : ''}
    ${p.desc ? `<span class="mp-desc">${esc(p.desc)}</span>` : ''}
    ${img ? `<img class="mp-img" src="${img}" alt="" loading="lazy">` : ''}
  </a>`
}

function avatarHTML (avatar, name, code, dot) {
  const cls = avatar ? 'avatar emoji' : 'avatar'
  const bg = avatar ? '' : `background:${colorOf(code)}`
  const inner = avatar || initialOf(name, code)
  return `<div class="${cls}" style="${bg}">${esc(inner)}${dot !== undefined ? `<div class="dot ${dot ? 'on' : ''}"></div>` : ''}</div>`
}

function avatarOf (code) {
  if (code === state.me.code) return state.me.avatar
  const f = state.friends.find(x => x.code === code)
  return (f && f.avatar) || ''
}

// ---- render ----
function render () {
  syncUnreadUI()
  const vb = $('ver-badge')
  if (vb) { const v = state.version || window.__TQ_MOBILE_VER; vb.textContent = v ? 'v' + v : '' }
  $('me-name').textContent = state.me.name || 'isimsiz'
  $('me-status').textContent = state.me.status || 'çevrimiçi'
  $('my-code').textContent = state.me.code
  const av = $('me-avatar')
  av.textContent = state.me.avatar || initialOf(state.me.name, state.me.code)
  av.className = state.me.avatar ? 'avatar emoji' : 'avatar'
  av.style.background = state.me.avatar ? '' : colorOf(state.me.code)
  if (!state.me.name && $('modal-profile').classList.contains('hidden')) openProfile()
  const homeButton = $('btn-home')
  const onHome = !activeConv
  homeButton.classList.toggle('active', onHome)
  homeButton.setAttribute('aria-current', onHome ? 'page' : 'false')

  // sol ray — odalar
  const rail = $('rail-rooms')
  rail.innerHTML = ''
  for (const r of state.rooms) {
    const activeR = activeConv && activeConv.type === 'room' && activeConv.topic === r.topic
    const el = document.createElement('div')
    el.className = 'rail-btn room' + (activeR ? ' active' : '')
    if (!activeR) el.style.setProperty('--room-color', colorOf(r.topic))
    el.textContent = r.name.trim()[0].toUpperCase()
    el.title = `${r.name} — ${r.online} kişi çevrimiçi`
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-label', el.title)
    el.setAttribute('aria-current', activeR ? 'page' : 'false')
    // Discord hissi: bahsetme → kırmızı sayılı rozet; sıradan okunmamış → sessiz nokta
    const un = r.channels.reduce((s, ch) => s + (unread['room-' + r.topic + '#' + ch] || 0), 0)
    const um = r.channels.reduce((s, ch) => s + (unreadMention['room-' + r.topic + '#' + ch] || 0), 0)
    if (um) el.innerHTML += `<span class="badge">${um}</span>`
    else if (un) el.innerHTML += '<span class="badge soft" title="Okunmamış mesaj var"></span>'
    el.onclick = () => openRoom(r)
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } }
    rail.appendChild(el)
  }

  // istekler
  const rq = $('requests')
  rq.innerHTML = ''
  $('requests-wrap').style.display = state.requests.length ? '' : 'none'
  for (const r of state.requests) {
    const el = document.createElement('div')
    el.className = 'request-item'
    el.innerHTML = `${avatarHTML(r.avatar, r.name, r.code)}
      <div class="rname">${esc(r.name || 'anon')}<br><small>${shortCode(r.code)}</small></div>`
    const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = '✓'
    ok.title = 'Arkadaşlık isteğini kabul et'; ok.setAttribute('aria-label', ok.title)
    ok.onclick = () => send({ t: 'accept-request', code: r.code })
    const no = document.createElement('button'); no.className = 'no'; no.textContent = '✕'
    no.title = 'Arkadaşlık isteğini reddet'; no.setAttribute('aria-label', no.title)
    no.onclick = () => send({ t: 'reject-request', code: r.code })
    el.append(ok, no)
    rq.appendChild(el)
  }

  // DM listesi
  const dl = $('dm-list')
  dl.innerHTML = ''
  for (const f of state.friends) {
    const el = document.createElement('div')
    el.className = 'dm-item' + (activeConv && activeConv.type === 'dm' && activeConv.code === f.code ? ' active' : '')
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-label', nameOf(f) + (f.online ? ', çevrimiçi' : ', çevrimdışı'))
    el.setAttribute('aria-current', activeConv && activeConv.type === 'dm' && activeConv.code === f.code ? 'page' : 'false')
    const un = unread['dm-' + f.code]
    el.innerHTML = `${avatarHTML(f.avatar, f.name, f.code, f.online)}
      <div class="dcol">
        <div class="dname">${esc(nameOf(f))}</div>
        ${f.statusText ? `<div class="dstatus">${esc(f.statusText)}</div>` : ''}
      </div>
      ${f.status === 'pending-out' ? '<span class="pstat wait" title="Karşı tarafın seni eklemesi bekleniyor">⏳</span>' : ''}
      ${un ? `<span class="unread">${un}</span>` : ''}`
    el.onclick = () => openDM(f)
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } }
    dl.appendChild(el)
  }
  if (!state.friends.length) {
    dl.innerHTML = '<div class="dm-empty"><span>👋</span><b>Henüz arkadaş yok</b><small>Kodunu paylaş veya yukarıdan bir arkadaş ekle.</small></div>'
  }

  renderChatHead()
  renderSidebarView()
  renderMembers()
  applyHash()
}

// Oda üye listesi (sağ panel)
function renderMembers () {
  const panel = $('member-list')
  if (!panel) return
  if (!activeConv || activeConv.type !== 'room') { panel.classList.add('hidden'); panel.classList.remove('panel-open'); syncMemberPanel(); return }
  const r = state.rooms.find(x => x.topic === activeConv.topic)
  if (!r) { panel.classList.add('hidden'); panel.classList.remove('panel-open'); syncMemberPanel(); return }
  panel.classList.remove('hidden')
  const members = [{ code: state.me.code, name: state.me.name || 'sen', me: true }]
    .concat((r.members || []).filter(m => m.code !== state.me.code))
  panel.innerHTML = `<div class="ml-title">ÜYELER — ${members.length}</div>` + members.map(m =>
    `<div class="ml-item">${avatarHTML(avatarOf(m.code), m.name, m.code, true)}<span class="ml-name">${esc(m.name)}${m.me ? ' (sen)' : ''}</span></div>`).join('')
  syncMemberPanel()
}

function syncMemberPanel () {
  const panel = $('member-list')
  if (!panel) return
  const available = !panel.classList.contains('hidden')
  const compact = window.innerWidth <= 1120
  const exposed = available && (!compact || panel.classList.contains('panel-open'))
  panel.inert = !exposed
  panel.setAttribute('aria-hidden', exposed ? 'false' : 'true')
  const toggle = document.querySelector('.members-toggle')
  if (toggle) toggle.setAttribute('aria-expanded', exposed && compact ? 'true' : 'false')
}

function renderChatHead () {
  const title = $('chat-title'); const sub = $('chat-sub'); const actions = $('chat-actions')
  actions.innerHTML = ''
  if (window.Voice) Voice.sync()
  if (!activeConv) {
    title.textContent = 'Turkuaz\'a hoş geldin'
    sub.textContent = 'serversız, uçtan uca şifreli, verin sende'
    $('msg-input').disabled = true
    return
  }
  $('msg-input').disabled = false
  if (activeConv.type === 'dm') {
    const f = state.friends.find(x => x.code === activeConv.code)
    if (!f) return
    title.textContent = '@' + nameOf(f)
    sub.textContent = f.online
      ? 'çevrimiçi — direkt P2P bağlantı' + (f.statusText ? ' · ' + f.statusText : '')
      : (f.status === 'pending-out' ? 'istek bekliyor — karşı tarafın da seni eklemesi lazım' : 'çevrimdışı — mesajlar bağlanınca iletilir')
    const call = document.createElement('button')
    call.className = 'action-call'
    call.textContent = '📞 Ara'
    call.title = 'Sesli veya görüntülü ara'
    call.setAttribute('aria-label', call.title)
    call.disabled = !f.online
    if (!f.online) call.style.opacity = .4
    call.onclick = () => window.CallMgr && CallMgr.start(f.code)
    actions.appendChild(call)
    const blk = document.createElement('button')
    const isB = (state.blocked || []).includes(f.code)
    blk.className = 'action-block' + (isB ? ' unblock' : '')
    blk.textContent = isB ? 'Engeli kaldır' : '🚫 Engelle'
    blk.title = blk.textContent
    blk.setAttribute('aria-label', blk.textContent)
    blk.onclick = () => {
      if (isB) send({ t: 'unblock', code: f.code })
      else if (confirm(nameOf(f) + ' engellensin mi? Mesajları artık gelmeyecek.')) send({ t: 'block', code: f.code })
    }
    actions.appendChild(blk)
  } else {
    const r = state.rooms.find(x => x.topic === activeConv.topic)
    if (!r) { activeConv = null; return renderChatHead() }
    title.textContent = '# ' + activeCh(r.topic) // oda adı sidebar'da; başlıkta aktif kanal
    sub.textContent = r.name + ' · ' + r.online + ' çevrimiçi' + (r.isOwner ? ' · sahibisin' : '')
    const members = document.createElement('button')
    members.className = 'members-toggle'
    members.textContent = '👥 Üyeler'
    members.title = 'Oda üyelerini göster'
    members.setAttribute('aria-label', members.title)
    members.setAttribute('aria-expanded', $('member-list').classList.contains('panel-open') ? 'true' : 'false')
    members.onclick = () => {
      $('member-list').classList.toggle('panel-open')
      syncMemberPanel()
    }
    const copy = document.createElement('button')
    copy.className = 'action-copy'
    copy.textContent = 'Davet kodunu kopyala'
    copy.title = 'Davet kodunu kopyala'
    copy.setAttribute('aria-label', copy.title)
    copy.onclick = () => copyText(r.invite, copy, 'Kopyalandı ✓', 'Davet kodunu kopyala')
    const leave = document.createElement('button')
    leave.className = 'action-leave'
    leave.textContent = 'Ayrıl'
    leave.title = 'Odadan ayrıl'
    leave.setAttribute('aria-label', leave.title)
    leave.onclick = () => {
      if (confirm('"' + r.name + '" odasından ayrılıyor musun?')) {
        send({ t: 'leave-room', topic: r.topic })
        activeConv = null; renderMessages(); render()
      }
    }
    actions.append(members, copy, leave)
  }
}

// ---- Discord-tarzı bağlamsal sidebar ----
// Oda seçiliyken 2. kolon = o odanın dikey kanal listesi (Metin + Ses bölümleri);
// ana sayfa/DM'de = arkadaşlar + DM'ler. (Eski yatay #channel-tabs kaldırıldı.)
function renderSidebarView () {
  const r = activeConv && activeConv.type === 'room' && state.rooms.find(x => x.topic === activeConv.topic)
  const home = $('sidebar-home'); const roomEl = $('sidebar-room')
  if (!home || !roomEl) return
  home.classList.toggle('hidden', !!r)
  roomEl.classList.toggle('hidden', !r)
  if (r) renderSidebarRoom(r, roomEl)
}
// Voice, üyelik değişince (katıl/ayrıl/hello) bunu çağırır → ses kanalı listesi canlı
window.refreshSidebarRoom = () => { if (activeConv && activeConv.type === 'room') renderSidebarView() }

// Odanın sesindeki katılımcılar: sen sesde olmasan da room-ev ile "görülenler" bilinir.
function voiceParticipants (topic) {
  const out = new Map()
  const V = window.Voice
  if (!V) return out
  const seen = V.seen && V.seen.get(topic)
  if (seen) for (const [code, info] of seen) out.set(code, { code, name: info.name || 'anon' })
  if (V.room === topic) {
    out.set(state.me.code, { code: state.me.code, name: state.me.name || 'sen', me: true, muted: V.muted })
    for (const m of V.members.values()) out.set(m.code, { code: m.code, name: m.name || 'anon', muted: m.muted })
  }
  return out
}

function renderSidebarRoom (r, el) {
  el.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'sr-head'
  const nm = document.createElement('span'); nm.className = 'sr-name'; nm.textContent = r.name; nm.title = r.name
  head.appendChild(nm)
  el.appendChild(head)

  const scroll = document.createElement('div'); scroll.className = 'sr-scroll'
  el.appendChild(scroll)

  // ---- METİN KANALLARI ----
  const tg = document.createElement('div'); tg.className = 'ch-group'
  const tgt = document.createElement('div'); tgt.className = 'ch-group-title'
  const tglabel = document.createElement('span'); tglabel.textContent = 'METİN KANALLARI'; tgt.appendChild(tglabel)
  const addBtn = document.createElement('button'); addBtn.className = 'ch-add-mini'; addBtn.textContent = '+'
  addBtn.title = 'Yeni kanal'; addBtn.setAttribute('aria-label', 'Yeni kanal ekle')
  addBtn.onclick = () => {
    const ch = prompt('Kanal adı:')
    if (ch && ch.trim()) { send({ t: 'add-channel', room: r.topic, ch: ch.trim() }); activeChs[r.topic] = ch.trim().toLowerCase().replace(/[^a-z0-9ğüşöçı_-]/g, '') }
  }
  tgt.appendChild(addBtn); tg.appendChild(tgt)
  for (const ch of r.channels) {
    const active = activeCh(r.topic) === ch
    const un = unread['room-' + r.topic + '#' + ch]
    const um = unreadMention['room-' + r.topic + '#' + ch]
    const row = document.createElement('div')
    row.className = 'ch-row' + (active ? ' active' : '') + (un && !active ? ' has-unread' : '')
    row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0')
    row.setAttribute('aria-current', active ? 'page' : 'false')
    const hash = document.createElement('span'); hash.className = 'ch-hash'; hash.textContent = '#'
    const label = document.createElement('span'); label.className = 'ch-label'; label.textContent = ch
    row.append(hash, label)
    if (um) { const b = document.createElement('span'); b.className = 'ch-badge'; b.textContent = um; row.appendChild(b) }
    const go = () => {
      activeChs[r.topic] = ch
      captureUnreadMarker('room-' + r.topic + '#' + ch)
      markRead('room-' + r.topic + '#' + ch)
      closeDrawer()
      render(); renderMessages()
    }
    row.onclick = go
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } }
    tg.appendChild(row)
  }
  scroll.appendChild(tg)

  // ---- SES KANALLARI ----
  const vg = document.createElement('div'); vg.className = 'ch-group'
  const vgt = document.createElement('div'); vgt.className = 'ch-group-title'
  const vglabel = document.createElement('span'); vglabel.textContent = 'SES KANALLARI'; vgt.appendChild(vglabel)
  vg.appendChild(vgt)
  const parts = voiceParticipants(r.topic)
  const joined = !!(window.Voice && Voice.room === r.topic)
  const vrow = document.createElement('div')
  vrow.className = 'vc-row' + (joined ? ' joined' : '')
  vrow.setAttribute('role', 'button'); vrow.setAttribute('tabindex', '0')
  vrow.setAttribute('aria-label', 'Sesli sohbet — genel' + (joined ? ' (içindesin)' : ''))
  const ic = document.createElement('span'); ic.className = 'vc-ic'; ic.textContent = '🔊'
  const vl = document.createElement('span'); vl.className = 'ch-label'; vl.textContent = 'genel'
  vrow.append(ic, vl)
  if (parts.size) { const c = document.createElement('span'); c.className = 'vc-count'; c.textContent = parts.size; vrow.appendChild(c) }
  const joinVoice = () => { if (window.Voice && Voice.room !== r.topic) Voice.join() }
  vrow.onclick = joinVoice
  vrow.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinVoice() } }
  vg.appendChild(vrow)
  if (parts.size) {
    const list = document.createElement('div'); list.className = 'vc-members'
    for (const p of parts.values()) {
      const mrow = document.createElement('div'); mrow.className = 'vc-member'
      mrow.innerHTML = avatarHTML(avatarOf(p.code), p.name, p.code)
      const mn = document.createElement('span'); mn.className = 'vc-mname'; mn.textContent = p.name + (p.me ? ' (sen)' : '')
      mrow.appendChild(mn)
      if (p.muted) { const mu = document.createElement('span'); mu.className = 'vc-mute'; mu.title = 'susturulmuş'; mu.textContent = '🔇'; mrow.appendChild(mu) }
      list.appendChild(mrow)
    }
    vg.appendChild(list)
  }
  scroll.appendChild(vg)
}

function renderMessages () {
  const box = $('messages')
  box.innerHTML = ''
  renderTyping()
  const conv = convId()
  if (!conv) {
    box.innerHTML = `<div class="empty-state">
      <div class="empty-wave" aria-hidden="true">≈</div>
      <span class="empty-kicker">SUNUCUSUZ · DOĞRUDAN · SANA AİT</span>
      <h1>Kendi akışına hoş geldin.</h1>
      <p>Mesajların kendi diskinde kalır. Bağlantılar arkadaşlarına doğrudan ve şifreli gider.</p>
      <div class="empty-actions">
        <button id="empty-add-friend" class="empty-primary">Arkadaş ekle</button>
        <button id="empty-create-room">Oda kur veya katıl</button>
      </div>
      <div class="empty-trust"><span>◆ Uçtan uca şifreli</span><span>◆ Merkezi sunucu yok</span><span>◆ Verin sende</span></div>
    </div>`
    $('empty-add-friend').onclick = () => {
      if (window.innerWidth <= 760) {
        document.body.classList.add('drawer-open')
        syncDrawerButton()
      }
      setTimeout(() => $('friend-code-input').focus(), 0)
    }
    $('empty-create-room').onclick = () => $('btn-add-room').click()
    return
  }
  let msgs = histories[conv] || []
  const isRoom = activeConv.type === 'room'
  const room = isRoom ? state.rooms.find(x => x.topic === activeConv.topic) : null
  if (isRoom) msgs = msgs.filter(m => (m.ch || 'genel') === activeCh(activeConv.topic))
  const pendingIds = activeConv.type === 'dm' ? new Set(state.pending[activeConv.code] || []) : new Set()

  // "YENİ" ayracı: açılışta yakalanan okunmamış sayısından yerini bul,
  // ilk çizimde mesaj id'sine sabitle (yeni mesaj gelince kaymasın)
  const curKey = activeConv.type === 'dm' ? conv : conv + '#' + activeCh(activeConv.topic)
  let newSepAt = -1
  if (unreadMarker && unreadMarker.key === curKey) {
    if (unreadMarker.id) {
      newSepAt = msgs.findIndex(x => x.id === unreadMarker.id)
    } else {
      let left = unreadMarker.count
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].from !== state.me.code && !msgs[i].call) {
          left--
          if (left <= 0) { newSepAt = i; break }
        }
      }
      if (newSepAt >= 0) unreadMarker.id = msgs[newSepAt].id
    }
  }

  let lastFrom = null; let lastTs = 0; let lastDay = ''
  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi]
    if (mi === newSepAt) {
      const us = document.createElement('div')
      us.className = 'unread-sep'
      us.innerHTML = '<span>YENİ</span>'
      box.appendChild(us)
      lastFrom = null
    }
    const day = fmtDay(m.ts)
    if (day !== lastDay) {
      const sep = document.createElement('div')
      sep.className = 'day-sep'; sep.textContent = day
      box.appendChild(sep); lastDay = day; lastFrom = null
    }
    if (m.call) { // arama kaydı: balon değil, ortalanmış sistem satırı
      const sys = document.createElement('div')
      sys.className = 'sys-row'
      sys.textContent = m.text + ' · ' + fmtTime(m.ts)
      box.appendChild(sys)
      lastFrom = null; lastTs = m.ts
      continue
    }
    const compact = m.from === lastFrom && m.ts - lastTs < 5 * 60 * 1000 && !m.deleted
    const row = document.createElement('div')
    const pending = pendingIds.has(m.id)
    const hit = !m.deleted && m.from !== state.me.code && mentionsMe(m.text)
    row.className = 'msg-row' + (compact ? ' compact' : '') + (pending ? ' pending' : '') + (hit ? ' mention-hit' : '')

    let body = ''
    if (m.deleted) {
      body = '<div class="msg-deleted">bu mesaj silindi</div>'
    } else {
      if (m.pinned) body += '<div class="msg-pinned">📌 sabitlendi</div>'
      if (m.re) body += `<div class="msg-reply">↩ <b>${esc(m.re.name || 'anon')}</b>: <span>${esc(m.re.text || '')}</span></div>`
      if (m.fw) body += `<div class="msg-fw">↪ iletildi · aslı: <b>${esc(m.fw.name)}</b></div>`
      if (m.text) body += `<div class="msg-text">${fmt(m.text)}${m.edited ? ' <span class="msg-edited">(düzenlendi)</span>' : ''}${pending ? '<span class="msg-pending-mark">⏳</span>' : ''}</div>`
      if (m.prev) body += prevHTML(m.prev)
      if (m.file) body += fileHTML(m)
    }
    const reacts = reactsHTML(m)

    row.innerHTML = `${avatarHTML(avatarOf(m.from), m.name, m.from)}
      <div class="msg-body">
        ${compact ? '' : `<div class="msg-meta"><span class="msg-author">${esc(m.name || 'anon')}</span><span class="msg-time">${fmtTime(m.ts)}</span></div>`}
        ${body}${reacts}
      </div>`

    if (!m.deleted) row.appendChild(toolsFor(m, conv, room))
    attachMsgHandlers(row, m, conv)
    box.appendChild(row)
    lastFrom = m.from; lastTs = m.ts
  }
  if (!msgs.length) box.innerHTML = '<div class="empty-hint">Henüz mesaj yok — ilk mesajı sen at 🚀</div>'
  box.scrollTop = box.scrollHeight
  requestBridgeFiles(box)
}

// Mobil (WebView köprüsü): /files/ HTTP yolu yok — resim içeriğini çekirdekten
// base64 iste ve data-URL olarak yerleştir. Masaüstünde hiç çalışmaz.
const _fileReq = new Set()
function requestBridgeFiles (box) {
  if (!window.TurkuazNative) return
  box.querySelectorAll('.msg-img[data-fid], .file-missing[data-fid]').forEach(el => {
    const fid = el.dataset.fid
    if (_fileReq.has(fid)) return
    _fileReq.add(fid)
    send({ t: 'file-data', fid })
  })
}
function onFileData (m) {
  if (!m.ok || !m.data) { _fileReq.delete(m.fid); return }
  const dataUrl = 'data:' + (m.mime || 'application/octet-stream') + ';base64,' + m.data
  document.querySelectorAll(`[data-fid="${m.fid}"]`).forEach(el => {
    if ((m.mime || '').startsWith('image/')) {
      const img = document.createElement('img')
      img.className = 'msg-img'
      img.dataset.fid = m.fid
      img.src = dataUrl
      img.onclick = () => window.open(dataUrl)
      el.replaceWith(img)
    } else if ((m.mime || '').startsWith('audio/') && el.tagName === 'AUDIO') {
      el.src = dataUrl // mobil: HTTP yok, sesli mesaj data-URL'den çalınır
    }
  })
}

function fileHTML (m) {
  const f = m.file
  const url = '/files/' + f.fid
  if ((f.mime || '').startsWith('audio/')) {
    return `<div class="msg-audio-wrap"><audio class="msg-audio" controls preload="metadata" src="${url}" data-fid="${f.fid}" data-from="${m.from}"></audio>
      <span class="msg-audio-name">🎤 ${esc(f.fname.replace(/\.[a-z0-9]+$/i, ''))} · ${fmtSize(f.size || 0)}</span></div>`
  }
  if ((f.mime || '').startsWith('image/')) {
    return `<img class="msg-img" src="${url}" data-fid="${f.fid}" data-from="${m.from}" alt="${esc(f.fname)}"
      onerror="this.outerHTML='<div class=&quot;file-missing&quot; data-fid=&quot;${f.fid}&quot; data-from=&quot;${m.from}&quot;>📥 ${esc(f.fname)} — içeriği getirmek için tıkla</div>'">`
  }
  return `<a class="msg-file" href="${url}" download="${esc(f.fname)}">📎 <span>${esc(f.fname)}</span><span class="fsize">${fmtSize(f.size || 0)}</span></a>`
}

function reactsHTML (m) {
  const r = m.reacts || {}
  const keys = Object.keys(r)
  if (!keys.length) return ''
  return '<div class="reacts">' + keys.map(e => {
    const users = r[e]
    const mine = users[state.me.code] ? ' mine' : ''
    const names = Object.values(users).join(', ')
    return `<span class="react-chip${mine}" data-emoji="${e}" title="${esc(names)}">${e} ${Object.keys(users).length}</span>`
  }).join('') + '</div>'
}

function toolsFor (m, conv, room) {
  const tools = document.createElement('div')
  tools.className = 'msg-tools'
  const rep = document.createElement('button')
  rep.textContent = '↩'; rep.title = 'Yanıtla'
  rep.onclick = () => setReply(m)
  tools.appendChild(rep)
  const fwd = document.createElement('button')
  fwd.textContent = '↪'; fwd.title = 'İlet'
  fwd.onclick = () => openForward(m, conv)
  tools.appendChild(fwd)
  const pin = document.createElement('button')
  pin.textContent = '📌'; pin.title = m.pinned ? 'Sabiti kaldır' : 'Sabitle'
  pin.onclick = () => send({ t: 'pin', conv, msgId: m.id })
  tools.appendChild(pin)
  for (const e of QUICK_EMOJI) {
    const b = document.createElement('button')
    b.textContent = e
    b.onclick = () => send({ t: 'react', conv, msgId: m.id, emoji: e })
    tools.appendChild(b)
  }
  if (m.from === state.me.code && !m.file) {
    const ed = document.createElement('button')
    ed.textContent = '✏️'; ed.title = 'Düzenle'
    ed.onclick = () => {
      const t = prompt('Mesajı düzenle:', m.text)
      if (t !== null && t.trim() && t !== m.text) send({ t: 'edit', conv, msgId: m.id, text: t })
    }
    tools.appendChild(ed)
  }
  if (m.from === state.me.code) {
    const del = document.createElement('button')
    del.textContent = '🗑️'; del.title = 'Sil'
    del.onclick = () => { if (confirm('Mesaj silinsin mi?')) send({ t: 'del', conv, msgId: m.id }) }
    tools.appendChild(del)
  }
  if (room && room.isOwner && m.from !== state.me.code) {
    const ban = document.createElement('button')
    ban.textContent = '🚫'; ban.title = 'Odadan yasakla'
    ban.onclick = () => {
      if (confirm(esc(m.name) + ' bu odadan yasaklansın mı? (imzalı ban — herkese dağıtılır)')) {
        send({ t: 'ban', room: room.topic, code: m.from, on: true })
      }
    }
    tools.appendChild(ban)
  }
  return tools
}

function attachMsgHandlers (row, m, conv) {
  row.querySelectorAll('.react-chip').forEach(chip => {
    chip.onclick = () => send({ t: 'react', conv, msgId: m.id, emoji: chip.dataset.emoji })
  })
  const img = row.querySelector('.msg-img')
  if (img) img.onclick = () => window.open(img.src)
  // mobil: hover olmadığı için mesaja dokununca araç çubuğu açılır
  row.addEventListener('click', (e) => {
    if (window.innerWidth > 760) return
    if (e.target.closest('.msg-tools, a, .react-chip, .spoiler, img')) return
    const was = row.classList.contains('tools-open')
    document.querySelectorAll('.msg-row.tools-open').forEach(r => r.classList.remove('tools-open'))
    if (!was) row.classList.add('tools-open')
  })
}

// "dosyayı getir" butonu render'dan sonra (img onerror ile) oluşabildiği için delegasyon
$('messages').addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('.file-missing')
  if (!el) return
  send({ t: 'fetch-file', fid: el.dataset.fid, from: el.dataset.from, conv: convId() })
  el.textContent = '⏳ getiriliyor...'
  setTimeout(() => renderMessages(), 4000)
})

// ---- gezinme ----
function openDM (f) {
  clearReply()
  hideMentionPop()
  closeDrawer()
  activeConv = { type: 'dm', code: f.code }
  location.hash = 'dm-' + f.code
  captureUnreadMarker('dm-' + f.code)
  markRead('dm-' + f.code)
  send({ t: 'history', conv: 'dm-' + f.code })
  render(); renderMessages()
  $('msg-input').focus()
}
function openRoom (r) {
  clearReply()
  hideMentionPop()
  closeDrawer()
  activeConv = { type: 'room', topic: r.topic }
  location.hash = 'room-' + r.topic
  captureUnreadMarker('room-' + r.topic + '#' + activeCh(r.topic))
  markRead('room-' + r.topic + '#' + activeCh(r.topic))
  send({ t: 'history', conv: 'room-' + r.topic })
  render(); renderMessages()
  $('msg-input').focus()
}
function openConvById (conv) {
  if (conv.startsWith('dm-')) {
    const f = state.friends.find(x => 'dm-' + x.code === conv)
    if (f) openDM(f)
  } else {
    const r = state.rooms.find(x => 'room-' + x.topic === conv)
    if (r) openRoom(r)
  }
}

let hashApplied = false
function applyHash () {
  if (hashApplied || activeConv) return
  const h = decodeURIComponent(location.hash.slice(1))
  if (!h) return
  hashApplied = true
  openConvById(h)
}

const modalReturnFocus = new Map()
function syncDialogInert () {
  const modalOpen = !!topVisibleModal()
  const settingsOpen = $('settings') && !$('settings').classList.contains('hidden')
  $('app').inert = modalOpen || settingsOpen
  if ($('settings')) $('settings').inert = modalOpen
  if ($('call-widget')) $('call-widget').inert = modalOpen || settingsOpen
}
window.syncDialogInert = syncDialogInert

function topVisibleModal () {
  return [...document.querySelectorAll('.modal-back[aria-modal="true"]')]
    .filter(el => !el.classList.contains('hidden') && el.isConnected)
    .sort((a, b) => Number(getComputedStyle(a).zIndex) - Number(getComputedStyle(b).zIndex))
    .pop() || null
}

function modalFocusables (root) {
  return [...root.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.closest('.hidden') && !el.hidden && el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
}

function showModal (id, preferredFocus) {
  const root = $(id)
  const opening = root.classList.contains('hidden')
  if (opening) modalReturnFocus.set(id, document.activeElement)
  closeDrawer()
  root.classList.remove('hidden')
  root.setAttribute('aria-hidden', 'false')
  syncDialogInert()
  if (opening) {
    setTimeout(() => {
      if (root.classList.contains('hidden')) return
      const preferred = preferredFocus && $(preferredFocus)
      const target = (preferred && !preferred.hidden && !preferred.disabled && preferred) || modalFocusables(root)[0]
      if (target) target.focus()
    }, 0)
  }
}

function hideModal (id, restoreFocus = true) {
  const root = $(id)
  if (!root || root.classList.contains('hidden')) return
  root.classList.add('hidden')
  root.setAttribute('aria-hidden', 'true')
  syncDialogInert()
  const previous = modalReturnFocus.get(id)
  modalReturnFocus.delete(id)
  if (!restoreFocus) return
  setTimeout(() => {
    let target = previous
    if (!target || !target.isConnected || target.disabled || target.closest('[inert]')) target = $('btn-menu')
    // Yedek de inert olabilir (modal, açık ayarların ÜSTÜNDE kapandıysa #app inert):
    // odağı görünür ayar paneline ver, yoksa klavye odağı BODY'de kaybolur.
    if (!target || target.closest('[inert]')) {
      const st = $('settings')
      target = (st && !st.classList.contains('hidden') && !st.inert) ? $('set-close') : null
    }
    if (target && target.focus) target.focus()
  }, 0)
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  const visible = topVisibleModal()
  if (!visible) return
  const focusable = modalFocusables(visible)
  if (!focusable.length) { e.preventDefault(); return }
  const first = focusable[0]; const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  else if (!visible.contains(document.activeElement)) { e.preventDefault(); first.focus() }
}, true)

// ---- profil ----
let selAvatar = ''
function openProfile () {
  $('profile-name').value = state.me.name
  $('profile-status').value = state.me.status || ''
  selAvatar = state.me.avatar || ''
  $('btn-close-profile').hidden = !state.me.name
  const grid = $('avatar-grid')
  grid.innerHTML = ''
  const none = document.createElement('button')
  none.type = 'button'
  none.className = 'av-opt' + (selAvatar === '' ? ' sel' : '')
  none.textContent = 'Aa'
  none.style.fontSize = '14px'
  none.title = 'Baş harfini kullan'
  none.setAttribute('aria-pressed', selAvatar === '' ? 'true' : 'false')
  none.onclick = () => { selAvatar = ''; openProfile(); setTimeout(() => grid.querySelector('[aria-pressed="true"]')?.focus(), 0) }
  grid.appendChild(none)
  for (const a of AVATARS) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'av-opt' + (selAvatar === a ? ' sel' : '')
    el.textContent = a
    el.setAttribute('aria-label', a + ' avatarını seç')
    el.setAttribute('aria-pressed', selAvatar === a ? 'true' : 'false')
    el.onclick = () => { selAvatar = a; openProfile(); setTimeout(() => grid.querySelector('[aria-pressed="true"]')?.focus(), 0) }
    grid.appendChild(el)
  }
  showModal('modal-profile', 'profile-name')
}

// Panoya yaz; API reddederse (izin/odak) gizli textarea yöntemine düş.
// Butona gerçek sonucu yansıt — başarısızken "Kopyalandı" deme.
async function copyText (text, btn, ok, back) {
  const restoreHTML = btn.classList.contains('icon-button') ? btn.innerHTML : null
  let done = true
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { done = document.execCommand('copy') } catch { done = false }
    ta.remove()
  }
  btn.textContent = done ? ok : 'Kopyalanamadı!'
  setTimeout(() => {
    if (restoreHTML !== null) btn.innerHTML = restoreHTML
    else btn.textContent = back
  }, 1500)
}

// ---- olaylar ----
$('btn-copy-code').onclick = () => copyText(state.me.code, $('btn-copy-code'), '✓', '⧉')
$('btn-add-friend').onclick = () => {
  const code = $('friend-code-input').value.trim()
  if (code) { send({ t: 'add-friend', code }); $('friend-code-input').value = '' }
}
$('friend-code-input').onkeydown = (e) => { if (e.key === 'Enter') $('btn-add-friend').onclick() }

$('btn-edit-profile').onclick = openProfile
$('btn-close-profile').onclick = () => { if (state.me.name) hideModal('modal-profile') }
$('btn-save-profile').onclick = () => {
  const name = $('profile-name').value.trim()
  if (!name) return
  send({ t: 'set-profile', name, avatar: selAvatar, status: $('profile-status').value.trim() })
  hideModal('modal-profile')
}
$('profile-name').onkeydown = (e) => { if (e.key === 'Enter') $('btn-save-profile').onclick() }

function renderGroupFriends () {
  const box = $('group-friends'); box.innerHTML = ''
  const fr = state.friends.filter(f => f.status === 'friend')
  if (!fr.length) { box.innerHTML = '<div class="group-empty"><span>👥</span><b>Gruba eklenebilecek arkadaş yok</b><small>Önce sol menüden bir arkadaş ekle.</small></div>'; return }
  for (const f of fr) {
    const lab = document.createElement('label'); lab.className = 'group-friend'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = f.code
    const name = document.createElement('span'); name.textContent = nameOf(f)
    lab.append(cb, name)
    box.appendChild(lab)
  }
}
$('btn-add-room').onclick = () => { closeDrawer(); renderGroupFriends(); showModal('modal-room', 'room-name-input') }
$('btn-close-room-x').onclick = () => hideModal('modal-room')
$('btn-create-group').onclick = () => {
  const name = $('group-name-input').value.trim()
  const members = [...$('group-friends').querySelectorAll('input:checked')].map(c => c.value)
  if (!name || !members.length) { alert('Grup adı ver ve en az bir arkadaş seç.'); return }
  send({ t: 'create-group', name, members })
  $('group-name-input').value = ''
  hideModal('modal-room')
}
$('btn-close-room-modal').onclick = () => hideModal('modal-room')
$('btn-create-room').onclick = () => {
  const name = $('room-name-input').value.trim()
  if (name) { send({ t: 'create-room', name }); $('room-name-input').value = ''; hideModal('modal-room') }
}
$('btn-join-room').onclick = () => {
  const code = $('room-code-input').value.trim()
  if (code) { send({ t: 'join-room', code }); $('room-code-input').value = ''; hideModal('modal-room') }
}

$('btn-home').onclick = () => {
  closeDrawer()
  $('member-list').classList.remove('panel-open')
  activeConv = null
  history.replaceState(null, '', location.pathname)
  render(); renderMessages()
}

// ---- @bahsetme önerisi (oda üyeleri; DM'de karşı taraf — sunucuyla aynı) ----
let mentionIdx = 0
function mentionCandidates (q) {
  if (!activeConv) return []
  let list = []
  if (activeConv.type === 'room') {
    const r = state.rooms.find(x => x.topic === activeConv.topic)
    list = (r ? r.members || [] : []).filter(m => m.code !== state.me.code)
  } else {
    const f = state.friends.find(x => x.code === activeConv.code)
    if (f) list = [{ code: f.code, name: nameOf(f) }]
  }
  const uniq = new Map()
  for (const n of list) if (n.name && !uniq.has(n.name)) uniq.set(n.name, n)
  q = q.toLocaleLowerCase('tr')
  return [...uniq.values()].filter(n => n.name.toLocaleLowerCase('tr').startsWith(q)).slice(0, 8)
}
function mentionToken () {
  const inp = $('msg-input')
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length)
  const m = upto.match(/(^|\s)@([^\s@]{0,32})$/)
  return m ? { q: m[2], start: upto.length - m[2].length - 1 } : null
}
function hideMentionPop () { const p = $('mention-pop'); p.classList.add('hidden'); p.innerHTML = '' }
function renderMentionPop () {
  const pop = $('mention-pop')
  const tok = mentionToken()
  const list = tok ? mentionCandidates(tok.q) : []
  if (!list.length) { hideMentionPop(); return }
  mentionIdx = Math.min(mentionIdx, list.length - 1)
  pop.innerHTML = ''
  list.forEach((n, i) => {
    const el = document.createElement('div')
    el.className = 'mention-opt' + (i === mentionIdx ? ' sel' : '')
    el.innerHTML = `${avatarHTML(avatarOf(n.code), n.name, n.code)}<span>${esc(n.name)}</span>`
    el.onmousedown = (e) => { e.preventDefault(); applyMention(n.name) }
    pop.appendChild(el)
  })
  pop.classList.remove('hidden')
}
function applyMention (name) {
  const inp = $('msg-input')
  const tok = mentionToken()
  if (!tok) return
  const end = inp.selectionStart ?? inp.value.length
  inp.value = inp.value.slice(0, tok.start) + '@' + name + ' ' + inp.value.slice(end)
  inp.selectionStart = inp.selectionEnd = tok.start + name.length + 2
  hideMentionPop()
  inp.focus()
}
document.addEventListener('click', (e) => {
  const p = $('mention-pop')
  if (p && !p.classList.contains('hidden') && !p.contains(e.target) && e.target !== $('msg-input')) hideMentionPop()
})

document.addEventListener('pointerdown', (e) => {
  const panel = $('member-list')
  if (panel.classList.contains('panel-open') && !panel.contains(e.target) && !e.target.closest('.members-toggle')) {
    panel.classList.remove('panel-open')
    syncMemberPanel()
  }
})

// mesaj gönderme + yazıyor sinyali
let lastTyping = 0
let prevWarmT = null
$('msg-input').oninput = () => {
  mentionIdx = 0
  renderMentionPop()
  clearTimeout(prevWarmT) // önizlemeyi yazma durunca ısıt (yarım URL'lere istek atma)
  prevWarmT = setTimeout(() => {
    const u = firstUrl($('msg-input').value)
    if (u) fetchPreview(u)
  }, 600)
  if (!activeConv || Date.now() - lastTyping < 2500) return
  lastTyping = Date.now()
  if (activeConv.type === 'dm') send({ t: 'typing', to: activeConv.code })
  else send({ t: 'room-ev', room: activeConv.topic, ev: { kind: 'typing', ch: activeCh(activeConv.topic) } })
}
// yanıtla
function setReply (m) {
  replyTarget = { id: m.id, name: m.name || 'anon', text: (m.text || (m.file ? '📎 ' + m.file.fname : '')).slice(0, 140) }
  renderReplyBar(); $('msg-input').focus()
}
function clearReply () { replyTarget = null; renderReplyBar() }
function renderReplyBar () {
  const bar = $('reply-bar')
  if (!replyTarget) { bar.classList.add('hidden'); bar.innerHTML = ''; return }
  bar.classList.remove('hidden')
  bar.innerHTML = `<span class="rb-info">↩ <b>${esc(replyTarget.name)}</b> kişisine yanıt: <span class="rb-text">${esc(replyTarget.text)}</span></span><button class="rb-close" title="İptal">✕</button>`
  bar.querySelector('.rb-close').onclick = clearReply
}

$('msg-input').onkeydown = (e) => {
  const pop = $('mention-pop')
  if (!pop.classList.contains('hidden')) { // öneri açıkken ok/Enter/Tab seçime gider
    const n = pop.querySelectorAll('.mention-opt').length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      renderMentionPop()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const sel = pop.querySelector('.mention-opt.sel span:last-child')
      if (sel) applyMention(sel.textContent)
      return
    }
    if (e.key === 'Escape') { hideMentionPop(); return }
  }
  if (e.key !== 'Enter' || e.shiftKey) return
  const text = $('msg-input').value.trim()
  if (!text || !activeConv) return
  const re = replyTarget || undefined
  const conv = activeConv
  const ch = conv.type === 'room' ? activeCh(conv.topic) : null
  $('msg-input').value = ''
  clearReply()
  unreadMarker = null
  // Önizleme beklenirken sıra bozulmasın diye gönderimler zincire dizilir;
  // kart hazır değilse en fazla 1.5 sn beklenir, gelmezse kartsız gider.
  sendChain = sendChain.then(async () => {
    let prev
    const u = firstUrl(text)
    if (u) prev = await Promise.race([fetchPreview(u), new Promise(r => setTimeout(r, 1500))]) || undefined
    if (conv.type === 'dm') send({ t: 'send-dm', code: conv.code, text, re, prev })
    else send({ t: 'send-room', topic: conv.topic, ch, text, re, prev })
  })
}
let sendChain = Promise.resolve()

// ---- mesaj iletme ----
let forwardSrc = null // { conv, msgId }
function openForward (m, conv) {
  forwardSrc = { conv, msgId: m.id }
  $('forward-src').innerHTML = `<b>${esc(m.name || 'anon')}</b>: ${esc((m.text || (m.file ? '📎 ' + m.file.fname : '')).slice(0, 120))}`
  const box = $('forward-targets')
  box.innerHTML = ''
  for (const f of state.friends.filter(x => x.status === 'friend')) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'fw-target'
    el.innerHTML = `${avatarHTML(f.avatar, f.name, f.code)}<span>${esc(nameOf(f))}</span>`
    el.onclick = () => doForward({ code: f.code })
    box.appendChild(el)
  }
  for (const r of state.rooms) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'fw-target'
    el.innerHTML = `<span class="fw-room" style="background:${colorOf(r.topic)}">${esc(r.name.trim()[0].toUpperCase())}</span><span>${esc(r.name)} · #${esc(activeCh(r.topic))}</span>`
    el.onclick = () => doForward({ room: r.topic, ch: activeCh(r.topic) })
    box.appendChild(el)
  }
  if (!box.children.length) {
    box.innerHTML = '<div class="group-empty"><span>👥</span><b>İletilecek yer yok</b><small>Önce bir arkadaş ekle ya da odaya katıl.</small></div>'
  }
  showModal('modal-forward')
}
function doForward (target) {
  if (!forwardSrc) return
  send({ t: 'forward', ...target, conv: forwardSrc.conv, msgId: forwardSrc.msgId })
  forwardSrc = null
  hideModal('modal-forward')
  toast('Mesaj iletildi ✓', 'success')
}
$('btn-close-forward').onclick = () => hideModal('modal-forward')

// dosya gönderme
$('btn-attach').onclick = () => { if (activeConv) $('file-input').click() }
$('file-input').onchange = () => {
  const f = $('file-input').files[0]
  $('file-input').value = ''
  if (f) sendFileToActive(f)
}
function sendFileToActive (f) {
  if (!activeConv) return
  if (f.size > 8 * 1024 * 1024) { alert('Dosya 8 MB\'ı geçemez.'); return }
  const rd = new FileReader()
  rd.onload = () => {
    const data = String(rd.result).split(',')[1]
    const base = { t: 'send-file', fname: f.name, mime: f.type || 'application/octet-stream', data }
    if (activeConv.type === 'dm') send({ ...base, code: activeConv.code })
    else send({ ...base, room: activeConv.topic, ch: activeCh(activeConv.topic) })
  }
  rd.readAsDataURL(f)
}
// ---- sesli mesaj ----
// 🎤 tıkla → kayıt başlar (buton kırmızı, süre sayar); tekrar tıkla → gönderilir;
// Esc → iptal. Opus/WebM ~32 kbps: 60 sn ≈ 240 KB, mevcut dosya kanalından gider.
let vmRec = null
const VM_MAX_MS = 60 * 1000
function vmUpdateButton () {
  const b = $('btn-voicemsg')
  if (!vmRec) { b.textContent = '🎤'; b.classList.remove('rec'); return }
  const s = Math.floor((Date.now() - vmRec.t0) / 1000)
  b.textContent = '⏹ ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
  b.classList.add('rec')
}
function vmStop (cancelled) {
  if (!vmRec) return
  vmRec.cancelled = cancelled
  clearInterval(vmRec.timer)
  document.removeEventListener('keydown', vmRec.esc, true)
  try { vmRec.mr.stop() } catch {}
}
$('btn-voicemsg').onclick = async () => {
  if (vmRec) { vmStop(false); return }
  if (!activeConv) return
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (e) {
    if (window.toast) toast('Mikrofona erişilemedi: ' + e.message, 'error', 5000)
    return
  }
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  let mr
  try { mr = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 }) } catch (e) {
    stream.getTracks().forEach(t => t.stop())
    if (window.toast) toast('Kayıt başlatılamadı: ' + e.message, 'error', 5000)
    return
  }
  const rec = { mr, chunks: [], t0: Date.now(), conv: activeConv, cancelled: false }
  rec.esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); vmStop(true) } }
  mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data) }
  mr.onstop = () => {
    stream.getTracks().forEach(t => t.stop())
    vmRec = null
    vmUpdateButton()
    if (rec.cancelled) return
    const secs = Math.max(1, Math.round((Date.now() - rec.t0) / 1000))
    const blob = new Blob(rec.chunks, { type: mimeType })
    if (blob.size < 1500) { if (window.toast) toast('Kayıt çok kısa.', 'warn', 3000); return }
    if (blob.size > 8 * 1024 * 1024) { if (window.toast) toast('Kayıt 8 MB sınırını aştı.', 'error', 4000); return }
    const rd = new FileReader()
    rd.onload = () => {
      const data = String(rd.result).split(',')[1]
      // mime'ı ';codecs=...' olmadan yolla: sunucu inline allowlist'i tam eşleşme arar
      const base = {
        t: 'send-file',
        fname: 'Sesli mesaj ' + Math.floor(secs / 60) + '.' + String(secs % 60).padStart(2, '0') + '.webm',
        mime: 'audio/webm',
        data
      }
      if (rec.conv.type === 'dm') send({ ...base, code: rec.conv.code })
      else send({ ...base, room: rec.conv.topic, ch: activeCh(rec.conv.topic) })
    }
    rd.readAsDataURL(blob)
  }
  vmRec = rec
  rec.timer = setInterval(() => {
    vmUpdateButton()
    if (Date.now() - rec.t0 >= VM_MAX_MS) { vmStop(false); if (window.toast) toast('60 sn sınırına ulaşıldı, gönderildi.', 'info', 3000) }
  }, 500)
  document.addEventListener('keydown', rec.esc, true)
  mr.start(250)
  vmUpdateButton()
  if (window.toast) toast('Kayıt başladı — 🎤 tekrar tıkla: gönder · Esc: iptal', 'info', 3500)
}

$('messages').addEventListener('dragover', e => e.preventDefault())
$('messages').addEventListener('drop', e => {
  e.preventDefault()
  const f = e.dataTransfer.files && e.dataTransfer.files[0]
  if (f) sendFileToActive(f)
})

// emoji seçici
function insertAtCursor (inp, text) {
  const start = inp.selectionStart ?? inp.value.length
  const end = inp.selectionEnd ?? inp.value.length
  inp.value = inp.value.slice(0, start) + text + inp.value.slice(end)
  inp.selectionStart = inp.selectionEnd = start + text.length
  inp.focus()
}
let emojiBuilt = false
$('btn-emoji').onclick = (e) => {
  e.stopPropagation()
  const p = $('emoji-picker')
  if (!emojiBuilt) {
    for (const em of EMOJI_SET) {
      const b = document.createElement('button')
      b.className = 'emoji-opt'; b.type = 'button'; b.textContent = em
      b.onclick = (ev) => { ev.stopPropagation(); insertAtCursor($('msg-input'), em) }
      p.appendChild(b)
    }
    emojiBuilt = true
  }
  p.classList.toggle('hidden')
}
document.addEventListener('click', (e) => {
  const p = $('emoji-picker')
  if (p && !p.classList.contains('hidden') && !p.contains(e.target) && e.target !== $('btn-emoji')) p.classList.add('hidden')
})

// arama
$('btn-search').onclick = () => showModal('modal-search', 'search-input')
$('btn-close-search').onclick = () => hideModal('modal-search')
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !topVisibleModal() && $('settings').classList.contains('hidden')) { e.preventDefault(); $('btn-search').onclick() }
  if (e.key === 'Escape') {
    const top = topVisibleModal()
    if (top) {
      if (top.id === 'modal-search' || top.id === 'modal-room' || top.id === 'modal-transfer' || top.id === 'modal-forward' || (top.id === 'modal-profile' && state.me.name)) hideModal(top.id)
      return
    }
    $('member-list').classList.remove('panel-open')
    syncMemberPanel()
    closeDrawer()
  }
})
let searchT = null
$('search-input').oninput = () => {
  clearTimeout(searchT)
  searchT = setTimeout(() => send({ t: 'search', q: $('search-input').value }), 300)
}
function renderSearchResults (m) {
  const box = $('search-results')
  box.innerHTML = ''
  if (!m.results.length) { box.innerHTML = '<div style="color:var(--tx3);padding:10px;font-size:13px">Sonuç yok.</div>'; return }
  for (const r of m.results) {
    const el = document.createElement('div')
    el.className = 'sr-item'
    const where = r.conv.startsWith('dm-')
      ? '@' + (state.friends.find(f => 'dm-' + f.code === r.conv)?.name || 'dm')
      : '⌂ ' + (state.rooms.find(x => 'room-' + x.topic === r.conv)?.name || 'oda') + (r.msg.ch ? ' · #' + r.msg.ch : '')
    el.innerHTML = `<div class="sr-top">${esc(where)} · ${esc(r.msg.name)} · ${fmtTime(r.msg.ts)}</div>
      <div class="sr-text">${esc(r.msg.text || (r.msg.file && '📎 ' + r.msg.file.fname) || '')}</div>`
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.onclick = () => { hideModal('modal-search', false); openConvById(r.conv) }
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } }
    box.appendChild(el)
  }
}

// hesap taşıma
$('btn-transfer').onclick = () => { $('export-box').value = ''; $('import-box').value = ''; send({ t: 'export' }); showModal('modal-transfer', 'btn-close-transfer-x') }
$('btn-close-transfer-x').onclick = () => hideModal('modal-transfer')
$('btn-close-transfer').onclick = () => hideModal('modal-transfer')
$('btn-copy-export').onclick = () => copyText($('export-box').value, $('btn-copy-export'), 'Kopyalandı ✓', 'Kopyala')
$('btn-do-import').onclick = () => {
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob($('import-box').value.trim()))))
    if (!confirm('Bu PC\'deki mevcut kimliğin ÜZERİNE yazılacak. Devam mı?')) return
    send({ t: 'import', data })
  } catch { alert('Taşıma metni çözümlenemedi.') }
}

// bildirim izni (ilk tıklamada iste)
document.addEventListener('click', function askNotif () {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  document.removeEventListener('click', askNotif)
}, { once: true })

// ---- çekirdek logları + tanılama paneli (özellikle mobil için) ----
let gotState = false
const coreLogs = []
function onCoreLog (m) {
  coreLogs.push((m.level === 'error' ? '❌ ' : 'ℹ️ ') + (m.msg || ''))
  if (coreLogs.length > 60) coreLogs.shift()
  try { localStorage.setItem('tq.prevLogs', JSON.stringify(coreLogs.slice(-40))) } catch {} // çökme sonrası okunabilsin
  ;(m.level === 'error' ? console.error : console.log)('[çekirdek]', m.msg)
  if (m.level === 'error') showDiag()
}
function showDiag (withStart) {
  let d = $('diag-pop')
  if (!d) {
    d = document.createElement('div')
    d.id = 'diag-pop'
    d.innerHTML = `<div class="diag-head"><b>🔧 Tanılama</b><span class="diag-btns"><button id="diag-start" style="display:none">▶ Motoru başlat</button><button id="diag-mini" style="display:none">🧪 Mini test</button><button id="diag-copy">Kopyala</button><button id="diag-close">Kapat</button></span></div><pre id="diag-log"></pre>`
    document.body.appendChild(d)
    d.querySelector('#diag-close').onclick = () => d.remove()
    d.querySelector('#diag-copy').onclick = () => copyText(coreLogs.join('\n'), d.querySelector('#diag-copy'), 'Kopyalandı ✓', 'Kopyala')
    d.querySelector('#diag-start').onclick = () => { requestEngine(); d.querySelector('#diag-start').style.display = 'none' }
    d.querySelector('#diag-mini').onclick = () => { onCoreLog({ msg: '🧪 mini test istendi' }); send({ t: '__mini-test' }) }
  }
  if (withStart) { d.querySelector('#diag-start').style.display = ''; d.querySelector('#diag-mini').style.display = '' }
  d.querySelector('#diag-log').textContent = coreLogs.length ? coreLogs.join('\n') : '(log yok)'
}

// ---- mobil: motoru arayüz başlatır (güvenli mod çökme döngüsünü kırar) ----
let engineRequested = false
function requestEngine () {
  if (engineRequested) return
  engineRequested = true
  send({ t: '__engine-start' })
  setTimeout(() => {
    if (!gotState) { coreLogs.push('❌ Motor istendi ama 10 sn içinde durum gelmedi'); showDiag() }
  }, 10000)
}
if (window.TurkuazNative) {
  let prev = []
  try { prev = JSON.parse(localStorage.getItem('tq.prevLogs') || '[]') } catch {}
  const lastBoot = localStorage.getItem('tq.bootOk')
  try { localStorage.setItem('tq.bootOk', 'pending') } catch {}
  if (lastBoot === 'pending') {
    // önceki oturum sağlıklı duruma ulaşamadan bitmiş (büyük olasılıkla çökme)
    coreLogs.push('⚠️ ÖNCEKİ oturum çökmüş görünüyor. Son oturumun kayıtları:')
    for (const l of prev) coreLogs.push('   ' + l)
    coreLogs.push('▶ Motor güvenli modda BEKLETİLİYOR — logları kopyala, sonra istersen "Motoru başlat".')
    showDiag(true)
  } else {
    requestEngine()
  }
}

// ---- mobil güncelleme kontrolü: yeni APK çıktıysa şerit göster ----
if (window.TurkuazNative) {
  setTimeout(async () => {
    try {
      const cur = String(window.__TQ_MOBILE_VER || '')
      if (!cur) return
      const rs = await (await fetch('https://api.github.com/repos/demirataalbuz-maker/turkuaz-haberlesme/releases?per_page=20')).json()
      const rel = (Array.isArray(rs) ? rs : []).find(r => r.tag_name && r.tag_name.startsWith('mobile-v') && !r.draft)
      if (!rel) return
      const latest = rel.tag_name.replace('mobile-v', '').replace(/^v/, '')
      if (latest.localeCompare(cur, undefined, { numeric: true }) <= 0) return
      const apk = (rel.assets || []).find(a => a.name.endsWith('.apk'))
      const bar = document.createElement('div')
      bar.id = 'update-bar'
      bar.innerHTML = `<span>📱 Yeni sürüm hazır: <b>v${esc(latest)}</b></span>
        <a href="${(apk && apk.browser_download_url) || rel.html_url}" target="_blank" rel="noreferrer">İndir</a>
        <button id="upd-x" title="Kapat">✕</button>`
      document.body.appendChild(bar)
      bar.querySelector('#upd-x').onclick = () => bar.remove()
    } catch {}
  }, 4000)
}

// ---- mobil çekmece (drawer): dar ekranda sol menü ----
function syncDrawerButton () {
  const mobile = window.innerWidth < 761
  const open = mobile && document.body.classList.contains('drawer-open')
  $('btn-menu').setAttribute('aria-expanded', open ? 'true' : 'false')
  $('btn-menu').setAttribute('aria-label', open ? 'Menüyü kapat' : 'Menüyü aç')
  $('drawer-back').setAttribute('aria-hidden', open ? 'false' : 'true')
  for (const id of ['rail', 'sidebar']) {
    const el = $(id)
    el.inert = mobile && !open
    el.setAttribute('aria-hidden', mobile && !open ? 'true' : 'false')
  }
  for (const id of ['messages', 'composer', 'channel-tabs', 'chat-actions', 'livingroom', 'stream-bar']) {
    const el = $(id)
    if (el) el.inert = open
  }
  syncMemberPanel()
}
function closeDrawer () {
  const focusedInDrawer = $('rail').contains(document.activeElement) || $('sidebar').contains(document.activeElement)
  if (focusedInDrawer && window.innerWidth < 761) $('btn-menu').focus()
  document.body.classList.remove('drawer-open')
  syncDrawerButton()
}
function toggleDrawer () {
  const opening = !document.body.classList.contains('drawer-open')
  if (opening) $('member-list').classList.remove('panel-open')
  document.body.classList.toggle('drawer-open')
  syncDrawerButton()
  setTimeout(() => (opening ? $('btn-home') : $('btn-menu')).focus(), 0)
}
$('btn-menu').onclick = toggleDrawer
$('drawer-back').onclick = closeDrawer
// dar ekranda ilk açılışta menü açık gelsin (sohbet seçili değilse)
if (window.innerWidth < 761 && !activeConv) document.body.classList.add('drawer-open')
syncDrawerButton()
window.addEventListener('resize', () => {
  if (window.innerWidth >= 761) document.body.classList.remove('drawer-open')
  else if (!document.body.classList.contains('drawer-open') && ($('rail').contains(document.activeElement) || $('sidebar').contains(document.activeElement))) $('btn-menu').focus()
  if (window.innerWidth > 1120) $('member-list').classList.remove('panel-open')
  syncMemberPanel()
  syncDrawerButton()
})

window.addEventListener('focus', markActiveRead)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') markActiveRead()
})

Transport.start()
syncUnreadUI()
renderMessages()
