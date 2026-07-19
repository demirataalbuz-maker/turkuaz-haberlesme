# Turkuaz 🌊

Serversız, P2P sohbet uygulaması. **Merkezi sunucu yok** — herkesin verisi
kendi bilgisayarında durur, herkesin bilgisayarı kendi "server"ıdır.
Bağlantılar kişiye özel kriptografik kodlarla kurulur, uçtan uca şifrelidir.

## Özellikler

- **DM**: mesaj, düzenle/sil, emoji reaksiyon, yazıyor göstergesi,
  offline kuyruk (karşı taraf gelince teslim + ack), dosya/resim gönderme
- **Odalar**: davet koduyla katılım, **kanallar** (#genel, #müzik...),
  **geçmiş senkronu** (sonradan katılan eski mesajları online üyelerden çeker),
  **imzalı moderasyon** (oda sahibi kriptografik imzayla yasaklar; herkes imzayı
  doğrular, banlının mesajları düşer)
- **Ses/görüntü**: odada sesli sohbet + **oturma odası** (balonunu sürükle,
  sesler konuma göre yönlü gelir — HRTF), kamera, **ekran paylaşımı**,
  konuşma göstergesi, RNNoise güçlü gürültü engelleme, bağlantı kalite göstergesi,
  kalıcı ses dock'u ve DM'den **birebir arama** (native bildirim, kabul/red)
- **Oyun kullanımı**: pencere arkasında da çalışan `Ctrl+Shift+M` sustur/aç,
  odak kaybında güvenli kapanan PTT ve sekiz hazır efektli ses paneli
- **Profil**: emoji avatar + özel durum
- **Arama**: Ctrl+K ile yerel geçmişte ara
- **Hesap taşıma**: kimlik + arkadaşlar + odalar başka PC'ye taşınır;
  yazışmalar eski PC'de kalır (bilinçli tasarım)
- **Masaüstü**: tepsi ikonu (kapatınca arkada çalışır), sistem bildirimleri

## Mimari

- Peer keşfi: [Hyperswarm](https://github.com/holepunchto/hyperswarm) DHT —
  dağıtık, sahipsiz. Bootstrap düğümleri sadece ağa giriş kapısı.
- Mesajlar: Noise şifreli doğrudan soketler üzerinden JSON.
- Ses/görüntü: WebRTC (medya doğrudan akar); sinyalleşme kendi P2P kanalından.
  STUN yalnızca adres keşfi için (veri geçmez, aynı ağda hiç kullanılmaz).
- Depolama: `data/` içinde JSON + JSONL (append-only günlük; react/edit/sil
  olayları okurken katlanır) + `files/` (dosyalar).

## Çalıştırma

```bash
# masaüstü uygulaması (önerilen)
dist/Turkuaz.AppImage          # ya da masaüstündeki Turkuaz kısayolu

# geliştirme
npm start                      # tarayıcıdan http://localhost:3210
npm run app                    # electron penceresi
npm run dist:linux             # Linux x64 AppImage üret
npm run dist:win               # Windows x64 NSIS kurucusu üret (imza gerekir)
npm test                       # updater sözleşmesi + 14 aşamalı P2P E2E
npm run test:av                # ses/görüntü testi: 2 Electron, sahte kamera,
                               # kamera + ekran paylaşımı + DM araması + pano
npm run test:voice:mesh        # 6 ayrı istemci, 15/15 ses bağlantısı
TURKUAZ_VOICE_CLIENTS=10 npm run test:voice:mesh  # 10 istemci, 45/45
npm run test:bare              # telefonla ortak Bare çekirdeği + offline dönüş
```

Ortam değişkenleri: `PORT` (3210), `TURKUAZ_DATA` (veri klasörü),
`TURKUAZ_BOOTSTRAP` (test için yerel DHT, örn `127.0.0.1:49737`),
`TURKUAZ_ICE` (özel ICE sunucuları, aşağıya bak).

## İndir (Windows / Linux)

Hazır paketler [Releases](https://github.com/demirataalbuz-maker/turkuaz-haberlesme/releases)
sayfasında:
- **Windows x64:** `Turkuaz-Setup-X.Y.Z.exe` — indir, çalıştır, kurulur.
- **Linux x64:** `Turkuaz.AppImage` — indir, çalıştırılabilir yap (`chmod +x`), aç.

Her iki paket de kendini otomatik günceller (aşağıya bak).

## Otomatik güncelleme

NSIS ile kurulmuş Windows uygulaması ve Linux AppImage, açılıştan 15 saniye
sonra ve ardından 4 saatte bir son **stable** GitHub Release'i denetler. Bu bir
push bildirimi değildir; yeni sürüm bulununca arka planda iner, uygulama içindeki
şerit yüzdeyi gösterir ve indirme bitince sistem bildirimi gelir. Ayarlar →
Gelişmiş'ten elle denetleyebilir, şeritten/ayarlardan/tepsiden **Yeniden başlat ve
güncelle** diyebilirsin.

"Sonra" dersen güncelleme gerçek uygulama çıkışında kurulur. Pencerenin X'i
Turkuaz'ı kapatmaz, tepsiye gizler; gerçek çıkış için tepsi → Çıkış'ı kullan.
Linux'ta AppImage'ı yazılabilir bir klasöre koy (örn.
`~/Uygulamalar/Turkuaz.AppImage`); hem dosya hem üst klasörü yazılabilir olmalı.
Updater dosyayı yerinde değiştirir, dolayısıyla aynı kısayol geçerli kalır.

Yeni sürüm yayınlamak (repo sahibi) — **Windows + Linux birlikte, GitHub Actions ile:**

```bash
npm version patch        # sürümü yükseltir (X.Y.Z) + git tag oluşturur (vX.Y.Z)
git push --follow-tags   # tag'i push'la → .github/workflows/release.yml tetiklenir
```

Actions önce updater/P2P/Bare/Electron testlerini geçirir; Windows'ta imzalı
`.exe`, Linux'ta AppImage üretir; manifest boyutu ve SHA-512 zincirini kontrol
eder. Sonra tek taslak Release'e şu beş dosyayı birlikte koyar:

- `Turkuaz.AppImage` + `latest-linux.yml`
- `Turkuaz-Setup-X.Y.Z.exe` + `.exe.blockmap` + `latest.yml`

Taslak updater'a görünmez. Temiz Windows ve Linux makinelerinde eski sürümden
aday sürüme kabul testi yaptıktan sonra **Publish release** seç; istemciler bir
sonraki açılışta veya en geç sonraki 4 saatlik kontrolde görür. Yayınlanmış
hatalı bir sürümün dosyalarını değiştirme; daha yüksek bir X.Y.Z yaması çıkar.

Windows release işi `WIN_CSC_LINK` ve `WIN_CSC_KEY_PASSWORD` GitHub secret'ları
olmadan bilerek durur; kurucu geçerli Authenticode imzası taşımak zorundadır ve
sertifika yayıncı adı sonraki sürümlerde sabit kalmalıdır. GitHub release yükleme
için Actions'ın kendi `GITHUB_TOKEN`'ı yeterlidir. Repo ve Releases public
kalmalı; kullanıcı uygulamasına GitHub token gömülmez. GitHub hesabında 2FA'yı
açık tut. Linux'ta Windows Authenticode eşdeğeri olmadığı için yayın zincirinin
güveni GitHub hesabı ve Actions yetkilerine dayanır.

Arka plandaki geçici ağ hataları banner açmaz; ayrıntı kullanıcı veri klasöründe
`update.log` dosyasına yazılır (1 MiB'de `update.log.old` olur). `npm start` veya
`npm run app` geliştirme sürümleri kendini güncellemez; git kurulumunda
`git pull` kullanılır.

## Ses/görüntü bağlanmıyor mu?

Mesajlar Hyperswarm üzerinden gider (kendi delik açma + röle altyapısı var),
ama **medya WebRTC ile doğrudan akar**. CGNAT ya da simetrik NAT arkasındaki
farklı ağlardaki iki PC arasında bu doğrudan bağlantı kurulamayabilir —
belirtisi: kamera/ekran yerelde açılır ama karşıya hiç görüntü/ses gitmez,
balonda ⏳/⚠️ işareti kalır, aramada "bağlanıyor…" yazısı geçmez.

**Varsayılan çözüm:** Turkuaz kutudan çıkışta çoklu STUN + ücretsiz bir public
TURN röle ile gelir. TURN yalnızca doğrudan bağlantı kurulamayınca **son çare**
olarak kullanılır (aynı ağdaki peer'lar yine doğrudan bağlanır). Medya DTLS-SRTP
ile uçtan uca şifreli olduğundan röle içeriği göremez.

- Röleyi tamamen kapatmak (yalnızca doğrudan bağlantı): `TURKUAZ_NO_DEFAULT_TURN=1`
- Ücretsiz röle yavaş/kapalıysa ya da kendi TURN'ünü (coturn vb.) kullanmak için
  veri klasörüne `ice.json` koy — varsayılanı geçersiz kılar:

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  { "urls": "turn:turn.ornek.com:3478", "username": "kullanici", "credential": "sifre" }
]
```

Aynı içerik `TURKUAZ_ICE` ortam değişkeniyle de verilebilir.

## Başka PC'ye kurulum

```bash
# Node.js 20+ kurulu olsun, sonra:
git clone https://github.com/demirataalbuz-maker/turkuaz-haberlesme.git
cd turkuaz-haberlesme
npm install
npm start              # tarayıcıdan http://localhost:3210
# masaüstü uygulaması istersen:
npm run dist:linux     # dist/Turkuaz.AppImage üretir
```

İki PC'de de açınca kodlaşıp arkadaş olun; hesabını taşımak istersen
uygulamadaki ⇄ (Hesabı taşı) butonunu kullan.

## Güvenlik notları

- Kimlik = Ed25519 anahtar çifti; arkadaş kodu = public key. Taklit edilemez.
- `identity.json` içindeki `seed` kimliğindir — paylaşma, yedeğini güvenli tut.
- Oda güvenliği = davet kodunun gizliliği. Moderasyon imzaları oda sahibinin
  anahtarıyla doğrulanır; sahte ban listesi yayılamaz.
- Arayüz sadece `127.0.0.1` dinler.

## Sınırlar (bilinçli)

- Herkes offline'ken oda mesajı iletilmez (verecek biri online olmalı).
- Sesli sohbet tam örgü: ana kabul hedefi 5+1; aynı-makine laboratuvar testinde
  10 kişi/45 bağlantı geçti. Farklı ev ağları, TURN ve uzun süreli soak kabulü
  ayrıca yapılmalı.
- Mobil ve kalabalık odalar (SFU) sonraki aşama.
