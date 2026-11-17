// Slugs, UUIDs y validaciones de texto (Slug, Router.uuidValido, Config.esIdValido, Validar de Swift).
import { createHash } from 'node:crypto'
import { ErrorAPI } from './errores.js'

const segmentador = new Intl.Segmenter('es', { granularity: 'grapheme' })

/** Largo en grafemas, como `String.count` de Swift (no `.length`, que cuenta unidades UTF-16). */
export function largo(s: string): number {
  let n = 0
  for (const _ of segmentador.segment(s)) n++
  return n
}

/** Los primeros `n` grafemas (`String.prefix(n)` de Swift). */
export function prefijo(s: string, n: number): string {
  let out = ''
  let i = 0
  for (const g of segmentador.segment(s)) {
    if (i++ >= n) break
    out += g.segment
  }
  return out
}

/** Minúsculas y sin acentos (folding diacriticInsensitive + caseInsensitive). */
export function plegar(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

const alnumMin = (c: number) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122)

export const Slug = {
  /** `^[a-z0-9][a-z0-9-]{0,40}$` */
  valido(s: string): boolean {
    const u = Buffer.from(s, 'utf8')
    if (u.length === 0 || u.length > 41 || !alnumMin(u[0]!)) return false
    return u.every((c) => alnumMin(c) || c === 45)
  },

  /** Minúsculas, sin acentos, no alfanuméricos -> "-". Puede dar "" si no queda nada. */
  de(s: string): string {
    let out = ''
    let guion = false
    for (const ch of plegar(s)) {
      const c = ch.codePointAt(0)!
      if (c < 128 && alnumMin(c)) {
        out += ch
        guion = false
      } else if (!guion && out !== '') {
        out += '-'
        guion = true
      }
    }
    out = out.replace(/-+$/, '')
    if (out.length > 41) out = out.slice(0, 41).replace(/-+$/, '')
    return out
  },

  /** Slug de `s` que no esté en `usados` (agrega -2, -3...). `respaldo` si `s` no da nada. */
  unico(s: string, usados: Set<string>, respaldo: string): string {
    let base = Slug.de(s)
    if (base === '') base = respaldo
    if (!usados.has(base)) return base
    for (let n = 2; ; n++) {
      const suf = `-${n}`
      const c = base.slice(0, 41 - suf.length) + suf
      if (!usados.has(c)) return c
    }
  },
}

/** UUID con guiones (mayúsculas o minúsculas). */
/** UUID fijo derivado de un texto (sha256 con forma de v4): la misma sesión de claude para la misma clave, sin guardarla. */
export function uuidDe(texto: string): string {
  const h = createHash('sha256').update(texto).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function uuidValido(s: string): boolean {
  if (s.length !== 36) return false
  for (let i = 0; i < 36; i++) {
    const c = s.charCodeAt(i)
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 45) return false
    } else if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return false
  }
  return true
}

/** Id de agente de la config: ASCII alfanumérico al inicio, luego alfanuméricos, `_` o `-`; hasta 64. */
export function esIdValido(s: string): boolean {
  if (s === '' || largo(s) > 64) return false
  const alnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  if (!alnum(s.charCodeAt(0))) return false
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (!(alnum(c) || c === 95 || c === 45)) return false
  }
  return true
}

export const Validar = {
  reservados: new Set(['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude-code-guide', 'claude', 'persona', 'creador']),
  modelos: new Set(['sonnet', 'opus', 'haiku', 'inherit']),
  /** `--effort` de Claude Code: cuánto piensa antes de responder. Más esfuerzo = más tokens (los de pensar se cobran como salida). */
  esfuerzos: new Set(['low', 'medium', 'high', 'xhigh', 'max']),

  colorHex(s: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(s)
  },

  /** Cadena recortada y no vacía de tamaño razonable, o error 400. `undefined` si no es obligatoria y falta. */
  texto(v: unknown, campo: string, max: number, obligatorio = true): string | undefined {
    if (v === undefined || v === null) {
      if (obligatorio) throw new ErrorAPI(400, `Falta «${campo}».`)
      return undefined
    }
    if (typeof v !== 'string') throw new ErrorAPI(400, `«${campo}» tiene que ser texto.`)
    const t = v.trim()
    if (t === '') {
      if (obligatorio) throw new ErrorAPI(400, `Falta «${campo}».`)
      return undefined
    }
    if (largo(t) > max) throw new ErrorAPI(400, `«${campo}» es demasiado largo (máximo ${max} caracteres).`)
    return t
  },

  /** Relativa, dentro de `conocimiento/`, sin `..`. */
  rutaEscrituraValida(r: string): boolean {
    return r.startsWith('conocimiento/') && !r.includes('..') && !r.includes('\0') && !r.endsWith('/')
  },
}
