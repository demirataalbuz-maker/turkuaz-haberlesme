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
```

Ortam değişkenleri: `PORT` (3210), `TURKUAZ_DATA` (veri klasörü),
`TURKUAZ_BOOTSTRAP` (test için yerel DHT, örn `127.0.0.1:49737`).

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
