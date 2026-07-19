const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')
const { verifyArtifacts } = require('../scripts/verify-update-artifacts')

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turkuaz-update-artifacts-'))
  try {
    const artifact = Buffer.alloc(2048, 42)
    const hash = crypto.createHash('sha512').update(artifact).digest('base64')
    fs.writeFileSync(path.join(dir, 'Turkuaz.AppImage'), artifact)
    const manifest = {
      version: '9.8.7',
      files: [{ url: 'Turkuaz.AppImage', sha512: hash, size: artifact.length, blockMapSize: 128 }],
      path: 'Turkuaz.AppImage',
      sha512: hash
    }
    const manifestPath = path.join(dir, 'latest-linux.yml')
    fs.writeFileSync(manifestPath, yaml.dump(manifest))
    await verifyArtifacts('linux', { artifactDir: dir, version: '9.8.7', quiet: true })

    manifest.files[0].sha512 = 'bozuk-nested-hash'
    fs.writeFileSync(manifestPath, yaml.dump(manifest))
    await assert.rejects(
      verifyArtifacts('linux', { artifactDir: dir, version: '9.8.7', quiet: true }),
      /files\[\] SHA-512/
    )
    console.log('PASS: updater manifestinin files[] zinciri doğrulanıyor')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
