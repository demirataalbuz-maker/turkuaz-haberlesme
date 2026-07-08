# Turkuaz mobil — aynı proje, telefonda da

Hedef: **tek repo, tek çekirdek.** Masaüstü (Electron) ve mobil (Android/iOS)
aynı projeden çıkacak; UI ve P2P mantığı paylaşılacak, sadece "kabuk" değişecek.

## Ne paylaşılır, ne ayrıdır

| Katman | Masaüstü | Mobil | Paylaşım |
|---|---|---|---|
| Arayüz (`public/`) | Electron penceresi | WebView | ✅ **aynı kod** |
| P2P mantığı (`lib/`, protokol) | Node `server.js` | Bare runtime | ✅ büyük kısmı ortak |
| Kabuk | `electron-main.js` | React Native | ❌ platforma özel |
| Taşıma (UI ↔ P2P) | WebSocket (localhost) | köprü (bridge) | 🔧 soyutlanacak |

## Neden mümkün — Bare

Hyperswarm/hyperdht'yi yapan **Holepunch**'ın mobil için bir JS runtime'ı var:
**Bare**. Node yerine Bare kullanınca `hyperswarm`/`hyperdht` ve native modüller
(sodium, udx) **telefonda çalışıyor**. Holepunch'ın kendi uygulaması **Keet**
(P2P sohbet) tam olarak bunu yapıyor — yani seçtiğimiz altyapı mobili mümkün
kılan tek ekosistem. Tarayıcı/PWA yolu KAPALI (mobil tarayıcı ham UDP yapamaz,
Hyperswarm peer'ı olamaz).

## Mimari değişimi

```
Bugün (masaüstü):
  public/ (UI)  ⟷  WebSocket(localhost:3210)  ⟷  server.js [Node: hyperswarm]

Mobilde:
  public/ (UI, WebView)  ⟷  bridge/postMessage  ⟷  Bare [hyperswarm]
```

Anahtar iş: `public/app.js` içindeki `ws`/`send()` katmanını **soyutlamak** —
masaüstünde WebSocket, mobilde köprü olacak şekilde. (Bu zaten iyi bir refactor,
mobil olmasa bile taşıma katmanını UI'dan ayırır.)

## Dürüst zorluklar

1. **Taşıma refactor'ü:** `app.js` şu an WebSocket'e sıkı bağlı → tek bir
   `transport` arayüzü ardına al. (Ön koşul, masaüstünde bugün yapılabilir.)
2. **Ses/görüntü:** Mobil WebView WebRTC destekler (Android Chrome WebView;
   iOS WKWebView 14.3+), ya da `react-native-webrtc`. Test gerek — mobilde
   kamera/mikrofon izinleri ve arka plan davranışı farklı.
3. **Arka plan:** Mobil OS uygulama kapanınca P2P soketini öldürür →
   "kapalıyken mesaj al" masaüstündeki kadar kolay değil. Keet bunu push-uyandırma
   ile çözüyor. iOS özellikle katı. (Uygulama açıkken sorun yok.)
4. **Dağıtım:** Android APK doğrudan dağıtılır (kolay). iOS App Store zahmetli
   + yıllık geliştirici ücreti. Oto-update mobilde farklı çalışır (store /
   kendi kanalın).

## Fazlar

1. **Prep (masaüstü):** UI taşıma katmanını soyutla — WebSocket'i tek yerde topla.
   Riski düşük, mobil için ön koşul. *Buradan başlanır.*
2. **Bare PoC:** `server.js`'in P2P çekirdeğini Bare'de çalıştır; Android'de
   başsız (headless) iki cihaz bağlanıp mesajlaşsın.
3. **RN kabuk + WebView:** `public/` arayüzünü mobilde göster, köprüyle Bare'e bağla.
4. **A/V:** kamera/mikrofon + WebRTC'yi mobilde çalıştır.
5. **Android build → test → APK.** Sonra iOS.
6. **Oto-update** mobil kanalını kur.

## İlk adım
Önce Windows testini bitir (masaüstü sağlamlaşsın). Sonra **Faz 1** ile
başlarız — UI'ı bozmadan mobil-hazır hale getiren taşıma soyutlaması.
