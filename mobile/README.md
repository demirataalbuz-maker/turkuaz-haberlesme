# Turkuaz Mobil (Bare + React Native)

Aynı proje, telefonda. **Masaüstüyle aynı arayüzü** (`../public/`) bir WebView'de
gösterir; P2P çekirdeğini (Hyperswarm/hyperdht) **Bare** runtime'ında çalıştırır.
Masaüstündeki `server.js`'in yaptığını burada `backend/backend.mjs` yapar —
tek fark: HTTP/WebSocket yerine **WebView ↔ RN ↔ Bare köprüsü**.

> Durum: **İSKELE (scaffold).** Mimari + köprü + build yapılandırması hazır.
> Bu klasör Android SDK + Bare toolchain olan bir makinede derlenir; bu depoda
> derlenmiş APK YOKTUR. `backend.mjs`'in P2P olay işleyicisi `server.js`'i
> birebir yansıtır — ortak çekirdeğe çıkarmak sonraki adım (aşağıya bak).

## Mimari

```
┌─────────────────────── React Native (App.js) ───────────────────────┐
│                                                                       │
│   WebView  ← aynı public/ arayüzü (transport.js köprü modunda)        │
│      ▲  window.TurkuazNative.postMessage(str)  → RN.onMessage         │
│      │  window.__turkuazRecv(str)              ← RN.injectJavaScript  │
│      ▼                                                                 │
│   Köprü (App.js)  ⇄  BareKit.IPC (duplex JSON hattı)                  │
│                                                                       │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │
┌────────────────────────────── Bare ──────────────────────────────────┐
│   backend/backend.mjs                                                 │
│     - lib/p2p.js (Hyperswarm + Noise)  ← masaüstüyle AYNI kod         │
│     - lib/store.js (bare-fs ile)       ← yerel depolama               │
│     - server.js'teki mesaj işleyicileri (friend/dm/room/rtc...)       │
│     - IPC: UI aksiyonları (set-profile, send-dm...) → işle → state/msg│
└───────────────────────────────────────────────────────────────────────┘
```

Arayüz tarafı **Faz 1'de** hazırlandı: `public/transport.js` mobilde
`window.TurkuazNative` varsa köprü modunda çalışır (masaüstünde WebSocket).

## Neden Bare
Hyperswarm/hyperdht'yi yapan Holepunch'ın mobil JS runtime'ı. Native modüller
(sodium, udx) Bare için mobil-derli. Keet (Holepunch'ın P2P sohbeti) aynı yolu
kullanıyor. Tarayıcı/PWA yolu KAPALI (mobil tarayıcı ham UDP yapamaz).

## Kurulum & derleme (toolchain'li makinede)

```bash
cd mobile
npm install                      # RN + react-native-webview + react-native-bare-kit
# Bare backend'i mobil bundle'a paketle:
npx bare-pack --target android --target ios --linked \
  --out app/backend.bundle.mjs backend/backend.mjs
# Arayüzü kopyala (aynı public/):
cp -r ../public app/web
# Android:
npx react-native run-android
# iOS (macOS + Xcode):
cd ios && pod install && cd .. && npx react-native run-ios
```

## Bilinen işler / sırada
1. **Ortak çekirdek:** `server.js`'teki mesaj işleyicilerini `lib/core.js`'e
   çıkar; hem `server.js` (masaüstü) hem `backend.mjs` (mobil) onu kullansın.
   (Şu an backend.mjs bu mantığı ayrı taşıyor — kopya riski.)
2. **store.js fs:** Bare'de `bare-fs` kullan; yol = uygulama veri dizini.
3. **Arka plan:** iOS/Android uygulama kapanınca P2P soketini öldürür →
   "kapalıyken mesaj al" için push-uyandırma gerekir (Keet gibi). Uygulama
   açıkken sorun yok.
4. **A/V:** WebView WebRTC (Android Chrome WebView, iOS WKWebView 14.3+) ya da
   `react-native-webrtc`. Kamera/mikrofon izinleri Info.plist / AndroidManifest.
5. **Dağıtım:** Android APK doğrudan; iOS App Store (yıllık ücret).
