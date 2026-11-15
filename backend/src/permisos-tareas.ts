// Pedidos de permiso de las corridas sin la persona (tareas, encargos, pasos de flujo). La corrida va en `dontAsk` con
// Bash, Edit y Write visibles: lo que el agente no tiene permitido se rechaza y llega en `permission_denials`. Esos rechazos
// quedan guardados como pedidos pendientes (SQLite, sobreviven a un reinicio) y la ejecución en `esperando_permiso`, sin
// entrega. La persona los ve con la misma tarjeta que los del chat (`permisos` en /api/actividad) y responde con
// `POST /api/permisos/<id>`. Cuando respondió todos los de una ejecución, la tarea retoma su conversación con lo permitido
// (programador.ts, `continuar`) y recién ahí deja la entrega.
import { randomUUID } from 'node:crypto'
import type { Denegacion } from './claude-runner.js'
import { sanear } from './consultas.js'
import { esObjeto, type Obj } from './json.js'
import { PermisosVivos, type DecisionPermiso } from './permisos-vivos.js'
import { num, txt, type Fila, type SQLiteDB } from './sqlite.js'
import type { TareaProgramada } from './tareas.js'
import { prefijo } from './validar.js'

/** Herramientas cuyos rechazos se guardan como pedido (las demás, p. ej. conectores de actuar, se rechazan a propósito). */
export const herramientasAnotables = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** Más pedidos que esto en una misma vuelta: se guardan los primeros. */
export const maxPedidosPorVuelta = 10

export type PedidoTarea = {
  id: string
  ejecucion: number
  oficina: string
  agente: string
  herramienta: string
  detalle: string
  descripcion?: string
  input: Obj
  /** Reglas que guarda «Siempre» (vacío = solo una vez). */
  reglas: string[]
  decision?: DecisionPermiso
  ts: number
}

/** Lo que hace falta para retomar una ejecución que espera permiso (aunque la app se haya reiniciado). */
export type EsperaPermiso = {
  ejecucion: number
  oficina: string
  tarea: TareaProgramada
  actuar: string[]
  /** Archivos escritos en las vueltas anteriores (rutas absolutas). */
  archivos: string[]
  /** Costo de las vueltas anteriores. */
  costo: number
  /** Texto de la última vuelta (por si la que sigue falla, queda algo). */
  texto: string
}

/** JSON de la tarjeta: lo mismo que un pedido del chat, más el nombre de la tarea. */
export function pedidoTareaJSON(p: PedidoTarea, tarea: string): Obj {
  const d: Obj = { id: p.id, agente: p.agente, herramienta: p.herramienta, detalle: p.detalle, reglas: p.reglas, ts: p.ts, tarea }
  if (p.descripcion !== undefined) d.descripcion = p.descripcion
  return d
}

/** Pedidos a partir de los rechazos de una vuelta: solo las herramientas anotables, sin repetir, hasta `maxPedidosPorVuelta`. */
export function pedidosDe(denegados: Denegacion[], p: { ejecucion: number; oficina: string; agente: string }): PedidoTarea[] {
  const out: PedidoTarea[] = []
  const vistos = new Set<string>()
  const ts = Date.now() / 1000
  for (const d of denegados) {
    if (!herramientasAnotables.includes(d.herramienta)) continue
    const detalle = PermisosVivos.detalle(d.herramienta, d.input)
    const clave = d.herramienta + '\u001f' + detalle
    if (vistos.has(clave)) continue
    vistos.add(clave)
    const pedido: PedidoTarea = {
      id: randomUUID().toLowerCase(), ejecucion: p.ejecucion, oficina: p.oficina, agente: p.agente, herramienta: d.herramienta, detalle,
      input: d.input, reglas: PermisosVivos.reglasSugeridas(d.herramienta, d.input), ts,
    }
    if (typeof d.input.description === 'string') pedido.descripcion = prefijo(sanear(d.input.description), 300)
    out.push(pedido)
    if (out.length >= maxPedidosPorVuelta) break
  }
  return out
}

/** Reglas que valen solo para la vuelta que sigue con «Una vez»: el archivo exacto (Edit/Write) o las del comando (Bash). */
export function reglasUnaVez(p: PedidoTarea): string[] {
  if (p.herramienta === 'Bash') return p.reglas
  const ruta = typeof p.input.file_path === 'string' ? p.input.file_path : typeof p.input.notebook_path === 'string' ? p.input.notebook_path : undefined
  if (ruta === undefined || !ruta.startsWith('/') || ruta.includes('..') || /[\n\r\0()]/.test(ruta)) return p.reglas
  return [`Edit(/${ruta})`, `Write(/${ruta})`]
}

/** Mensaje con el que la tarea retoma su conversación después de que la persona respondió. */
export function mensajeContinuar(pedidos: PedidoTarea[], duenio: string): string {
  const quien = duenio === '' ? 'La persona' : duenio
  const si = pedidos.filter((p) => p.decision === 'una_vez' || p.decision === 'siempre')
  const no = pedidos.filter((p) => p.decision !== 'una_vez' && p.decision !== 'siempre')
  const linea = (p: PedidoTarea) => `- ${p.herramienta}: ${p.detalle}`
  let m = `${quien} respondió los permisos que te faltaron en esta tarea.`
  if (si.length > 0) m += `\n\nAhora tenés permiso para:\n${si.map(linea).join('\n')}`
  if (no.length > 0) m += `\n\nNo te dio permiso para (no lo intentes de otra forma, seguí sin eso):\n${no.map(linea).join('\n')}`
  m += si.length > 0
    ? '\n\nHacé ahora lo que quedó permitido, seguí la tarea desde donde quedaste y terminá con tu respuesta final completa (la que queda como entrega).'
    : '\n\nSeguí la tarea sin eso y terminá con tu respuesta final completa (la que queda como entrega).'
  return m
}

// MARK: - SQLite

const parsear = <T>(s: string, def: T): T => { try { return JSON.parse(s) as T } catch { return def } }
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function pedidoDeFila(f: Fila): PedidoTarea {
  const input = parsear<unknown>(txt(f.input), {})
  const p: PedidoTarea = {
    id: txt(f.id), ejecucion: num(f.ejecucion), oficina: txt(f.oficina), agente: txt(f.agente), herramienta: txt(f.herramienta),
    detalle: txt(f.detalle), input: esObjeto(input) ? input : {}, reglas: strs(parsear<unknown>(txt(f.reglas), [])), ts: num(f.ts),
  }
  if (f.descripcion !== null && f.descripcion !== undefined) p.descripcion = txt(f.descripcion)
  const d = f.decision === null || f.decision === undefined ? undefined : txt(f.decision)
  if (d === 'una_vez' || d === 'siempre' || d === 'rechazar') p.decision = d
  return p
}

const colsPedido = 'id,ejecucion,oficina,agente,herramienta,detalle,descripcion,input,reglas,decision,ts'

/** Tablas `esperas_permiso` (una fila por ejecución que espera) y `permisos_tareas` (sus pedidos). */
export class PermisosTareasDB {
  constructor(private readonly db: SQLiteDB) {}

  preparar() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS esperas_permiso (
        ejecucion INTEGER PRIMARY KEY,
        oficina TEXT NOT NULL,
        tarea TEXT NOT NULL,
        actuar TEXT NOT NULL DEFAULT '[]',
        archivos TEXT NOT NULL DEFAULT '[]',
        costo REAL NOT NULL DEFAULT 0,
        texto TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS permisos_tareas (
        id TEXT PRIMARY KEY,
        ejecucion INTEGER NOT NULL,
        oficina TEXT NOT NULL,
        agente TEXT NOT NULL,
        herramienta TEXT NOT NULL,
        detalle TEXT NOT NULL,
        descripcion TEXT,
        input TEXT NOT NULL,
        reglas TEXT NOT NULL,
        decision TEXT,
        ts REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS permisos_tareas_ejecucion ON permisos_tareas(ejecucion);
    CREATE INDEX IF NOT EXISTS permisos_tareas_oficina ON permisos_tareas(oficina, decision);
    `)
  }

  /** Guarda la espera y sus pedidos (reemplaza los de vueltas anteriores de la misma ejecución). */
  guardar(e: EsperaPermiso, pedidos: PedidoTarea[]) {
    this.db.run('DELETE FROM permisos_tareas WHERE ejecucion=?', [e.ejecucion])
    this.db.run('INSERT OR REPLACE INTO esperas_permiso(ejecucion,oficina,tarea,actuar,archivos,costo,texto) VALUES(?,?,?,?,?,?,?)',
      [e.ejecucion, e.oficina, JSON.stringify(e.tarea), JSON.stringify(e.actuar), JSON.stringify(e.archivos), e.costo, e.texto])
    for (const p of pedidos) {
      this.db.run(`INSERT INTO permisos_tareas(${colsPedido}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [p.id, p.ejecucion, p.oficina, p.agente, p.herramienta, p.detalle, p.descripcion ?? null, JSON.stringify(p.input), JSON.stringify(p.reglas), p.decision ?? null, p.ts])
    }
  }

  espera(ejecucion: number): EsperaPermiso | undefined {
    const f = this.db.query('SELECT ejecucion,oficina,tarea,actuar,archivos,costo,texto FROM esperas_permiso WHERE ejecucion=?', [ejecucion])[0]
    if (!f) return undefined
    const t = parsear<unknown>(txt(f.tarea), undefined)
    if (!esObjeto(t)) return undefined
    return {
      ejecucion: num(f.ejecucion), oficina: txt(f.oficina), tarea: t as unknown as TareaProgramada, actuar: strs(parsear<unknown>(txt(f.actuar), [])),
      archivos: strs(parsear<unknown>(txt(f.archivos), [])), costo: num(f.costo), texto: txt(f.texto),
    }
  }

  /** Ejecuciones que esperan (de una oficina), con el nombre de su tarea. */
  esperas(oficina: string): EsperaPermiso[] {
    return this.db.query('SELECT ejecucion FROM esperas_permiso WHERE oficina=? ORDER BY ejecucion', [oficina])
      .map((f) => this.espera(num(f.ejecucion))).filter((e): e is EsperaPermiso => e !== undefined)
  }

  /** Pedidos sin responder de una oficina, en orden de llegada. */
  pendientes(oficina: string): PedidoTarea[] {
    return this.db.query(`SELECT ${colsPedido} FROM permisos_tareas WHERE oficina=? AND decision IS NULL ORDER BY ts, rowid`, [oficina]).map(pedidoDeFila)
  }

  pedido(oficina: string, id: string): PedidoTarea | undefined {
    const f = this.db.query(`SELECT ${colsPedido} FROM permisos_tareas WHERE oficina=? AND id=?`, [oficina, id])[0]
    return f ? pedidoDeFila(f) : undefined
  }

  pedidosDe(ejecucion: number): PedidoTarea[] {
    return this.db.query(`SELECT ${colsPedido} FROM permisos_tareas WHERE ejecucion=? ORDER BY ts, rowid`, [ejecucion]).map(pedidoDeFila)
  }

  decidir(id: string, d: DecisionPermiso) { this.db.run('UPDATE permisos_tareas SET decision=? WHERE id=?', [d, id]) }

  /** Saca la espera y sus pedidos (la tarea retomó o se dio por terminada). */
  borrar(ejecucion: number) {
    this.db.run('DELETE FROM permisos_tareas WHERE ejecucion=?', [ejecucion])
    this.db.run('DELETE FROM esperas_permiso WHERE ejecucion=?', [ejecucion])
  }
}
