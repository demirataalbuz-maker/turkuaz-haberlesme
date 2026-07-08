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
  konuşma göstergesi, DM'den **birebir arama** (zil, kabul/red)
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
dist/Turkuaz-*.AppImage        # ya da masaüstündeki Turkuaz kısayolu

# geliştirme
npm start                      # tarayıcıdan http://localhost:3210
npm run app                    # electron penceresi
npm run dist                   # AppImage üret
npm test                       # 14 aşamalı uçtan uca test (3 sanal kullanıcı)
npm run test:av                # ses/görüntü testi: 2 Electron, sahte kamera,
                               # kamera + ekran paylaşımı + DM araması + pano
```

Ortam değişkenleri: `PORT` (3210), `TURKUAZ_DATA` (veri klasörü),
`TURKUAZ_BOOTSTRAP` (test için yerel DHT, örn `127.0.0.1:49737`),
`TURKUAZ_ICE` (özel ICE sunucuları, aşağıya bak),
`TURKUAZ_UPDATE_URL` (özel güncelleme feed'i, aşağıya bak).

## İndir (Windows / Linux)

Hazır paketler [Releases](https://github.com/demirataalbuz-maker/turkuaz-haberlesme/releases)
sayfasında:
- **Windows:** `Turkuaz-Setup-X.Y.Z.exe` — indir, çalıştır, kurulur.
- **Linux:** `Turkuaz-X.Y.Z.AppImage` — indir, çalıştırılabilir yap (`chmod +x`), aç.

Her iki paket de kendini otomatik günceller (aşağıya bak).

## Otomatik güncelleme

Paketli uygulama (Windows `.exe` / Linux AppImage) kendini günceller: açılışta
(15 sn sonra) ve 4 saatte bir GitHub Releases'e bakar, yeni sürüm varsa arka
planda indirir (sha512 doğrulamalı), bildirim gösterir ve **uygulama kapanırken
kurar**. Tepsi menüsünden "güncellemesini kur" ile hemen de kurulabilir.
Linux'ta AppImage'ı sabit bir yola koy (örn `~/Uygulamalar/Turkuaz.AppImage`) —
güncelleme dosyayı yerinde değiştirir, kısayolun hep geçerli kalır. (Windows
kurulumu zaten sabit klasöre gelir.)

Yeni sürüm yayınlamak (repo sahibi) — **Windows + Linux birlikte, GitHub Actions ile:**

```bash
npm version patch        # sürümü yükseltir (X.Y.Z) + git tag oluşturur (vX.Y.Z)
git push --follow-tags   # tag'i push'la → .github/workflows/release.yml tetiklenir
```

Actions bulutta Windows'ta `.exe`, Linux'ta AppImage derler ve ikisini de
GitHub Release'e (taslak) yükler. Actions bitince release'i **"Publish"** et —
oto-update tüm kurulumlara (her iki platform) dağıtır. Ekstra token gerekmez,
Actions'ın kendi `GITHUB_TOKEN`'ı yeter.

Tek platform elle derlemek istersen: `GH_TOKEN=<token> npm run release`
(çalıştığın OS'un hedefini derler), ya da yayınlamadan `npm run dist`.

Kendi feed'ini kullanmak istersen `TURKUAZ_UPDATE_URL=https://ornek.com/feed`
ver — o adreste `latest-linux.yml` + AppImage duran herhangi bir statik sunucu
yeterli. Not: güncelleme kanalı = uzaktan kod çalıştırma yetkisi; güven zinciri
GitHub hesabına dayanır, hesabında 2FA açık olsun. `npm start` (git) kurulumları
kendini güncellemez — `git pull` yeterli.

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
npm run dist           # dist/Turkuaz-*.AppImage üretir
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
- Sesli sohbet tam örgü: 2-8 kişilik gruplar için ideal.
- Mobil ve kalabalık odalar (SFU) sonraki aşama.
