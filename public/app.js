// Turkuaz arayüzü. Taşıma katmanı (WebSocket / mobil köprü) transport.js'te;
// UI sadece window.send() ve Transport.onMessage() üzerinden konuşur.
let state = { me: { name: '', code: '', avatar: '', status: '' }, friends: [], requests: [], rooms: [], pending: {}, blocked: [] }
let activeConv = null            // { type:'dm', code } | { type:'room', topic }
let replyTarget = null           // yanıtlanan mesaj { id, name, text }
const activeChs = {}             // topic -> kanal adı
const histories = {}             // conv -> [msg] (katlanmış)
const unread = {}                // key -> sayı (dm: conv, oda: conv#ch)
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
  const visible = isActiveConv(m.conv) &&
    (!m.conv.startsWith('room-') || (m.msg.ch || 'genel') === activeCh(m.conv.slice(5)))
  if (visible) renderMessages()
  else if (!mine) {
    const k = unreadKey(m.conv, m.msg.ch)
    unread[k] = (unread[k] || 0) + 1
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
const COLORS = ['#14b8a6', '#0ea5e9', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899', '#22c55e', '#eab308']
function colorOf (code) {
  let h = 0
  for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
function initialOf (name, code) { return (name || code || '?').trim()[0].toUpperCase() }
function esc (s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
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

function avatarHTML (avatar, name, code, dot) {
  const cls = avatar ? 'avatar emoji' : 'avatar'
  const bg = avatar ? '' : `background:${colorOf(code)}`
  const inner = avatar || initialOf(name, code)
  return `<div class="${cls}" style="${bg}">${inner}${dot !== undefined ? `<div class="dot ${dot ? 'on' : ''}"></div>` : ''}</div>`
}

function avatarOf (code) {
  if (code === state.me.code) return state.me.avatar
  const f = state.friends.find(x => x.code === code)
  return (f && f.avatar) || ''
}

// ---- render ----
function render () {
  $('me-name').textContent = state.me.name || 'isimsiz'
  $('me-status').textContent = state.me.status || 'çevrimiçi'
  $('my-code').textContent = state.me.code
  const av = $('me-avatar')
  av.textContent = state.me.avatar || initialOf(state.me.name, state.me.code)
  av.className = state.me.avatar ? 'avatar emoji' : 'avatar'
  av.style.background = state.me.avatar ? '' : colorOf(state.me.code)
  if (!state.me.name && $('modal-profile').classList.contains('hidden')) openProfile()

  // sol ray — odalar
  const rail = $('rail-rooms')
  rail.innerHTML = ''
  for (const r of state.rooms) {
    const activeR = activeConv && activeConv.type === 'room' && activeConv.topic === r.topic
    const el = document.createElement('div')
    el.className = 'rail-btn room' + (activeR ? ' active' : '')
    if (!activeR) el.style.background = colorOf(r.topic)
    el.textContent = r.name.trim()[0].toUpperCase()
    el.title = `${r.name} — ${r.online} kişi çevrimiçi`
    const un = r.channels.reduce((s, ch) => s + (unread['room-' + r.topic + '#' + ch] || 0), 0)
    if (un) el.innerHTML += `<span class="badge">${un}</span>`
    el.onclick = () => openRoom(r)
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
    ok.onclick = () => send({ t: 'accept-request', code: r.code })
    const no = document.createElement('button'); no.className = 'no'; no.textContent = '✕'
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
    const un = unread['dm-' + f.code]
    el.innerHTML = `${avatarHTML(f.avatar, f.name, f.code, f.online)}
      <div class="dcol">
        <div class="dname">${esc(nameOf(f))}</div>
        ${f.statusText ? `<div class="dstatus">${esc(f.statusText)}</div>` : ''}
      </div>
      ${f.status === 'pending-out' ? '<span class="pstat wait" title="Karşı tarafın seni eklemesi bekleniyor">⏳</span>' : ''}
      ${un ? `<span class="unread">${un}</span>` : ''}`
    el.onclick = () => openDM(f)
    dl.appendChild(el)
  }
  if (!state.friends.length) {
    dl.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:4px 10px">Henüz arkadaş yok. Kodunu paylaş ya da arkadaşının kodunu ekle.</div>'
  }

  renderChatHead()
  renderTabs()
  renderMembers()
  applyHash()
}

// Oda üye listesi (sağ panel)
function renderMembers () {
  const panel = $('member-list')
  if (!panel) return
  if (!activeConv || activeConv.type !== 'room') { panel.classList.add('hidden'); return }
  const r = state.rooms.find(x => x.topic === activeConv.topic)
  if (!r) { panel.classList.add('hidden'); return }
  panel.classList.remove('hidden')
  const members = [{ code: state.me.code, name: state.me.name || 'sen', me: true }]
    .concat((r.members || []).filter(m => m.code !== state.me.code))
  panel.innerHTML = `<div class="ml-title">ÜYELER — ${members.length}</div>` + members.map(m =>
    `<div class="ml-item">${avatarHTML(avatarOf(m.code), m.name, m.code, true)}<span class="ml-name">${esc(m.name)}${m.me ? ' (sen)' : ''}</span></div>`).join('')
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
    call.textContent = '📞 Ara'
    call.disabled = !f.online
    if (!f.online) call.style.opacity = .4
    call.onclick = () => window.CallMgr && CallMgr.start(f.code)
    actions.appendChild(call)
    const blk = document.createElement('button')
    const isB = (state.blocked || []).includes(f.code)
    blk.textContent = isB ? 'Engeli kaldır' : '🚫 Engelle'
    blk.onclick = () => {
      if (isB) send({ t: 'unblock', code: f.code })
      else if (confirm(nameOf(f) + ' engellensin mi? Mesajları artık gelmeyecek.')) send({ t: 'block', code: f.code })
    }
    actions.appendChild(blk)
  } else {
    const r = state.rooms.find(x => x.topic === activeConv.topic)
    if (!r) { activeConv = null; return renderChatHead() }
    title.textContent = '⌂ ' + r.name
    sub.textContent = r.online + ' kişi çevrimiçi' + (r.isOwner ? ' · odanın sahibisin' : '')
    const copy = document.createElement('button')
    copy.textContent = 'Davet kodunu kopyala'
    copy.onclick = () => copyText(r.invite, copy, 'Kopyalandı ✓', 'Davet kodunu kopyala')
    const leave = document.createElement('button')
    leave.textContent = 'Ayrıl'
    leave.onclick = () => {
      if (confirm('"' + r.name + '" odasından ayrılıyor musun?')) {
        send({ t: 'leave-room', topic: r.topic })
        activeConv = null; renderMessages(); render()
      }
    }
    actions.append(copy, leave)
  }
}

function renderTabs () {
  const bar = $('channel-tabs')
  if (!activeConv || activeConv.type !== 'room') { bar.classList.add('hidden'); return }
  const r = state.rooms.find(x => x.topic === activeConv.topic)
  if (!r) { bar.classList.add('hidden'); return }
  bar.classList.remove('hidden')
  bar.innerHTML = ''
  for (const ch of r.channels) {
    const el = document.createElement('div')
    el.className = 'ch-tab' + (activeCh(r.topic) === ch ? ' active' : '')
    const un = unread['room-' + r.topic + '#' + ch]
    el.innerHTML = `# ${esc(ch)}${un ? `<span class="unread">${un}</span>` : ''}`
    el.onclick = () => {
      activeChs[r.topic] = ch
      delete unread['room-' + r.topic + '#' + ch]
      render(); renderMessages()
    }
    bar.appendChild(el)
  }
  const add = document.createElement('div')
  add.className = 'ch-add'
  add.textContent = '+ kanal'
  add.onclick = () => {
    const ch = prompt('Kanal adı:')
    if (ch && ch.trim()) {
      send({ t: 'add-channel', room: r.topic, ch: ch.trim() })
      activeChs[r.topic] = ch.trim().toLowerCase().replace(/[^a-z0-9ğüşöçı_-]/g, '')
    }
  }
  bar.appendChild(add)
}

function renderMessages () {
  const box = $('messages')
  box.innerHTML = ''
  renderTyping()
  const conv = convId()
  if (!conv) {
    box.innerHTML = `<div class="empty-hint">🌊 Burada bulut yok.<br>Mesajların kendi diskinde, bağlantıların doğrudan arkadaşlarına.<br>Soldan bir sohbet seç ya da yeni arkadaş ekle.</div>`
    return
  }
  let msgs = histories[conv] || []
  const isRoom = activeConv.type === 'room'
  const room = isRoom ? state.rooms.find(x => x.topic === activeConv.topic) : null
  if (isRoom) msgs = msgs.filter(m => (m.ch || 'genel') === activeCh(activeConv.topic))
  const pendingIds = activeConv.type === 'dm' ? new Set(state.pending[activeConv.code] || []) : new Set()

  let lastFrom = null; let lastTs = 0; let lastDay = ''
  for (const m of msgs) {
    const day = fmtDay(m.ts)
    if (day !== lastDay) {
      const sep = document.createElement('div')
      sep.className = 'day-sep'; sep.textContent = day
      box.appendChild(sep); lastDay = day; lastFrom = null
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
      if (m.text) body += `<div class="msg-text">${fmt(m.text)}${m.edited ? ' <span class="msg-edited">(düzenlendi)</span>' : ''}${pending ? '<span class="msg-pending-mark">⏳</span>' : ''}</div>`
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
    }
  })
}

function fileHTML (m) {
  const f = m.file
  const url = '/files/' + f.fid
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
  delete unread['dm-' + f.code]
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
  delete unread['room-' + r.topic + '#' + activeCh(r.topic)]
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

function showModal (id) { $(id).classList.remove('hidden') }
function hideModal (id) { $(id).classList.add('hidden') }

// ---- profil ----
let selAvatar = ''
function openProfile () {
  $('profile-name').value = state.me.name
  $('profile-status').value = state.me.status || ''
  selAvatar = state.me.avatar || ''
  const grid = $('avatar-grid')
  grid.innerHTML = ''
  const none = document.createElement('div')
  none.className = 'av-opt' + (selAvatar === '' ? ' sel' : '')
  none.textContent = 'Aa'
  none.style.fontSize = '14px'
  none.title = 'Baş harfini kullan'
  none.onclick = () => { selAvatar = ''; openProfile() }
  grid.appendChild(none)
  for (const a of AVATARS) {
    const el = document.createElement('div')
    el.className = 'av-opt' + (selAvatar === a ? ' sel' : '')
    el.textContent = a
    el.onclick = () => { selAvatar = a; openProfile() }
    grid.appendChild(el)
  }
  showModal('modal-profile')
}

// Panoya yaz; API reddederse (izin/odak) gizli textarea yöntemine düş.
// Butona gerçek sonucu yansıt — başarısızken "Kopyalandı" deme.
async function copyText (text, btn, ok, back) {
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
  setTimeout(() => { btn.textContent = back }, 1500)
}

// ---- olaylar ----
$('btn-copy-code').onclick = () => copyText(state.me.code, $('btn-copy-code'), '✓', '⧉')
$('btn-add-friend').onclick = () => {
  const code = $('friend-code-input').value.trim()
  if (code) { send({ t: 'add-friend', code }); $('friend-code-input').value = '' }
}
$('friend-code-input').onkeydown = (e) => { if (e.key === 'Enter') $('btn-add-friend').onclick() }

$('btn-edit-profile').onclick = openProfile
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
  if (!fr.length) { box.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:4px 2px">Önce arkadaş ekle.</div>'; return }
  for (const f of fr) {
    const lab = document.createElement('label'); lab.className = 'group-friend'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = f.code
    lab.append(cb, document.createTextNode(' ' + nameOf(f)))
    box.appendChild(lab)
  }
}
$('btn-add-room').onclick = () => { renderGroupFriends(); showModal('modal-room') }
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

// mesaj gönderme + yazıyor sinyali
let lastTyping = 0
$('msg-input').oninput = () => {
  mentionIdx = 0
  renderMentionPop()
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
  if (activeConv.type === 'dm') send({ t: 'send-dm', code: activeConv.code, text, re })
  else send({ t: 'send-room', topic: activeConv.topic, ch: activeCh(activeConv.topic), text, re })
  $('msg-input').value = ''
  clearReply()
}

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
$('btn-search').onclick = () => { showModal('modal-search'); $('search-input').focus() }
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('btn-search').onclick() }
  if (e.key === 'Escape') ['modal-search', 'modal-room', 'modal-transfer'].forEach(hideModal)
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
    el.onclick = () => { hideModal('modal-search'); openConvById(r.conv) }
    box.appendChild(el)
  }
}

// hesap taşıma
$('btn-transfer').onclick = () => { $('export-box').value = ''; $('import-box').value = ''; send({ t: 'export' }); showModal('modal-transfer') }
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
function closeDrawer () { document.body.classList.remove('drawer-open') }
function toggleDrawer () { document.body.classList.toggle('drawer-open') }
$('btn-menu').onclick = toggleDrawer
$('drawer-back').onclick = closeDrawer
// dar ekranda ilk açılışta menü açık gelsin (sohbet seçili değilse)
if (window.innerWidth < 761 && !activeConv) document.body.classList.add('drawer-open')

Transport.start()
renderMessages()
