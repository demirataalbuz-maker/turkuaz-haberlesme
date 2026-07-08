// Taşıma katmanı: arayüz ile P2P çekirdeği arasında.
//  - Masaüstü & tarayıcı: localhost WebSocket (server.js).
//  - Mobil (WebView): React Native tarafından enjekte edilen yerel köprü.
// Arayüz kodu yalnızca window.send() ve Transport.onMessage() bilir; altta
// hangi taşımanın olduğunu bilmez. Böylece public/ aynen mobilde de çalışır.
(function () {
  let handler = () => {}

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
      start () { try { window.TurkuazNative.postMessage(JSON.stringify({ t: '__ready' })) } catch {} },
      send (obj) { try { window.TurkuazNative.postMessage(JSON.stringify(obj)) } catch {} }
    }
  }

  // Masaüstü/tarayıcı: localhost WebSocket, koptuğunda yeniden bağlanır.
  function wsTransport () {
    let ws = null
    function connect () {
      ws = new WebSocket('ws://' + location.host)
      ws.onmessage = (ev) => deliver(ev.data)
      ws.onclose = () => setTimeout(connect, 1500)
    }
    return {
      start () { connect() },
      send (obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)) }
    }
  }

  const impl = (typeof window !== 'undefined' && window.TurkuazNative) ? bridgeTransport() : wsTransport()

  window.Transport = {
    onMessage (fn) { handler = fn },
    start () { impl.start() }
  }
  window.send = function (obj) { impl.send(obj) }
})()
