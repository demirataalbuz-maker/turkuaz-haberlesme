// Turkuaz soundboard ("ses paneli"): kısa efekt sesleri WebAudio ile sentezlenir —
// ses dosyası yok, ağdan yalnızca minicik bir olay gider ({kind:'sndpad', id}),
// herkes aynı sesi KENDİ cihazında üretir. Oda sesli sohbetinde ve DM aramasında çalışır.
/* global state, send, Voice, CallMgr, TurkuazSettings */
(function () {
  let ctx = null
  let desiredSink = null
  let appliedSink = null
  let sinkTask = Promise.resolve(true)

  function selectedSink () {
    if (desiredSink !== null) return desiredSink
    try { return String(TurkuazSettings.get().spkId || '') } catch { return '' }
  }

  function C () {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
    return ctx
  }

  // AudioContext.setSinkId Chromium/Electron'da varsa soundboard da ayarlarda
  // seçilen hoparlöre gider. Çağrıları sıraya koymak hızlı cihaz değişimlerinde
  // eski bir promise'in yeni seçimi ezmesini önler.
  function applySink (c, id) {
    desiredSink = String(id || '')
    const target = desiredSink
    if (!c || typeof c.setSinkId !== 'function') return Promise.resolve(false)
    if (appliedSink === target) return sinkTask
    sinkTask = sinkTask.catch(() => false).then(async () => {
      await c.setSinkId(target)
      if (desiredSink === target) appliedSink = target
      return true
    }).catch(() => false)
    return sinkTask
  }

  async function readyContext () {
    const c = C()
    await applySink(c, selectedSink())
    try { await c.resume() } catch {}
    return c
  }
  const vol = () => { try { return Math.min(1, (Number(TurkuazSettings.get().outVol) || 100) / 100) } catch { return 1 } }

  function master (c) {
    const g = c.createGain()
    g.gain.value = 0.9 * vol()
    g.connect(c.destination)
    return g
  }
  // tek osilatör vuruşu: freq→endFreq kayması + hızlı zarf
  function hit (c, out, { type = 'sine', f = 440, f2 = 0, t = 0, dur = 0.3, g = 0.2 }) {
    const o = c.createOscillator(); const gn = c.createGain()
    o.type = type
    o.frequency.setValueAtTime(Math.max(30, f), t)
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t + dur)
    gn.gain.setValueAtTime(0.0001, t)
    gn.gain.exponentialRampToValueAtTime(g, t + 0.02)
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(gn).connect(out)
    o.start(t); o.stop(t + dur + 0.05)
  }
  // filtreli gürültü patlaması (alkış / trampet / tss)
  function burst (c, out, { t = 0, dur = 0.15, g = 0.3, fc = 1500, q = 1 }) {
    const len = Math.max(1, Math.ceil(c.sampleRate * dur))
    const buf = c.createBuffer(1, len, c.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = c.createBufferSource(); src.buffer = buf
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = fc; f.Q.value = q
    const gn = c.createGain(); gn.gain.value = g
    src.connect(f); f.connect(gn); gn.connect(out)
    src.start(t)
  }

  const SOUNDS = [
    {
      id: 'korna', emoji: '📢', label: 'Korna',
      fn: (c, o, t) => { for (const [dt, dur] of [[0, 0.28], [0.36, 0.55]]) { hit(c, o, { type: 'sawtooth', f: 220, f2: 233, t: t + dt, dur, g: 0.16 }); hit(c, o, { type: 'square', f: 440, f2: 466, t: t + dt, dur, g: 0.05 }) } }
    },
    {
      id: 'badum', emoji: '🥁', label: 'Ba-dum tss',
      fn: (c, o, t) => {
        hit(c, o, { f: 150, f2: 55, t, dur: 0.16, g: 0.5 })
        hit(c, o, { f: 150, f2: 55, t: t + 0.22, dur: 0.16, g: 0.5 })
        burst(c, o, { t: t + 0.46, dur: 0.12, g: 0.4, fc: 220, q: 0.8 })
        burst(c, o, { t: t + 0.46, dur: 0.7, g: 0.25, fc: 8000, q: 0.4 })
      }
    },
    {
      id: 'trombon', emoji: '😢', label: 'Üzgün trombon',
      fn: (c, o, t) => { const N = [233, 220, 208, 185]; N.forEach((f, i) => hit(c, o, { type: 'sawtooth', f, f2: i === 3 ? 165 : f, t: t + i * 0.38, dur: i === 3 ? 1.0 : 0.32, g: 0.12 })) }
    },
    {
      id: 'tada', emoji: '🎉', label: 'Ta-da!',
      fn: (c, o, t) => {
        [523, 659, 784].forEach((f, i) => hit(c, o, { type: 'triangle', f, t: t + i * 0.09, dur: 0.22, g: 0.14 }))
        ;[1047, 784, 659].forEach(f => hit(c, o, { type: 'triangle', f, t: t + 0.3, dur: 0.9, g: 0.09 }))
        burst(c, o, { t: t + 0.3, dur: 0.4, g: 0.1, fc: 6000, q: 0.4 })
      }
    },
    {
      id: 'toink', emoji: '🎈', label: 'Toink',
      fn: (c, o, t) => { hit(c, o, { type: 'triangle', f: 500, f2: 900, t, dur: 0.08, g: 0.2 }); hit(c, o, { type: 'triangle', f: 900, f2: 220, t: t + 0.08, dur: 0.3, g: 0.2 }) }
    },
    {
      id: 'alkis', emoji: '👏', label: 'Alkış',
      fn: (c, o, t) => { let dt = 0; for (let i = 0; i < 14; i++) { burst(c, o, { t: t + dt, dur: 0.05, g: 0.35 * (1 - i / 20), fc: 1100 + Math.random() * 500, q: 0.7 }); dt += 0.055 + Math.random() * 0.05 } }
    },
    {
      id: 'ding', emoji: '🔔', label: 'Ding',
      fn: (c, o, t) => { hit(c, o, { f: 1319, t, dur: 1.1, g: 0.15 }); hit(c, o, { f: 2637, t, dur: 0.6, g: 0.05 }) }
    },
    {
      id: 'ufo', emoji: '🛸', label: 'UFO',
      fn: (c, o, t) => { hit(c, o, { type: 'triangle', f: 300, f2: 1400, t, dur: 0.5, g: 0.12 }); hit(c, o, { type: 'triangle', f: 1400, f2: 500, t: t + 0.5, dur: 0.5, g: 0.12 }) }
    }
  ]

  const Soundboard = {
    sounds: SOUNDS,
    play (id) {
      const s = SOUNDS.find(x => x.id === id)
      if (!s) return Promise.resolve(false)
      return readyContext().then(c => {
        s.fn(c, master(c), c.currentTime + 0.02)
        return true
      }).catch(() => false)
    },
    setSink (id) {
      desiredSink = String(id || '')
      return ctx ? applySink(ctx, desiredSink) : Promise.resolve(true)
    },
    _last: 0,
    remote (id) { // uzaktan gelen — basit sel önlemi
      const now = Date.now()
      if (now - this._last < 250) return
      this._last = now
      this.play(id)
    },
    trigger (id) { // yerelde çal + sesli sohbettekilere gönder
      this.play(id)
      if (window.Voice && Voice.room) {
        send({ t: 'room-ev', room: Voice.room, ev: { kind: 'sndpad', id } })
      } else if (window.CallMgr && CallMgr.state === 'active' && CallMgr.peer) {
        send({ t: 'rtc', to: CallMgr.peer, data: { kind: 'call-snd', scope: 'call', id } })
      }
    },
    toggle (btn) {
      const old = document.getElementById('sndpad-pop')
      if (old) { old.remove(); return }
      const pop = document.createElement('div')
      pop.id = 'sndpad-pop'
      pop.innerHTML = '<div class="snd-title">SES PANELİ</div>'
      const grid = document.createElement('div'); grid.className = 'snd-grid'
      for (const s of SOUNDS) {
        const b = document.createElement('button')
        b.className = 'snd-btn'
        b.innerHTML = `<span class="snd-emoji">${s.emoji}</span><span>${s.label}</span>`
        b.onclick = () => this.trigger(s.id)
        grid.appendChild(b)
      }
      pop.appendChild(grid)
      document.body.appendChild(pop)
      const r = btn.getBoundingClientRect()
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left - 40)) + 'px'
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 10) + 'px'
      setTimeout(() => {
        const off = (e) => { if (!pop.contains(e.target) && e.target !== btn) { pop.remove(); document.removeEventListener('pointerdown', off, true) } }
        document.addEventListener('pointerdown', off, true)
      }, 0)
    }
  }
  window.Soundboard = Soundboard

  document.addEventListener('DOMContentLoaded', () => {
    const b1 = document.getElementById('btn-sndpad')
    if (b1) b1.onclick = () => Soundboard.toggle(b1)
    const b2 = document.getElementById('call-sndpad')
    if (b2) b2.onclick = () => Soundboard.toggle(b2)
  })
})()
