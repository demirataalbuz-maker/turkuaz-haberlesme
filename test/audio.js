// Ses zinciri karar mantığı testleri. voice.js bir tarayıcı dosyası (require
// edilemez), bu yüzden test edilecek saf fonksiyonlar GERÇEK kaynaktan
// çekilip vm içinde çalıştırılır — formülü teste kopyalamak yerine.
//
// Kapsanan regresyonlar:
//  1) Klasik mod gürültü engellemeyi de kapatmıştı. Oysa sesi ezen katman
//     SEVİYE ZİNCİRİ (filtre+kompresör+makeup+limiter+kapı); gürültü engelleme
//     (RNNoise/DFN) kullanıcının sevdiği ve korunması gereken parçaydı.
//     Klasik mod artık yalnız zinciri atlar, gürültü engellemeye dokunmaz.
//  2) Gürültü kapısının eşiği koda gömülüydü (tepe > 7/128) ve ayarlardaki
//     hassasiyet kaydırıcısı kapıyı değil "sesle konuş" modunu etkiliyordu →
//     alçak sesli konuşan kesiliyor, düzeltemiyordu.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'voice.js'), 'utf8')

let fails = 0
function check (name, fn) {
  try { fn(); console.log('PASS: ' + name) } catch (e) { console.log('FAIL: ' + name + ' — ' + e.message); fails++ }
}

// Kaynaktan bir fonksiyon bildirimini süslü parantez eşleyerek çıkar.
function extractFn (src, name) {
  const start = src.indexOf('function ' + name + ' (')
  if (start < 0) throw new Error('fonksiyon bulunamadı: ' + name)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('kapanış bulunamadı: ' + name)
}

const NEEDED = ['isClassicAudio', 'micConstraints', 'gateSens', 'rmsThreshold',
  'vadProbThreshold', 'gateHold', 'monitorGain', 'applyMonitor']

// Verilen ayarlarla bir sandbox kur
function load (settings) {
  const ctx = vm.createContext({ console })
  vm.runInContext('function _settings () { return ' + JSON.stringify(settings || {}) + ' }', ctx)
  for (const n of NEEDED) vm.runInContext(extractFn(SRC, n), ctx)
  return ctx
}
const call = (ctx, expr) => vm.runInContext(expr, ctx)

// ---- 1) mod seçimi ----
check('varsayılan klasik moddur', () => {
  assert.strictEqual(call(load({}), 'isClassicAudio()'), true)
  assert.strictEqual(call(load({ audioMode: 'classic' }), 'isClassicAudio()'), true)
  assert.strictEqual(call(load({ audioMode: 'advanced' }), 'isClassicAudio()'), false)
})

// ---- 2) klasik mod gürültü engellemeye DOKUNMAZ ----
// Klasik mod gürültü engellemeyi KAPATMAZ; yalnız seviye zincirini atlar.
// 'strong'/'dfn' seçiliyken işi RNNoise/DFN yapar → tarayıcı NS kapalı olmalı
// (çift işleme sesi boğardı). 'standard' seçiliyken tarayıcı NS açık kalır.
check('klasik: gürültü engelleme seçimi aynen geçerli', () => {
  const std = call(load({ audioMode: 'classic', noise: 'standard' }), 'micConstraints(false)')
  assert.strictEqual(std.audio.noiseSuppression, true, 'standard → tarayıcı NS açık')
  for (const noise of ['strong', 'dfn']) {
    const c = call(load({ audioMode: 'classic', noise }), 'micConstraints(false)')
    assert.strictEqual(c.audio.noiseSuppression, false, noise + ' → işi AI yapar, tarayıcı NS kapalı')
  }
})
check('klasik: dengeleme ayarı AGC\'yi kapatmaz (kendi limiter\'ımız yok)', () => {
  const c = call(load({ audioMode: 'classic', micLimiter: 'strong' }), 'micConstraints(false)')
  assert.strictEqual(c.audio.autoGainControl, true)
  assert.strictEqual(c.audio.echoCancellation, true)
})
check('klasik: stüdyo modu yankı+AGC kapatır (kulaklık senaryosu korunur)', () => {
  const c = call(load({ audioMode: 'classic', micHQ: true, noise: 'standard' }), 'micConstraints(false)')
  assert.strictEqual(c.audio.echoCancellation, false)
  assert.strictEqual(c.audio.autoGainControl, false)
  assert.strictEqual(c.audio.noiseSuppression, true)
})
check('klasik: seçili mikrofon korunur', () => {
  const c = call(load({ audioMode: 'classic', micId: 'MIC-7' }), 'micConstraints(false)')
  // Not: nesne vm realm'inden geldiği için prototip kimliği farklı → alan karşılaştır
  assert.strictEqual(c.audio.deviceId.exact, 'MIC-7')
})

// ---- 3) gelişmiş mod eski davranışını korur ----
check('gelişmiş: dfn modunda tarayıcı NS kapalı (işi RNNoise/DFN yapar)', () => {
  const c = call(load({ audioMode: 'advanced', noise: 'dfn' }), 'micConstraints(false)')
  assert.strictEqual(c.audio.noiseSuppression, false)
})
check('gelişmiş: limiter açıkken tarayıcı AGC kapalı (çift işleme olmasın)', () => {
  const c = call(load({ audioMode: 'advanced', micLimiter: 'normal' }), 'micConstraints(false)')
  assert.strictEqual(c.audio.autoGainControl, false)
})

// ---- 4) kapı hassasiyeti gerçekten ayarlanabilir ----
check('gateSens sınırlanır ve varsayılanı 50', () => {
  const c = load({})
  assert.strictEqual(call(c, 'gateSens()'), 50)
  assert.strictEqual(call(load({ gateSens: -20 }), 'gateSens()'), 0)
  assert.strictEqual(call(load({ gateSens: 500 }), 'gateSens()'), 100)
})
check('hassasiyet arttıkça eşik düşer (daha çok ses geçer)', () => {
  const c = load({})
  const lo = call(c, 'rmsThreshold(0)')
  const mid = call(c, 'rmsThreshold(50)')
  const hi = call(c, 'rmsThreshold(100)')
  assert.ok(lo > mid && mid > hi, 'eşik monoton azalmalı')
  assert.ok(hi > 0, 'eşik pozitif kalmalı (sessizlik kapıyı açmasın)')
})
// Asıl şikayetin kilidi: varsayılan ayar ESKİ gömülü eşikten müsamahalı olmalı.
// Eski kod tepe genliğine bakıyordu: 7/128 ≈ 0.0547 tepe. Konuşmada tepe/RMS
// oranı ~3 olduğundan bu ≈ 0.018 RMS'e denk gelir.
check('varsayılan eşik eski gömülü eşikten müsamahalı', () => {
  const eskiRmsKarsiligi = (7 / 128) / 3
  const yeni = call(load({}), 'rmsThreshold(50)')
  assert.ok(yeni < eskiRmsKarsiligi, 'varsayılan daha çok ses geçirmeli (' + yeni + ' < ' + eskiRmsKarsiligi + ')')
})
check('en sıkı uçta bile eski davranıştan katı değil', () => {
  const eskiRmsKarsiligi = (7 / 128) / 3
  const enSiki = call(load({}), 'rmsThreshold(0)')
  assert.ok(enSiki <= eskiRmsKarsiligi * 1.05, 'sıkı uç eskisi civarında kalmalı')
})
check('hassasiyet arttıkça kapı daha uzun açık kalır', () => {
  const c = load({})
  assert.ok(call(c, 'gateHold(100)') > call(c, 'gateHold(0)'))
  assert.ok(call(c, 'gateHold(0)') >= 180, 'cümle içi duraklama için taban tutulmalı')
})
check('VAD eşiği sınırlar içinde ve hassasiyetle düşer', () => {
  const c = load({})
  const lo = call(c, 'vadProbThreshold(0)')
  const hi = call(c, 'vadProbThreshold(100)')
  assert.ok(lo > hi)
  assert.ok(hi >= 0.15 && lo <= 0.85, 'olasılık eşiği makul aralıkta kalmalı')
})

// ---- 5) kendini dinleme ----
check('monitor kapalıyken kazanç sıfır', () => {
  assert.strictEqual(call(load({ monitor: false, monitorVol: 80 }), 'monitorGain()'), 0)
})
check('monitor açıkken seviye ölçeklenir ve sınırlanır', () => {
  assert.ok(Math.abs(call(load({ monitor: true, monitorVol: 60 }), 'monitorGain()') - 0.6) < 1e-9)
  assert.strictEqual(call(load({ monitor: true, monitorVol: 999 }), 'monitorGain()'), 1)
  assert.strictEqual(call(load({ monitor: true, monitorVol: -5 }), 'monitorGain()'), 0)
})

// Susturunca kendini duymamalı: monitör tapı gönderilen track'ten ÖNCE olduğu
// için track'i kapatmak monitörü susturmuyordu.
function fakeObj (extra) {
  const o = { ctx: { currentTime: 0 }, _monitorGain: { gain: { value: null, setTargetAtTime (v) { this.value = v } } } }
  return Object.assign(o, extra)
}
check('susturulmuşken monitör susar', () => {
  const c = load({ monitor: true, monitorVol: 70 })
  const o = fakeObj({ muted: true })
  call(c, 'applyMonitor')(o)
  assert.strictEqual(o._monitorGain.gain.value, 0)
})
check('arama tarafında da (mutedFlag) monitör susar', () => {
  const c = load({ monitor: true, monitorVol: 70 })
  const o = fakeObj({ mutedFlag: true })
  call(c, 'applyMonitor')(o)
  assert.strictEqual(o._monitorGain.gain.value, 0)
})
check('kapı kapalıyken (PTT/VAD) monitör susar', () => {
  const c = load({ monitor: true, monitorVol: 70 })
  const o = fakeObj({ _gateOpen: false })
  call(c, 'applyMonitor')(o)
  assert.strictEqual(o._monitorGain.gain.value, 0)
})
check('konuşurken monitör ayarlanan seviyede', () => {
  const c = load({ monitor: true, monitorVol: 70 })
  const o = fakeObj({ muted: false, _gateOpen: true })
  call(c, 'applyMonitor')(o)
  assert.ok(Math.abs(o._monitorGain.gain.value - 0.7) < 1e-9)
})
check('monitör düğümü yoksa patlamaz', () => {
  const c = load({ monitor: true })
  call(c, 'applyMonitor')({})
  call(c, 'applyMonitor')(null)
})

console.log(fails ? ('SONUÇ: ' + fails + ' FAIL') : 'PASS: ses zinciri — klasik mod, kapı hassasiyeti, kendini dinleme')
process.exit(fails ? 1 : 0)
