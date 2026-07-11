// Bare runtime'ında Turkuaz çekirdeğini ayağa kaldırır (test/bare-smoke.js sürer).
// Mobil backend.mjs'in birebir benzeri — tek fark: BareKit IPC yerine stdin/stdout.
// Kullanım: bare test/bare-entry.mjs <veri-dizini> [bootstrap-port]
import process from 'bare-process'
import Store from '../lib/store.js'
import coremod from '../lib/core.js'

const { createCore } = coremod

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

try {
  const dataDir = process.argv[2]
  const bootPort = Number(process.argv[3]) || 0
  const store = new Store(dataDir)
  const core = createCore({
    store,
    bootstrap: bootPort ? [{ host: '127.0.0.1', port: bootPort }] : undefined,
    iceServers: []
  })
  core.onUI(out)
  let buf = ''
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      core.handleUI(m, out)
    }
  })
  out({ t: 'bare-ready', code: core.myCode, bare: Bare.version })
} catch (e) {
  out({ t: 'bare-error', err: String((e && e.stack) || e) })
}
