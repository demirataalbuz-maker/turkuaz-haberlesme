# Discord → Turkuaz özellik karşılaştırması & yol haritası

Amaç: Discord'daki tüm özellikleri çıkarmak, Turkuaz'da **ne var / kısmen var /
yok** diye işaretlemek ve özellikle **menü + ayarlar bölümünü** Discord'a benzer
şekilde inşa etmeye hazırlık yapmak.

Durum kodları: ✅ var · 🟡 kısmen · ❌ yok · 🚫 kapsam dışı (serversız mimariyle
mantıklı değil / SFU-sunucu ister)

---

## 1. Ses & Görüntü ayarları  ← senin en çok istediğin bölüm

Discord'un "Ses ve Görüntü" (Voice & Video) ayar sayfasındaki HER madde:

| Discord özelliği | Ne yapar | Turkuaz |
|---|---|---|
| **Giriş cihazı seçimi** (mikrofon) | Hangi mikrofon | ❌ (hep varsayılan) |
| **Çıkış cihazı seçimi** (hoparlör/kulaklık) | Sesi nereye ver (`setSinkId`) | ❌ |
| **Giriş ses seviyesi** | Mikrofon kazancı slider | ❌ |
| **Çıkış ses seviyesi** | Genel dinleme sesi slider | 🟡 (master gain var ama UI yok) |
| **Mikrofon testi** | "Let's check" — kendini duy | ❌ (konuşma göstergesi var, test yok) |
| **Giriş modu: Ses Etkinliği** | Konuşunca otomatik aç | 🟡 (hep açık, eşik yok) |
| **Giriş modu: Bas-Konuş (PTT)** | Tuşa basılıyken yayınla | ❌ |
| **PTT bırakma gecikmesi** | Tuş bırakınca kısa süre açık kal | ❌ |
| **Giriş hassasiyeti (VAD eşiği)** | Otomatik/manuel gürültü eşiği + canlı ölçer | ❌ |
| **Echo Cancellation** (yankı önleme) | | ✅ (odada + DM) |
| **Gürültü Engelleme — Standart** | WebRTC seviyesi gürültü bastırma | ✅ `noiseSuppression:true` |
| **Gürültü Engelleme — Krisp (ML)** | Yapay zekâ ile arka plan sesi (klavye, fan, köpek) tamamen siler | ❌ ← Discord'un asıl "sihiri" bu |
| **Otomatik Kazanç (AGC)** | Ses seviyeni otomatik dengeler | 🟡 (odada ✅, **DM aramasında eksik**) |
| **Gelişmiş Ses Etkinliği** | Daha akıllı konuşma algılama | ❌ |
| **Zayıflatma (Attenuation)** | Biri konuşunca diğer uygulama seslerini kıs (% + seçenekler) | ❌ |
| **QoS Yüksek Paket Önceliği** | Ses paketlerine ağda öncelik | ❌ |
| **Ses alt sistemi** (Standart/Eski/Deneysel) | Ses motoru seçimi | ❌ |
| **Ses ayarlarını sıfırla** | | ❌ |
| **Kamera seçimi + önizleme** | Hangi kamera, canlı test | ❌ (hep varsayılan, 640×480 sabit) |
| **Arka plan bulanıklaştırma / sanal arka plan** | | ❌ |
| **Ekran paylaşımı çözünürlüğü** (720/1080/kaynak) | | ❌ (sabit) |
| **Ekran paylaşımı FPS** (15/30/60) | | 🟡 (15'e sabit, seçilemiyor) |
| **Ekran sesi paylaşımı** | Ekranla birlikte uygulama sesini de gönder | ❌ (`audio:false`) |
| **Video arka planları / OpenH264 donanım** | | ❌ |

**Özet ses açığı:** Turkuaz sadece tarayıcının 3 temel WebRTC filtresini
kullanıyor. Discord'un fark yaratan tarafı = **Krisp (ML gürültü engelleme) +
cihaz seçimi + ses seviyesi + bas-konuş + VAD hassasiyeti**. Bunların hepsi
istemci tarafı, sunucu gerektirmiyor — yani Turkuaz'a eklenebilir.

> Not: Krisp'in kendisi tescilli. Turkuaz'da muadili için `@shiguredo/rnnoise-wasm`
> veya RNNoise WASM ile Web Audio zincirine bir gürültü bastırma düğümü eklenebilir
> (tam Krisp kadar iyi değil ama "standart"tan çok daha iyi).

---

## 2. Ayarlar menüsünün yapısı  ← "menü ve ayar bölümünü direkt kopyala"

Discord kullanıcı ayarları = **solda kategori listesi + sağda içerik paneli**,
tam ekran koyu tema. Kategoriler:

**Kullanıcı**
- Hesabım (Hesabım) · Profiller · Gizlilik & Güvenlik · Veri & Gizlilik
- Yetkili Uygulamalar · Cihazlar (oturumlar) · Bağlantılar · Aile Merkezi

**Faturalandırma** (Nitro/abonelik) — 🚫 Turkuaz'da yok, gerekmez

**Uygulama Ayarları**
- **Ses ve Görüntü** (yukarıdaki tablo)
- Metin & Görüntüler (emoji, link önizleme, mesaj görünümü)
- Bildirimler
- Kısayol Tuşları (Keybinds)
- Dil
- Streamer Modu
- Gelişmiş (geliştirici modu, donanım hızlandırma)
- Etkinlik Ayarları / Bindirme (Overlay) — 🚫 oyun bindirme

**Görünüm (Appearance)** — tema (koyu/açık), mesaj yoğunluğu (rahat/sıkışık),
yazı tipi ölçeği, yakınlaştırma

**Erişilebilirlik** — azaltılmış hareket, doygunluk, ekran okuyucu, TTS

**Çıkış Yap**

### Turkuaz'ın şu anki durumu
Birleşik ayar ekranı **yok**. Bunun yerine dağınık modal'lar var: Profil,
Oda, Arama, Hesap Taşıma. Yani yapılacak iş: bunları **tek bir Discord-tarzı
ayarlar ekranında** toplamak (sol kategori + sağ panel) ve eksik bölümleri
(Ses/Görüntü, Görünüm, Bildirimler, Kısayollar) eklemek.

**Turkuaz'a mantıklı ayar kategorileri:**
- Hesabım (isim/avatar/durum — profil modalını buraya taşı) + arkadaş kodu
- Ses ve Görüntü (yeni — yukarıdaki tablodaki maddeler)
- Görünüm (tema/renk — zaten turkuaz tema var, açık tema + yoğunluk eklenebilir)
- Bildirimler (masaüstü bildirim aç/kapa, ses)
- Kısayollar (Ctrl+K zaten var, PTT tuşu eklenir)
- Gizlilik (ICE/TURN ayarı, "sadece röle" IP gizleme modu)
- Hesabı Taşı (mevcut ⇄ modalı buraya)
- Gelişmiş (veri klasörü, ice.json, sürüm + güncelleme durumu)

---

## 3. Genel arayüz & mesajlaşma özellikleri

| Discord | Turkuaz |
|---|---|
| Sunucu rayı (sol) + kanal listesi + üye listesi (sağ) | 🟡 (ray + oda + DM var; üye listesi ❌) |
| Metin kanalları | ✅ (oda içinde kanallar) |
| Ses kanalları | ✅ (oda = ses + oturma odası) |
| Duyuru / Forum / Stage kanalları | ❌ |
| Kategoriler (kanal grupları) | ❌ |
| Konular (Threads) | ❌ |
| Roller & izinler | 🟡 (sadece sahip + ban imzalı) |
| Sağ tık menüleri (kullanıcı/mesaj) | 🟡 (mesaj araçları var, tam context menü yok) |
| Yanıtla (reply) | ❌ |
| Mesaja tepki (emoji react) | ✅ |
| Düzenle / Sil | ✅ |
| Sabitle (pin) | ❌ |
| Okunmadı işaretle | 🟡 (unread sayacı var, elle işaret yok) |
| İleri (forward) | ❌ |
| Markdown / kod bloğu / spoiler | ❌ (düz metin) |
| Emoji / sticker / GIF seçici | 🟡 (5 hızlı emoji var, seçici ❌) |
| Bahsetme (@mention) | ❌ |
| Dosya / resim ekleme | ✅ (8 MB, parçalı P2P) |
| Link/görsel önizleme (embed) | 🟡 (resim gösteriliyor, embed ❌) |
| Durum (çevrimiçi/rahatsız etme/görünmez) | 🟡 (çevrimiçi + özel durum metni) |
| Özel durum (custom status) | ✅ |
| Arkadaş sistemi (çevrimiçi/bekleyen/engelli) | 🟡 (arkadaş + istek var; engelleme ❌) |
| Grup DM | ❌ (sadece birebir DM) |
| Arama (mesajlarda) | ✅ (Ctrl+K, yerel) |
| Ses kanalı katılımcı görünümü | ✅ (oturma odası — üstelik konumsal ses, Discord'da yok!) |
| Soundboard | ❌ |
| Ekran paylaşımı | ✅ |
| Sesli/görüntülü birebir arama | ✅ (zil/kabul/red) |
| Bildirimler & @everyone/@here | 🟡 (masaüstü bildirim var) |
| Sunucu keşfi / boost / Nitro | 🚫 |
| Bot / slash komut / uygulama | 🚫 |
| Çoklu cihaz senkron | 🚫 (hesap taşıma modeli — bilinçli) |

### Turkuaz'ın Discord'da OLMAYAN artıları
- **Serversız / P2P** — merkezi sunucu yok, veri sende
- **Konumsal ses (HRTF oturma odası)** — balon sürükle, ses yönden gelir
- **İmzalı moderasyon** — kriptografik, sahte ban yayılamaz
- **Uçtan uca şifreli** (Noise) + kimlik taklit edilemez (Ed25519)

---

## 4. Öncelik sırası önerisi (Discord'a yaklaşmak için)

1. **Birleşik ayarlar ekranı** (Discord-tarzı sol kategori + sağ panel) — iskelet
2. **Ses & Görüntü ayarları** içine: cihaz seçimi, giriş/çıkış ses seviyesi,
   bas-konuş, VAD hassasiyeti + canlı ölçer
3. **ML gürültü engelleme** (RNNoise WASM) — "gürültü engelleme: standart / güçlü"
4. **Ekran paylaşımı seçenekleri** (çözünürlük/FPS/ses paylaşımı)
5. Mesaj tarafı: yanıtla, markdown, @mention, emoji seçici
6. Görünüm ayarları: açık tema, mesaj yoğunluğu

---

## 5. Açık teknik notlar
- DM aramasında `autoGainControl` eksik (odada var) — ilk ayar işinde düzelt.
- Çıkış cihazı için `<audio>`/`<video>.setSinkId()` gerekir (Electron destekler).
- PTT için global kısayol: Electron `globalShortcut` (pencere arkada olsa da çalışır).
- Ekran sesi paylaşımı: `getDisplayMedia({ audio: true })` — Linux'ta ekran sesi
  yakalama sınırlı olabilir, test gerek.
