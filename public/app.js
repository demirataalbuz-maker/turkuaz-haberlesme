// Turkuaz arayüzü — localhost'taki kendi sunucumuza WebSocket ile bağlanır.
let ws = null
let state = { me: { name: '', code: '', avatar: '', status: '' }, friends: [], requests: [], rooms: [], pending: {} }
let activeConv = null            // { type:'dm', code } | { type:'room', topic }
const activeChs = {}             // topic -> kanal adı
const histories = {}             // conv -> [msg] (katlanmış)
const unread = {}                // key -> sayı (dm: conv, oda: conv#ch)
const typing = {}                // key -> { name, until }

const $ = (id) => document.getElementById(id)
const QUICK_EMOJI = ['👍', '❤️', '😂', '🔥', '😮']
const AVATARS = ['😀', '😎', '🦊', '🐱', '🐼', '🦁', '🐸', '👾', '🤖', '🐙', '🦄', '🐺', '🦅', '🐍', '⚡', '🌊', '🌙', '⭐', '🎮', '🎧', '⚔️', '🛡️', '🧿', '🍉']

function connect () {
  ws = new WebSocket('ws://' + location.host)
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    switch (m.t) {
      case 'state': state = m; render(); break
      case 'history':
        histories[m.conv] = m.msgs
        if (isActiveConv(m.conv)) renderMessages()
        break
      case 'msg': onIncomingMsg(m); break
      case 'msg-ev': applyEvent(m.conv, m.ev); break
      case 'delivered': if (isActiveConv(m.conv)) renderMessages(); break
      case 'typing': onTyping(m.conv, m.name); break
      case 'notify': onNotify(m); break
      case 'file-ready': if (activeConv) renderMessages(); break
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
  }
  ws.onclose = () => setTimeout(connect, 1500)
}
function send (obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)) }

function convId () {
  if (!activeConv) return null
  return activeConv.type === 'dm' ? 'dm-' + activeConv.code : 'room-' + activeConv.topic
}
function isActiveConv (conv) { return convId() === conv }
function activeCh (topic) { return activeChs[topic] || 'genel' }
function unreadKey (conv, ch) { return conv.startsWith('room-') ? conv + '#' + (ch || 'genel') : conv }

function onIncomingMsg (m) {
  if (!histories[m.conv]) histories[m.conv] = []
  histories[m.conv].push(m.msg)
  const mine = m.msg.from === state.me.code
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
  applyHash()
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
  } else {
    const r = state.rooms.find(x => x.topic === activeConv.topic)
    if (!r) { activeConv = null; return renderChatHead() }
    title.textContent = '⌂ ' + r.name
    sub.textContent = r.online + ' kişi çevrimiçi' + (r.isOwner ? ' · odanın sahibisin' : '')
    const copy = document.createElement('button')
    copy.textContent = 'Davet kodunu kopyala'
    copy.onclick = () => { navigator.clipboard.writeText(r.invite); copy.textContent = 'Kopyalandı ✓'; setTimeout(() => { copy.textContent = 'Davet kodunu kopyala' }, 1500) }
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
    row.className = 'msg-row' + (compact ? ' compact' : '') + (pending ? ' pending' : '')

    let body = ''
    if (m.deleted) {
      body = '<div class="msg-deleted">bu mesaj silindi</div>'
    } else {
      if (m.text) body += `<div class="msg-text">${esc(m.text)}${m.edited ? ' <span class="msg-edited">(düzenlendi)</span>' : ''}${pending ? '<span class="msg-pending-mark">⏳</span>' : ''}</div>`
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
  activeConv = { type: 'dm', code: f.code }
  location.hash = 'dm-' + f.code
  delete unread['dm-' + f.code]
  send({ t: 'history', conv: 'dm-' + f.code })
  render(); renderMessages()
  $('msg-input').focus()
}
function openRoom (r) {
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

// ---- olaylar ----
$('btn-copy-code').onclick = () => {
  navigator.clipboard.writeText(state.me.code)
  $('btn-copy-code').textContent = '✓'
  setTimeout(() => { $('btn-copy-code').textContent = '⧉' }, 1500)
}
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

$('btn-add-room').onclick = () => showModal('modal-room')
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

// mesaj gönderme + yazıyor sinyali
let lastTyping = 0
$('msg-input').oninput = () => {
  if (!activeConv || Date.now() - lastTyping < 2500) return
  lastTyping = Date.now()
  if (activeConv.type === 'dm') send({ t: 'typing', to: activeConv.code })
  else send({ t: 'room-ev', room: activeConv.topic, ev: { kind: 'typing', ch: activeCh(activeConv.topic) } })
}
$('msg-input').onkeydown = (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return
  const text = $('msg-input').value.trim()
  if (!text || !activeConv) return
  if (activeConv.type === 'dm') send({ t: 'send-dm', code: activeConv.code, text })
  else send({ t: 'send-room', topic: activeConv.topic, ch: activeCh(activeConv.topic), text })
  $('msg-input').value = ''
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
$('btn-copy-export').onclick = () => {
  navigator.clipboard.writeText($('export-box').value)
  $('btn-copy-export').textContent = 'Kopyalandı ✓'
  setTimeout(() => { $('btn-copy-export').textContent = 'Kopyala' }, 1500)
}
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

connect()
renderMessages()
