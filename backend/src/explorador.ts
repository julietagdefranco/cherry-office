// Explorador de carpetas (para elegir dónde abrir/crear/vincular) y de la carpeta de la oficina (solo lectura).
// Explorador.swift. Mismos topes y reglas de seguridad.
//
//   GET  /api/fs/carpetas?ruta=&ocultas=0|1&archivos=zip   subcarpetas de una carpeta DENTRO de $HOME
//   POST /api/fs/carpetas {padre, nombre}     crea una subcarpeta dentro de $HOME
//   GET  /api/oficina/archivos?ruta=<rel>     lista de la carpeta de la oficina activa
//   GET  /api/oficina/archivo?ruta=<rel>      vista previa: {texto} (512 KB) o {base64, mime} (imágenes, 2 MB)
//   GET  /api/oficina/vista?ruta=<rel>        lista para mostrar (Vista.leer): una página trae adentro su CSS, JS e imágenes
//   En las tres de la oficina, `ruta` también puede ser absoluta dentro de una carpeta de trabajo (trabajo.ts).
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import { ErrorAPI } from './errores.js'
import { esObjeto, type Obj } from './json.js'
import type { HQLog } from './log.js'
import type { Oficinas } from './oficinas.js'
import { enCarpetaTrabajo } from './trabajo.js'
import { Vista } from './vista.js'
import { atrapar, no405, type Query, type RespuestaAPI, type SubRouter } from './router.js'

const maxEntradas = 500
const maxTexto = 512 * 1024
const maxImagen = 2 * 1024 * 1024
const maxNombre = 120
const extTexto = new Set(['md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'log', 'html', 'htm', 'svg', 'mmd', 'mermaid', 'xml', 'yaml', 'yml', 'js', 'mjs', 'ts', 'css', 'py', 'sh', 'sql'])
const extImagen: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const rutas = new Set(['/api/fs/carpetas', '/api/oficina/archivos', '/api/oficina/archivo', '/api/oficina/vista'])
/** En Windows y macOS (por defecto) el sistema de archivos no distingue mayúsculas: la contención tampoco. */
const sinMayusculas = process.platform === 'win32'

// MARK: utilidades puras

/** realpath (resuelve enlaces); undefined si no existe. */
export function real(ruta: string): string | undefined {
  try {
    return fs.realpathSync.native(ruta)
  } catch {
    return undefined
  }
}

/** realpath de lo que exista: los componentes que faltan se agregan tal cual. */
export function realAunqueFalte(ruta: string): string {
  const r = real(ruta)
  if (r !== undefined) return r
  const padre = path.dirname(ruta)
  if (padre === ruta || padre === '') return ruta
  return path.join(realAunqueFalte(padre), path.basename(ruta))
}

export function dentro(base: string, ruta: string): boolean {
  const [b, r] = sinMayusculas ? [base.toLowerCase(), ruta.toLowerCase()] : [base, ruta]
  return r === b || r.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

const stat = (p: string) => { try { return fs.statSync(p) } catch { return undefined } }
const lstat = (p: string) => { try { return fs.lstatSync(p) } catch { return undefined } }
export const esDirectorio = (p: string) => stat(p)?.isDirectory() ?? false
export const esArchivoRegular = (p: string) => { const s = stat(p); return s !== undefined && !s.isDirectory() }
const esEnlace = (p: string) => lstat(p)?.isSymbolicLink() ?? false

/** Nombre de carpeta nuevo: sin separadores, `:` ni caracteres de control, sin puntos al principio. "" si no sirve. */
export function nombreSaneado(s: string): string {
  let t = [...s].map((c) => {
    const u = c.codePointAt(0)!
    return c === '/' || c === '\\' || c === ':' || u < 32 || u === 127 ? '-' : c
  }).join('').trim()
  t = t.replace(/^\.+/, '').trim()
  return [...t].slice(0, maxNombre).join('').trim()
}

/** Dentro de la oficina solo se ven los ocultos `.claude` (nivel 0). */
const parteOcultaPermitida = (i: number, parte: string) => !parte.startsWith('.') || (i === 0 && parte === '.claude')

function ordenar(a: string, b: string): number {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  if (x === y) return a < b ? -1 : a > b ? 1 : 0
  return x < y ? -1 : 1
}

export class ExploradorRouter implements SubRouter {
  constructor(private readonly config: Config, private readonly oficinas: Oficinas, private readonly log: HQLog) {}

  static esRuta(p: string) { return rutas.has(p) }

  async handle(method: string, p: string, query: Query, body?: Buffer): Promise<RespuestaAPI | null> {
    if (!ExploradorRouter.esRuta(p)) return null
    return atrapar(async () => {
      try {
        if (p === '/api/fs/carpetas' && method === 'GET') return [200, this.carpetas(query)]
        if (p === '/api/fs/carpetas' && method === 'POST') return [200, this.crearCarpeta(body)]
        if (p === '/api/oficina/archivos' && method === 'GET') return [200, this.archivos(query)]
        if (p === '/api/oficina/archivo' && method === 'GET') return [200, this.archivo(query)]
        if (p === '/api/oficina/vista' && method === 'GET') return [200, this.vista(query)]
        return no405
      } catch (e) {
        if (!(e instanceof ErrorAPI)) this.log.error('explorador: error interno')
        throw e
      }
    })
  }

  // MARK: carpetas dentro de $HOME

  private get home() { return realAunqueFalte(this.config.home) }

  private resolverEnHome(ruta: string): string {
    const home = this.home
    if (ruta === '') return home
    if (ruta.includes('\0') || !path.isAbsolute(ruta)) throw new ErrorAPI(400, 'La ruta tiene que ser absoluta.')
    const r = realAunqueFalte(ruta)
    if (!dentro(home, r)) throw new ErrorAPI(403, 'Solo se pueden explorar carpetas dentro de tu carpeta personal.')
    if (!fs.existsSync(r)) throw new ErrorAPI(404, 'No encontré esa carpeta.')
    if (!esDirectorio(r)) throw new ErrorAPI(400, 'Eso no es una carpeta.')
    return r
  }

  private accesos(home: string): Obj[] {
    const out: Obj[] = [{ nombre: 'Inicio', ruta: home }]
    for (const [nombre, rel] of [['Escritorio', 'Desktop'], ['Documentos', 'Documents'], ['Descargas', 'Downloads']] as const) {
      const r = realAunqueFalte(path.join(home, rel))
      if (dentro(home, r) && esDirectorio(r)) out.push({ nombre, ruta: r })
    }
    const ofi = realAunqueFalte(this.config.oficinasDir)
    if (dentro(home, ofi) && esDirectorio(ofi)) out.push({ nombre: 'Oficinas', ruta: ofi })
    return out
  }

  private carpetas(q: Query): Obj {
    const home = this.home
    const r = this.resolverEnHome((q.ruta ?? '').trim())
    const ocultas = q.ocultas === '1' || q.ocultas === 'true'
    const conZip = q.archivos === 'zip'
    const zips: Obj[] = []
    let nombres: string[]
    try {
      nombres = fs.readdirSync(r)
    } catch {
      throw new ErrorAPI(403, 'No tengo permiso para leer esa carpeta.')
    }
    nombres.sort(ordenar)
    const lista: Obj[] = []
    let truncado = false
    for (const n of nombres) {
      if (!ocultas && n.startsWith('.')) continue
      const p = path.join(r, n)
      if (esEnlace(p) && !dentro(home, realAunqueFalte(p))) continue // un enlace que sale de $HOME no se muestra
      if (!esDirectorio(p)) {
        if (conZip && n.toLowerCase().endsWith('.zip') && esArchivoRegular(p) && zips.length < maxEntradas) {
          zips.push({ nombre: n, ruta: p, tam: stat(p)?.size ?? 0 })
        }
        continue
      }
      if (lista.length >= maxEntradas) { truncado = true; break }
      lista.push({ nombre: n, ruta: p, esOficina: esArchivoRegular(path.join(p, 'oficina.json')) })
    }
    const out: Obj = {
      ruta: r, padre: r === home ? null : path.dirname(r), esOficina: esArchivoRegular(path.join(r, 'oficina.json')),
      accesos: this.accesos(home), carpetas: lista, truncado,
    }
    if (conZip) out.archivos = zips
    return out
  }

  private crearCarpeta(body?: Buffer): Obj {
    let d: unknown
    try {
      if (body && body.length > 0 && body.length <= 10_000) d = JSON.parse(body.toString('utf8'))
    } catch {}
    if (!esObjeto(d) || typeof d.padre !== 'string' || typeof d.nombre !== 'string') throw new ErrorAPI(400, 'pedido inválido')
    const p = d.padre.trim()
    if (p === '') throw new ErrorAPI(400, 'Falta la carpeta donde crearla.')
    const r = this.resolverEnHome(p)
    const nombre = nombreSaneado(d.nombre)
    if (nombre === '' || nombre === '.' || nombre === '..') throw new ErrorAPI(400, 'Ponele un nombre a la carpeta.')
    const destino = path.join(r, nombre)
    if (lstat(destino) !== undefined) throw new ErrorAPI(409, 'Ya existe algo con ese nombre.')
    try {
      fs.mkdirSync(destino)
    } catch {
      throw new ErrorAPI(403, 'No pude crear la carpeta ahí.')
    }
    return { ok: true, nombre, ruta: destino }
  }

  // MARK: carpeta de la oficina activa (solo lectura)

  /** Una ruta relativa a la oficina activa o, si es absoluta, dentro de una de sus carpetas de trabajo (trabajo.ts).
   *  `rel(partes)` da cómo se nombra una ruta de ahí para el front: relativa a la oficina, o absoluta en una carpeta de
   *  trabajo (así el front la vuelve a pedir igual). */
  private resolverEnOficina(relCruda: string): { base: string; real: string; partes: string[]; trabajo: boolean; rel: (p: string[]) => string } {
    const act = this.oficinas.requerirActiva()
    const recortada = relCruda.trim()
    const prohibido = new ErrorAPI(403, 'Esa ruta no está permitida.')
    if (path.isAbsolute(recortada)) {
      const t = enCarpetaTrabajo(act.oficina, recortada)
      if (!t) throw prohibido
      if (!fs.existsSync(t.real)) throw new ErrorAPI(404, 'No encontré eso en la carpeta de trabajo.')
      return { base: t.base, real: t.real, partes: t.partes, trabajo: true, rel: (p) => path.join(t.base, ...p).split(path.sep).join('/') }
    }
    const base = realAunqueFalte(act.carpeta)
    const rel = recortada.replace(/^\/+/, '').replace(/\/+$/, '')
    if (rel.includes('\0') || rel.includes('\\') || recortada.startsWith('/')) throw prohibido
    const partes = rel.split('/').filter((x) => x !== '' && x !== '.')
    partes.forEach((p, i) => { if (p === '..' || !parteOcultaPermitida(i, p)) throw prohibido })
    const r = partes.length === 0 ? base : realAunqueFalte(path.join(base, ...partes))
    if (!dentro(base, r)) throw prohibido
    if (!fs.existsSync(r)) throw new ErrorAPI(404, 'No encontré eso en la oficina.')
    return { base, real: r, partes, trabajo: false, rel: (p) => p.join('/') }
  }

  private archivos(q: Query): Obj {
    const { base, real: r, partes, trabajo, rel } = this.resolverEnOficina(q.ruta ?? '')
    if (!esDirectorio(r)) throw new ErrorAPI(400, 'Eso no es una carpeta.')
    let nombres: string[]
    try {
      nombres = fs.readdirSync(r)
    } catch {
      throw new ErrorAPI(403, 'No tengo permiso para leer esa carpeta.')
    }
    type Fila = { nombre: string; rel: string; dir: boolean; tam: number; mod: number }
    let filas: Fila[] = []
    for (const n of nombres) {
      if (trabajo ? n.startsWith('.') : !parteOcultaPermitida(partes.length, n)) continue
      if (!trabajo && partes.length === 1 && partes[0] === '.claude' && n !== 'agents') continue
      const rr = realAunqueFalte(path.join(r, n))
      const s = stat(rr)
      if (!dentro(base, rr) || !s) continue // enlace que sale de la oficina
      const dir = s.isDirectory()
      filas.push({ nombre: n, rel: rel([...partes, n]), dir, tam: dir ? 0 : s.size, mod: Math.floor(s.mtimeMs / 1000) })
    }
    filas.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : ordenar(a.nombre, b.nombre)))
    const truncado = filas.length > maxEntradas
    if (truncado) filas = filas.slice(0, maxEntradas)
    return {
      carpeta: base, ruta: rel(partes), truncado,
      archivos: filas.map((f) => ({ rel: f.rel, nombre: f.nombre, esCarpeta: f.dir, tam: f.tam, mod: f.mod })),
    }
  }

  /** Como `archivo`, pero lista para mostrar: una página HTML viene empaquetada (vista.ts), así el visor aislado del
   *  chat la ve con sus estilos e imágenes. Mismas reglas de ruta que el resto de la oficina. */
  private vista(q: Query): Obj {
    const { base, partes, real: r, trabajo } = this.resolverEnOficina(q.ruta ?? '')
    if (partes.length === 0) throw new ErrorAPI(400, 'Falta la ruta del archivo.')
    if (!esArchivoRegular(r)) throw new ErrorAPI(400, 'Eso no es un archivo.')
    // en una carpeta de trabajo, la página toma sus recursos de esa carpeta (y nada de afuera)
    return { vista: Vista.leer(trabajo ? base : this.oficinas.requerirActiva().carpeta, partes.join('/')) }
  }

  private archivo(q: Query): Obj {
    const { base, real: r, partes, rel } = this.resolverEnOficina(q.ruta ?? '')
    if (partes.length === 0) throw new ErrorAPI(400, 'Falta la ruta del archivo.')
    if (!esArchivoRegular(r)) throw new ErrorAPI(400, 'Eso no es un archivo.')
    const nombre = partes[partes.length - 1]!
    const ext = nombre.includes('.') ? nombre.split('.').pop()!.toLowerCase() : ''
    const s = stat(r)
    const tam = s?.size ?? 0
    const out: Obj = { rel: rel(partes), nombre, tam, mod: Math.floor((s?.mtimeMs ?? 0) / 1000), ruta: path.join(base, ...partes) }
    let fd: number
    try {
      fd = fs.openSync(r, 'r')
    } catch {
      throw new ErrorAPI(403, 'No tengo permiso para leer ese archivo.')
    }
    try {
      if (extTexto.has(ext)) {
        const buf = Buffer.alloc(maxTexto + 1)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        out.truncado = n > maxTexto
        out.texto = buf.subarray(0, Math.min(n, maxTexto)).toString('utf8')
      } else if (extImagen[ext]) {
        if (tam > maxImagen) throw new ErrorAPI(413, 'La imagen es demasiado grande para la vista previa (máximo 2 MB).')
        out.base64 = fs.readFileSync(r).toString('base64')
        out.mime = extImagen[ext]
      } else {
        out.sinVista = true
      }
    } finally {
      fs.closeSync(fd)
    }
    return out
  }
}
