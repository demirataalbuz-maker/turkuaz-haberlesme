# DeepFilterNet3 streaming model — üretim kaydı

- Kaynak checkpoint: Rikorose/DeepFilterNet v0.5.6 resmi DeepFilterNet3 (model_120.ckpt.best)
- Export kodu: grazder/DeepFilterNet, branch torchDF-changes, commit 1097015 (MIT)
- Komut: model_onnx_export.py --test --performance --ort
- Ortam: Python 3.11.9, torch 2.1.0+cpu, onnxruntime 1.27.0, opset 17 (2026-07-20)
- Arayüz: input_frame[480] f32 + states[45304] f32 + atten_lim_db[] f32
          -> enhanced_audio_frame[480] + out_states[45304] + lsnr[1]
- Doğrulama (7800X3D, tek thread): kare başına ort. 1.54 ms / p95 1.62 / max 2.40
  (bütçe 10 ms, RTF 0.154); sokak gürültülü örnekte RMS 0.1014 -> 0.0797
