// Puente entre la oficina (la página) y la app: el front ya habla con `window.webkit.messageHandlers.hq.postMessage`
// (lo que daba WKWebView en la app Swift), así que se expone ese mismo objeto. Cada mensaje devuelve una Promise.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    hq: { postMessage: (mensaje: unknown) => ipcRenderer.invoke('hq', mensaje) },
  },
})

// Para que el front sepa en qué sistema corre (textos como «Mostrar en Finder» / «en el Explorador»).
contextBridge.exposeInMainWorld('oficinaApp', { plataforma: process.platform })
