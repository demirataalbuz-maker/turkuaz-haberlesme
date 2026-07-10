// Turkuaz oyun modu: oturma odasında balonlarla mini oyunlar (hava hokeyi +
// haxball tarzı futbol). Serversız: fizik OYUNU BAŞLATANIN (host) makinesinde
// koşar, oyuncular raket pozisyonlarını P2P oda kanalından yollar, host da
// pak/skor durumunu yayınlar. Seyirciler canlı izler.
/* global state, send, Voice, Soundboard, esc, avatarOf, colorOf, initialOf */
(function () {
  const W = 1000; const H = 600 // mantıksal saha
  const MODES = {
    hokey: { label: 'Hava Hokeyi', emoji: '🏒', maxP: 2, padR: 42, puckR: 24, goalH: 200, friction: 0.9965, half: true, win: 7 },
    futbol: { label: 'Balon Futbolu', emoji: '⚽', maxP: 4, padR: 36, puckR: 26, goalH: 240, friction: 0.9915, half: false, win: 5 }
  }

  const Games = {
    g: null, // aktif oyun durumu
    ui: null,

    // ---------- yaşam döngüsü ----------
    isHost () { return this.g && this.g.host === state.me.code },
    inGame () { return !!this.g },

    openMenu (btn) {
      if (!window.Voice || !Voice.room) { alert('Önce sesli sohbete katıl (🎧), oyun oradan başlar.'); return }
      if (this.g) { this.showOverlay(); return }
      const old = document.getElementById('game-menu')
      if (old) { old.remove(); return }
      const pop = document.createElement('div')
      pop.id = 'game-menu'
      pop.innerHTML = '<div class="snd-title">OYUN BAŞLAT</div>'
      for (const [id, m] of Object.entries(MODES)) {
        const b = document.createElement('button')
        b.className = 'game-opt'
        b.innerHTML = `<span class="ge">${m.emoji}</span><span>${m.label}</span><small>${m.maxP} kişi</small>`
        b.onclick = () => { pop.remove(); this.host(id) }
        pop.appendChild(b)
      }
      document.body.appendChild(pop)
      const r = btn.getBoundingClientRect()
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left - 40)) + 'px'
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 10) + 'px'
      setTimeout(() => {
        const off = (e) => { if (!pop.contains(e.target) && e.target !== btn) { pop.remove(); document.removeEventListener('pointerdown', off, true) } }
        document.addEventListener('pointerdown', off, true)
      }, 0)
    },

    host (mode) {
      const md = MODES[mode]; if (!md) return
      this.g = {
        id: Math.random().toString(36).slice(2, 10),
        mode,
        room: Voice.room,
        host: state.me.code,
        started: false,
        players: [{ code: state.me.code, name: state.me.name || 'sen', side: 0 }],
        inputs: {}, // code -> {x,y}
        puck: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
        pads: {},   // code -> {x,y} (render için)
        score: [0, 0],
        freeze: 0, winner: null, lastState: 0, lastSeen: Date.now()
      }
      this.ev({ op: 'invite', gid: this.g.id, mode, name: state.me.name || 'anon' })
      this.showOverlay()
      this.loopStart()
    },

    join () {
      if (!this.g || this.g.started === 'ended') return
      this.ev({ op: 'join', gid: this.g.id, name: state.me.name || 'anon' })
      this.showOverlay()
    },

    stop (silent) {
      if (!this.g) return
      if (!silent) this.ev({ op: 'end', gid: this.g.id })
      this.loopStop()
      this.g = null
      this.hideOverlay()
    },
    onVoiceLeave () { // sesli sohbetten ayrılırken (Voice.leave çağırır, room hâlâ setli)
      if (!this.g) return
      const amPlayer = this.g.players.some(p => p.code === state.me.code)
      this.stop(!(amPlayer && !this.g.winner))
    },

    // ---------- ağ ----------
    ev (data) { if (Voice.room) send({ t: 'room-ev', room: Voice.room, ev: { kind: 'game', ...data } }) },

    onRoomEv (m) {
      const d = m.ev || {}
      if (!window.Voice || Voice.room !== m.room) return // aynı sesli sohbette değilsek karışma
      switch (d.op) {
        case 'invite': { // biri oyun kurdu → katılma daveti göster
          if (this.g) return
          this.g = {
            id: d.gid, mode: MODES[d.mode] ? d.mode : 'hokey', room: m.room, host: m.from,
            started: false, players: [{ code: m.from, name: d.name || 'anon', side: 0 }],
            inputs: {}, puck: { x: W / 2, y: H / 2, vx: 0, vy: 0 }, pads: {},
            score: [0, 0], freeze: 0, winner: null, lastSeen: Date.now(), spectator: true
          }
          this.showOverlay()
          break
        }
        case 'join': { // (host işler) oyuncu katıldı
          if (!this.isHost() || !this.g || d.gid !== this.g.id || this.g.started) return
          const md = MODES[this.g.mode]
          if (this.g.players.find(p => p.code === m.from)) return
          if (this.g.players.length >= md.maxP) return
          this.g.players.push({ code: m.from, name: m.name || d.name || 'anon', side: this.g.players.length % 2 })
          this.ev({ op: 'start', gid: this.g.id, mode: this.g.mode, players: this.g.players, go: this.g.players.length >= 2 })
          if (this.g.players.length >= 2) this.begin()
          this.renderLobby()
          break
        }
        case 'start': { // host oyuncu listesi + başlangıç yayınladı
          if (!this.g || d.gid !== this.g.id || this.isHost()) return
          this.g.players = Array.isArray(d.players) ? d.players : this.g.players
          this.g.spectator = !this.g.players.find(p => p.code === state.me.code)
          if (d.go) this.begin()
          this.renderLobby()
          break
        }
        case 'input': { // (host işler) oyuncu raket pozisyonu
          if (!this.isHost() || !this.g || d.gid !== this.g.id) return
          if (this.g.players.find(p => p.code === m.from)) {
            this.g.inputs[m.from] = { x: Number(d.x) || 0, y: Number(d.y) || 0 }
          }
          break
        }
        case 'state': { // host'tan oyun durumu
          if (!this.g || d.gid !== this.g.id || this.isHost()) return
          this.g.lastSeen = Date.now()
          this.g.puck = d.puck || this.g.puck
          this.g.pads = d.pads || this.g.pads
          if (Array.isArray(d.score)) {
            const changed = d.score[0] !== this.g.score[0] || d.score[1] !== this.g.score[1]
            this.g.score = d.score
            if (changed && window.Soundboard) Soundboard.play('tada')
          }
          if (d.hit && window.Soundboard) this.clickSound()
          this.g.freeze = d.freeze || 0
          break
        }
        case 'end': {
          if (!this.g || d.gid !== this.g.id) return
          if (d.winner !== undefined) { this.g.winner = d.winner; this.renderBanner(); setTimeout(() => this.stop(true), 3500) } else this.stop(true)
          break
        }
      }
    },

    // ---------- oyun akışı (host) ----------
    begin () {
      if (!this.g || this.g.started) return
      this.g.started = true
      this.g.spectator = !this.g.players.find(p => p.code === state.me.code)
      // raketler başlangıç yerine (2v2'de aynı taraftakiler alt/üst)
      this.g.players.forEach((p, i) => {
        const off = i > 1 ? (i % 2 ? 140 : -140) : 0
        this.g.pads[p.code] = { x: p.side === 0 ? W * 0.2 : W * 0.8, y: H / 2 + off }
        this.g.inputs[p.code] = { ...this.g.pads[p.code] }
      })
      this.g.puck = { x: W / 2, y: H / 2, vx: 0, vy: 0 }
      this.g.freeze = Date.now() + 1200
      this.showOverlay()
      this.loopStart()
      if (window.Soundboard) Soundboard.play('ding')
    },

    loopStart () {
      // rAF değil: pencere arkada/kısılmışken de aksın (host fiziği durmasın)
      if (this._int) return
      this._int = setInterval(() => this.frame(), 16)
    },
    loopStop () {
      if (this._int) { clearInterval(this._int); this._int = null }
    },

    frame () {
      const g = this.g
      if (!g || !this.ui) return
      if (g.started && this.isHost()) this.physics()
      if (g.started && !this.isHost() && !g.spectator) this.sendInput()
      if (g.started && !this.isHost() && Date.now() - g.lastSeen > 4000) { // host koptu
        this.banner('Bağlantı koptu 😕'); setTimeout(() => this.stop(true), 2000); g.started = 'ended'
      }
      this.draw()
    },

    physics () {
      const g = this.g; const md = MODES[g.mode]
      const now = Date.now()
      // raketler: benimki fare, diğerleri son input (hız = fark)
      for (const p of g.players) {
        const target = p.code === state.me.code ? (this._mouse || g.pads[p.code]) : (g.inputs[p.code] || g.pads[p.code])
        const pad = g.pads[p.code] || (g.pads[p.code] = { x: W / 2, y: H / 2 })
        let tx = Math.min(W - md.padR, Math.max(md.padR, target.x))
        let ty = Math.min(H - md.padR, Math.max(md.padR, target.y))
        if (md.half) { // hokeyde herkes kendi yarısında
          if (p.side === 0) tx = Math.min(W / 2 - md.padR, tx)
          else tx = Math.max(W / 2 + md.padR, tx)
        }
        pad.vx = tx - pad.x; pad.vy = ty - pad.y
        pad.x = tx; pad.y = ty
      }
      if (g.freeze && now < g.freeze) { this.broadcastState(); return }
      g.freeze = 0
      const pk = g.puck
      pk.x += pk.vx; pk.y += pk.vy
      pk.vx *= md.friction; pk.vy *= md.friction
      let hit = false
      // duvarlar (kale boşluğu hariç)
      const gTop = (H - md.goalH) / 2; const gBot = (H + md.goalH) / 2
      if (pk.y < md.puckR) { pk.y = md.puckR; pk.vy = Math.abs(pk.vy); hit = true }
      if (pk.y > H - md.puckR) { pk.y = H - md.puckR; pk.vy = -Math.abs(pk.vy); hit = true }
      const inGoalBand = pk.y > gTop && pk.y < gBot
      if (pk.x < md.puckR) {
        if (inGoalBand) { if (pk.x < -md.puckR) return this.goal(1) } else { pk.x = md.puckR; pk.vx = Math.abs(pk.vx); hit = true }
      }
      if (pk.x > W - md.puckR) {
        if (inGoalBand) { if (pk.x > W + md.puckR) return this.goal(0) } else { pk.x = W - md.puckR; pk.vx = -Math.abs(pk.vx); hit = true }
      }
      // raket çarpışması
      for (const p of g.players) {
        const pad = g.pads[p.code]
        const dx = pk.x - pad.x; const dy = pk.y - pad.y
        const d = Math.hypot(dx, dy); const min = md.padR + md.puckR
        if (d < min && d > 0.001) {
          const nx = dx / d; const ny = dy / d
          pk.x = pad.x + nx * min; pk.y = pad.y + ny * min
          const dot = pk.vx * nx + pk.vy * ny
          pk.vx -= 2 * Math.min(0, dot) * nx
          pk.vy -= 2 * Math.min(0, dot) * ny
          pk.vx += (pad.vx || 0) * 0.6
          pk.vy += (pad.vy || 0) * 0.6
          hit = true
        }
      }
      // hız sınırı
      const sp = Math.hypot(pk.vx, pk.vy); const MAXS = 22
      if (sp > MAXS) { pk.vx = pk.vx / sp * MAXS; pk.vy = pk.vy / sp * MAXS }
      if (hit) this.clickSound()
      this.broadcastState(hit)
    },

    goal (side) { // side = sayıyı ALAN taraf (0 sol takım skoru)
      const g = this.g; const md = MODES[g.mode]
      g.score[side]++
      g.puck = { x: W / 2, y: H / 2, vx: 0, vy: 0 }
      g.freeze = Date.now() + 1200
      if (window.Soundboard) Soundboard.play('tada')
      if (g.score[side] >= md.win) {
        g.winner = side
        this.ev({ op: 'end', gid: g.id, winner: side })
        this.broadcastState()
        this.renderBanner()
        setTimeout(() => this.stop(true), 3500)
        return
      }
      this.broadcastState()
    },

    _lastB: 0,
    broadcastState (hit) {
      const now = Date.now()
      if (!hit && now - this._lastB < 50) return // ~20Hz
      this._lastB = now
      const g = this.g
      const round = (o) => ({ x: Math.round(o.x), y: Math.round(o.y) })
      const pads = {}
      for (const [c, p] of Object.entries(g.pads)) pads[c] = round(p)
      this.ev({ op: 'state', gid: g.id, puck: { ...round(g.puck), vx: +g.puck.vx.toFixed(1), vy: +g.puck.vy.toFixed(1) }, pads, score: g.score, freeze: g.freeze, hit: !!hit })
    },

    _lastIn: 0,
    sendInput () {
      const now = Date.now()
      if (!this._mouse || now - this._lastIn < 40) return
      this._lastIn = now
      this.ev({ op: 'input', gid: this.g.id, x: Math.round(this._mouse.x), y: Math.round(this._mouse.y) })
    },

    clickSound () {
      const now = Date.now()
      if (now - (this._lastClick || 0) < 90) return
      this._lastClick = now
      try {
        this._cctx = this._cctx || new (window.AudioContext || window.webkitAudioContext)()
        const c = this._cctx; const t = c.currentTime
        const o = c.createOscillator(); const gn = c.createGain()
        o.type = 'triangle'; o.frequency.setValueAtTime(700, t); o.frequency.exponentialRampToValueAtTime(240, t + 0.07)
        gn.gain.setValueAtTime(0.12, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
        o.connect(gn).connect(c.destination)
        o.start(t); o.stop(t + 0.1)
      } catch {}
    },

    // ---------- arayüz ----------
    showOverlay () {
      if (!this.ui) {
        const ov = document.createElement('div')
        ov.id = 'game-overlay'
        ov.innerHTML = `
          <div id="game-top">
            <span id="game-title"></span>
            <span id="game-score"></span>
            <span class="game-btns">
              <button id="game-fs" title="Tam ekran">⛶</button>
              <button id="game-x" title="Kapat">✕</button>
            </span>
          </div>
          <canvas id="game-canvas"></canvas>
          <div id="game-lobby"></div>
          <div id="game-banner" class="hidden"></div>`
        document.body.appendChild(ov)
        this.ui = ov
        const cv = ov.querySelector('#game-canvas')
        const mouse = (e) => {
          const r = cv.getBoundingClientRect()
          this._mouse = { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }
        }
        cv.addEventListener('pointermove', mouse)
        cv.addEventListener('pointerdown', mouse)
        ov.querySelector('#game-x').onclick = () => {
          // oyuncu çıkarsa oyun herkes için biter; seyirci sessizce kapatır
          const amPlayer = this.g && this.g.players.some(p => p.code === state.me.code)
          this.stop(!(amPlayer && !this.g.winner))
        }
        ov.querySelector('#game-fs').onclick = () => {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
          else ov.requestFullscreen && ov.requestFullscreen().catch(() => {})
        }
      }
      this.ui.classList.remove('hidden')
      this.renderLobby()
      this.loopStart()
    },
    hideOverlay () {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      if (this.ui) { this.ui.remove(); this.ui = null }
      const b = document.getElementById('game-menu'); if (b) b.remove()
    },

    renderLobby () {
      if (!this.ui || !this.g) return
      const g = this.g; const md = MODES[g.mode]
      this.ui.querySelector('#game-title').textContent = md.emoji + ' ' + md.label
      const lob = this.ui.querySelector('#game-lobby')
      if (g.started) { lob.classList.add('hidden'); return }
      lob.classList.remove('hidden')
      const meIn = g.players.find(p => p.code === state.me.code)
      const names = g.players.map(p => esc(p.name)).join(', ')
      lob.innerHTML = `<div class="gl-box">
        <div class="gl-who">${names} hazır — rakip bekleniyor (${g.players.length}/${md.maxP})</div>
        ${meIn ? '<div class="gl-hint">Yeterli oyuncu katılınca oyun kendiliğinden başlar</div>' : `<button id="gl-join" class="primary">🎮 Katıl</button>`}
      </div>`
      const jb = lob.querySelector('#gl-join')
      if (jb) jb.onclick = () => this.join()
    },

    banner (text) {
      const b = this.ui && this.ui.querySelector('#game-banner')
      if (!b) return
      b.textContent = text
      b.classList.remove('hidden')
    },
    renderBanner () {
      const g = this.g
      if (!g || g.winner === null || g.winner === undefined) return
      const winners = g.players.filter(p => p.side === g.winner).map(p => p.name).join(' + ')
      this.banner('🏆 ' + (winners || 'Kazanan') + ' kazandı! (' + g.score[0] + '–' + g.score[1] + ')')
    },

    draw () {
      const g = this.g
      if (!g || !this.ui) return
      const cv = this.ui.querySelector('#game-canvas')
      const box = cv.parentElement.getBoundingClientRect()
      const availH = box.height - 52
      const scale = Math.min(box.width / W, availH / H)
      const cw = Math.floor(W * scale); const chh = Math.floor(H * scale)
      if (cv.width !== cw || cv.height !== chh) { cv.width = cw; cv.height = chh }
      const x = (v) => v * scale; const y = (v) => v * scale
      const ctx = cv.getContext('2d')
      const md = MODES[g.mode]
      const css = getComputedStyle(document.documentElement)
      const tq = (css.getPropertyValue('--tq') || '#2dd4bf').trim()
      // saha
      ctx.fillStyle = g.mode === 'futbol' ? '#0b2e1e' : '#0a2430'
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 2
      ctx.strokeRect(x(6), y(6), x(W - 12), y(H - 12))
      ctx.beginPath(); ctx.moveTo(x(W / 2), y(6)); ctx.lineTo(x(W / 2), y(H - 6)); ctx.stroke()
      ctx.beginPath(); ctx.arc(x(W / 2), y(H / 2), x(80), 0, Math.PI * 2); ctx.stroke()
      // kaleler
      const gTop = (H - md.goalH) / 2
      ctx.fillStyle = 'rgba(45,212,191,.25)'
      ctx.fillRect(0, y(gTop), x(10), y(md.goalH))
      ctx.fillStyle = 'rgba(14,165,233,.3)'
      ctx.fillRect(cv.width - x(10), y(gTop), x(10), y(md.goalH))
      // skor
      const sc = this.ui.querySelector('#game-score')
      sc.textContent = g.started || g.score[0] + g.score[1] ? `${g.score[0]}  —  ${g.score[1]}` : ''
      // raketler
      for (const p of g.players) {
        const pad = g.pads[p.code]
        if (!pad) continue
        ctx.beginPath()
        ctx.fillStyle = p.side === 0 ? tq : '#0ea5e9'
        ctx.arc(x(pad.x), y(pad.y), x(md.padR), 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#06231f'
        ctx.font = `700 ${Math.max(11, x(20))}px system-ui`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        const av = avatarOf(p.code)
        ctx.fillText(av || (p.name || '?')[0].toUpperCase(), x(pad.x), y(pad.y))
        ctx.fillStyle = 'rgba(255,255,255,.75)'
        ctx.font = `600 ${Math.max(10, x(14))}px system-ui`
        ctx.fillText(p.name || '', x(pad.x), y(pad.y + md.padR + 18))
      }
      // pak/top
      ctx.beginPath()
      ctx.fillStyle = g.mode === 'futbol' ? '#f8fafc' : '#f59e0b'
      ctx.arc(x(g.puck.x), y(g.puck.y), x(md.puckR), 0, Math.PI * 2)
      ctx.fill()
      if (g.freeze && Date.now() < g.freeze && g.started) {
        ctx.fillStyle = 'rgba(255,255,255,.85)'
        ctx.font = `800 ${Math.max(16, x(40))}px system-ui`
        ctx.fillText('HAZIR OL…', cv.width / 2, cv.height / 2 - x(70))
      }
    }
  }

  window.Games = Games

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('btn-games')
    if (b) b.onclick = () => Games.openMenu(b)
  })
})()
