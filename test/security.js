// Güvenlik regresyon testleri — ağsız, deterministik.
// SSRF IP sınıflandırıcısı + assertPublicUrl (loopback/iç ağ reddi).
// Bu testler geçmezse /preview yeniden SSRF'e açılmış demektir.
const assert = require('assert')
const { isPrivateIp, assertPublicUrl } = require('../lib/urlguard')

async function main () {
  // ---- özel/dahili sayılması GEREKENLER ----
  const priv = [
    '127.0.0.1', '10.0.0.1', '10.255.255.255', '192.168.1.1', '172.16.0.1',
    '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3'
  ]
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, 'özel sayılmalı: ' + ip)

  // ---- genel internet sayılması GEREKENLER ----
  const pub = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '11.0.0.1',
    '172.15.0.1', '172.32.0.1', '192.167.1.1', '2606:4700:4700::1111'
  ]
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, 'genel sayılmalı: ' + ip)

  // ---- assertPublicUrl: IP literalleri (DNS gerektirmez) ----
  for (const bad of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.0.1/', 'https://10.0.0.5/', 'ftp://8.8.8.8/']) {
    await assert.rejects(() => assertPublicUrl(new URL(bad)), 'reddedilmeli: ' + bad)
  }
  for (const ok of ['http://8.8.8.8/x', 'https://1.1.1.1/']) {
    await assert.doesNotReject(() => assertPublicUrl(new URL(ok)), 'kabul edilmeli: ' + ok)
  }

  console.log('PASS: güvenlik — SSRF IP sınıflandırıcı + assertPublicUrl (loopback/iç ağ reddi)')
  process.exit(0)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
