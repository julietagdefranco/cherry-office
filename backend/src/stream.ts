// Eventos de `claude -p --output-format stream-json --verbose`, reducidos a lo que la oficina muestra (Stream.swift).
// Nunca llevan contenido de archivos ni resultados de herramientas: solo nombres de herramientas y un objetivo corto.
// El único contenido es el texto que el agente le escribe a la persona (`texto.contenido`), que solo usa la vista en
// vivo del chat (CajaVivo); la actividad de la oficina lo ignora.
import path from 'node:path'
import { esObjeto } from './json.js'
import { largo, prefijo } from './validar.js'

export type EventoClaude =
  | { tipo: 'inicio'; sesion: string }
  | { tipo: 'pensando' }
  | { tipo: 'herramienta'; nombre: string; objetivo?: string }
  /** Ruta de un archivo que el agente escribió (Write, Edit, NotebookEdit). Llega después de su `herramienta`. */
  | { tipo: 'archivo'; ruta: string }
  /** Un bloque de texto de la respuesta. `contenido` solo lo lee el chat en vivo; nunca va a /api/actividad. */
  | { tipo: 'texto'; contenido?: string }
  | { tipo: 'resultado'; costo?: number; error: boolean }

/** Recibe los eventos de una corrida, en orden. */
export type Observador = (e: EventoClaude) => void

/** Herramientas que escriben un archivo (su ruta llega en `file_path` o `notebook_path`). */
const escritoras = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Eventos de una línea (una línea `assistant` puede traer varios bloques). Lo que no es JSON o no se conoce: []. */
export function parsearEvento(linea: string): EventoClaude[] {
  let o: unknown
  try {
    o = JSON.parse(linea)
  } catch {
    return []
  }
  if (!esObjeto(o) || typeof o.type !== 'string') return []
  switch (o.type) {
    case 'system':
      return o.subtype === 'init' && typeof o.session_id === 'string' ? [{ tipo: 'inicio', sesion: o.session_id }] : []
    case 'assistant': {
      const msg = esObjeto(o.message) ? o.message : {}
      const bloques = Array.isArray(msg.content) ? msg.content.filter(esObjeto) : []
      return bloques.flatMap((b): EventoClaude[] => {
        if (b.type === 'thinking') return [{ tipo: 'pensando' }]
        if (b.type === 'text') return [typeof b.text === 'string' && b.text !== '' ? { tipo: 'texto', contenido: b.text } : { tipo: 'texto' }]
        if (b.type !== 'tool_use' || typeof b.name !== 'string') return []
        const input = esObjeto(b.input) ? b.input : {}
        const out: EventoClaude[] = [{ tipo: 'herramienta', nombre: b.name, objetivo: objetivo(input) }]
        const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
        if (escritoras.has(b.name) && p !== '') out.push({ tipo: 'archivo', ruta: p })
        return out
      })
    }
    case 'result':
      return [{ tipo: 'resultado', costo: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined, error: o.is_error === true }]
    default:
      return []
  }
}

/** Objetivo legible y corto de una herramienta: nombre de archivo, patrón, dominio o colega. Sin contenido. */
export function objetivo(input: Record<string, unknown>): string | undefined {
  const corto = (s: string) => (largo(s) > 60 ? prefijo(s, 59) + '…' : s)
  const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
  const p = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : undefined
  if (p) return corto(path.posix.basename(p.replace(/\\/g, '/')))
  if (s(input.pattern)) return corto(input.pattern as string)
  if (typeof input.url === 'string') {
    try {
      const h = new URL(input.url).hostname
      if (h) return corto(h)
    } catch {}
  }
  if (s(input.query)) return corto(input.query as string)
  if (s(input.colega)) return corto(input.colega as string)
  return undefined
}

/** Corta bytes en líneas completas (los chunks del pipe pueden partir una línea o un carácter UTF-8). */
export class CortadorLineas {
  private buf: Buffer = Buffer.alloc(0)
  constructor(private readonly alLinea: (l: string) => void) {}

  agregar(d: Buffer) {
    this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d])
    let i: number
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const linea = this.buf.subarray(0, i)
      this.buf = this.buf.subarray(i + 1)
      if (linea.length > 0) this.alLinea(linea.toString('utf8'))
    }
  }

  /** Lo que quedó sin `\n` al final. */
  terminar() {
    if (this.buf.length > 0) {
      this.alLinea(this.buf.toString('utf8'))
      this.buf = Buffer.alloc(0)
    }
  }
}

/** Junta el costo de una o varias corridas. */
export class CajaCosto {
  private total?: number
  sumar(c?: number) { if (c !== undefined) this.total = (this.total ?? 0) + c }
  get valor() { return this.total }
  /** Observador que suma el costo del `resultado` y reenvía todo a `siguiente`. */
  observador(siguiente?: Observador): Observador {
    return (e) => {
      if (e.tipo === 'resultado') this.sumar(e.costo)
      siguiente?.(e)
    }
  }
}

/** Junta las rutas de los archivos escritos, sin repetir y en orden. */
export class CajaArchivos {
  private rutas: string[] = []
  agregar(r: string) { if (!this.rutas.includes(r)) this.rutas.push(r) }
  get valor() { return [...this.rutas] }
  observador(siguiente?: Observador): Observador {
    return (e) => {
      if (e.tipo === 'archivo') this.agregar(e.ruta)
      siguiente?.(e)
    }
  }
}

/** Un paso de la respuesta en vivo del chat: un bloque de texto, una herramienta o un archivo escrito. */
export type PasoVivo =
  | { t: 'texto'; c: string }
  | { t: 'herramienta'; nombre: string; objetivo?: string }
  | { t: 'archivo'; ruta: string }

/** Lo que el agente va haciendo en un chat, en orden, para mostrarlo mientras escribe (como Claude Code).
 *  Guarda el texto que le escribe a la persona y los nombres de herramientas con su objetivo corto, nunca resultados. */
export class CajaVivo {
  static readonly maxPasos = 400
  private pasos: PasoVivo[] = []
  /** Sube con cada cambio: el front pide de nuevo solo si cambió. */
  version = 0
  get valor(): PasoVivo[] { return [...this.pasos] }
  agregar(p: PasoVivo) {
    if (this.pasos.length >= CajaVivo.maxPasos) this.pasos.splice(0, 1)
    this.pasos.push(p)
    this.version++
  }
  observador(siguiente?: Observador): Observador {
    return (e) => {
      if (e.tipo === 'texto' && e.contenido !== undefined) this.agregar({ t: 'texto', c: e.contenido })
      else if (e.tipo === 'herramienta') this.agregar(e.objetivo !== undefined ? { t: 'herramienta', nombre: e.nombre, objetivo: e.objetivo } : { t: 'herramienta', nombre: e.nombre })
      else if (e.tipo === 'archivo') this.agregar({ t: 'archivo', ruta: e.ruta })
      siguiente?.(e)
    }
  }
}
