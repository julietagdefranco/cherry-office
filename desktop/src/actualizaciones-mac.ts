// Actualizaciones de la app de Mac sin firma de Developer ID (electron-updater no sirve: en Mac usa Squirrel.Mac, que
// exige esa firma). Hace lo mismo que hacía Sparkle en la app Swift, con el mismo feed y la misma clave:
// 1. Lee appcast.xml de la última release publicada de GitHub.
// 2. Si hay una versión más nueva, baja el .zip y verifica su firma EdDSA (Ed25519) contra la clave pública del
//    proyecto (la misma `SUPublicEDKey` que tenía la app Swift), además del tamaño.
// 3. Lo descomprime con ditto al lado de la app (mismo volumen), revisa que sea una Oficina.app sana (bundle id,
//    versión, firma ad-hoc íntegra) y la deja lista.
// 4. Al salir, un script suelto espera a que la app termine, cambia la .app vieja por la nueva y, si se pidió,
//    la vuelve a abrir.
// Como lo baja la propia app (no el navegador), el archivo no queda en cuarentena: macOS no vuelve a pedir
// «Abrir igualmente».
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const FEED = 'https://github.com/salaesp/cherry-office/releases/latest/download/appcast.xml'
/** Clave pública EdDSA del proyecto (la privada es el secret SPARKLE_PRIVATE_KEY del workflow de release). También va
 *  en el Info.plist (`build.mac.extendInfo.SUPublicEDKey` en package.json): Sparkle de la 1.0 Swift rechaza una
 *  actualización sin firma de Developer ID si la app nueva no trae la misma clave. */
export const CLAVE_PUBLICA = '3lXavZJQZAaLrys0ULu1XQD/vj8CLcyxe4NP+QAWsx8='
const BUNDLE_ID = 'com.oficina.app'

export type Entrada = { version: string; build: string; url: string; firma: string; tam: number; notas?: string }

/** El primer `<item>` del appcast (el workflow publica uno solo, la versión de esa release). */
export function leerAppcast(xml: string): Entrada | undefined {
  const item = /<item>([\s\S]*?)<\/item>/.exec(xml)?.[1]
  if (!item) return undefined
  const etiqueta = (n: string) => new RegExp(`<sparkle:${n}>\\s*([^<]*?)\\s*</sparkle:${n}>`).exec(item)?.[1]
  const enclosure = /<enclosure\b([^>]*)\/?>/.exec(item)?.[1] ?? ''
  const atributo = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(enclosure)?.[1]
  const version = etiqueta('shortVersionString') ?? atributo('sparkle:shortVersionString')
  const build = etiqueta('version') ?? atributo('sparkle:version') ?? ''
  const url = atributo('url')
  const firma = atributo('sparkle:edSignature')
  const tam = Number(atributo('length'))
  if (!version || !url || !firma || !Number.isFinite(tam) || tam <= 0) return undefined
  return { version, build, url: url.replace(/&amp;/g, '&'), firma, tam, notas: etiqueta('fullReleaseNotesLink') }
}

/** >0 si `a` es más nueva que `b` (X.Y.Z; un sufijo -beta cuenta como anterior a la misma versión sin sufijo). */
export function compararVersiones(a: string, b: string): number {
  const partes = (v: string) => {
    const [num, pre] = v.trim().replace(/^v/, '').split('-', 2)
    return { n: num.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? '' }
  }
  const x = partes(a), y = partes(b)
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) {
    const d = (x.n[i] ?? 0) - (y.n[i] ?? 0)
    if (d) return d
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** Firma EdDSA de Sparkle: Ed25519 «pura» sobre los bytes del archivo; clave pública cruda de 32 bytes en base64. */
export function firmaValida(datos: Buffer, firmaB64: string, claveB64: string): boolean {
  try {
    const cruda = Buffer.from(claveB64, 'base64')
    if (cruda.length !== 32) return false
    // SPKI DER de una clave Ed25519 = prefijo fijo + los 32 bytes
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), cruda])
    const clave = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
    return crypto.verify(null, datos, clave, Buffer.from(firmaB64, 'base64'))
  } catch {
    return false
  }
}

/** La Oficina.app que está corriendo (de .../Oficina.app/Contents/MacOS/Oficina), o undefined si no es un bundle. */
export function bundleActual(exe: string): string | undefined {
  const b = path.resolve(exe, '../../..')
  return b.endsWith('.app') ? b : undefined
}

/**
 * Por qué no se puede reemplazar la app en su lugar (undefined = se puede). Si la app corre desde el .dmg, desde la
 * «translocación» de Gatekeeper (todavía en cuarentena, sin mover a Aplicaciones) o desde una carpeta sin permiso de
 * escritura, el aviso ofrece bajarla a mano.
 */
export function impedimento(bundle: string | undefined): string | undefined {
  if (!bundle) return 'La app no corre desde una Oficina.app.'
  if (bundle.includes('/AppTranslocation/')) return 'macOS la está abriendo desde una ubicación temporal: movela a Aplicaciones.'
  if (bundle.startsWith('/Volumes/')) return 'La app corre desde el instalador: arrastrala a Aplicaciones.'
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    return `No tengo permiso para escribir en ${path.dirname(bundle)}.`
  }
  return undefined
}

/** Carpeta donde se prepara la versión nueva: al lado de la app, para que el cambio final sea un `mv` en el mismo volumen. */
export const carpetaPreparacion = (bundle: string) => path.join(path.dirname(bundle), '.Oficina-actualizacion')

/** Borra lo que haya quedado de una actualización anterior (bajada a medias o ya instalada). */
export function limpiar(bundle: string) {
  try { fs.rmSync(carpetaPreparacion(bundle), { recursive: true, force: true }) } catch {}
}

/**
 * Baja el .zip, lo verifica y lo deja descomprimido en la carpeta de preparación. Devuelve la ruta de la Oficina.app
 * nueva. `bajar` es `fetch` (en la app, `net.fetch` de Electron, que respeta el proxy del sistema).
 */
export async function preparar(opciones: {
  entrada: Entrada
  bundle: string
  clave?: string
  bajar: (url: string) => Promise<Response>
  progreso?: (pct: number) => void
}): Promise<string> {
  const { entrada, bundle, progreso } = opciones
  const dir = carpetaPreparacion(bundle)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const zip = path.join(dir, 'Oficina.zip')

  const r = await opciones.bajar(entrada.url)
  if (!r.ok || !r.body) throw new Error(`No pude bajar la actualización (HTTP ${r.status}).`)
  const partes: Buffer[] = []
  let bajado = 0
  const lector = r.body.getReader()
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    bajado += value.byteLength
    if (bajado > entrada.tam) throw new Error('La actualización es más grande de lo anunciado.')
    partes.push(Buffer.from(value))
    progreso?.(Math.round((bajado / entrada.tam) * 100))
  }
  const datos = Buffer.concat(partes)
  if (datos.length !== entrada.tam) throw new Error('La actualización llegó incompleta.')
  if (!firmaValida(datos, entrada.firma, opciones.clave ?? CLAVE_PUBLICA)) {
    throw new Error('La firma de la actualización no es válida: no la instalo.')
  }
  fs.writeFileSync(zip, datos)

  const x = spawnSync('/usr/bin/ditto', ['-x', '-k', zip, dir], { encoding: 'utf8' })
  fs.rmSync(zip, { force: true })
  if (x.status !== 0) throw new Error(`No pude descomprimir la actualización: ${x.stderr || x.status}`)
  const nueva = path.join(dir, 'Oficina.app')
  revisarBundle(nueva, entrada.version)
  return nueva
}

/** Que lo descomprimido sea de verdad la Oficina de la versión anunciada y que su firma (ad-hoc) esté íntegra. */
function revisarBundle(app: string, version: string) {
  const plist = path.join(app, 'Contents/Info.plist')
  if (!fs.existsSync(plist)) throw new Error('La actualización no trae una Oficina.app.')
  const leer = (clave: string) =>
    spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${clave}`, plist], { encoding: 'utf8' }).stdout.trim()
  if (leer('CFBundleIdentifier') !== BUNDLE_ID) throw new Error('La actualización no es de Oficina.')
  if (leer('CFBundleShortVersionString') !== version) throw new Error('La versión de la actualización no coincide.')
  const firma = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  if (firma.status !== 0) throw new Error(`La actualización está dañada: ${firma.stderr.trim()}`)
}

/**
 * Lanza el script que, cuando la app termina (`pid`), cambia la .app vieja por la nueva. Si algo falla, deja la vieja
 * donde estaba. Corre suelto (detached): sobrevive al cierre de la app.
 */
export function instalarAlTerminar(opciones: { pid: number; bundle: string; nueva: string; reabrir: boolean }) {
  const script = [
    'PID="$1"; APP="$2"; NUEVA="$3"; REABRIR="$4"; DIR="$5"',
    // hasta 60 s esperando que termine la app (apaga el backend y los claude que estén corriendo)
    'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done',
    'VIEJA="$DIR/Oficina-vieja.app"; rm -rf "$VIEJA"',
    'if mv "$APP" "$VIEJA"; then',
    '  if mv "$NUEVA" "$APP"; then rm -rf "$DIR"; else mv "$VIEJA" "$APP"; fi',
    'fi',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    '[ "$REABRIR" = 1 ] && open "$APP"',
    'exit 0',
  ].join('\n')
  spawn('/bin/sh', ['-c', script, 'oficina-actualizar', String(opciones.pid), opciones.bundle, opciones.nueva,
    opciones.reabrir ? '1' : '0', path.dirname(opciones.nueva)], { detached: true, stdio: 'ignore' }).unref()
}
