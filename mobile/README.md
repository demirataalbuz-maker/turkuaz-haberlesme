# Turkuaz Mobil (Bare + React Native)

Aynı proje, telefonda. **Masaüstüyle aynı arayüzü** (`../public/`) bir WebView'de
gösterir; P2P çekirdeğini (Hyperswarm/hyperdht) **Bare** runtime'ında çalıştırır.
Masaüstündeki `server.js`'in yaptığını burada `backend/backend.mjs` yapar —
tek fark: HTTP/WebSocket yerine **WebView ↔ RN ↔ Bare köprüsü**.

> Durum: **ÇEKİRDEK HAZIR + CI DERLEMESİ.** Tüm mesajlaşma mantığı `lib/core.js`'te —
> masaüstüyle AYNI kod; `backend.mjs` ince bir BareKit-IPC sarmalayıcı. Çekirdek
> `npm run test:bare` ile GERÇEK Bare runtime'ında test ediliyor (arkadaşlık, DM+ack,
> oda, geçmiş, arama ✅). APK, GitHub Actions `mobile-apk` workflow'uyla derlenir
> (elle tetikle ya da `mobile-v*` tag'i). Cihazda uçtan uca test HENÜZ yapılmadı.

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
1. ~~Ortak çekirdek~~ ✅ (`lib/core.js`; masaüstü + mobil aynı kod, `test:bare` ile doğrulanıyor)
2. ~~store.js fs~~ ✅ (kök package.json `imports`: Node'da builtin, Bare'de bare-fs/path/events)
3. **Cihaz testi:** APK'yı gerçek telefonda aç — worklet başlıyor mu, veri dizini
   yazılabilir mi, DHT'ye çıkıyor mu (mobil şebekede UDP), masaüstüyle DM.
4. **Dosyalar:** resimler köprüden base64 geliyor (`file-data`); dosya İNDİRME
   (kaydetme) mobilde henüz yok.
5. **Arka plan:** uygulama kapanınca P2P soketi ölür → push-uyandırma gerekir
   (Keet gibi). Uygulama açıkken sorun yok. bare-kit suspend/resume API'si var.
6. **A/V:** WebView WebRTC (getUserMedia izin köprüsü) ya da `react-native-webrtc`.
7. **Dağıtım:** Android APK GitHub Release'ten; iOS sonra (App Store, yıllık ücret).
