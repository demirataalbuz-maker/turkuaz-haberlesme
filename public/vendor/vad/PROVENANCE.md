# Silero VAD (v5) — konuşma etkinliği modeli, üretim kaydı

- Kaynak: snakers4/silero-vad (MIT), src/silero_vad/data/silero_vad.onnx
  (GitHub raw, master), indirme 2026-07-21, boyut 2.327.524 bayt
- Amaç: "akıllı noise gate" — amplitüd eşiği yerine GERÇEK konuşma tespiti.
  Yüksek ama konuşma-olmayan sesleri (mekanik klavye, fan, çarpma) kesmeye yarar.
- Arayüz (onnxruntime ile doğrulandı): input[1,512] f32 + state[2,1,128] f32 +
  sr[] int64 (=16000)  ->  output[1,1] (konuşma olasılığı 0..1) + stateN[2,1,128]
- Çalıştırma: 512 örneklik (32 ms) kareler, 16 kHz mono. onnxruntime-web (wasm),
  tamamen yerel, CDN yok. Ses YOLUNDA DEĞİL — yalnız gate kararı için analiz.
- Kullanım: OPT-IN + deneysel. Yüklenemez/hata verirse amplitüd gate'e güvenli
  düşülür (mevcut davranış hiç bozulmaz).
