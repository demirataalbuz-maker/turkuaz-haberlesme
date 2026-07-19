const assert = require('assert')
const { EventEmitter } = require('events')
const { createDesktopUpdater } = require('../lib/desktop-updater')

class FakeUpdater extends EventEmitter {
  constructor () {
    super()
    this.checks = 0
    this.installs = []
  }

  async checkForUpdates () { this.checks++ }
  quitAndInstall (...args) { this.installs.push(args) }
}

function fakeTimers () {
  const handles = []
  const make = (fn) => {
    const h = { fn, unref () {} }
    handles.push(h)
    return h
  }
  return {
    handles,
    api: {
      setTimeout: make,
      setInterval: make,
      clearTimeout () {},
      clearInterval () {}
    }
  }
}

async function main () {
  const fake = new FakeUpdater()
  const timer = fakeTimers()
  const states = []
  const notices = []
  const updater = createDesktopUpdater({
    autoUpdater: fake,
    currentVersion: '1.0.0',
    publish: s => states.push(s),
    notify: s => notices.push(s),
    logger: { info () {}, error () {} },
    timers: timer.api
  })

  assert.strictEqual(updater.install(), false, 'hazır olmayan güncelleme kurulmamalı')
  updater.start()
  assert.strictEqual(fake.autoDownload, true)
  assert.strictEqual(fake.autoInstallOnAppQuit, true)
  assert.strictEqual(fake.autoRunAppAfterInstall, true)
  assert.strictEqual(fake.allowPrerelease, false)
  assert.strictEqual(fake.allowDowngrade, false)
  assert.strictEqual(fake.disableWebInstaller, true)
  assert.strictEqual(timer.handles.length, 2, 'ilk kontrol + periyodik kontrol zamanlanmalı')

  await updater.check(true)
  assert.strictEqual(fake.checks, 1)
  assert.strictEqual(updater.getState().status, 'checking')
  assert.strictEqual(updater.getState().manual, true)
  fake.emit('update-not-available', { version: '1.0.0' })
  assert.strictEqual(updater.getState().status, 'up-to-date')

  // Geçici "güncelsin" bildirimini kapatan zamanlayıcıyı çalıştır.
  timer.handles.at(-1).fn()
  assert.strictEqual(updater.getState().status, 'idle')

  await updater.check(false)
  fake.emit('update-available', { version: '1.1.0' })
  assert.strictEqual(updater.getState().status, 'downloading')
  assert.strictEqual(updater.getState().version, '1.1.0')
  fake.emit('download-progress', { percent: 47.25, transferred: 47, total: 100, bytesPerSecond: 12 })
  assert.strictEqual(updater.getState().percent, 47.25)
  fake.emit('update-downloaded', { version: '1.1.0' })
  assert.strictEqual(updater.getState().status, 'ready')
  assert.strictEqual(notices.length, 1)
  assert.strictEqual(updater.install(), true)
  assert.deepStrictEqual(fake.installs, [[true, true]])
  assert.strictEqual(updater.install(), false, 'aynı güncelleme iki kez kurulmamalı')

  // Otomatik kontroldeki ağ hatası kullanıcıyı banner ile rahatsız etmez.
  const fake2 = new FakeUpdater()
  const updater2 = createDesktopUpdater({
    autoUpdater: fake2,
    currentVersion: '1.0.0',
    logger: { info () {}, error () {} },
    timers: fakeTimers().api
  })
  updater2.start()
  await updater2.check(false)
  fake2.emit('error', new Error('çevrimdışı'))
  assert.strictEqual(updater2.getState().status, 'idle')
  await updater2.check(true)
  fake2.emit('error', new Error('sunucu yok'))
  assert.strictEqual(updater2.getState().status, 'error')
  assert.match(updater2.getState().error, /sunucu yok/)

  updater.stop()
  updater2.stop()
  assert.ok(states.some(s => s.status === 'downloading'))
  assert.ok(states.some(s => s.status === 'ready'))
  console.log('PASS: masaüstü otomatik güncelleme durum makinesi')
}

main().catch((err) => { console.error(err); process.exit(1) })
