// Extracción de texto de los archivos de la biblioteca y utilidades de archivos (Extraccion.swift): nombres seguros,
// hash, tipos y escaneo de carpetas vinculadas.
//
// Diferencias con Swift (que usa PDFKit y textutil): PDF con `unpdf`, .docx con `mammoth`, .odt descomprimiendo
// `content.xml`, .rtf con un parser chico. Solo .doc y .pages siguen usando `/usr/bin/textutil` (solo macOS); en otras
// plataformas dan el mismo aviso que Swift cuando falta textutil.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { largo, prefijo } from './validar.js'

export const TipoArchivo = {
  pdf: 'pdf',
  documentos: new Set(['docx', 'doc', 'rtf', 'pages', 'odt']),
  planos: new Set(['txt', 'md', 'csv', 'tsv', 'json']),
  imagenes: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic']),
  get soportados(): Set<string> { return new Set([...this.documentos, ...this.planos, ...this.imagenes, this.pdf]) },
  get lista(): string { return [...this.soportados].sort().map((x) => '.' + x).join(' ') },

  /** Extensión en minúsculas, sin el punto ("" si no tiene). */
  extension(nombre: string): string { return path.extname(nombre).slice(1).toLowerCase() },
  /** Nombre sin la extensión. */
  sinExtension(nombre: string): string { return path.basename(nombre, path.extname(nombre)) },

  mime(ext: string): string {
    switch (ext) {
      case 'pdf': return 'application/pdf'
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      case 'doc': return 'application/msword'
      case 'rtf': return 'application/rtf'
      case 'odt': return 'application/vnd.oasis.opendocument.text'
      case 'pages': return 'application/vnd.apple.pages'
      case 'txt': return 'text/plain; charset=utf-8'
      case 'md': return 'text/markdown; charset=utf-8'
      case 'csv': return 'text/csv; charset=utf-8'
      case 'tsv': return 'text/tab-separated-values; charset=utf-8'
      case 'json': return 'application/json'
      case 'png': return 'image/png'
      case 'jpg': case 'jpeg': return 'image/jpeg'
      case 'gif': return 'image/gif'
      case 'webp': return 'image/webp'
      case 'heic': return 'image/heic'
      default: return 'application/octet-stream'
    }
  },
}

/** Texto máximo que se guarda por documento (caracteres). */
export const maxTexto = 2_000_000

export type Resultado = {
  texto?: string
  aviso?: string
  /** Es una imagen: el texto sale de describirla con Claude. */
  necesitaVision?: boolean
}

// MARK: nombres

const recortarEspacios = (s: string) => s.replace(/^[\s\u0085\u2028\u2029]+|[\s\u0085\u2028\u2029]+$/g, '')

/** Nombre de archivo seguro: sin rutas, sin `..`, sin caracteres de control ni `:`, sin punto inicial, hasta 120 caracteres. */
export function nombreSeguro(crudo: string): string {
  let s = crudo.replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  if (i >= 0) s = s.slice(i + 1)
  s = [...s].map((c) => {
    const v = c.codePointAt(0)!
    return v < 32 || v === 127 || ':*?"<>|'.includes(c) ? '-' : c
  }).join('')
  s = s.replaceAll('..', '.')
  s = recortarEspacios(s)
  while (s.startsWith('.')) s = s.slice(1)
  s = recortarEspacios(s)
  if (largo(s) > 120) {
    const ext = path.extname(s).slice(1)
    const base = path.basename(s, path.extname(s))
    const tope = Math.max(1, 119 - largo(ext))
    s = prefijo(base, tope) + (ext === '' ? '' : '.' + ext)
  }
  return s === '' ? 'archivo' : s
}

/** `nombre` dentro de `dir` sin pisar nada que exista: `nombre.ext`, `nombre-2.ext`, … */
export function rutaLibre(dir: string, nombre: string): string {
  let cand = path.join(dir, nombre)
  const ext = path.extname(nombre)
  const base = path.basename(nombre, ext)
  for (let n = 2; fs.existsSync(cand); n++) cand = path.join(dir, `${base}-${n}${ext}`)
  return cand
}

// MARK: hash

export const sha256 = (data: Buffer | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** SHA-256 de un archivo leído de a pedazos; undefined si no se puede abrir. */
export function sha256Archivo(ruta: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const h = createHash('sha256')
    const s = fs.createReadStream(ruta, { highWaterMark: 1 << 20 })
    s.on('data', (d) => h.update(d))
    s.on('error', () => resolve(undefined))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

// MARK: texto

export async function texto(ruta: string, ext: string): Promise<Resultado> {
  const r: Resultado = {}
  try {
    if (TipoArchivo.imagenes.has(ext)) r.necesitaVision = true
    else if (ext === TipoArchivo.pdf) await textoPDF(ruta, r)
    else if (ext === 'docx') await textoDocx(ruta, r)
    else if (ext === 'odt') textoOdt(ruta, r)
    else if (ext === 'rtf') textoRtf(ruta, r)
    else if (TipoArchivo.documentos.has(ext)) await textoTextutil(ruta, ext, r)
    else textoPlano(ruta, r)
  } catch {
    r.aviso = 'No pude leer el archivo.'
  }
  if (r.texto !== undefined && r.texto.length > maxTexto && largo(r.texto) > maxTexto) r.texto = prefijo(r.texto, maxTexto)
  return r
}

const limpiar = (t: string) => t.replace(/^[\s\u0085\u2028\u2029]+|[\s\u0085\u2028\u2029]+$/g, '')

async function textoPDF(ruta: string, r: Resultado) {
  let buf: Buffer
  try { buf = fs.readFileSync(ruta) } catch { r.aviso = 'No pude abrir el PDF.'; return }
  const { getDocumentProxy, extractText } = await import('unpdf')
  let t: string
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const res = await extractText(pdf, { mergePages: true })
    t = limpiar(res.text)
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()
  } catch (e) {
    const n = e instanceof Error ? e.name : ''
    r.aviso = n === 'PasswordException' ? 'El PDF está protegido con contraseña.' : 'No pude abrir el PDF.'
    return
  }
  if (t === '') r.aviso = 'El PDF no tiene texto (¿es un escaneo?).'
  else r.texto = t
}

async function textoDocx(ruta: string, r: Resultado) {
  try {
    const mammoth = (await import('mammoth')).default
    const res = await mammoth.extractRawText({ buffer: fs.readFileSync(ruta) })
    const t = limpiar(res.value)
    if (t === '') r.aviso = 'El documento no tiene texto.'
    else r.texto = t
  } catch {
    r.aviso = 'No pude leer el texto de este documento (.docx).'
  }
}

const entidades: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodificarEntidades = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  }
  return entidades[e.toLowerCase()] ?? m
})

function textoOdt(ruta: string, r: Resultado) {
  try {
    const archivos = unzipSync(new Uint8Array(fs.readFileSync(ruta)), { filter: (f) => f.name === 'content.xml' })
    const xml = archivos['content.xml']
    if (!xml) { r.aviso = 'No pude leer el texto de este documento (.odt).'; return }
    const t = limpiar(decodificarEntidades(
      Buffer.from(xml).toString('utf8')
        .replace(/<text:tab\s*\/>/g, '\t')
        .replace(/<text:line-break\s*\/>/g, '\n')
        .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_m, n: string | undefined) => ' '.repeat(n ? Math.min(parseInt(n, 10), 100) : 1))
        .replace(/<\/text:(?:p|h)>/g, '\n')
        .replace(/<[^>]*>/g, ''),
    )).replace(/\n{3,}/g, '\n\n')
    if (t === '') r.aviso = 'El documento no tiene texto.'
    else r.texto = t
  } catch {
    r.aviso = 'No pude leer el texto de este documento (.odt).'
  }
}

// RTF: parser chico (grupos, palabras de control, \'hh, \uN). Ignora las tablas de fuentes/colores/estilos y las
// destinos `\*`. Alcanza para texto corrido; no pretende ser completo.
const destinosIgnorados = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl',
  'footerr', 'fldinst', 'generator', 'themedata', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl',
  'xmlnstbl', 'object', 'private', 'colorschememapping', 'filetbl', 'pgptbl', 'protusertbl', 'userprops', 'wgrffmtfilter'])
const simbolos: Record<string, string> = { bullet: '•', endash: '–', emdash: '—', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  tab: '\t', par: '\n', line: '\n', page: '\n', sect: '\n', cell: '\t', row: '\n', emspace: ' ', enspace: ' ' }

export function rtfATexto(buf: Buffer): string {
  const cp1252 = new TextDecoder('windows-1252')
  const s = cp1252.decode(buf)
  type Estado = { ignorar: boolean; uc: number; saltar: number }
  const pila: Estado[] = []
  let e: Estado = { ignorar: false, uc: 1, saltar: 0 }
  let out = ''
  const emitir = (t: string) => { if (!e.ignorar) out += t }
  for (let i = 0; i < s.length;) {
    const c = s[i]!
    if (c === '{') { pila.push({ ...e }); i++; continue }
    if (c === '}') { e = pila.pop() ?? e; i++; continue }
    if (c === '\r' || c === '\n') { i++; continue }
    if (c !== '\\') {
      if (e.saltar > 0) e.saltar--
      else emitir(c)
      i++
      continue
    }
    const n = s[i + 1]
    if (n === undefined) break
    if ('\\{}'.includes(n)) { if (e.saltar > 0) e.saltar--; else emitir(n); i += 2; continue }
    if (n === "'") {
      const hex = s.slice(i + 2, i + 4)
      const v = parseInt(hex, 16)
      i += 4
      if (e.saltar > 0) { e.saltar--; continue }
      if (Number.isFinite(v)) emitir(cp1252.decode(Uint8Array.of(v)))
      continue
    }
    if (n === '*') { e.ignorar = true; i += 2; continue }
    if (n === '~') { emitir(' '); i += 2; continue }
    if (n === '_') { emitir('-'); i += 2; continue }
    if (n === '-' || n === '|' || n === ':') { i += 2; continue }
    if (n === '\n' || n === '\r') { emitir('\n'); i += 2; continue }
    if (!/[a-zA-Z]/.test(n)) { i += 2; continue }
    // palabra de control
    let j = i + 1
    while (j < s.length && /[a-zA-Z]/.test(s[j]!)) j++
    const palabra = s.slice(i + 1, j)
    let k = j
    if (s[k] === '-') k++
    while (k < s.length && /\d/.test(s[k]!)) k++
    const param = k > j ? parseInt(s.slice(j, k), 10) : undefined
    if (s[k] === ' ') k++
    i = k
    if (destinosIgnorados.has(palabra)) { e.ignorar = true; continue }
    if (palabra === 'uc' && param !== undefined) { e.uc = param; continue }
    if (palabra === 'u' && param !== undefined) {
      emitir(String.fromCharCode(param < 0 ? param + 65536 : param))
      e.saltar = e.uc
      continue
    }
    const sim = simbolos[palabra]
    if (sim !== undefined) emitir(sim)
  }
  return out
}

function textoRtf(ruta: string, r: Resultado) {
  const buf = fs.readFileSync(ruta)
  if (!buf.subarray(0, 8).toString('latin1').startsWith('{\\rtf')) { r.aviso = 'No pude leer el texto de este documento (.rtf).'; return }
  const t = limpiar(rtfATexto(buf)).replace(/\n{3,}/g, '\n\n')
  if (t === '') r.aviso = 'El documento no tiene texto.'
  else r.texto = t
}

const textutil = '/usr/bin/textutil'

/** .doc y .pages: solo con textutil (macOS). */
async function textoTextutil(ruta: string, ext: string, r: Resultado) {
  if (process.platform !== 'darwin' || !fs.existsSync(textutil)) {
    r.aviso = 'No encuentro textutil para leer este tipo de documento.'
    return
  }
  const res = await correrTextutil(ruta)
  if (res !== undefined) {
    const t = limpiar(res)
    if (t === '') r.aviso = 'El documento no tiene texto.'
    else r.texto = t
  } else {
    r.aviso = `No pude leer el texto de este documento (.${ext}).`
  }
}

function correrTextutil(ruta: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const hijo = spawn(textutil, ['-convert', 'txt', '-stdout', ruta], { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const trozos: Buffer[] = []
    let vencido = false
    const t = setTimeout(() => { vencido = true; hijo.kill('SIGKILL') }, 60_000)
    hijo.stdout.on('data', (d: Buffer) => trozos.push(d))
    hijo.on('error', () => { clearTimeout(t); resolve(undefined) })
    hijo.on('close', (rc) => {
      clearTimeout(t)
      resolve(rc === 0 && !vencido ? Buffer.concat(trozos).toString('utf8') : undefined)
    })
  })
}

function textoPlano(ruta: string, r: Resultado) {
  let d: Buffer
  try { d = fs.readFileSync(ruta) } catch { r.aviso = 'No pude leer el archivo.'; return }
  let t: string
  try {
    t = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(d)
  } catch {
    t = d.toString('latin1')
  }
  t = limpiar(t)
  if (t === '') r.aviso = 'El archivo está vacío.'
  else r.texto = t
}

// MARK: escaneo de carpetas vinculadas

export type Hallado = { ruta: string; tam: number; hash: string }
export type Escaneo = {
  hallados: Hallado[]
  /** Archivos soportados que no entraron (demasiado grandes o por pasar el tope). */
  omitidos: number
  tope: boolean
}

const paquetes = new Set(['.app', '.bundle', '.framework', '.plugin', '.rtfd', '.photoslibrary', '.xcodeproj', '.xcworkspace', '.pkg'])

/** Recorre `raiz` (sin ocultos ni enlaces simbólicos), solo extensiones soportadas, con tope de archivos y de bytes. */
export async function escanear(raiz: string, p: { maxArchivos: number; maxBytes: number; maxArchivoBytes: number }): Promise<Escaneo> {
  const out: Escaneo = { hallados: [], omitidos: 0, tope: false }
  const candidatos: [string, number][] = []
  const soportados = TipoArchivo.soportados
  const recorrer = (dir: string) => {
    let entradas: fs.Dirent[]
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const d of entradas) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue
      const ruta = path.join(dir, d.name)
      if (d.isDirectory()) {
        if (!paquetes.has(path.extname(d.name).toLowerCase())) recorrer(ruta)
      } else if (d.isFile() && soportados.has(TipoArchivo.extension(d.name))) {
        let tam = 0
        try { tam = fs.statSync(ruta).size } catch { continue }
        candidatos.push([ruta, tam])
      }
    }
  }
  recorrer(raiz)
  candidatos.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  let total = 0
  for (const [ruta, tam] of candidatos) {
    if (tam > p.maxArchivoBytes) { out.omitidos++; continue }
    if (out.hallados.length >= p.maxArchivos || total + tam > p.maxBytes) { out.omitidos++; out.tope = true; continue }
    const hash = await sha256Archivo(ruta)
    if (hash === undefined) { out.omitidos++; continue }
    total += tam
    out.hallados.push({ ruta, tam, hash })
  }
  return out
}
