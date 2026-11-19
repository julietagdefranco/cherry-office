// Texto para comparar: palabras significativas y parecido entre dos textos. Vive acá (y no en `reuniones.ts` ni en
// `conocimiento.ts`) para que lo usen la memoria y el resto sin armar ciclos de imports.
import { plegar } from './validar.js'

/** Minúsculas y sin acentos. */
export const plano = (s: string) => plegar(s)

/** Palabras ASCII alfanuméricas del texto plano. */
export function palabras(s: string): string[] {
  return plano(s).split(/[^0-9a-z]+/).filter((x) => x !== '')
}

export const vacias = new Set([
  'para', 'como', 'sobre', 'este', 'esta', 'esto', 'estos', 'estas', 'entre', 'desde', 'hasta', 'cuando', 'donde',
  'porque', 'pero', 'tiene', 'tener', 'hacer', 'queremos', 'podemos', 'vamos', 'nuestro', 'nuestra', 'nuestros',
  'nuestras', 'algo', 'cada', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras', 'mucho', 'mucha',
  'tambien', 'ademas', 'hacia', 'segun', 'tema', 'reunion', 'ronda',
])

export function coincide(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < 5 || b.length < 5) return false
  return a.slice(0, 5) === b.slice(0, 5)
}

/** Palabras que no sirven para comparar preguntas ni buscar (además de las `vacias` de las reuniones). */
const vaciasExtra = new Set([
  'que', 'qué', 'con', 'los', 'las', 'del', 'una', 'uno', 'unos', 'unas', 'por', 'mas', 'muy', 'hay', 'son', 'sus', 'les',
  'nos', 'ese', 'esa', 'eso', 'cual', 'cuales', 'quien', 'quienes', 'como', 'tenes', 'sabes', 'sabe', 'saber', 'podes',
  'puede', 'pueden', 'hola', 'gracias', 'favor', 'era', 'fue', 'ser', 'estar', 'esta', 'estan', 'tenemos', 'the', 'and',
])

/** Palabras significativas (sin acentos, minúsculas, de 3 letras o más, sin las vacías), sin repetir. */
export function claves(s: string): string[] {
  const out: string[] = []
  for (const p of palabras(s)) if (p.length >= 3 && !vacias.has(p) && !vaciasExtra.has(p) && !out.includes(p)) out.push(p)
  return out
}

/** Parecido entre dos textos: coeficiente de Dice sobre sus `claves` (prefijo de 5 letras, ver `coincide`). 0 a 1. */
export function similitud(a: string, b: string): number {
  const A = claves(a), B = claves(b)
  if (A.length === 0 || B.length === 0) return 0
  let m = 0
  for (const x of A) if (B.some((y) => coincide(x, y))) m++
  return (2 * m) / (A.length + B.length)
}
