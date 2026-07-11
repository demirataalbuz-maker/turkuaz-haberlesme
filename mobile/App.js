// Turkuaz mobil kabuk (React Native).
// WebView'de masaüstüyle AYNI arayüzü (public/) gösterir; P2P çekirdeğini Bare
// worklet'inde (backend/backend.mjs) çalıştırır. İkisini satır-bazlı JSON köprüyle
// bağlar — masaüstündeki server.js'in WebSocket'i yerine.
import React, { useRef, useEffect } from 'react'
import { SafeAreaView, StyleSheet, StatusBar, Linking } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
// bare-pack çıktısının base64 hali (scripts/pack-backend.js üretir) — RN bundle'ına gömülür.
import bundleB64 from './app/backend.bundle.js'
import { version as APP_VERSION } from './package.json'

// WebView yüklenmeden önce: public/transport.js'in köprü modunu tetikleyen köprü.
// __TQ_MOBILE_VER: arayüzdeki güncelleme kontrolü sürümü buradan okur.
const INJECT_BEFORE = `
  window.TurkuazNative = { postMessage: (s) => window.ReactNativeWebView.postMessage(s) };
  window.__TQ_MOBILE_VER = ${JSON.stringify(APP_VERSION)};
  true;
`

export default function App () {
  const webRef = useRef(null)
  const ipcRef = useRef(null)
  const pendingRef = useRef([]) // WebView hazır olmadan gelenler

  // Çekirdek/RN hatalarını WebView'e log olarak düşür — uygulama ÇÖKMEZ,
  // arayüzdeki tanılama paneli gösterir.
  const toWeb = (line) => {
    const js = 'window.__turkuazRecv && window.__turkuazRecv(' + JSON.stringify(line) + '); true;'
    if (webRef.current) { try { webRef.current.injectJavaScript(js) } catch {} } else pendingRef.current.push(js)
  }
  const logWeb = (msg) => toWeb(JSON.stringify({ t: 'log', level: 'error', msg }))
  const logWeb0 = (msg) => toWeb(JSON.stringify({ t: 'log', msg })) // bilgi seviyesi (panel açtırmaz)

  const workletRef = useRef(null)
  const startedRef = useRef(false)

  useEffect(() => {
    // RN tarafında yakalanmamış hata → çökme yerine tanılamaya yaz
    if (global.ErrorUtils && global.ErrorUtils.setGlobalHandler) {
      global.ErrorUtils.setGlobalHandler((e) => {
        logWeb('RN hatası: ' + ((e && e.message) || e))
      })
    }
    return () => { try { workletRef.current && workletRef.current.terminate() } catch {} }
  }, [])

  // Motor, ARAYÜZ AÇILDIKTAN SONRA çalışır: native bir çökme olsa bile
  // uygulama önce açılır, tanılama paneli (ve kara kutu) görünür kalır.
  const startBackend = () => {
    if (startedRef.current) return
    startedRef.current = true
    setTimeout(() => {
      try {
        logWeb0('motor: worklet oluşturuluyor')
        const worklet = new Worklet()
        workletRef.current = worklet
        logWeb0('motor: bundle çözülüyor (' + Math.round(bundleB64.length / 1024) + ' KB b64)')
        const bytes = b4a.from(bundleB64, 'base64')
        // DİKKAT: dosya adı `.bundle` OLMALI — bare-pack çıktısı bundle formatıdır,
        // .mjs uzantısı verilirse Bare düz JS sanıp SyntaxError ile ölür (v0.5.0 bug'ı).
        logWeb0('motor: worklet.start çağrılıyor')
        worklet.start('/backend.bundle', bytes) // 0.15 API: senkron, bayt kaynak
        logWeb0('motor: worklet.start DÖNDÜ (native init tamam)')
        const ipc = worklet.IPC
        ipcRef.current = ipc
        ipc.on('error', (e) => logWeb('köprü (IPC) hatası: ' + ((e && e.message) || e)))
        ipc.on('close', () => logWeb('Bare çekirdeği kapandı (IPC koptu)'))
        for (const line of outboxRef.current.splice(0)) { try { ipc.write(line + '\n') } catch {} }

        // Bare → WebView: satır-bazlı JSON çerçeveleme
        let buf = ''
        ipc.on('data', (chunk) => {
          buf += chunk.toString()
          let i
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1)
            if (line) toWeb(line)
          }
        })
      } catch (e) {
        logWeb('worklet kurulamadı: ' + ((e && e.message) || e))
      }
    }, 700)
  }

  // 🧪 Mini motor testi: bundle'sız, bomboş bir worklet. Bu da çökerse suçlu
  // motor çekirdeğinin kendisi (libjs/bare-kit); çalışırsa suçlu bizim paket.
  const miniTest = () => {
    try {
      logWeb0('🧪 mini test: worklet başlatılıyor…')
      const w = new Worklet()
      w.start('/mini.js', 'const { IPC } = BareKit\nIPC.write(JSON.stringify({ t: "log", msg: "🧪 mini motor YAŞIYOR — çekirdek bu cihazda çalışıyor, sorun bizim pakette" }) + "\\n")')
      let mb = ''
      w.IPC.on('data', (chunk) => {
        mb += chunk.toString()
        let i
        while ((i = mb.indexOf('\n')) !== -1) { const line = mb.slice(0, i); mb = mb.slice(i + 1); if (line) toWeb(line) }
      })
    } catch (e) {
      logWeb('🧪 mini test worklet kurulamadı: ' + ((e && e.message) || e))
    }
  }

  // WebView → Bare (motor henüz yoksa kuyruğa al, başlayınca akıt).
  // '__engine-start' ARAYÜZDEN gelir: önceki açılış çökmüşse arayüz motoru
  // BAŞLATMAZ (güvenli mod) — çökme döngüsü kırılır, loglar okunabilir kalır.
  const outboxRef = useRef([])
  const onMessage = (e) => {
    try {
      const raw = e.nativeEvent.data
      if (raw.includes('"__engine-start"')) { startBackend(); return }
      if (raw.includes('"__mini-test"')) { miniTest(); return }
      const ipc = ipcRef.current
      if (ipc) ipc.write(raw + '\n')
      else outboxRef.current.push(raw)
    } catch (err) {
      logWeb('köprüye yazılamadı: ' + ((err && err.message) || err))
    }
  }

  const onWebReady = () => {
    for (const js of pendingRef.current.splice(0)) {
      try { webRef.current && webRef.current.injectJavaScript(js) } catch {}
    }
  }

  // Dış bağlantılar (mesajdaki linkler, APK indirme) telefonun tarayıcısında açılsın
  const onShouldStart = (req) => {
    const u = (req && req.url) || ''
    if (u.startsWith('file://') || u.startsWith('about:') || u.startsWith('data:')) return true
    Linking.openURL(u).catch(() => {})
    return false
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#08110f" />
      <WebView
        ref={webRef}
        // Paketlenen arayüz (npm run web:copy). Android asset yolu:
        source={{ uri: 'file:///android_asset/web/index.html' }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
        onMessage={onMessage}
        onLoadEnd={onWebReady}
        onShouldStartLoadWithRequest={onShouldStart}
        setSupportMultipleWindows={false}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        style={styles.web}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#08110f' },
  web: { flex: 1, backgroundColor: '#10201e' }
})
