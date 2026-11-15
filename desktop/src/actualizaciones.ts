// Actualizaciones automáticas (solo Windows, app empaquetada) con electron-updater.
// Lee las releases publicadas de GitHub (los borradores no cuentan: publicar la release es lo que la manda a todos).
// Baja la versión nueva en segundo plano y la instala al salir, o antes si el usuario elige «Reiniciar ahora».
import { app, dialog, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const CADA = 6 * 60 * 60 * 1000 // cada 6 horas (además de al abrir)

export type EstadoActualizacion =
  | { tipo: 'nada' }
  | { tipo: 'buscando' }
  | { tipo: 'bajando'; version: string; pct: number }
  | { tipo: 'lista'; version: string }

let estado: EstadoActualizacion = { tipo: 'nada' }
let alCambiar: () => void = () => {}
let ventana: () => BrowserWindow | undefined = () => undefined
/** Si el usuario eligió reiniciar ya, al terminar de cerrar se relanza la app. */
let reiniciarAlSalir = false
let manual = false

export const disponible = () => process.platform === 'win32' && app.isPackaged
export const estadoActual = () => estado

function cambiar(e: EstadoActualizacion) {
  estado = e
  alCambiar()
}

export function iniciar(opciones: { ventana: () => BrowserWindow | undefined; alCambiar: () => void }) {
  if (!disponible()) return
  ventana = opciones.ventana
  alCambiar = opciones.alCambiar
  autoUpdater.autoDownload = true
  // el cierre lo maneja main.ts (apaga el backend y llama a instalarAlSalir): electron-updater no se entera de app.exit
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => { if (estado.tipo === 'nada') cambiar({ tipo: 'buscando' }) })
  autoUpdater.on('update-not-available', () => {
    if (estado.tipo === 'buscando') cambiar({ tipo: 'nada' })
    if (manual) void avisar('Oficina está al día', `Tenés la última versión (${app.getVersion()}).`)
    manual = false
  })
  autoUpdater.on('update-available', (info) => cambiar({ tipo: 'bajando', version: info.version, pct: 0 }))
  autoUpdater.on('download-progress', (p) => {
    if (estado.tipo === 'bajando') cambiar({ ...estado, pct: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    cambiar({ tipo: 'lista', version: info.version })
    manual = false
    void preguntarReinicio(info.version)
  })
  autoUpdater.on('error', (err) => {
    if (estado.tipo !== 'lista') cambiar({ tipo: 'nada' })
    if (manual) void avisar('No se pudo buscar actualizaciones', String(err?.message ?? err))
    manual = false
  })

  setTimeout(() => void buscar(false), 15_000)
  setInterval(() => void buscar(false), CADA)
}

/** `manual`: desde el menú; avisa también si no hay nada nuevo o si falla. */
export async function buscar(esManual: boolean) {
  if (!disponible()) {
    if (esManual) void avisar('Actualizaciones', 'Las actualizaciones automáticas solo funcionan en la app instalada.')
    return
  }
  if (estado.tipo === 'lista') return void preguntarReinicio(estado.version)
  if (estado.tipo === 'bajando') {
    if (esManual) void avisar('Bajando la actualización', `Se está bajando la versión ${estado.version} (${estado.pct}%).`)
    return
  }
  manual = esManual
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // ya lo informa el evento 'error'
  }
}

async function preguntarReinicio(version: string) {
  const w = ventana()
  const opciones = {
    type: 'info' as const,
    title: 'Actualización lista',
    message: `La versión ${version} de Oficina está lista.`,
    detail: 'Se instala al reiniciar la app. Si elegís «Más tarde», se instala la próxima vez que salgas de Oficina.',
    buttons: ['Reiniciar ahora', 'Más tarde'],
    defaultId: 0,
    cancelId: 1,
  }
  const r = w ? await dialog.showMessageBox(w, opciones) : await dialog.showMessageBox(opciones)
  if (r.response === 0) reiniciar()
}

export function reiniciar() {
  if (estado.tipo !== 'lista') return
  reiniciarAlSalir = true
  app.quit()
}

/**
 * Lo llama main.ts al final del cierre (con el backend ya apagado). Si hay una versión bajada, lanza el instalador
 * en silencio y devuelve true (electron-updater cierra la app); si no, devuelve false y main.ts sale como siempre.
 */
export function instalarAlSalir(): boolean {
  if (estado.tipo !== 'lista') return false
  try {
    autoUpdater.quitAndInstall(true, reiniciarAlSalir)
    return true
  } catch {
    return false
  }
}

async function avisar(titulo: string, texto: string) {
  const w = ventana()
  const opciones = { type: 'info' as const, title: titulo, message: titulo, detail: texto, buttons: ['Aceptar'] }
  if (w) await dialog.showMessageBox(w, opciones)
  else await dialog.showMessageBox(opciones)
}
