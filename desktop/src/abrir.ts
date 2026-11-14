// Abrir archivos de la oficina con su aplicación (Abrir.swift). Solo rutas que, con los enlaces resueltos, caen dentro
// de la carpeta de la oficina activa o de una carpeta vinculada; nunca nada que ejecute código.
import fs from 'node:fs'
import path from 'node:path'

/** Tipos que ejecutan código: nunca se abren desde la oficina (un agente o una carpeta vinculada podría traer uno). */
export const extensionesBloqueadas = new Set([
  'app', 'command', 'sh', 'zsh', 'bash', 'csh', 'tcsh', 'ksh', 'pkg', 'mpkg', 'dmg', 'scpt', 'scptd', 'applescript',
  'workflow', 'action', 'terminal', 'tool', 'jar', 'exe', 'bat', 'cmd', 'msi', 'pl', 'py', 'rb', 'wflow', 'osax', 'prefpane',
  // Windows
  'com', 'scr', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'lnk', 'url', 'reg', 'cpl', 'hta', 'msc', 'msp', 'appx', 'msix',
])

const sinMayusculas = process.platform === 'win32' || process.platform === 'darwin'

function real(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return undefined
  }
}

/** La ruta resuelta si existe y cae dentro de alguna de las `bases`; undefined si no. */
export function resolver(ruta: string, bases: string[]): string | undefined {
  if (!path.isAbsolute(ruta) || ruta.includes('\0')) return undefined
  const r = real(ruta)
  if (!r) return undefined
  const norm = (s: string) => (sinMayusculas ? s.toLowerCase() : s)
  for (const b of bases) {
    if (!path.isAbsolute(b)) continue
    const base = real(b)
    if (!base || path.dirname(base) === base) continue // nunca la raíz del disco
    if (norm(r) === norm(base) || norm(r).startsWith(norm(base) + path.sep)) return r
  }
  return undefined
}

/** true si abrirla ejecutaría código (aplicaciones, scripts, instaladores, archivos con permiso de ejecución). */
export function ejecutable(ruta: string): boolean {
  if (extensionesBloqueadas.has(path.extname(ruta).slice(1).toLowerCase())) return true
  try {
    const s = fs.statSync(ruta)
    if (s.isDirectory()) return /\.app$/i.test(ruta)
    if (process.platform === 'win32') return false
    fs.accessSync(ruta, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
