// Electron ana sürecindeki otomatik güncelleyicinin durum makinesi.
// Electron'a doğrudan bağımlı değildir; sahte bir autoUpdater ile test edilebilir.
const CHECK_INTERVAL = 4 * 60 * 60 * 1000
const FIRST_CHECK_DELAY = 15 * 1000

function errorText (err) {
  return String((err && err.message) || err || 'Bilinmeyen güncelleme hatası').slice(0, 400)
}

function createDesktopUpdater ({
  autoUpdater,
  currentVersion,
  publish = () => {},
  notify = () => {},
  logger = console,
  firstCheckDelay = FIRST_CHECK_DELAY,
  checkInterval = CHECK_INTERVAL,
  timers = {}
}) {
  if (!autoUpdater) throw new Error('autoUpdater gerekli')

  const later = timers.setTimeout || setTimeout
  const repeat = timers.setInterval || setInterval
  const cancelLater = timers.clearTimeout || clearTimeout
  const cancelRepeat = timers.clearInterval || clearInterval
  let firstTimer = null
  let intervalTimer = null
  let noticeTimer = null
  let started = false
  let manualCheck = false

  let state = {
    status: 'idle',
    currentVersion: String(currentVersion || ''),
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    manual: false,
    error: null,
    lastCheckedAt: null
  }

  const handlers = {}
  const snapshot = () => ({ ...state })

  function log (level, ...args) {
    try {
      const fn = logger && (logger[level] || logger.info || logger.log)
      if (fn) fn.call(logger, ...args)
    } catch {}
  }

  function emit (patch) {
    state = { ...state, ...patch }
    const value = snapshot()
    try { publish(value) } catch {}
    return value
  }

  function clearTransientNotice (expectedStatus, ms = 6000) {
    if (noticeTimer) cancelLater(noticeTimer)
    noticeTimer = later(() => {
      if (state.status === expectedStatus) emit({ status: 'idle', manual: false, error: null })
    }, ms)
    if (noticeTimer && noticeTimer.unref) noticeTimer.unref()
  }

  function fail (err) {
    const message = errorText(err)
    const showToUser = manualCheck || state.manual
    manualCheck = false
    log('error', 'Güncelleme hatası:', message)
    if (showToUser) {
      emit({ status: 'error', manual: true, error: message })
      clearTransientNotice('error', 10000)
    } else {
      emit({ status: 'idle', manual: false, error: message })
    }
  }

  handlers.checking = () => {
    emit({ status: 'checking', manual: manualCheck, error: null, lastCheckedAt: Date.now() })
  }
  handlers.available = (info = {}) => {
    emit({
      status: 'downloading',
      version: String(info.version || ''),
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      manual: manualCheck,
      error: null
    })
  }
  handlers.progress = (info = {}) => {
    emit({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Number(info.percent) || 0)),
      transferred: Math.max(0, Number(info.transferred) || 0),
      total: Math.max(0, Number(info.total) || 0),
      bytesPerSecond: Math.max(0, Number(info.bytesPerSecond) || 0),
      error: null
    })
  }
  handlers.notAvailable = () => {
    const showToUser = manualCheck
    manualCheck = false
    emit({
      status: showToUser ? 'up-to-date' : 'idle',
      version: null,
      percent: 0,
      manual: showToUser,
      error: null,
      lastCheckedAt: Date.now()
    })
    if (showToUser) clearTransientNotice('up-to-date')
  }
  handlers.downloaded = (info = {}) => {
    manualCheck = false
    const value = emit({
      status: 'ready',
      version: String(info.version || state.version || ''),
      percent: 100,
      manual: false,
      error: null,
      lastCheckedAt: Date.now()
    })
    log('info', 'Güncelleme indirildi:', value.version)
    try { notify(value) } catch {}
  }
  handlers.cancelled = () => {
    manualCheck = false
    emit({ status: 'idle', manual: false, error: null })
  }
  handlers.error = (err) => fail(err)

  async function check (manual = false) {
    if (!started) return snapshot()
    if (['checking', 'downloading', 'ready', 'installing'].includes(state.status)) return snapshot()
    manualCheck = !!manual
    handlers.checking()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // electron-updater çoğu hatayı ayrıca `error` olayıyla yollar. Durum hâlâ
      // checking ise promise reddini burada görünür yap; iki kez bildirme.
      if (state.status === 'checking') fail(err)
    }
    return snapshot()
  }

  function install () {
    if (state.status !== 'ready') return false
    emit({ status: 'installing', manual: false, error: null })
    // Windows'ta NSIS'i sessiz yükseltme modunda çalıştır; AppImageUpdater da
    // yeni AppImage'ı yerinde kurar. İkinci argüman kurulumdan sonra yeniden açar.
    autoUpdater.quitAndInstall(true, true)
    return true
  }

  function start () {
    if (started) return snapshot()
    started = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.disableWebInstaller = true

    autoUpdater.on('checking-for-update', handlers.checking)
    autoUpdater.on('update-available', handlers.available)
    autoUpdater.on('download-progress', handlers.progress)
    autoUpdater.on('update-not-available', handlers.notAvailable)
    autoUpdater.on('update-downloaded', handlers.downloaded)
    autoUpdater.on('update-cancelled', handlers.cancelled)
    autoUpdater.on('error', handlers.error)

    firstTimer = later(() => check(false), firstCheckDelay)
    intervalTimer = repeat(() => check(false), checkInterval)
    if (firstTimer && firstTimer.unref) firstTimer.unref()
    if (intervalTimer && intervalTimer.unref) intervalTimer.unref()
    emit({ status: 'idle' })
    return snapshot()
  }

  function stop () {
    if (firstTimer) cancelLater(firstTimer)
    if (intervalTimer) cancelRepeat(intervalTimer)
    if (noticeTimer) cancelLater(noticeTimer)
    firstTimer = intervalTimer = noticeTimer = null
    for (const [event, handler] of [
      ['checking-for-update', handlers.checking],
      ['update-available', handlers.available],
      ['download-progress', handlers.progress],
      ['update-not-available', handlers.notAvailable],
      ['update-downloaded', handlers.downloaded],
      ['update-cancelled', handlers.cancelled],
      ['error', handlers.error]
    ]) autoUpdater.removeListener(event, handler)
    started = false
  }

  return { start, stop, check, install, getState: snapshot }
}

module.exports = { createDesktopUpdater, FIRST_CHECK_DELAY, CHECK_INTERVAL }
