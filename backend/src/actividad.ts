// Qué está haciendo cada agente ahora mismo (en memoria). Lo alimentan los eventos de stream-json de cada corrida y lo
// lee el front por GET /api/actividad (Actividad.swift).
import { randomUUID } from 'node:crypto'
import type { Obj } from './json.js'
import type { EventoClaude, Observador } from './stream.js'
import { largo, prefijo } from './validar.js'

export type EstadoAgente = {
  /** pensando | leyendo | escribiendo | buscando | consultando | armando | trabajando */
  estado: string
  herramienta?: string
  objetivo?: string
  /** Qué es la corrida, fijo: «Respondiéndote», el tema de la reunión, el nombre de la tarea… */
  tarea?: string
  /** chat | reunion | biblioteca | tarea | consulta | creador */
  origen: string
  desde: number
}

/** Tipos de tarjeta del Creador (TarjetasStore.swift). */
export const tiposTarjeta = ['departamento', 'agente', 'flujo', 'regla', 'conector', 'tarea']

export class ActividadRegistro {
  /** clave (oficina \u001f agente) -> corridas en curso por token (un agente puede consultar mientras chatea). */
  private corridas = new Map<string, Map<string, EstadoAgente>>()
  private orden = new Map<string, string[]>()
  version = 0

  constructor(private readonly reloj: () => number = () => Date.now()) {}

  static clave(oficina: string, agente: string) { return oficina + '\u001f' + agente }

  /** Estado visible según la herramienta. */
  static estado(n: string): string {
    if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(n)) return 'leyendo'
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(n)) return 'escribiendo'
    if (n === 'WebSearch' || n === 'WebFetch') return 'buscando'
    if (n.startsWith('mcp__hq__consultar')) return 'consultando'
    return ActividadRegistro.tipoCreador(n) !== undefined || n === 'mcp__hq__marcar_faltante' ? 'armando' : 'trabajando'
  }

  /** `mcp__hq__proponer_<tipo>` del Creador -> el tipo de tarjeta (`proponer_accion` es de los agentes). */
  static tipoCreador(h: string): string | undefined {
    const pref = 'mcp__hq__proponer_'
    if (!h.startsWith(pref)) return undefined
    const t = h.slice(pref.length)
    return tiposTarjeta.includes(t) ? t : undefined
  }

  /** Recorta un pedido para mostrarlo mientras llega el resumen. */
  static recortar(s: string, max = 48): string {
    const t = s.replace(/\n/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '')
    return largo(t) > max ? prefijo(t, max - 1) + '…' : t
  }

  /** Empieza una corrida. Devuelve un token para `terminar`. */
  empezar(oficina: string, agente: string, origen: string, tarea?: string): string {
    const token = randomUUID()
    const k = ActividadRegistro.clave(oficina, agente)
    if (!this.corridas.has(k)) this.corridas.set(k, new Map())
    this.corridas.get(k)!.set(token, {
      estado: 'pensando', tarea: tarea === undefined ? undefined : ActividadRegistro.recortar(tarea), origen, desde: this.reloj(),
    })
    this.orden.set(k, [...(this.orden.get(k) ?? []), token])
    this.version++
    return token
  }

  terminar(oficina: string, agente: string, token: string) {
    const k = ActividadRegistro.clave(oficina, agente)
    this.corridas.get(k)?.delete(token)
    this.orden.set(k, (this.orden.get(k) ?? []).filter((t) => t !== token))
    if ((this.corridas.get(k)?.size ?? 0) === 0) {
      this.corridas.delete(k)
      this.orden.delete(k)
    }
    this.version++
  }

  /** Sube la versión sin cambiar nada (p. ej. llegó o se fue un pedido de permiso): el front vuelve a leer todo. */
  tocar() { this.version++ }

  /** Reemplaza el texto de la tarea (cuando llega el resumen). */
  tarea(oficina: string, agente: string, token: string, texto: string) {
    const e = this.corridas.get(ActividadRegistro.clave(oficina, agente))?.get(token)
    if (!e) return
    e.tarea = texto
    this.version++
  }

  aplicar(oficina: string, agente: string, token: string, e: EventoClaude) {
    const est = this.corridas.get(ActividadRegistro.clave(oficina, agente))?.get(token)
    if (!est) return
    if (e.tipo === 'pensando' || e.tipo === 'texto') {
      est.estado = 'pensando'
      delete est.herramienta
      delete est.objetivo
    } else if (e.tipo === 'herramienta') {
      est.estado = ActividadRegistro.estado(e.nombre)
      est.herramienta = e.nombre
      est.objetivo = ActividadRegistro.tipoCreador(e.nombre) ?? e.objetivo
    } else return
    this.version++
  }

  observador(oficina: string, agente: string, token: string): Observador {
    return (e) => this.aplicar(oficina, agente, token, e)
  }

  /** Estado actual de cada agente de una oficina (la corrida más reciente gana). */
  vista(oficina: string): Map<string, EstadoAgente> {
    const out = new Map<string, EstadoAgente>()
    const pref = oficina + '\u001f'
    for (const [k, tokens] of this.orden) {
      if (!k.startsWith(pref)) continue
      const t = tokens[tokens.length - 1]
      const e = t === undefined ? undefined : this.corridas.get(k)?.get(t)
      if (e) out.set(k.slice(pref.length), e)
    }
    return out
  }

  json(oficina: string): Obj {
    const ahora = this.reloj()
    const ags: Obj = {}
    for (const [id, e] of this.vista(oficina)) {
      const d: Obj = { estado: e.estado, origen: e.origen, seg: Math.trunc((ahora - e.desde) / 1000) }
      if (e.herramienta !== undefined) d.herramienta = e.herramienta
      if (e.objetivo !== undefined) d.objetivo = e.objetivo
      if (e.tarea !== undefined) d.tarea = e.tarea
      ags[id] = d
    }
    return { agentes: ags, version: this.version }
  }

  /** Envuelve una corrida: empieza, pasa el observador (más `extra`) y termina pase lo que pase. */
  async seguir<T>(p: { oficina: string; agente: string; origen: string; tarea?: string; extra?: Observador },
    body: (obs: Observador, token: string) => Promise<T>): Promise<T> {
    const token = this.empezar(p.oficina, p.agente, p.origen, p.tarea)
    try {
      const mio = this.observador(p.oficina, p.agente, token)
      const obs: Observador = p.extra ? (e) => { mio(e); p.extra!(e) } : mio
      return await body(obs, token)
    } finally {
      this.terminar(p.oficina, p.agente, token)
    }
  }
}
