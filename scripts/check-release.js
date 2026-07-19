// Release başlamadan önce sürüm/tag ve auto-update paket sözleşmesini doğrular.
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const lock = require(path.join(root, 'package-lock.json'))

function fail (message) {
  console.error('RELEASE CHECK FAIL:', message)
  process.exitCode = 1
}

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail('masaüstü stable kanalı için sürüm X.Y.Z biçiminde olmalı: ' + pkg.version)
if (lock.version !== pkg.version || !lock.packages || !lock.packages[''] || lock.packages[''].version !== pkg.version) {
  fail('package.json ve package-lock.json sürümleri aynı değil')
}

const tag = process.env.GITHUB_REF_NAME || process.env.TURKUAZ_RELEASE_TAG || ''
if (tag && tag.startsWith('v') && tag !== 'v' + pkg.version) {
  fail('etiket ' + tag + ', package sürümü ise v' + pkg.version)
}

const build = pkg.build || {}
const targets = (value) => (value && value.target) || []
if (build.appId !== 'dev.turkuaz.app') fail('appId değişmiş; NSIS yükseltme kimliği sabit kalmalı')
if (!targets(build.win).includes('nsis')) fail('Windows NSIS hedefi eksik')
// İmza sertifikamız yok — forceCodeSigning açılırsa release hiç exe üretemiyor (v0.4.4 vakası).
if (build.win && build.win.forceCodeSigning) fail('forceCodeSigning kapalı olmalı: sertifika yok, exe imzasız dağıtılıyor (v0.4.2 gibi)')
if (!targets(build.linux).includes('AppImage')) fail('Linux AppImage hedefi eksik')
if (!build.publish || !build.publish.some(p => p.provider === 'github' && p.owner === 'demirataalbuz-maker' && p.repo === 'turkuaz-haberlesme')) {
  fail('GitHub update provider yapılandırması eksik veya değişmiş')
}
if (!build.nsis || build.nsis.artifactName !== 'Turkuaz-Setup-${version}.${ext}') fail('Windows installer dosya adı sözleşmesi bozuk')
if (!build.linux || build.linux.artifactName !== 'Turkuaz.${ext}') fail('Linux AppImage sabit dosya adı sözleşmesi bozuk')
if (pkg.desktopName !== 'Turkuaz.desktop' || build.linux.syncDesktopName !== true) fail('Linux pencere/.desktop kimliği eşleşmiyor')
if (!build.toolsets || build.toolsets.appimage !== '1.0.3') fail('modern AppImage toolset 1.0.3 etkin değil')

if (!process.exitCode) console.log('PASS: release sürümü ve Windows/Linux updater sözleşmesi')
