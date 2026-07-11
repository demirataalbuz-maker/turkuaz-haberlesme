// Bare backend'ini mobil bundle'a paketler ve RN'in sorunsuz gömebilmesi için
// base64 string modülüne sarar (metro asset oyunlarına gerek kalmaz):
//   node scripts/pack-backend.js
// Çıktılar: app/backend.bundle.mjs (bare-pack) + app/backend.bundle.js (base64 modül)
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, 'app', 'backend.bundle.mjs')
fs.mkdirSync(path.join(ROOT, 'app'), { recursive: true })

execFileSync('npx', [
  'bare-pack',
  '--target', 'android-arm64', '--target', 'android-arm',
  '--linked',
  '--out', out,
  path.join(ROOT, 'backend', 'backend.mjs')
], { cwd: ROOT, stdio: 'inherit' })

const b64 = fs.readFileSync(out).toString('base64')
fs.writeFileSync(
  path.join(ROOT, 'app', 'backend.bundle.js'),
  '// OTOMATİK ÜRETİLDİ (scripts/pack-backend.js) — elle düzenleme\n' +
  'module.exports = ' + JSON.stringify(b64) + '\n'
)
console.log('tamam: app/backend.bundle.js (' + Math.round(b64.length / 1024) + ' KB base64)')
