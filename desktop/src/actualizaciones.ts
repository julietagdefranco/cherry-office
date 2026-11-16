// Actualizaciones automáticas de la app empaquetada.
// - Windows: electron-updater (latest.yml de la release).
// - Mac: actualizador propio (actualizaciones-mac.ts) sobre el appcast.xml firmado con EdDSA, porque electron-updater
//   en Mac exige firma de Developer ID.
// Las dos leen las releases publicadas de GitHub (los borradores no cuentan: publicar la release es lo que la manda a
// todos), bajan la versión nueva en segundo plano y la instalan al salir, o antes si el usuario elige «Reiniciar ahora».
// HQ_SIN_ACTUALIZACIONES=1 las apaga; HQ_ACTUALIZACIONES_FEED y HQ_ACTUALIZACIONES_CLAVE (solo Mac) sirven para probar
// con un appcast y una clave propios.
import { app, dialog, net, shell, type BrowserWindow } from 'electron'
// import con nombre: el paquete se declara ESM (__esModule) sin `default`, así que con esbuild
// `import electronUpdater from …` queda undefined y la app se cae al arrancar (le pasó a la 1.0.0 de Windows)
import { autoUpdater } from 'electron-updater'
import * as mac from './actualizaciones-mac.js'

const CADA = 6 * 60 * 60 * 1000 // cada 6 horas (además de al abrir)

export type EstadoActualizacion =
  | { tipo: 'nada' }
  | { tipo: 'buscando' }
  | { tipo: 'bajando'; version: string; pct: number }
  | { tipo: 'lista'; version: string }
  /** Mac: hay versión nueva pero no se puede instalar sola (corre desde el .dmg, sin permiso…): bajarla a mano. */
  | { tipo: 'manual'; version: string; url: string; motivo: string }

let estado: EstadoActualizacion = { tipo: 'nada' }
let alCambiar: () => void = () => {}
/** Tostada en la ventana de la oficina (si está abierta): que se vea que algo pasa mientras baja. */
let alAvisar: (texto: string) => void = () => {}
let ventana: () => BrowserWindow | undefined = () => undefined
/** Si el usuario eligió reiniciar ya, al terminar de cerrar se relanza la app. */
let reiniciarAlSalir = false
let manual = false

const esMac = process.platform === 'darwin'
/** Mac: la Oficina.app nueva ya descomprimida y revisada, lista para el cambio al salir. */
let nuevaMac: string | undefined

export const disponible = () =>
  (process.platform === 'win32' || esMac) && app.isPackaged && process.env.HQ_SIN_ACTUALIZACIONES !== '1'
export const estadoActual = () => estado

function cambiar(e: EstadoActualizacion) {
  const antes = estado
  if (e.tipo === 'bajando' && antes.tipo === 'bajando' && antes.pct === e.pct && antes.version === e.version) return
  estado = e
  if (e.tipo === 'bajando' && antes.tipo !== 'bajando') {
    alAvisar(`Hay una versión nueva de Oficina (${e.version}). La estoy bajando; te aviso cuando esté lista para instalar.`)
  }
  // barra de progreso en el ícono del Dock (Mac) o de la barra de tareas (Windows)
  try { ventana()?.setProgressBar(e.tipo === 'bajando' ? Math.max(0.01, e.pct / 100) : -1) } catch {}
  alCambiar()
}

export function iniciar(opciones: {
  ventana: () => BrowserWindow | undefined
  alCambiar: () => void
  alAvisar?: (texto: string) => void
}) {
  if (!disponible()) return
  ventana = opciones.ventana
  alCambiar = opciones.alCambiar
  if (opciones.alAvisar) alAvisar = opciones.alAvisar
  if (esMac) {
    const b = mac.bundleActual(app.getPath('exe'))
    if (b && !mac.impedimento(b)) mac.limpiar(b) // restos de una actualización anterior
  } else iniciarWindows()
  setTimeout(() => void buscar(false), 15_000)
  setInterval(() => void buscar(false), CADA)
}

function iniciarWindows() {
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
}

/** `manual`: desde el menú; avisa también si no hay nada nuevo o si falla. */
export async function buscar(esManual: boolean) {
  if (!disponible()) {
    if (esManual) void avisar('Actualizaciones', 'Las actualizaciones automáticas solo funcionan en la app instalada.')
    return
  }
  if (estado.tipo === 'lista') return void preguntarReinicio(estado.version)
  if (estado.tipo === 'manual' && esManual) return void ofrecerDescarga(estado)
  if (estado.tipo === 'bajando') {
    if (esManual) void avisar('Bajando la actualización', `Se está bajando la versión ${estado.version} (${estado.pct}%).`)
    return
  }
  if (estado.tipo === 'buscando') return
  if (esManual) alAvisar('Buscando actualizaciones…')
  if (esMac) return buscarMac(esManual)
  manual = esManual
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // ya lo informa el evento 'error'
  }
}

async function buscarMac(esManual: boolean) {
  cambiar({ tipo: 'buscando' })
  let version: string | undefined
  try {
    const feed = process.env.HQ_ACTUALIZACIONES_FEED || mac.FEED
    const r = await net.fetch(feed, { cache: 'no-store' })
    if (!r.ok) throw new Error(`No pude leer las actualizaciones (HTTP ${r.status}).`)
    const entrada = mac.leerAppcast(await r.text())
    if (!entrada) throw new Error('El aviso de actualizaciones no se pudo leer.')
    if (mac.compararVersiones(entrada.version, app.getVersion()) <= 0) {
      cambiar({ tipo: 'nada' })
      if (esManual) void avisar('Oficina está al día', `Tenés la última versión (${app.getVersion()}).`)
      return
    }
    version = entrada.version
    const bundle = mac.bundleActual(app.getPath('exe'))
    const motivo = mac.impedimento(bundle)
    if (motivo) {
      const e = { tipo: 'manual' as const, version, motivo, url: entrada.notas || 'https://github.com/salaesp/cherry-office/releases/latest' }
      cambiar(e)
      if (esManual) void ofrecerDescarga(e)
      return
    }
    cambiar({ tipo: 'bajando', version, pct: 0 })
    let ultimo = 0
    nuevaMac = await mac.preparar({
      entrada, bundle: bundle!, clave: process.env.HQ_ACTUALIZACIONES_CLAVE || undefined,
      bajar: (url) => net.fetch(url, { cache: 'no-store' }), // 120 MB: que no queden en la caché HTTP
      progreso: (pct) => {
        if (pct - ultimo < 5 && pct < 100) return // el menú se rearma en cada cambio: de a 5 %
        ultimo = pct
        cambiar({ tipo: 'bajando', version: version!, pct })
      },
    })
    cambiar({ tipo: 'lista', version })
    void preguntarReinicio(version)
  } catch (err) {
    nuevaMac = undefined
    const b = mac.bundleActual(app.getPath('exe'))
    if (version && b && !mac.impedimento(b)) mac.limpiar(b)
    cambiar({ tipo: 'nada' })
    if (esManual) void avisar(version ? 'No se pudo actualizar' : 'No se pudo buscar actualizaciones', String((err as Error)?.message ?? err))
  }
}

async function ofrecerDescarga(e: Extract<EstadoActualizacion, { tipo: 'manual' }>) {
  const w = ventana()
  const opciones = {
    type: 'info' as const,
    title: 'Hay una versión nueva',
    message: `Está la versión ${e.version} de Oficina.`,
    detail: `No se puede instalar sola: ${e.motivo}`,
    buttons: ['Bajarla', 'Más tarde'],
    defaultId: 0,
    cancelId: 1,
  }
  const r = w ? await dialog.showMessageBox(w, opciones) : await dialog.showMessageBox(opciones)
  if (r.response === 0) void shell.openExternal(e.url)
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
 * Lo llama main.ts al final del cierre (con el backend ya apagado). Windows: si hay una versión bajada, lanza el
 * instalador en silencio y devuelve true (electron-updater cierra la app). Mac: deja corriendo el script que cambia la
 * .app cuando el proceso termina y devuelve false. Si no hay nada, false y main.ts sale como siempre.
 */
export function instalarAlSalir(): boolean {
  if (estado.tipo !== 'lista') return false
  if (esMac) {
    const bundle = mac.bundleActual(app.getPath('exe'))
    if (!nuevaMac || !bundle) return false
    try {
      mac.instalarAlTerminar({ pid: process.pid, bundle, nueva: nuevaMac, reabrir: reiniciarAlSalir })
    } catch {}
    return false // main.ts sale enseguida; el script espera a que termine el proceso
  }
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
