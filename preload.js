// Güvenli köprü: arayüz (web) ile Electron ana süreci arasında yalnızca
// gerekli, kısıtlı API'yi açar (contextIsolation açık). Şu an: ekran
// paylaşımı için kaynak (ekran) listesi.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('turkuazDesktop', {
  getSources: () => ipcRenderer.invoke('turkuaz-get-sources')
})
