// Taşıma katmanı: arayüz ile P2P çekirdeği arasında.
//  - Masaüstü & tarayıcı: localhost WebSocket (server.js).
//  - Mobil (WebView): React Native tarafından enjekte edilen yerel köprü.
// Arayüz kodu yalnızca window.send() ve Transport.onMessage() bilir; altta
// hangi taşımanın olduğunu bilmez. Böylece public/ aynen mobilde de çalışır.
(function () {
  let handler = () => {}
  let statusHandler = () => {}

  function reportStatus (status, detail) {
    try { statusHandler({ status, detail: detail || '' }) } catch {}
  }

  function deliver (raw) {
    let m
    try { m = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    handler(m)
  }

  // Mobil köprü: RN tarafı window.TurkuazNative.postMessage(str) sağlar; gelen
  // mesajları da window.__turkuazRecv(str) çağırarak buraya iletir.
  function bridgeTransport () {
    window.__turkuazRecv = (str) => deliver(str)
    return {
      start () {
        reportStatus('online')
        try { window.TurkuazNative.postMessage(JSON.stringify({ t: '__ready' })) } catch {}
      },
      send (obj) { try { window.TurkuazNative.postMessage(JSON.stringify(obj)) } catch {} }
    }
  }

  // Masaüstü/tarayıcı: localhost WebSocket, koptuğunda yeniden bağlanır.
  function wsTransport () {
    let ws = null
    let retryTimer = null
    let retry = 0
    const queue = []
    const TRANSIENT = new Set(['typing', 'rtc', 'room-ev', '__ready'])

    function flush () {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      while (queue.length) {
        try { ws.send(JSON.stringify(queue.shift())) } catch { break }
      }
    }

    function connect () {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
      clearTimeout(retryTimer)
      reportStatus(retry ? 'reconnecting' : 'connecting')
      try { ws = new WebSocket('ws://' + location.host) } catch { scheduleReconnect(); return }
      ws.onmessage = (ev) => deliver(ev.data)
      ws.onopen = () => {
        retry = 0
        reportStatus('online')
        try { ws.send(JSON.stringify({ t: '__ready' })) } catch {}
        flush()
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        ws = null
        reportStatus('offline')
        scheduleReconnect()
      }
    }
    function scheduleReconnect () {
      if (retryTimer) return
      const wait = Math.min(8000, 700 * Math.pow(1.65, retry++))
      retryTimer = setTimeout(() => { retryTimer = null; connect() }, wait)
    }
    return {
      start () { connect() },
      send (obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(obj)) } catch {}
          return true
        }
        // Mesaj/dosya/ayar gibi kullanıcı eylemlerini kısa backend kopmalarında
        // kaybetme. WebRTC sinyali ve typing gibi anlık olaylar eskiyince
        // zararlı olabileceği için kuyruğa girmez; heartbeat onları yeniler.
        if (obj && !TRANSIENT.has(obj.t)) {
          if (queue.length >= 100) queue.shift()
          queue.push(obj)
        }
        return false
      }
    }
  }

  const impl = (typeof window !== 'undefined' && window.TurkuazNative) ? bridgeTransport() : wsTransport()

  window.Transport = {
    onMessage (fn) { handler = fn },
    onStatus (fn) { statusHandler = typeof fn === 'function' ? fn : () => {} },
    start () { impl.start() }
  }
  window.send = function (obj) { impl.send(obj) }
})()
