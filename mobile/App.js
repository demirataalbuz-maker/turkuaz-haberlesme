// Turkuaz mobil kabuk (React Native).
// WebView'de masaüstüyle AYNI arayüzü (public/) gösterir; P2P çekirdeğini Bare
// worklet'inde (backend/backend.mjs) çalıştırır. İkisini satır-bazlı JSON köprüyle
// bağlar — masaüstündeki server.js'in WebSocket'i yerine.
import React, { useRef, useEffect } from 'react'
import { SafeAreaView, StyleSheet, StatusBar } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
// bare-pack çıktısı (Bare backend'in mobil bundle'ı). `npm run bare:pack` üretir.
import bundle from './app/backend.bundle.mjs'

// WebView yüklenmeden önce: public/transport.js'in köprü modunu tetikleyen köprü.
// transport.js şunları bekler: window.TurkuazNative.postMessage(str) ve
// window.__turkuazRecv(str). İlkini burada sağlıyoruz; ikincisini RN enjekte eder.
const INJECT_BEFORE = `
  window.TurkuazNative = { postMessage: (s) => window.ReactNativeWebView.postMessage(s) };
  true;
`

export default function App () {
  const webRef = useRef(null)
  const ipcRef = useRef(null)

  useEffect(() => {
    const worklet = new Worklet()
    worklet.start('/backend.bundle', bundle)
    const ipc = worklet.IPC
    ipcRef.current = ipc

    // Bare → WebView: satır-bazlı JSON çerçeveleme
    let buf = ''
    ipc.on('data', (chunk) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line && webRef.current) {
          webRef.current.injectJavaScript('window.__turkuazRecv && window.__turkuazRecv(' + JSON.stringify(line) + '); true;')
        }
      }
    })

    return () => { try { worklet.terminate() } catch {} }
  }, [])

  // WebView → Bare
  const onMessage = (e) => {
    const ipc = ipcRef.current
    if (ipc) ipc.write(e.nativeEvent.data + '\n')
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#08110f" />
      <WebView
        ref={webRef}
        // Paketlenen arayüz (npm run web:copy → app/web). Android asset yolu:
        source={{ uri: 'file:///android_asset/web/index.html' }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
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
