// Turkuaz masaüstü uygulaması: server.js'i aynı süreçte başlatır ve
// arayüzü bir pencerede açar. Pencere kapatılınca tepsiye küçülür,
// mesajlar gelmeye devam eder.
const { app, BrowserWindow, session, Tray, Menu, desktopCapturer, Notification, ipcMain, dialog, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { createDesktopUpdater } = require('./lib/desktop-updater')

const APP_ID = 'dev.turkuaz.app'
const PORT = parseInt(process.env.PORT || '3210', 10)
const APP_ORIGIN = 'http://127.0.0.1:' + PORT
process.env.PORT = String(PORT)
if (!process.env.TURKUAZ_DATA && !process.env.PEERCORD_DATA) {
  process.env.TURKUAZ_DATA = path.join(app.getPath('userData'), 'data')
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Pencere arkadayken zamanlayıcı kısılmasın: arama/oyun/ses arka planda da aksın
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// Wayland'da Electron global kısayollarını masaüstü portalına kaydeder.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

// GPU süreci açılamazsa Chromium tüm uygulamayı öldürüyor:
//   "GPU process launch failed: error_code=1002"
//   "FATAL: GPU process isn't usable. Goodbye."
// Linux/Wayland + bozuk DRI/sürücüde sık. Yazılım render'a düş;
// TURKUAZ_FORCE_GPU=1 ile GPU zorlanır, TURKUAZ_DISABLE_GPU=1 ile her yerde kapanır.
;(function configureGpu () {
  if (process.env.TURKUAZ_FORCE_GPU === '1') return
  const session = String(process.env.XDG_SESSION_TYPE || '').toLowerCase()
  const wayland = session === 'wayland' || !!process.env.WAYLAND_DISPLAY
  const disable = process.env.TURKUAZ_DISABLE_GPU === '1' ||
    (process.platform === 'linux' && wayland)
  if (!disable) return
  try { app.disableHardwareAcceleration() } catch {}
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
})()

if (process.env.PEERCORD_FAKE_MEDIA || process.env.TURKUAZ_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
app.setAppUserModelId(APP_ID)

// Ana süreçte yakalanmamış hata pencereyi/tepsiyi çökertip uygulamayı sessizce
// öldürmesin — güncelleyici log dosyasına düşür, uygulama ayakta kalsın.
process.on('uncaughtException', (e) => { try { console.error('main uncaught:', (e && (e.stack || e.message)) || e) } catch {} })
process.on('unhandledRejection', (e) => { try { console.error('main unhandled:', (e && (e.stack || e.message)) || e) } catch {} })

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
let trayStateKey = ''
let updateController = null
let updateNotification = null
let callNotification = null
let lastMuteShortcutAt = 0
let muteShortcutRegistered = false
let lastDeafenShortcutAt = 0
let deafenShortcutRegistered = false
let updateState = {
  status: 'idle', currentVersion: app.getVersion(), version: null,
  percent: 0, manual: false, error: null, lastCheckedAt: null
}

function publishUpdateState (next) {
  updateState = { ...updateState, ...next }
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('turkuaz-update-state', updateState) } catch {}
  }
  refreshTrayUpdateState()
}

function refreshTrayUpdateState () {
  if (tray) {
    const key = updateState.status + ':' + (updateState.version || '') + ':' +
      (updateState.status === 'downloading' ? Math.floor((updateState.percent || 0) / 5) : '')
    if (key === trayStateKey) return
    trayStateKey = key
    try {
      tray.setContextMenu(trayMenu())
      tray.setToolTip(updateState.status === 'ready'
        ? 'Turkuaz — v' + updateState.version + ' güncellemesi hazır'
        : 'Turkuaz — çalışıyor')
    } catch {}
  }
}

function trayMenu () {
  const items = [
    { label: 'Turkuaz\'ı Göster', click: () => { win.show(); win.focus() } }
  ]
  items.push({ type: 'separator' })
  if (updateState.status === 'ready') {
    items.push({
      label: 'v' + updateState.version + ' güncellemesini kur (yeniden başlat)',
      click: () => updateController && updateController.install()
    })
  } else if (updateState.status === 'downloading') {
    items.push({ label: 'Güncelleme indiriliyor — %' + Math.round(updateState.percent || 0), enabled: false })
  } else if (updateState.status === 'checking') {
    items.push({ label: 'Güncellemeler denetleniyor…', enabled: false })
  } else if (updateState.status === 'disabled') {
    items.push({ label: 'Otomatik güncelleme bu pakette kullanılamıyor', enabled: false })
  } else {
    items.push({ label: 'Güncellemeleri denetle', click: () => updateController && updateController.check(true) })
  }
  items.push(
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit() } }
  )
  return Menu.buildFromTemplate(items)
}

function updateLogger () {
  const file = path.join(app.getPath('userData'), 'update.log')
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      try { fs.rmSync(file + '.old', { force: true }) } catch {}
      fs.renameSync(file, file + '.old')
    }
  } catch {}
  const write = (level, args) => {
    const line = args.map(v => {
      if (v instanceof Error) return v.stack || v.message
      if (typeof v === 'object') { try { return JSON.stringify(v) } catch {} }
      return String(v)
    }).join(' ')
    try { fs.appendFileSync(file, new Date().toISOString() + ' [' + level + '] ' + line + '\n') } catch {}
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args)
  }
}

// Paketli Windows NSIS ve Linux AppImage sürümlerinde GitHub Releases'i izler.
// İndirilen güncelleme kullanıcı isterse hemen, aksi halde normal çıkışta kurulur.
function setupAutoUpdate () {
  if (!app.isPackaged) {
    publishUpdateState({ status: 'disabled', reason: 'Geliştirme sürümünde otomatik güncelleme kapalı.' })
    return
  }
  // Linux'ta electron-updater yalnız AppImage paketini yerinde günceller.
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    publishUpdateState({ status: 'disabled', reason: 'Linux otomatik güncellemesi yalnız AppImage paketinde çalışır.' })
    return
  }
  if (process.platform === 'linux') {
    try {
      fs.accessSync(process.env.APPIMAGE, fs.constants.W_OK)
      fs.accessSync(path.dirname(process.env.APPIMAGE), fs.constants.W_OK)
    } catch {
      publishUpdateState({ status: 'disabled', reason: 'AppImage konumu yazılabilir değil; dosyayı kendi kullanıcı klasörüne taşı.' })
      return
    }
  }
  let autoUpdater
  try { ({ autoUpdater } = require('electron-updater')) } catch {
    publishUpdateState({ status: 'disabled', reason: 'Güncelleme modülü yüklenemedi.' })
    return
  }
  const logger = updateLogger()
  autoUpdater.logger = logger

  updateController = createDesktopUpdater({
    autoUpdater,
    currentVersion: app.getVersion(),
    logger,
    publish: publishUpdateState,
    notify: (state) => {
      if (!Notification.isSupported()) return
      try {
        updateNotification = new Notification({
          title: 'Turkuaz güncellemesi hazır',
          body: 'v' + state.version + ' indirildi. Şimdi yeniden başlatabilir veya normal çıkışta kurulmasını bekleyebilirsin.'
        })
        updateNotification.on('click', () => { if (win) { win.show(); win.focus() } })
        updateNotification.once('close', () => { updateNotification = null })
        updateNotification.show()
      } catch {}
    }
  })
  updateController.start()
}

async function start () {
  await app.whenReady()

  const allowedPermissions = ['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']
  const trustedUrl = (value) => {
    try { return new URL(value).origin === APP_ORIGIN } catch { return false }
  }
  const trustedWebContents = (wc) => !!win && !win.isDestroyed() && wc === win.webContents

  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return trustedWebContents(wc) && details.isMainFrame && trustedUrl(requestingOrigin) &&
      (!details.requestingUrl || trustedUrl(details.requestingUrl)) && allowedPermissions.includes(permission)
  })
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    // clipboard-sanitized-write olmadan navigator.clipboard.writeText reddedilir;
    // fullscreen olmadan video.requestFullscreen() sessizce reddedilir (⛶/çift tık)
    const trusted = trustedWebContents(wc) && details.isMainFrame && trustedUrl(details.requestingUrl)
    cb(trusted && allowedPermissions.includes(permission))
  })
  // desktopCapturer.getSources Wayland'da xdg-desktop-portal'a gider; portal
  // takılırsa promise HİÇ dönmeyebiliyor → her çağrıyı zaman aşımıyla sar,
  // yoksa ekran paylaşımı/uygulama donar.
  const getSourcesSafe = (opts, ms = 4000) => Promise.race([
    desktopCapturer.getSources(opts),
    new Promise(resolve => setTimeout(() => resolve([]), ms))
  ]).catch(() => [])

  // Ekran paylaşımında birincil ekranı ver (kendi seçim arayüzümüz yok)
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    if (!win || win.isDestroyed() || !req.frame ||
        req.frame !== win.webContents.mainFrame || !trustedUrl(req.securityOrigin)) return cb({})
    getSourcesSafe({ types: ['screen'] }).then(sources => {
      if (!sources.length) return cb({})
      const res = { video: sources[0] }
      // Sistem sesi: Chromium loopback yakalama şu an yalnızca Windows'ta
      if (req.audioRequested && process.platform === 'win32') res.audio = 'loopback'
      cb(res)
    })
  })

  if (await portInUse(PORT)) {
    dialog.showErrorBox(
      'Turkuaz başlatılamadı',
      'Yerel ' + PORT + ' portu başka bir uygulama tarafından kullanılıyor. O uygulamayı kapatıp Turkuaz\'ı yeniden aç.'
    )
    quitting = true
    app.quit()
    return
  }
  require('./server')
  await sleep(400)

  const iconPath = path.join(__dirname, 'build', 'icon.png')
  function trustedRenderer (event) {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false
    if (!event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false
    try {
      return new URL(event.senderFrame.url).origin === APP_ORIGIN
    } catch { return false }
  }
  function requireTrustedRenderer (event) {
    if (!trustedRenderer(event)) throw new Error('Yetkisiz Turkuaz IPC isteği')
  }

  // Ekran paylaşımı için kaynak (ekran) listesi — kendi seçicimizi göstermek için
  ipcMain.handle('turkuaz-get-sources', async (event) => {
    requireTrustedRenderer(event)
    try {
      const sources = await getSourcesSafe({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
      // display_id: uzaktan kontrolde imleci DOĞRU monitöre eşlemek için şart
      return sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), displayId: s.display_id }))
    } catch { return [] }
  })
  ipcMain.handle('turkuaz-update-get-state', (event) => {
    requireTrustedRenderer(event)
    return { ...updateState }
  })
  ipcMain.handle('turkuaz-update-check', async (event) => {
    requireTrustedRenderer(event)
    if (!updateController) return { ...updateState }
    return updateController.check(true)
  })
  ipcMain.handle('turkuaz-update-install', (event) => {
    requireTrustedRenderer(event)
    return !!(updateController && updateController.install())
  })
  ipcMain.handle('turkuaz-call-notify', (event, rawName) => {
    requireTrustedRenderer(event)
    if (!Notification.isSupported()) return false
    const callerName = String(rawName || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 64) || 'Bir arkadaşın'
    try {
      if (callNotification) callNotification.close()
      const notification = new Notification({
        title: 'Turkuaz gelen arama',
        body: callerName + ' seni arıyor.'
      })
      callNotification = notification
      notification.on('click', () => {
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      notification.once('close', () => {
        if (callNotification === notification) callNotification = null
      })
      notification.show()
      return true
    } catch {
      callNotification = null
      return false
    }
  })
  ipcMain.handle('turkuaz-call-clear', (event) => {
    requireTrustedRenderer(event)
    if (!callNotification) return false
    const notification = callNotification
    callNotification = null
    try { notification.close() } catch {}
    return true
  })
  // ---- uzaktan kontrol (ekran paylaşımı) ----
  // Native girdi enjeksiyonu (nut-js) burada. Güvenlik kapısı: girdi ancak
  // "armed" (kullanıcı onaylı, aktif) bir oturumda uygulanır. Renderer önce
  // begin() ile oturumu açar; end() ile kapatır. Armed değilken gelen her
  // girdi paketi SESSİZCE reddedilir — böylece kaçak/gecikmiş paket iş yapamaz.
  const remoteInput = require('./lib/remote-input')
  let rcArmed = false
  let rcSize = null // { width, height, x, y } paylaşılan EKRANIN masaüstündeki yeri
  // Paylaşılan ekranın gerçek sınırlarını bul. desktopCapturer kaynak id'si
  // "screen:<display_id>:0" biçiminde; display_id ile Electron'un display
  // listesinden bounds alınır. Bulunamazsa birincil ekrana düşülür — yoksa
  // ikinci monitör paylaşıldığında imleç yanlış ekrana giderdi.
  function boundsForDisplay (displayId) {
    try {
      const { screen } = require('electron')
      const all = screen.getAllDisplays()
      const hit = displayId != null && all.find(d => String(d.id) === String(displayId))
      const d = hit || screen.getPrimaryDisplay()
      if (d && d.bounds) {
        const sf = d.scaleFactor || 1
        // nut-js fiziksel piksel kullanır; Electron bounds DIP cinsindendir.
        return {
          x: Math.round(d.bounds.x * sf),
          y: Math.round(d.bounds.y * sf),
          width: Math.round(d.bounds.width * sf),
          height: Math.round(d.bounds.height * sf)
        }
      }
    } catch {}
    return null
  }
  ipcMain.handle('turkuaz-remote-available', (event) => {
    requireTrustedRenderer(event)
    return remoteInput.available()
  })
  ipcMain.handle('turkuaz-remote-begin', async (event, opts) => {
    requireTrustedRenderer(event)
    if (!remoteInput.available()) return { ok: false }
    const displayId = opts && opts.displayId
    rcSize = boundsForDisplay(displayId)
    if (!rcSize) {
      const s = await remoteInput.screenSize()   // yedek: nut-js birincil ekran
      rcSize = s ? { x: 0, y: 0, width: s.width, height: s.height } : null
    }
    if (!rcSize) return { ok: false }
    rcArmed = true
    return { ok: true, width: rcSize.width, height: rcSize.height }
  })
  ipcMain.handle('turkuaz-remote-end', async (event) => {
    requireTrustedRenderer(event)
    rcArmed = false
    rcSize = null
    // Basılı kalan tuş/düğme bırakılmazsa karşı makine kilitli kalır
    await remoteInput.releaseAll()
    return true
  })
  // Oturumu kapatmadan basılı tuş/düğmeleri bırak (izleyen odağı kaybetti).
  ipcMain.handle('turkuaz-remote-release-all', async (event) => {
    requireTrustedRenderer(event)
    if (!rcArmed) return false
    await remoteInput.releaseAll()
    return true
  })
  // Girdi uygula. ev: {k:'m',x,y} | {k:'r',dx,dy} | {k:'d'|'u',b}
  //                  | {k:'w',dy} | {k:'kd'|'ku',code}
  ipcMain.handle('turkuaz-remote-input', async (event, ev) => {
    requireTrustedRenderer(event)
    if (!rcArmed || !rcSize || !ev || typeof ev !== 'object') return false
    const { width: w, height: h, x: ox, y: oy } = rcSize
    try {
      switch (ev.k) {
        case 'm': await remoteInput.moveTo(ev.x, ev.y, w, h, ox, oy); break
        case 'r': await remoteInput.moveBy(ev.dx, ev.dy); break
        case 'd': await remoteInput.button(true, ev.b); break
        case 'u': await remoteInput.button(false, ev.b); break
        case 'w': await remoteInput.scroll(ev.dy); break
        case 'kd': await remoteInput.key(true, ev.code); break
        case 'ku': await remoteInput.key(false, ev.code); break
      }
    } catch {}
    return true
  })
  // İZLEYEN tarafı da bir kontrol oturumunun içindedir ama enjeksiyon yapmaz
  // (rcArmed açılmaz). Pano senkronu iki yönlü olduğu için izleyene ayrı,
  // DAR bir kapı: yalnız panoyu açar, girdi enjeksiyonunu asla açmaz.
  let rcControlling = false
  ipcMain.handle('turkuaz-remote-set-controlling', (event, on) => {
    requireTrustedRenderer(event)
    rcControlling = !!on
    return true
  })
  const rcInSession = () => rcArmed || rcControlling
  // Pano senkronu — yalnız aktif kontrol oturumunda, yalnız DÜZ METİN.
  // Resim/dosya panosu bilerek dışarıda: sessizce büyük veri sızdırmasın.
  const RC_CLIP_MAX = 100 * 1024
  ipcMain.handle('turkuaz-remote-clipboard-read', (event) => {
    requireTrustedRenderer(event)
    if (!rcInSession()) return null
    try {
      const { clipboard } = require('electron')
      const t = clipboard.readText()
      return typeof t === 'string' && t.length <= RC_CLIP_MAX ? t : null
    } catch { return null }
  })
  ipcMain.handle('turkuaz-remote-clipboard-write', (event, text) => {
    requireTrustedRenderer(event)
    if (!rcInSession() || typeof text !== 'string' || text.length > RC_CLIP_MAX) return false
    try {
      const { clipboard } = require('electron')
      clipboard.writeText(text)
      return true
    } catch { return false }
  })

  ipcMain.handle('turkuaz-shortcut-global-mute-active', (event) => {
    requireTrustedRenderer(event)
    return muteShortcutRegistered
  })
  ipcMain.handle('turkuaz-shortcut-global-deafen-active', (event) => {
    requireTrustedRenderer(event)
    return deafenShortcutRegistered
  })

  win = new BrowserWindow({
    width: 1300,
    height: 850,
    backgroundColor: '#10201e',
    title: 'Turkuaz',
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadURL('http://127.0.0.1:' + PORT)

  // Oyun veya başka bir pencere odaktayken de mikrofonu tek tuşla sustur/aç.
  // Kısa debounce, işletim sisteminin basılı tuş tekrarının durumu hızla tersine
  // çevirmesini önler; renderer yalnız bu dar olayı dinleyebilir.
  try {
    muteShortcutRegistered = globalShortcut.register('CommandOrControl+Shift+M', () => {
      const now = Date.now()
      if (now - lastMuteShortcutAt < 500) return
      lastMuteShortcutAt = now
      if (!win || win.isDestroyed()) return
      try { win.webContents.send('turkuaz-shortcut-toggle-mute') } catch {}
    })
  } catch { muteShortcutRegistered = false }
  // Sağırlaştır (deafen) — oyun odaktayken de tek tuş
  try {
    deafenShortcutRegistered = globalShortcut.register('CommandOrControl+Shift+D', () => {
      const now = Date.now()
      if (now - lastDeafenShortcutAt < 500) return
      lastDeafenShortcutAt = now
      if (!win || win.isDestroyed()) return
      try { win.webContents.send('turkuaz-shortcut-toggle-deafen') } catch {}
    })
  } catch { deafenShortcutRegistered = false }

  // kapat → tepsiye küçül
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })

  try {
    tray = new Tray(iconPath)
    trayStateKey = ''
    tray.setToolTip('Turkuaz — çalışıyor')
    tray.setContextMenu(trayMenu())
    refreshTrayUpdateState()
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
app.on('will-quit', () => {
  try {
    if (app.isReady()) {
      globalShortcut.unregister('CommandOrControl+Shift+M')
      globalShortcut.unregister('CommandOrControl+Shift+D')
    }
  } catch {}
  muteShortcutRegistered = false
  deafenShortcutRegistered = false
})
app.on('window-all-closed', () => { if (quitting) app.quit() })

// Normal kullanımda tek backend/updater örneği çalışsın. İki-Electron A/V testi
// sahte medya bayrağıyla bilinçli olarak birden çok örnek açar.
const allowMultiple = !!(process.env.TURKUAZ_ALLOW_MULTIPLE || process.env.TURKUAZ_FAKE_MEDIA || process.env.PEERCORD_FAKE_MEDIA)
const hasSingleInstanceLock = allowMultiple || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  if (!allowMultiple) {
    app.on('second-instance', () => {
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  }
  start()
}
