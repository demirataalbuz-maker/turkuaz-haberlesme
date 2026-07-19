// electron-builder çıktılarının manifest, sürüm, boyut ve SHA-512 tutarlılığını
// CI'da yayın taslağı kullanıcıya açılmadan önce doğrular.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const yaml = require('js-yaml')

const root = path.join(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))

function die (message) { throw new Error('UPDATE ARTIFACT FAIL: ' + message) }
function sha512 (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    fs.createReadStream(file).on('error', reject).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('base64')))
  })
}

async function verifyArtifacts (platform, { artifactDir = path.join(root, 'dist'), version = pkg.version, quiet = false } = {}) {
  if (!['linux', 'windows'].includes(platform)) die('platform linux veya windows olmalı')
  const manifestName = platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'
  const expectedArtifact = platform === 'linux' ? 'Turkuaz.AppImage' : 'Turkuaz-Setup-' + version + '.exe'
  const manifestPath = path.join(artifactDir, manifestName)
  const artifactPath = path.join(artifactDir, expectedArtifact)
  if (!fs.existsSync(manifestPath)) die(manifestName + ' yok')
  if (!fs.existsSync(artifactPath)) die(expectedArtifact + ' yok')
  if (platform === 'windows' && !fs.existsSync(artifactPath + '.blockmap')) die(expectedArtifact + '.blockmap yok')

  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest || typeof manifest !== 'object') die(manifestName + ' geçerli YAML nesnesi değil')
  if (manifest.version !== version) die(manifestName + ' sürümü package.json ile aynı değil')
  if (manifest.path !== expectedArtifact) die(manifestName + ' path alanı beklenen paketi göstermiyor')
  if (!Array.isArray(manifest.files)) die(manifestName + ' files listesi yok')
  const entry = manifest.files.find(file => file && file.url === expectedArtifact)
  if (!entry) die('files[] beklenen paketi göstermiyor: ' + expectedArtifact)
  const actualSize = fs.statSync(artifactPath).size
  if (!Number(entry.size) || Number(entry.size) !== actualSize) die('files[] boyutu gerçek paketle aynı değil')
  const actualHash = await sha512(artifactPath)
  if (!entry.sha512 || entry.sha512 !== actualHash) die('files[] SHA-512 değeri gerçek paketle aynı değil')
  if (!manifest.sha512 || manifest.sha512 !== actualHash) die('üst seviye SHA-512 değeri gerçek paketle aynı değil')
  if (platform === 'linux' && (!Number(entry.blockMapSize) || Number(entry.blockMapSize) <= 0)) {
    die('AppImage gömülü block map boyutu yok')
  }
  if (platform === 'windows' && fs.statSync(artifactPath + '.blockmap').size < 100) die('Windows blockmap boş veya geçersiz')
  if (!quiet) console.log('PASS:', platform, 'güncelleme artifact sözleşmesi', version)
  return { manifest, entry, artifactPath, actualHash }
}

if (require.main === module) {
  verifyArtifacts(process.argv[2]).catch((err) => { console.error(err.message || err); process.exit(1) })
}

module.exports = { verifyArtifacts }
