// Turkuaz masaüstü uygulaması: server.js'i aynı süreçte başlatır ve
// arayüzü bir pencerede açar. Pencere kapatılınca tepsiye küçülür,
// mesajlar gelmeye devam eder.
const { app, BrowserWindow, session, Tray, Menu, desktopCapturer, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')

const PORT = parseInt(process.env.PORT || '3210', 10)
process.env.PORT = String(PORT)
if (!process.env.TURKUAZ_DATA && !process.env.PEERCORD_DATA) {
  process.env.TURKUAZ_DATA = path.join(app.getPath('userData'), 'data')
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.env.PEERCORD_FAKE_MEDIA || process.env.TURKUAZ_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function portInUse (port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

let win = null
let tray = null
let quitting = false
let updateReady = null // indirilen sürüm no'su (tepsi menüsünde gösterilir)

function trayMenu () {
  const items = [
    { label: 'Turkuaz\'ı Göster', click: () => { win.show(); win.focus() } }
  ]
  if (updateReady) {
    items.push(
      { type: 'separator' },
      {
        label: 'v' + updateReady + ' güncellemesini kur (yeniden başlar)',
        click: () => { require('electron-updater').autoUpdater.quitAndInstall() }
      }
    )
  }
  items.push(
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit() } }
  )
  return Menu.buildFromTemplate(items)
}

// Otomatik güncelleme: yalnızca AppImage olarak paketliyken çalışır.
// Feed = GitHub Releases (latest-linux.yml + AppImage); TURKUAZ_UPDATE_URL
// ile kendi feed'ine yönlendirebilirsin. İndirilen dosya sha512 ile doğrulanır,
// kurulum uygulama kapanırken yapılır (autoInstallOnAppQuit).
function setupAutoUpdate () {
  if (!app.isPackaged || !process.env.APPIMAGE) return
  let autoUpdater
  try { ({ autoUpdater } = require('electron-updater')) } catch { return }
  const testMode = !!process.env.TURKUAZ_UPDATE_TEST
  if (process.env.TURKUAZ_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.TURKUAZ_UPDATE_URL })
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version
    console.log('güncelleme indirildi: v' + info.version)
    if (tray) { tray.setContextMenu(trayMenu()); tray.setToolTip('Turkuaz — v' + info.version + ' güncellemesi hazır') }
    if (testMode) { autoUpdater.quitAndInstall() ; return }
    try {
      new Notification({
        title: 'Turkuaz güncellemesi hazır',
        body: 'v' + info.version + ' indirildi — uygulamayı kapatınca kurulur. Tepsiden hemen de kurabilirsin.'
      }).show()
    } catch {}
  })
  autoUpdater.on('error', (e) => { if (testMode) console.log('güncelleme hatası:', String(e)) }) // çevrimdışı vs. — sessiz geç
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, testMode ? 2000 : 15000)       // açılışta ağı hemen yorma
  setInterval(check, 4 * 60 * 60 * 1000)           // sonra 4 saatte bir
}

async function start () {
  await app.whenReady()

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    // clipboard-sanitized-write olmadan navigator.clipboard.writeText reddedilir
    cb(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write'].includes(permission))
  })
  // Ekran paylaşımında birincil ekranı ver (kendi seçim arayüzümüz yok)
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => cb(sources.length ? { video: sources[0] } : {}))
      .catch(() => cb({}))
  })

  if (await portInUse(PORT)) {
    console.log('Port ' + PORT + ' dolu — zaten çalışan Turkuaz\'a bağlanılıyor')
  } else {
    require('./server')
    await sleep(400)
  }

  const iconPath = path.join(__dirname, 'build', 'icon.png')
  win = new BrowserWindow({
    width: 1300,
    height: 850,
    backgroundColor: '#10201e',
    title: 'Turkuaz',
    autoHideMenuBar: true,
    icon: iconPath
  })
  win.loadURL('http://127.0.0.1:' + PORT)

  // kapat → tepsiye küçül
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })

  try {
    tray = new Tray(iconPath)
    tray.setToolTip('Turkuaz — çalışıyor')
    tray.setContextMenu(trayMenu())
    tray.on('click', () => { win.show(); win.focus() })
  } catch {}

  setupAutoUpdate()

  // Otomatik test kancası: ilk odaya girip sesli sohbete katılır,
  // WebRTC bağlantı durumunu rapor dosyasına yazar ve çıkar.
  if (process.env.PEERCORD_AUTOTEST) {
    const snapshot = () => win.webContents.executeJavaScript(`
      JSON.stringify({
        inVoice: !!Voice.room,
        members: [...Voice.members.values()].map(m => ({
          code: m.code.slice(0, 8),
          conn: m.pc.connectionState,
          audioTracks: Object.values(m.streams).reduce((s, x) => s + x.getAudioTracks().length, 0)
        }))
      })
    `)
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(3000)
        await win.webContents.executeJavaScript(`
          (async () => { openRoom(state.rooms[0]); await Voice.join(); return true })()
        `)
        let last = null
        for (let i = 0; i < 40; i++) {
          await sleep(1000)
          last = await snapshot()
          if (JSON.parse(last).members.some(m => m.conn === 'connected' && m.audioTracks > 0)) break
        }
        fs.writeFileSync(process.env.PEERCORD_AUTOTEST, last)
        if (process.env.PEERCORD_SHOT) {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.PEERCORD_SHOT, img.toPNG())
        }
        await sleep(6000)
      } catch (e) {
        fs.writeFileSync(process.env.PEERCORD_AUTOTEST, JSON.stringify({ error: String(e) }))
      }
      quitting = true
      app.quit()
    })
  }
}

app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { if (quitting) app.quit() })
start()
