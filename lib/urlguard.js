// SSRF koruması — link önizleme (/preview) sunucu tarafından rastgele URL çeker.
// Bu, kullanıcının KENDİ makinesindeki bir işlemdir; koruma olmadan
// http://127.0.0.1:PORT, http://169.254.169.254 (bulut metadata),
// http://192.168.1.1 (router paneli) gibi iç adresler çekilip önizleme kartına
// gömülebilir → iç ağ verisi dışarı sızar. Bu modül çözünen IP'yi özel/loopback
// aralıklarına karşı denetler ve her yönlendirme adımını yeniden doğrular.
//
// Kalan risk (bilinçli): DNS rebinding — doğrulama ile fetch arasında ismin
// başka IP'ye dönmesi. IP sabitleme https SNI/sertifikayı bozacağı için
// yapılmadı; önizleme hedefleri ezici çoğunlukla https.
const net = require('net')
const dns = require('dns').promises

// Bir IP genel internete mi ait, yoksa özel/dahili mi?
function isPrivateIp (ip) {
  ip = String(ip || '').split('%')[0] // IPv6 zone id at
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
    return (
      p[0] === 0 ||                                   // 0.0.0.0/8
      p[0] === 10 ||                                  // 10/8 özel
      p[0] === 127 ||                                 // loopback
      (p[0] === 169 && p[1] === 254) ||               // link-local / bulut metadata
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||   // 172.16/12 özel
      (p[0] === 192 && p[1] === 168) ||               // 192.168/16 özel
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||  // 100.64/10 CGNAT
      p[0] >= 224                                     // multicast + reserved
    )
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    if (l === '::1' || l === '::') return true                 // loopback / unspecified
    if (/^fe[89ab]/.test(l)) return true                       // fe80::/10 link-local
    if (/^f[cd]/.test(l)) return true                          // fc00::/7 ULA
    if (/^ff/.test(l)) return true                             // ff00::/8 multicast
    const m = l.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/) // v4-mapped/compat
    if (m) return isPrivateIp(m[1])
    return false
  }
  return true // tanınmayan biçim → güvensiz say
}

// URL'in host'u genel internete mi çözünüyor? Değilse fırlatır.
async function assertPublicUrl (u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('şema http(s) değil')
  const host = u.hostname.replace(/^\[|\]$/g, '') // IPv6 köşeli parantezini soy
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('özel/loopback IP engellendi: ' + host)
    return
  }
  const addrs = await dns.lookup(host, { all: true })
  if (!addrs || !addrs.length) throw new Error('DNS çözünmedi: ' + host)
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('host özel IP\'ye çözünüyor: ' + host)
}

// Yönlendirmeleri ELDE takip eder; her adımın host'unu genel-IP denetiminden
// geçirir. Böylece genel bir URL iç ağa yönlendirse bile engellenir.
async function safeFetch (urlString, opts = {}, maxHops = 5) {
  if (typeof fetch !== 'function') throw new Error('fetch yok')
  let current = new URL(urlString)
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(current)
    const res = await fetch(current, { ...opts, redirect: 'manual' })
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location')
    if (loc) {
      try { await (res.body && res.body.cancel && res.body.cancel()) } catch {}
      current = new URL(loc, current)
      continue
    }
    return { res, url: res.url || String(current) }
  }
  throw new Error('çok fazla yönlendirme')
}

module.exports = { isPrivateIp, assertPublicUrl, safeFetch }
