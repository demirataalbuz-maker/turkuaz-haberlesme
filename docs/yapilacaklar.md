# Turkuaz — yapılacaklar (kesin liste)

Discord karşılaştırmasından çıkan, **kesin yapılacak** işlerin ana listesi.
Durum: ✅ bitti · 🔜 kesin yapılacak · 🧪 büyük/sonra · 🚫 yapılmayacak

## ✅ Bitti (0.3.2 – 0.3.4)
- Discord-tarzı **birleşik ayarlar ekranı** (⚙)
- **Mikrofon / hoparlör / kamera cihaz seçimi**
- **Giriş & çıkış ses seviyesi** (canlı)
- **Kişi-bazlı ses** (katılımcıya sağ tık → ayrı ses)
- **Mikrofon testi** (canlı ölçer)
- **Ekran paylaşımı:** çözünürlük + FPS + ses seçeneği
- **Tam ekran** (kamera / paylaşılan ekran / DM görüntüsü)
- DM aramasında **AGC** düzeltmesi
- **Windows otomatik güncelleme** düzeltmesi
- Kopyalama butonu, WebRTC glare, çoklu STUN + TURN

## 🔜 Kesin yapılacak (öncelik sırası)
1. ◐ **Bas-konuş (PTT)** — uygulama-içi çalışıyor (0.3.10); global/arka-plan sürüm Electron globalShortcut+IPC ile sırada
2. ✅ **Giriş hassasiyeti (VAD)** — ses etkinliği modu + hassasiyet (0.3.10)
3. **Ekran seçici** — paylaşırken "hangi ekran/pencere?" (şu an otomatik ana ekran) — Electron IPC gerekir
4. **ML gürültü engelleme** — Krisp muadili (bkz. aşağıdaki bölüm)
5. **Mesaj tarafı:**
   - ✅ Markdown + kod bloğu + spoiler + otomatik link (0.3.6)
   - ✅ @bahsetme vurgusu (0.3.6)
   - ✅ Emoji seçici (0.3.6)
   - ✅ Yanıtla (reply) (0.3.7)
   - ✅ Sabitleme (pin) (0.3.8)
   - GIF seçici — kalan
6. ✅ **Üye listesi** (sağ panel) (0.3.8)
7. ✅ **Engelleme** (0.3.8)
8. **Grup DM** (2+ kişilik özel sohbet)
9. ✅ **Görünüm ayarları** — açık tema + mesaj yoğunluğu (0.3.9)
10. ✅ **Bildirim ayarları** — aç/kapa (0.3.9)
11. **Mobil** (Bare + React Native) — ayrı büyük proje, `mobil-yol-haritasi.md`

## 🧪 Büyük / sonra karar
- Konular (threads)
- Roller & izinler (tam sistem)
- Soundboard
- Arka plan bulanıklaştırma (kamera)

## 🚫 Yapılmayacak (kapsam dışı)
- Zayıflatma/attenuation — başka uygulamaların sesini kısmak native OS ses API'si ister, web/Electron'da yok
- QoS paket önceliği, "ses alt sistemi" — Discord'un kendi native ses motoru
- Bot / slash komut, Nitro / faturalandırma — serversız mimariye uymaz

---

## Gürültü engelleme (Krisp meselesi) — yaklaşım

**Sorun:** Discord'un Krisp'i tescilli bir ML modeli; klavye/fan/köpek sesini siler.
Bizde şu an sadece tarayıcının temel gürültü bastırması var.

**"Kendi AI'mızı geliştirelim" — iki anlama gelir:**
- **(a) Sıfırdan model eğitmek:** temiz+gürültülü ses veri seti topla, sinir ağı
  eğit, gerçek-zamanlı çalışacak şekilde optimize et, WASM/ONNX'e çıkar. Aylar
  süren bir ML araştırma işi. **Gerek yok** — bu iş çözülmüş.
- **(b) Hazır açık bir AI modelini entegre etmek:** ✅ akıllı yol. Zaten eğitilmiş,
  tarayıcıda çalışan modeller var. Biz sadece ses zincirine takıyoruz.

**Seçenekler (b):**
| Model | Kalite | Ağırlık | Tarayıcıda |
|---|---|---|---|
| **RNNoise** | İyi (Krisp'ten düşük ama "standart"tan çok iyi) | Çok hafif | ✅ WASM var, gerçek-zamanlı |
| **DeepFilterNet** | Çok iyi (Krisp'e yakın) | Ağır | 🟡 ONNX, CPU'yu zorlar |

**Nasıl bağlanır:** `voice.js`'te mikrofon zaten WebAudio'dan geçiyor (giriş-kazancı
için `buildMic`). Araya bir **AudioWorklet** koyup ses karelerini modelden
geçireceğiz → temizlenmiş ses gönderilecek. Altyapı hazır, üstüne oturur.
İstemci tarafı çalışır — serversız felsefeye tam uyar.

**Öneri:** Slice 3'te **RNNoise** ile başla (hızlı, hafif, kesin çalışır) →
"gürültü engelleme: kapalı / standart / güçlü (AI)" seçeneği. Beğenmezsek
DeepFilterNet'i değerlendiririz. **Sıfırdan model eğitmeye gerek yok.**
