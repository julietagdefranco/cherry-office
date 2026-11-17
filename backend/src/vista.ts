// Vista previa y retoques de los archivos de una entrega (docs/plan-vista-previa.md, fases V0 y V4).
//   - `Vista.leer`: el archivo listo para mostrar según su tipo (HTML empaquetado, markdown, texto, CSV, imagen, PDF).
//   - `Vista.empaquetar`: mete en la página sus CSS, JS, imágenes y fuentes relativas (el iframe aislado no puede pedirlas).
//   - `Vista.retocarHTML`: cambia un texto visible de la página, solo si aparece una vez en el fuente.
// Todo lo que se lee o escribe tiene que caer dentro de la carpeta de la oficina (enlaces simbólicos resueltos).
import fs from 'node:fs'
import path from 'node:path'
import { ErrorAPI } from './errores.js'
import { dentro, realAunqueFalte } from './explorador.js'
import type { Obj } from './json.js'

export const topesVista = {
  texto: 512 * 1024,
  imagen: 2 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  html: 5 * 1024 * 1024,
  recurso: 2 * 1024 * 1024,
  filasCSV: 500,
}

export type TipoVista = 'html' | 'markdown' | 'texto' | 'csv' | 'imagen' | 'pdf' | 'otro'

const extMarkdown = new Set(['md', 'markdown', 'mdown', 'mkd'])
const extTexto = new Set(['txt', 'json', 'log', 'xml', 'yaml', 'yml', 'mmd', 'mermaid'])
const extImagen: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
}
/** Lo que se puede meter como `data:` en una página. */
const mimeRecurso: Record<string, string> = {
  ...extImagen, ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
}

const extDe = (rel: string) => {
  const n = rel.split('/').pop() ?? ''
  return n.includes('.') ? n.split('.').pop()!.toLowerCase() : ''
}

export function tipoVista(rel: string): TipoVista {
  const e = extDe(rel)
  if (e === 'html' || e === 'htm') return 'html'
  if (extMarkdown.has(e)) return 'markdown'
  if (e === 'csv' || e === 'tsv') return 'csv'
  if (extImagen[e]) return 'imagen'
  if (e === 'pdf') return 'pdf'
  if (extTexto.has(e)) return 'texto'
  return 'otro'
}

/** Los tipos que se pueden retocar a mano: texto visible del HTML o el archivo entero si es texto. */
export const retocable = (t: TipoVista) => t === 'html' || t === 'markdown' || t === 'texto' || t === 'csv'

/** Ruta absoluta (real) de `rel` dentro de `carpeta`, o 403/404. */
export function resolverEnOficina(carpeta: string, rel: string): string {
  const prohibido = new ErrorAPI(403, 'Esa ruta no está permitida.')
  if (rel === '' || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || path.isAbsolute(rel)) throw prohibido
  if (rel.split('/').includes('..')) throw prohibido
  const base = realAunqueFalte(carpeta)
  const r = realAunqueFalte(path.join(base, ...rel.split('/')))
  if (!dentro(base, r) || r === base) throw prohibido
  let s: fs.Stats
  try { s = fs.statSync(r) } catch { throw new ErrorAPI(404, 'Ese archivo ya no está.') }
  if (s.isDirectory()) throw new ErrorAPI(400, 'Eso no es un archivo.')
  return r
}

const segundos = (s: fs.Stats) => Math.floor(s.mtimeMs / 1000)

export const Vista = {
  /** El archivo `rel` (ya validado como de la entrega) listo para mostrar. */
  leer(carpeta: string, rel: string): Obj {
    const abs = resolverEnOficina(carpeta, rel)
    const s = fs.statSync(abs)
    const tipo = tipoVista(rel)
    const out: Obj = { rel, nombre: rel.split('/').pop() ?? rel, tam: s.size, mod: segundos(s), ruta: abs, tipo, retocable: retocable(tipo) }
    switch (tipo) {
      case 'html': {
        if (s.size > topesVista.html) throw new ErrorAPI(413, 'La página es demasiado grande para la vista previa (máximo 5 MB).')
        const r = Vista.empaquetar(carpeta, rel, fs.readFileSync(abs, 'utf8'))
        out.html = r.html
        out.avisos = r.avisos
        break
      }
      case 'markdown': case 'texto': {
        const { texto, truncado } = leerTexto(abs)
        out.texto = texto
        out.truncado = truncado
        if (truncado) out.retocable = false
        break
      }
      case 'csv': {
        const { texto, truncado } = leerTexto(abs)
        const filas = parsearCSV(texto, extDe(rel) === 'tsv' ? '\t' : undefined)
        out.filas = filas.slice(0, topesVista.filasCSV)
        out.truncado = truncado || filas.length > topesVista.filasCSV
        out.texto = texto
        if (truncado) out.retocable = false
        break
      }
      case 'imagen': {
        if (s.size > topesVista.imagen) throw new ErrorAPI(413, 'La imagen es demasiado grande para la vista previa (máximo 2 MB).')
        out.base64 = fs.readFileSync(abs).toString('base64')
        out.mime = extImagen[extDe(rel)]
        break
      }
      case 'pdf': {
        if (s.size > topesVista.pdf) throw new ErrorAPI(413, 'El PDF es demasiado grande para la vista previa (máximo 10 MB).')
        out.base64 = fs.readFileSync(abs).toString('base64')
        out.mime = 'application/pdf'
        break
      }
      default:
        break
    }
    return out
  },

  /** Mete en la página los recursos relativos que viven en la oficina. Los `https:` quedan como están. */
  empaquetar(carpeta: string, relHtml: string, html: string): { html: string; avisos: string[] } {
    const avisos: string[] = []
    const dirHtml = path.posix.dirname(relHtml)
    const base = realAunqueFalte(carpeta)
    let total = 0

    /** Lee un recurso relativo a `dir` (relativa a la oficina); undefined (con aviso) si no se puede. */
    const leerRecurso = (dir: string, url: string): { buf: Buffer; ext: string; rel: string } | undefined => {
      const limpia = url.split('#')[0]!.split('?')[0]!
      let dec: string
      try { dec = decodeURIComponent(limpia) } catch { dec = limpia }
      if (dec === '') return undefined
      const rel = path.posix.normalize(path.posix.join(dir, dec))
      if (rel.startsWith('../') || rel === '..' || rel.startsWith('/')) { avisos.push(`«${url}» queda fuera de la oficina: no lo cargo.`); return undefined }
      const abs = realAunqueFalte(path.join(base, ...rel.split('/')))
      if (!dentro(base, abs)) { avisos.push(`«${url}» queda fuera de la oficina: no lo cargo.`); return undefined }
      let s: fs.Stats
      try { s = fs.statSync(abs) } catch { avisos.push(`No encontré «${url}».`); return undefined }
      if (s.isDirectory()) { avisos.push(`«${url}» es una carpeta.`); return undefined }
      if (s.size > topesVista.recurso) { avisos.push(`«${url}» es demasiado grande para la vista previa.`); return undefined }
      if (total + s.size > topesVista.html) { avisos.push(`La página con sus recursos pasa de 5 MB: «${url}» queda afuera.`); return undefined }
      total += s.size
      return { buf: fs.readFileSync(abs), ext: extDe(rel), rel }
    }
    const comoData = (dir: string, url: string): string | undefined => {
      if (!esRelativa(url)) return undefined
      const r = leerRecurso(dir, url)
      if (!r) return undefined
      const mime = mimeRecurso[r.ext]
      if (!mime) { avisos.push(`«${url}» no es de un tipo que pueda mostrar.`); return undefined }
      return `data:${mime};base64,${r.buf.toString('base64')}`
    }
    /** `url(...)` de un CSS que vive en `dir`. */
    const css = (dir: string, texto: string) => texto.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q: string, u: string) => {
      const d = comoData(dir, u.trim())
      return d ? `url(${q}${d}${q})` : m
    })

    let out = html
    // <link rel="stylesheet" href="x.css"> → <style>
    out = out.replace(/<link\b[^>]*>/gi, (tag) => {
      const rel = atributo(tag, 'rel')
      const href = atributo(tag, 'href')
      if (!rel || !/\bstylesheet\b/i.test(rel) || !href || !esRelativa(href)) return tag
      const r = leerRecurso(dirHtml, href)
      if (!r) return tag
      const media = atributo(tag, 'media')
      return `<style${media ? ` media="${escAtributo(media)}"` : ''}>${css(path.posix.dirname(r.rel), r.buf.toString('utf8')).replace(/<\/style/gi, '<\\/style')}</style>`
    })
    // <script src="x.js"></script> → en línea
    out = out.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (tag, attrs: string) => {
      const src = atributo(`<script${attrs}>`, 'src')
      if (!src || !esRelativa(src)) return tag
      const r = leerRecurso(dirHtml, src)
      if (!r) return tag
      const resto = attrs.replace(/\s(src|integrity|crossorigin)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      return `<script${resto}>${r.buf.toString('utf8').replace(/<\/script/gi, '<\\/script')}</script>`
    })
    // src / poster de imágenes, video, audio
    out = out.replace(/<(img|source|video|audio|input|track)\b[^>]*>/gi, (tag) =>
      tag.replace(/(\s(?:src|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, pre: string, _q: string, a?: string, b?: string) => {
        const d = comoData(dirHtml, (a ?? b ?? '').trim())
        return d ? `${pre}"${d}"` : m
      }))
    // url() en <style> y en style="…"
    out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a: string, cuerpo: string, c: string) => a + css(dirHtml, cuerpo) + c)
    out = out.replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, pre: string, _q: string, a?: string, b?: string) => {
      const v = a ?? b ?? ''
      if (!/url\(/i.test(v)) return m
      const q = a !== undefined ? '"' : "'"
      return `${pre}${q}${css(dirHtml, v)}${q}`
    })
    return { html: out, avisos: [...new Set(avisos)] }
  },

  /** Cambia `antes` por `despues` en el texto visible del HTML. 409 si no aparece una sola vez fuera de las etiquetas. */
  retocarHTML(fuente: string, antes: string, despues: string): string {
    const candidatos = [...new Set([antes, escTexto(antes), escTexto(antes).replace(/ /g, '&nbsp;')])]
    let hallado: { i: number; largo: number } | undefined
    let total = 0
    for (const c of candidatos) {
      const pos = posiciones(fuente, c)
      total += pos.length
      if (pos.length === 1 && !hallado) hallado = { i: pos[0]!, largo: c.length }
    }
    if (total === 0) throw new ErrorAPI(409, 'No encontré ese texto tal cual en el archivo. Pedíselo al agente.')
    if (total > 1 || !hallado) throw new ErrorAPI(409, 'Ese texto aparece más de una vez en el archivo. Pedíselo al agente.')
    if (dentroDeEtiqueta(fuente, hallado.i)) throw new ErrorAPI(409, 'Ese texto no está en el contenido de la página. Pedíselo al agente.')
    return fuente.slice(0, hallado.i) + escTexto(despues) + fuente.slice(hallado.i + hallado.largo)
  },

  segundos,
}

function leerTexto(abs: string): { texto: string; truncado: boolean } {
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(topesVista.texto + 1)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return { texto: buf.subarray(0, Math.min(n, topesVista.texto)).toString('utf8'), truncado: n > topesVista.texto }
  } finally {
    fs.closeSync(fd)
  }
}

/** CSV con comillas («a,"b, c",d»). Detecta `;` si la primera línea tiene más `;` que `,`. */
export function parsearCSV(texto: string, sep?: string): string[][] {
  const primera = texto.split(/\r?\n/, 1)[0] ?? ''
  const s = sep ?? ((primera.match(/;/g)?.length ?? 0) > (primera.match(/,/g)?.length ?? 0) ? ';' : ',')
  const filas: string[][] = []
  let fila: string[] = [], campo = '', comillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++ } else comillas = false
      } else campo += c
    } else if (c === '"' && campo === '') comillas = true
    else if (c === s) { fila.push(campo); campo = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++
      fila.push(campo); filas.push(fila); fila = []; campo = ''
      if (filas.length > topesVista.filasCSV) return filas
    } else campo += c
  }
  if (campo !== '' || fila.length > 0) { fila.push(campo); filas.push(fila) }
  return filas
}

const esRelativa = (u: string) => u !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//') && !u.startsWith('#')

/** Valor de un atributo de una etiqueta (`<x a="b">`), sin decodificar entidades salvo `&amp;`. */
function atributo(tag: string, nombre: string): string | undefined {
  const m = new RegExp(`\\s${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!m) return undefined
  return (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim()
}

const escAtributo = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const escTexto = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function posiciones(s: string, buscado: string): number[] {
  const out: number[] = []
  if (buscado === '') return out
  let i = s.indexOf(buscado)
  while (i !== -1) { out.push(i); i = s.indexOf(buscado, i + 1) }
  return out
}

/** ¿La posición `i` cae dentro de una etiqueta (`<a href="…">`) o de un comentario? */
function dentroDeEtiqueta(s: string, i: number): boolean {
  const abre = s.lastIndexOf('<', i), cierra = s.lastIndexOf('>', i)
  if (abre > cierra) return true
  const com = s.lastIndexOf('<!--', i)
  return com !== -1 && s.indexOf('-->', com) > i
}
