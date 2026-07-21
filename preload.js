// Güvenli köprü: arayüz (web) ile Electron ana süreci arasında yalnızca
// gerekli, kısıtlı API'yi açar (contextIsolation açık).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('turkuazDesktop', {
  getSources: () => ipcRenderer.invoke('turkuaz-get-sources'),
  calls: {
    notifyIncoming: (name) => ipcRenderer.invoke('turkuaz-call-notify', name),
    clearIncoming: () => ipcRenderer.invoke('turkuaz-call-clear')
  },
  shortcuts: {
    isGlobalMuteActive: () => ipcRenderer.invoke('turkuaz-shortcut-global-mute-active'),
    onToggleMute: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const handler = () => callback()
      ipcRenderer.on('turkuaz-shortcut-toggle-mute', handler)
      return () => ipcRenderer.removeListener('turkuaz-shortcut-toggle-mute', handler)
    },
    isGlobalDeafenActive: () => ipcRenderer.invoke('turkuaz-shortcut-global-deafen-active'),
    onToggleDeafen: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const handler = () => callback()
      ipcRenderer.on('turkuaz-shortcut-toggle-deafen', handler)
      return () => ipcRenderer.removeListener('turkuaz-shortcut-toggle-deafen', handler)
    }
  },
  updates: {
    getState: () => ipcRenderer.invoke('turkuaz-update-get-state'),
    check: () => ipcRenderer.invoke('turkuaz-update-check'),
    install: () => ipcRenderer.invoke('turkuaz-update-install'),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const handler = (_event, state) => callback(state)
      ipcRenderer.on('turkuaz-update-state', handler)
      return () => ipcRenderer.removeListener('turkuaz-update-state', handler)
    }
  }
})
