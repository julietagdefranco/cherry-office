// Dependencias entre agentes: pedir algo a un colega, quedar esperando su entrega y que la oficina relance el trabajo
// (docs/plan-dependencias.md). Tablas `pedidos` y `esperas` (viven en hq.db, no viajan en el .oficina.zip).
//
// Un PEDIDO es un encargo de B (id de tarea `pedido:<n>`) que un agente A le hace a B porque le falta algo. Una ESPERA es A
// diciendo «entregué una versión parcial: cuando B entregue, volvé a encargármelo». Siempre está atada a una ref de entrega
// concreta (`pedido:<n>` o `encargo:<reunión>:<m>`), así no hace falta un LLM para decidir si «llegó».
import { iso } from './entregas.js'
import type { Obj } from './json.js'
import type { Servicios } from './servicios.js'
import { registrarModulo } from './servicios.js'
import { num, txt, type Fila, type SQLValor, type SQLiteDB } from './sqlite.js'

// MARK: - modelo

export const estadosPedido = ['corriendo', 'entregado', 'fallido', 'cancelado']
export const estadosEspera = ['esperando', 'lista', 'relanzada', 'hecha', 'fallida', 'cancelada']
/** Estados en los que una espera sigue «abierta» (en juego). */
export const esperasAbiertas = ['esperando', 'lista', 'relanzada']

export type Pedido = {
  id: number
  oficina: string
  /** Agente que pide. */
  de: string
  /** Agente al que se le pide. */
  a: string
  que: string
  contexto: string
  /** Conversación/corrida desde la que se pidió. */
  sid: string
  /** Corrida `pedido:<id>` de `a`. */
  ejecucion?: number
  /** Entrega (completa) de `a` que lo cumplió. */
  entrega?: number
  /** corriendo | entregado | fallido | cancelado */
  estado: string
  /** Id del pedido raíz de la cadena (= id si es raíz). */
  cadena: number
  profundidad: number
  error?: string
  creado: number
  actualizado: number
}

export type Espera = {
  id: number
  oficina: string
  /** Quien espera. */
  agente: string
  /** Id de agente | 'persona'. */
  esperaA: string
  que: string
  /** Ref (raíz) de la entrega que la satisface: `pedido:<n>` | `encargo:<reunión>:<m>`. */
  ref: string
  pedido?: number
  /** `sid:<sid>` (MCP) | `reunion:<id>:<n>`. */
  grupo: string
  /** continuar | encargar */
  accion: string
  sid: string
  /** La v1. */
  entregaParcial?: number
  /** Lo que entregó el esperado. */
  entregaLlegada?: number
  /** La v2 / la del pendiente que arrancó. */
  entregaNueva?: number
  /** Solo accion=encargar: id de tarea, nombre y consigna base. */
  tarea?: string
  nombre?: string
  consigna?: string
  /** esperando | lista | relanzada | hecha | fallida | cancelada */
  estado: string
  ronda: number
  plazoDias: number
  /** mcp | reunion */
  origen: string
  reunion?: string
  pendiente?: number
  motivo?: string
  /** Aviso de vencida ya visto. */
  vista: boolean
  creada: number
  actualizada: number
}

const nulo = (v: SQLValor | undefined) => v === null || v === undefined

// MARK: - stores

const colsPedido = 'id,oficina,de,a,que,contexto,sid,ejecucion,entrega,estado,cadena,profundidad,error,creado,actualizado'

function pedidoDeFila(f: Fila): Pedido {
  const p: Pedido = {
    id: num(f.id), oficina: txt(f.oficina), de: txt(f.de), a: txt(f.a), que: txt(f.que), contexto: txt(f.contexto), sid: txt(f.sid),
    estado: txt(f.estado), cadena: num(f.cadena), profundidad: num(f.profundidad), creado: num(f.creado), actualizado: num(f.actualizado),
  }
  if (!nulo(f.ejecucion)) p.ejecucion = num(f.ejecucion)
  if (!nulo(f.entrega)) p.entrega = num(f.entrega)
  if (!nulo(f.error)) p.error = txt(f.error)
  return p
}

/** Columnas de `pedidos` que `actualizar` deja tocar (clave del objeto -> columna). */
const camposPedido: Record<string, string> = { ejecucion: 'ejecucion', entrega: 'entrega', estado: 'estado', error: 'error' }

export class PedidosStore {
  constructor(private readonly db: SQLiteDB) {}

  crear(p: { oficina: string; de: string; a: string; que: string; contexto?: string; sid?: string; cadena?: number; profundidad?: number }): Pedido | undefined {
    const ahora = Date.now() / 1000
    try {
      this.db.run(`INSERT INTO pedidos(oficina,de,a,que,contexto,sid,estado,cadena,profundidad,creado,actualizado) VALUES(?,?,?,?,?,?,'corriendo',0,?,?,?)`,
        [p.oficina, p.de, p.a, p.que, p.contexto ?? '', p.sid ?? '', p.profundidad ?? 0, ahora, ahora])
      const id = num(this.db.query('SELECT last_insert_rowid() AS id')[0]?.id)
      this.db.run('UPDATE pedidos SET cadena=? WHERE id=?', [p.cadena ?? id, id])
      return this.uno(p.oficina, id)
    } catch {
      return undefined
    }
  }

  uno(oficina: string, id: number): Pedido | undefined {
    try {
      const f = this.db.query(`SELECT ${colsPedido} FROM pedidos WHERE oficina=? AND id=?`, [oficina, id])[0]
      return f ? pedidoDeFila(f) : undefined
    } catch {
      return undefined
    }
  }

  /** De el más nuevo al más viejo. */
  lista(oficina: string, f: { estados?: string[]; de?: string; a?: string; cadena?: number; desde?: number; limite?: number } = {}): Pedido[] {
    let sql = `SELECT ${colsPedido} FROM pedidos WHERE oficina=?`
    const p: SQLValor[] = [oficina]
    if (f.estados && f.estados.length > 0) { sql += ` AND estado IN (${f.estados.map(() => '?').join(',')})`; p.push(...f.estados) }
    if (f.de !== undefined) { sql += ' AND de=?'; p.push(f.de) }
    if (f.a !== undefined) { sql += ' AND a=?'; p.push(f.a) }
    if (f.cadena !== undefined) { sql += ' AND cadena=?'; p.push(f.cadena) }
    if (f.desde !== undefined) { sql += ' AND creado>=?'; p.push(f.desde) }
    sql += ' ORDER BY id DESC LIMIT ?'
    p.push(Math.max(1, Math.min(f.limite ?? 500, 1000)))
    try {
      return this.db.query(sql, p).map(pedidoDeFila)
    } catch {
      return []
    }
  }

  actualizar(oficina: string, id: number, c: { ejecucion?: number | null; entrega?: number | null; estado?: string; error?: string | null }) {
    const sets: string[] = ['actualizado=?']
    const p: SQLValor[] = [Date.now() / 1000]
    for (const [k, v] of Object.entries(c)) {
      const col = camposPedido[k]
      if (col === undefined || v === undefined) continue
      sets.push(`${col}=?`)
      p.push(v)
    }
    p.push(oficina, id)
    try {
      return this.db.run(`UPDATE pedidos SET ${sets.join(',')} WHERE oficina=? AND id=?`, p)
    } catch {
      return 0
    }
  }
}

const colsEspera = 'id,oficina,agente,espera_a,que,ref,pedido,grupo,accion,sid,entrega_parcial,entrega_llegada,entrega_nueva,tarea,nombre,consigna,estado,ronda,plazo_dias,origen,reunion,pendiente,motivo,vista,creada,actualizada'

function esperaDeFila(f: Fila): Espera {
  const x: Espera = {
    id: num(f.id), oficina: txt(f.oficina), agente: txt(f.agente), esperaA: txt(f.espera_a), que: txt(f.que), ref: txt(f.ref),
    grupo: txt(f.grupo), accion: txt(f.accion), sid: txt(f.sid), estado: txt(f.estado), ronda: num(f.ronda), plazoDias: num(f.plazo_dias),
    origen: txt(f.origen), vista: num(f.vista) !== 0, creada: num(f.creada), actualizada: num(f.actualizada),
  }
  if (!nulo(f.pedido)) x.pedido = num(f.pedido)
  if (!nulo(f.entrega_parcial)) x.entregaParcial = num(f.entrega_parcial)
  if (!nulo(f.entrega_llegada)) x.entregaLlegada = num(f.entrega_llegada)
  if (!nulo(f.entrega_nueva)) x.entregaNueva = num(f.entrega_nueva)
  if (!nulo(f.tarea)) x.tarea = txt(f.tarea)
  if (!nulo(f.nombre)) x.nombre = txt(f.nombre)
  if (!nulo(f.consigna)) x.consigna = txt(f.consigna)
  if (!nulo(f.reunion)) x.reunion = txt(f.reunion)
  if (!nulo(f.pendiente)) x.pendiente = num(f.pendiente)
  if (!nulo(f.motivo)) x.motivo = txt(f.motivo)
  return x
}

/** Cambios que `EsperasStore.actualizar` acepta (null borra el valor). */
export type CambiosEspera = {
  estado?: string
  entregaParcial?: number | null
  entregaLlegada?: number | null
  entregaNueva?: number | null
  motivo?: string | null
  vista?: boolean
  ronda?: number
  sid?: string
}
const camposEspera: Record<string, string> = {
  estado: 'estado', entregaParcial: 'entrega_parcial', entregaLlegada: 'entrega_llegada', entregaNueva: 'entrega_nueva', motivo: 'motivo', ronda: 'ronda', sid: 'sid',
}

export type NuevaEspera = {
  oficina: string
  agente: string
  esperaA: string
  que: string
  ref: string
  pedido?: number
  grupo: string
  accion: 'continuar' | 'encargar'
  sid?: string
  entregaParcial?: number
  entregaLlegada?: number
  tarea?: string
  nombre?: string
  consigna?: string
  estado?: string
  ronda?: number
  plazoDias?: number
  origen: 'mcp' | 'reunion'
  reunion?: string
  pendiente?: number
}

export class EsperasStore {
  constructor(private readonly db: SQLiteDB) {}

  crear(p: NuevaEspera): Espera | undefined {
    const ahora = Date.now() / 1000
    try {
      this.db.run(`INSERT INTO esperas(oficina,agente,espera_a,que,ref,pedido,grupo,accion,sid,entrega_parcial,entrega_llegada,tarea,nombre,consigna,estado,ronda,plazo_dias,origen,reunion,pendiente,creada,actualizada)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.oficina, p.agente, p.esperaA, p.que, p.ref, p.pedido ?? null, p.grupo, p.accion, p.sid ?? '', p.entregaParcial ?? null, p.entregaLlegada ?? null,
        p.tarea ?? null, p.nombre ?? null, p.consigna ?? null, p.estado ?? 'esperando', p.ronda ?? 1, p.plazoDias ?? 2, p.origen, p.reunion ?? null, p.pendiente ?? null, ahora, ahora])
      const id = num(this.db.query('SELECT last_insert_rowid() AS id')[0]?.id)
      return this.una(p.oficina, id)
    } catch {
      return undefined
    }
  }

  una(oficina: string, id: number): Espera | undefined {
    try {
      const f = this.db.query(`SELECT ${colsEspera} FROM esperas WHERE oficina=? AND id=?`, [oficina, id])[0]
      return f ? esperaDeFila(f) : undefined
    } catch {
      return undefined
    }
  }

  /** De la más vieja a la más nueva. */
  lista(oficina: string, f: {
    estados?: string[]; agente?: string; esperaA?: string; grupo?: string; ref?: string; pedido?: number; sid?: string; reunion?: string; pendiente?: number
    /** Entrega que figura como parcial, llegada o nueva. */
    entrega?: number
    desde?: number; limite?: number
  } = {}): Espera[] {
    let sql = `SELECT ${colsEspera} FROM esperas WHERE oficina=?`
    const p: SQLValor[] = [oficina]
    if (f.estados && f.estados.length > 0) { sql += ` AND estado IN (${f.estados.map(() => '?').join(',')})`; p.push(...f.estados) }
    const igual = (col: string, v: SQLValor | undefined) => { if (v !== undefined) { sql += ` AND ${col}=?`; p.push(v) } }
    igual('agente', f.agente); igual('espera_a', f.esperaA); igual('grupo', f.grupo); igual('ref', f.ref); igual('pedido', f.pedido)
    igual('sid', f.sid); igual('reunion', f.reunion); igual('pendiente', f.pendiente)
    if (f.entrega !== undefined) { sql += ' AND (entrega_parcial=? OR entrega_llegada=? OR entrega_nueva=?)'; p.push(f.entrega, f.entrega, f.entrega) }
    if (f.desde !== undefined) { sql += ' AND creada>=?'; p.push(f.desde) }
    sql += ' ORDER BY id LIMIT ?'
    p.push(Math.max(1, Math.min(f.limite ?? 1000, 5000)))
    try {
      return this.db.query(sql, p).map(esperaDeFila)
    } catch {
      return []
    }
  }

  actualizar(oficina: string, id: number, c: CambiosEspera): number {
    const sets: string[] = ['actualizada=?']
    const p: SQLValor[] = [Date.now() / 1000]
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue
      if (k === 'vista') { sets.push('vista=?'); p.push(v ? 1 : 0); continue }
      const col = camposEspera[k]
      if (col === undefined) continue
      sets.push(`${col}=?`)
      p.push(v as SQLValor)
    }
    p.push(oficina, id)
    try {
      return this.db.run(`UPDATE esperas SET ${sets.join(',')} WHERE oficina=? AND id=?`, p)
    } catch {
      return 0
    }
  }

  /** Toma el grupo de forma atómica: las `lista` pasan a `relanzada`. Devuelve las que tomó (vacío si otro ya lo hizo). */
  tomarGrupo(oficina: string, grupo: string): Espera[] {
    const ahora = Date.now() / 1000
    const cambiadas = this.db.run(`UPDATE esperas SET estado='relanzada', actualizada=? WHERE oficina=? AND grupo=? AND estado='lista'`, [ahora, oficina, grupo])
    if (cambiadas === 0) return []
    return this.lista(oficina, { grupo, estados: ['relanzada'] }).filter((x) => x.actualizada >= ahora)
  }

  /** Devuelve a `lista` las esperas `relanzada` de un grupo (el relanzamiento no pudo arrancar). */
  soltarGrupo(oficina: string, grupo: string) {
    try {
      this.db.run(`UPDATE esperas SET estado='lista', actualizada=? WHERE oficina=? AND grupo=? AND estado='relanzada'`, [Date.now() / 1000, oficina, grupo])
    } catch {}
  }
}

export function prepararTablas(db: SQLiteDB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oficina TEXT NOT NULL,
        de TEXT NOT NULL,
        a TEXT NOT NULL,
        que TEXT NOT NULL,
        contexto TEXT NOT NULL DEFAULT '',
        sid TEXT NOT NULL DEFAULT '',
        ejecucion INTEGER,
        entrega INTEGER,
        estado TEXT NOT NULL,
        cadena INTEGER NOT NULL,
        profundidad INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        creado REAL NOT NULL,
        actualizado REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pedidos_oficina ON pedidos(oficina, estado, id);

    CREATE TABLE IF NOT EXISTS esperas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oficina TEXT NOT NULL,
        agente TEXT NOT NULL,
        espera_a TEXT NOT NULL,
        que TEXT NOT NULL,
        ref TEXT NOT NULL,
        pedido INTEGER,
        grupo TEXT NOT NULL,
        accion TEXT NOT NULL,
        sid TEXT NOT NULL DEFAULT '',
        entrega_parcial INTEGER,
        entrega_llegada INTEGER,
        entrega_nueva INTEGER,
        tarea TEXT, nombre TEXT, consigna TEXT,
        estado TEXT NOT NULL,
        ronda INTEGER NOT NULL DEFAULT 1,
        plazo_dias REAL NOT NULL DEFAULT 2,
        origen TEXT NOT NULL,
        reunion TEXT, pendiente INTEGER,
        motivo TEXT,
        vista INTEGER,
        creada REAL NOT NULL,
        actualizada REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS esperas_oficina ON esperas(oficina, estado, id);
    CREATE INDEX IF NOT EXISTS esperas_ref ON esperas(oficina, ref, estado);
    CREATE INDEX IF NOT EXISTS esperas_grupo ON esperas(oficina, grupo, estado);
  `)
}

// MARK: - JSON

const redondo = (d: number) => Math.round(d * 10) / 10

/** Días desde `creada`, y si ya pasó el plazo estando `esperando` (la «vencida» no es un estado: se calcula al leer). */
export function vencimiento(x: Espera, ahora: number): { vencida: boolean; dias: number } {
  const dias = Math.max(0, (ahora - x.creada) / 86400)
  return { vencida: x.estado === 'esperando' && dias > x.plazoDias, dias: redondo(dias) }
}

/** Contexto para armar el JSON de una espera: nombres de agentes y pedidos. */
export type ContextoEspera = {
  nombre: (id: string) => string
  pedido: (id: number) => Pedido | undefined
  ahora?: number
}

export function esperaJSON(x: Espera, c: ContextoEspera): Obj {
  const ahora = c.ahora ?? Date.now() / 1000
  const v = vencimiento(x, ahora)
  const ped = x.pedido === undefined ? undefined : c.pedido(x.pedido)
  const o: Obj = {
    id: x.id, agente: x.agente, agenteNombre: c.nombre(x.agente), esperaA: x.esperaA, esperaANombre: x.esperaA === 'persona' ? 'la persona' : c.nombre(x.esperaA),
    que: x.que, estado: x.estado, accion: x.accion, ref: x.ref,
    pedido: ped ? { id: ped.id, estado: ped.estado, entrega: ped.entrega ?? null } : null,
    entregaParcial: x.entregaParcial ?? null, entregaLlegada: x.entregaLlegada ?? null, entregaNueva: x.entregaNueva ?? null,
    plazoDias: x.plazoDias, ronda: x.ronda, origen: x.origen,
    creada: iso(x.creada), actualizada: iso(x.actualizada), vencida: v.vencida, dias: v.dias,
  }
  if (x.reunion !== undefined) o.reunion = x.reunion
  if (x.pendiente !== undefined) o.pendiente = x.pendiente
  if (x.motivo !== undefined) o.motivo = x.motivo
  return o
}

// MARK: - módulo

/** Lo que el hueco `dependencias` expone a los demás módulos. */
export class Dependencias {
  readonly pedidos: PedidosStore
  readonly esperas: EsperasStore

  constructor(readonly s: Servicios) {
    prepararTablas(s.store.db)
    this.pedidos = new PedidosStore(s.store.db)
    this.esperas = new EsperasStore(s.store.db)
  }

  /** `esperaJSON` con los nombres de la oficina `oficina` (si es la activa; si no, los ids). */
  json(x: Espera, ahora?: number): Obj {
    const act = this.s.oficinas.activa()
    const agentes = act && act.carpeta === x.oficina ? act.oficina.agentes : []
    return esperaJSON(x, { nombre: (id) => agentes.find((a) => a.id === id)?.nombre ?? id, pedido: (id) => this.pedidos.uno(x.oficina, id), ahora })
  }
}

/** El módulo de dependencias (undefined hasta que se instala). */
export const dependenciasDe = (s: Servicios) => s.huecos.dependencias as Dependencias | undefined

export function instalar(s: Servicios) {
  s.huecos.dependencias = new Dependencias(s)
}

registrarModulo('dependencias', 75, instalar)
