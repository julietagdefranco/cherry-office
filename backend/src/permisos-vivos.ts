// Pedidos de permiso en vivo (PermisosVivos.swift), en memoria. La herramienta MCP `pedir_permiso` crea un pedido y espera;
// el front los ve en `GET /api/actividad` (`permisos`) y responde con `POST /api/permisos/<id>`. Si nadie responde en
// `timeout`, o el chat termina antes, el pedido se rechaza.
import { randomUUID } from 'node:crypto'
import { sanear } from './consultas.js'
import { jsonCompacto } from './json-swift.js'
import type { IdentidadMCP } from './mcp-protocolo.js'
import type { Obj } from './json.js'
import { largo, prefijo } from './validar.js'

/** Un pedido de permiso de un agente que espera la respuesta de la persona (claude `--permission-prompt-tool`). */
export type PedidoPermiso = {
  id: string
  oficina: string
  agente: string
  sid: string
  /** Herramienta de claude que pide permiso (`Bash`, `Edit`, `Write`...). */
  herramienta: string
  /** Qué quiere hacer: el comando o la ruta del archivo (recortado). */
  detalle: string
  /** Descripción corta que manda claude con el comando (Bash), si vino. */
  descripcion?: string
  /** Reglas de `--allowedTools` que se guardan con «Siempre» (vacío = solo se puede permitir una vez). */
  reglas: string[]
  ts: number
}

export const pedidoJSON = (p: PedidoPermiso): Obj => {
  const d: Obj = { id: p.id, agente: p.agente, herramienta: p.herramienta, detalle: p.detalle, reglas: p.reglas, ts: p.ts }
  if (p.descripcion !== undefined) d.descripcion = p.descripcion
  return d
}

/** Qué respondió la persona. */
export type DecisionPermiso = 'una_vez' | 'siempre' | 'rechazar'
export const decisionesPermiso: DecisionPermiso[] = ['una_vez', 'siempre', 'rechazar']

type Entrada = { pedido: PedidoPermiso; token: string; resolver: (d: DecisionPermiso | undefined) => void; timer?: NodeJS.Timeout }

/** Programas en los que el permiso «siempre» incluye el subcomando (`git pull`, `npm install`). */
const conSubcomando = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'swift', 'cargo', 'go', 'docker', 'brew', 'pip', 'pip3', 'uv', 'gh', 'kubectl', 'make'])

export class PermisosVivos {
  static readonly maxDetalle = 2000
  static readonly maxPendientes = 20
  /** Más partes que esto en un comando compuesto: se guarda el comando exacto. */
  static readonly maxReglasPorPedido = 6

  /** Segundos que se espera a la persona (240 por defecto; `HQ_PERMISO_TIMEOUT` en el entorno lo cambia). */
  readonly timeout: number
  private readonly entradas = new Map<string, Entrada>()
  private alCambiarFn?: () => void

  constructor(p: { timeout?: number; env?: Record<string, string | undefined> } = {}) {
    const e = p.env ?? process.env
    const crudo = e.HQ_PERMISO_TIMEOUT
    const num = crudo !== undefined && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(crudo) ? Number(crudo) : undefined
    this.timeout = p.timeout ?? num ?? 240
  }

  /** Se llama cada vez que aparece o se va un pedido (se sube la versión de la actividad). */
  alCambiar(f: () => void) { this.alCambiarFn = f }

  private avisar() { this.alCambiarFn?.() }

  /** Crea el pedido y espera la decisión. undefined = nadie respondió a tiempo, el chat terminó o hay demasiados pendientes. */
  async pedir(p: { token: string; identidad: IdentidadMCP; herramienta: string; input: Obj }): Promise<DecisionPermiso | undefined> {
    const id = randomUUID().toLowerCase()
    const desc = p.input.description
    const pedido: PedidoPermiso = {
      id, oficina: p.identidad.oficina, agente: p.identidad.agente, sid: p.identidad.sid, herramienta: p.herramienta,
      detalle: PermisosVivos.detalle(p.herramienta, p.input),
      reglas: PermisosVivos.reglasSugeridas(p.herramienta, p.input), ts: Date.now() / 1000,
    }
    if (typeof desc === 'string') pedido.descripcion = prefijo(sanear(desc), 300)
    if (this.entradas.size >= PermisosVivos.maxPendientes) return undefined
    const espera = new Promise<DecisionPermiso | undefined>((resolve) => {
      const e: Entrada = { pedido, token: p.token, resolver: resolve }
      e.timer = setTimeout(() => this.terminar(id, undefined), Math.max(0, this.timeout) * 1000)
      e.timer.unref?.()
      this.entradas.set(id, e)
    })
    this.avisar()
    return espera
  }

  /** Resuelve un pedido (y lo saca de la lista). */
  private terminar(id: string, d: DecisionPermiso | undefined) {
    const e = this.entradas.get(id)
    if (!e) return
    this.entradas.delete(id)
    if (e.timer) clearTimeout(e.timer)
    e.resolver(d)
    this.avisar()
  }

  /** La persona respondió. Devuelve el pedido, o undefined si no existe (ya vencido o de otra oficina). */
  responder(oficina: string, id: string, decision: DecisionPermiso): PedidoPermiso | undefined {
    const p = this.pedido(oficina, id)
    if (!p) return undefined
    this.terminar(id, decision)
    return p
  }

  /** Un pedido pendiente de `oficina`. */
  pedido(oficina: string, id: string): PedidoPermiso | undefined {
    const e = this.entradas.get(id)
    return e && e.pedido.oficina === oficina ? e.pedido : undefined
  }

  /** Pendientes de una oficina, en orden de llegada. */
  pendientes(oficina: string): PedidoPermiso[] {
    return [...this.entradas.values()].filter((e) => e.pedido.oficina === oficina).map((e) => e.pedido)
  }

  /** El chat de ese token terminó: sus pedidos se rechazan. */
  cancelar(token: string) {
    for (const [id, e] of [...this.entradas]) if (e.token === token) this.terminar(id, undefined)
  }

  // MARK: lógica pura

  /** Qué se muestra: el comando (Bash) o la ruta (las que escriben); si no, el input como JSON. Recortado y saneado. */
  static detalle(_herramienta: string, input: Obj): string {
    let t: string
    if (typeof input.command === 'string') t = input.command
    else if (typeof input.file_path === 'string') t = input.file_path
    else if (typeof input.notebook_path === 'string') t = input.notebook_path
    else if (typeof input.url === 'string') t = input.url
    else t = jsonCompacto(input)
    return prefijo(sanear(t), PermisosVivos.maxDetalle)
  }

  /** Reglas que guarda «Siempre». Bash: `Bash(<programa> [subcomando]:*)` por cada parte de un comando compuesto
   *  (`&&`, `||`, `;`, `|`, `&`); si no se puede partir (sustituciones, subshells, comillas sin cerrar, variables al
   *  principio), el comando exacto `Bash(<comando>)`. Edit/Write: la carpeta del archivo (`Edit(//<carpeta>/**)` y
   *  `Write(//<carpeta>/**)`), o el archivo si está en la raíz; solo rutas absolutas de tipo Unix. El resto: ninguna. */
  static reglasSugeridas(herramienta: string, input: Obj): string[] {
    switch (herramienta) {
      case 'Bash': {
        if (typeof input.command !== 'string') return []
        const cmd = input.command.trim()
        if (cmd === '') return []
        const partes = partirComando(cmd)
        if (partes !== undefined) {
          const out: string[] = []
          for (const palabras of partes) {
            const r = reglaParte(palabras)
            if (r === undefined) { out.length = 0; break }
            if (!out.includes(r)) out.push(r)
          }
          if (out.length > 0 && out.length <= PermisosVivos.maxReglasPorPedido) return out
        }
        // exacto: sin saltos de línea ni paréntesis (rompen la sintaxis de la regla)
        if (/[\n\r()]/.test(cmd) || largo(cmd) > 280) return []
        return [`Bash(${cmd})`]
      }
      case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
        const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
        if (p === undefined || !p.startsWith('/') || p.includes('..') || p.includes('\0') || p.includes('\n') || p.includes('\r') || /[()]/.test(p)) return []
        const dir = carpetaDe(p)
        if (dir === '') return []
        if (dir === '/') {
          const f = p.replace(/\/+$/, '')
          return f === '' ? [] : [`Edit(/${f})`, `Write(/${f})`]
        }
        const d = dir.endsWith('/') ? dir.slice(0, -1) : dir
        return [`Edit(/${d}/**)`, `Write(/${d}/**)`]
      }
      default:
        return []
    }
  }

  /** Respuesta de la herramienta para claude (texto JSON). */
  static respuesta(d: DecisionPermiso | undefined, input: Obj): string {
    let o: Obj
    if (d === 'una_vez' || d === 'siempre') o = { behavior: 'allow', updatedInput: input }
    else if (d === 'rechazar') o = { behavior: 'deny', message: 'La persona no dio permiso para esto. No lo intentes de otra forma: seguí sin eso o preguntale.' }
    else o = { behavior: 'deny', message: 'Nadie respondió el pedido de permiso a tiempo. No lo intentes de otra forma: seguí sin eso o avisá qué necesitás.' }
    return jsonCompacto(o)
  }
}

/** `deletingLastPathComponent` de NSString para rutas absolutas. */
function carpetaDe(p: string): string {
  const s = p.replace(/\/+$/, '')
  if (s === '') return '/'
  const i = s.lastIndexOf('/')
  return i <= 0 ? '/' : s.slice(0, i)
}

/** Parte un comando de shell en sus comandos simples (por `&&`, `||`, `;`, `|`, `&` y saltos de línea fuera de comillas),
 *  cada uno como lista de palabras sin comillas. undefined si tiene algo que no se puede leer con seguridad: sustituciones
 *  (`` ` ``, `$(`, `<(`, `>(`), subshells o grupos (`(`, `)`, `{`, `}` sueltos) o comillas sin cerrar. Las redirecciones
 *  quedan como palabras (no importan: la regla usa solo el programa y el subcomando). */
export function partirComando(cmd: string): string[][] | undefined {
  const partes: string[][] = []
  let palabras: string[] = []
  let w = ''
  let hay = false // hay palabra en curso (aunque sea '')
  let comillas: '' | "'" | '"' = ''
  const cortarPalabra = () => { if (hay) palabras.push(w); w = ''; hay = false }
  const cortarParte = () => { cortarPalabra(); if (palabras.length > 0) partes.push(palabras); palabras = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    const sig = cmd[i + 1]
    if (comillas === "'") { if (c === "'") comillas = ''; else w += c; continue }
    if (comillas === '"') {
      if (c === '"') { comillas = ''; continue }
      if (c === '`' || (c === '$' && sig === '(')) return undefined
      if (c === '\\' && sig !== undefined) { w += sig; i++; continue }
      w += c; continue
    }
    if (c === "'" || c === '"') { comillas = c; hay = true; continue }
    if (c === '\\') { if (sig === undefined || sig === '\n') return undefined; w += sig; hay = true; i++; continue }
    if (c === '`' || (c === '$' && sig === '(') || ((c === '<' || c === '>') && sig === '(')) return undefined
    if (c === '(' || c === ')') return undefined
    if (c === ' ' || c === '\t') { cortarPalabra(); continue }
    if (c === '\n' || c === ';') { cortarParte(); continue }
    if (c === '|') { cortarParte(); if (sig === '|') i++; continue }
    if (c === '&') {
      if (sig === '&') { cortarParte(); i++; continue }
      // `2>&1`, `&>`: redirección, no separador
      if (w.endsWith('>') || sig === '>') { w += c; hay = true; continue }
      cortarParte(); continue
    }
    w += c; hay = true
  }
  if (comillas !== '') return undefined
  cortarParte()
  return partes
}

/** Regla `Bash(<programa> [subcomando]:*)` de un comando simple, o undefined si el programa no es un nombre limpio
 *  (variables al principio, comodines, `{`/`}`, redirecciones pegadas). */
function reglaParte(palabras: string[]): string | undefined {
  const prog = palabras[0]
  if (prog === undefined || !/^[A-Za-z0-9_./+@-]+$/.test(prog) || prog.startsWith('-')) return undefined
  let pref = prog
  const sub = palabras[1]
  if (conSubcomando.has(prog) && sub !== undefined && /^[A-Za-z0-9_.:@-]+$/.test(sub) && !sub.startsWith('-')) pref += ' ' + sub
  return `Bash(${pref}:*)`
}
