// Disk kasası: veriler diskte şifreli dursun (fiziksel erişime karşı koruma).
//  - Anahtar türetme: Argon2id (libsodium crypto_pwhash) — parola kaba
//    kuvvetle denenemesin diye bellek-sert KDF.
//  - Şifreleme: XSalsa20-Poly1305 (crypto_secretbox) — bütünlük dahil (AEAD);
//    diskte bit oynatılırsa açılış sessizce bozuk veri değil, hata üretir.
//  - vault.json parola İÇERMEZ: yalnızca tuz + doğrulama kutusu tutar.
// sodium-universal: masaüstünde (Node/Electron) ve telefonda (Bare) aynı API.
const fs = require('fs')
const path = require('path')
const sodium = require('sodium-universal')

const MAGIC = Buffer.from('TKV1')            // ikili dosya başlığı (blob/json)
const LINE_PREFIX = 'tkv1.'                  // JSONL satır başlığı (base64)
const CHECK_TEXT = Buffer.from('turkuaz-vault-ok')

function vaultFile (dir) { return path.join(dir, 'vault.json') }
function hasVault (dir) { return fs.existsSync(vaultFile(dir)) }

function deriveKey (pass, salt, ops, mem) {
  const key = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_pwhash(
    key, Buffer.from(String(pass), 'utf8'), salt,
    ops, mem, sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  return key
}

function encBuf (key, plain) {
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const cipher = Buffer.alloc(plain.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cipher, plain, nonce, key)
  return Buffer.concat([MAGIC, nonce, cipher])
}

function isEnc (buf) {
  return Buffer.isBuffer(buf) && buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

function decBuf (key, buf) {
  if (!isEnc(buf)) return null
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + sodium.crypto_secretbox_NONCEBYTES)
  const cipher = buf.subarray(MAGIC.length + sodium.crypto_secretbox_NONCEBYTES)
  if (cipher.length < sodium.crypto_secretbox_MACBYTES) return null
  const plain = Buffer.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(plain, cipher, nonce, key)) return null
  return plain
}

// JSONL satırları için: "tkv1.<base64(nonce+cipher)>"
function encLine (key, str) {
  return LINE_PREFIX + encBuf(key, Buffer.from(str, 'utf8')).subarray(MAGIC.length).toString('base64')
}
function isEncLine (line) { return typeof line === 'string' && line.startsWith(LINE_PREFIX) }
function decLine (key, line) {
  if (!isEncLine(line)) return null
  let raw
  try { raw = Buffer.from(line.slice(LINE_PREFIX.length), 'base64') } catch { return null }
  const plain = decBuf(key, Buffer.concat([MAGIC, raw]))
  return plain ? plain.toString('utf8') : null
}

// Yeni kasa kur: tuz üret, anahtarı türet, doğrulama kutusunu yaz.
function createVault (dir, pass) {
  const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  const ops = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
  const mem = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  const key = deriveKey(pass, salt, ops, mem)
  const meta = {
    v: 1,
    alg: 'argon2id13+xsalsa20poly1305',
    ops,
    mem,
    salt: salt.toString('hex'),
    check: encBuf(key, CHECK_TEXT).toString('hex')
  }
  const tmp = vaultFile(dir) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
  fs.renameSync(tmp, vaultFile(dir))
  return key
}

// Var olan kasayı parola ile aç: doğruysa anahtar, yanlışsa null.
function openVault (dir, pass) {
  let meta
  try { meta = JSON.parse(fs.readFileSync(vaultFile(dir), 'utf8')) } catch { return null }
  try {
    const key = deriveKey(pass, Buffer.from(meta.salt, 'hex'), meta.ops, meta.mem)
    const ok = decBuf(key, Buffer.from(meta.check, 'hex'))
    return (ok && ok.equals(CHECK_TEXT)) ? key : null
  } catch { return null }
}

function removeVault (dir) {
  try { fs.unlinkSync(vaultFile(dir)) } catch {}
}

module.exports = { hasVault, createVault, openVault, removeVault, encBuf, decBuf, isEnc, encLine, decLine, isEncLine }
