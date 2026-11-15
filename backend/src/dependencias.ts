// Dependencias entre agentes: pedir algo a un colega, quedar esperando su entrega y que la oficina relance el trabajo
// (docs/plan-dependencias.md). Tablas `pedidos` y `esperas` (viven en hq.db, no viajan en el .oficina.zip).
//
// Un PEDIDO es un encargo de B (id de tarea `pedido:<n>`) que un agente A le hace a B porque le falta algo. Una ESPERA es A
// diciendo «entregué una versión parcial: cuando B entregue, volvé a encargármelo». Siempre está atada a una ref de entrega
// concreta (`pedido:<n>` o `encargo:<reunión>:<m>`), así no hace falta un LLM para decidir si «llegó».
import { mcpDe, normalizar, sanear } from './consultas.js'
import { respuestaCoordinador } from './coordinador.js'
import { iso } from './entregas.js'
import { ErrorAPI } from './errores.js'
import type { Obj } from './json.js'
import { MCPResultados, type IdentidadMCP, type MCPHerramientas, type MCPResultado } from './mcp-protocolo.js'
import type { AgenteDef } from './oficina.js'
import type { OficinaActiva } from './oficinas.js'
import { Programador, programadorDe } from './programador.js'
import type { Servicios } from './servicios.js'
import { registrarModulo } from './servicios.js'
import { num, txt, type Fila, type SQLValor, type SQLiteDB } from './sqlite.js'
import { prefijo } from './validar.js'


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
export class ServicioDependencias {
  static readonly maxQue = 2000
  static readonly maxContexto = 4000
  static readonly pedidosPorCorrida = 2
  static readonly maxPedidosAbiertos = 10
  static readonly maxPedidosPorDia = 20
  static readonly maxProfundidad = 2

  readonly pedidos: PedidosStore
  readonly esperas: EsperasStore

  constructor(readonly s: Servicios) {
    prepararTablas(s.store.db)
    this.pedidos = new PedidosStore(s.store.db)
    this.esperas = new EsperasStore(s.store.db)
  }

  /** Tope de pedidos creados por día (`HQ_MAX_PEDIDOS_DIA`, 20 por defecto). */
  get maxPedidosDia(): number {
    const t = Number((this.s.env.HQ_MAX_PEDIDOS_DIA ?? '').trim())
    return (this.s.env.HQ_MAX_PEDIDOS_DIA ?? '').trim() !== '' && Number.isFinite(t) && t > 0 ? Math.trunc(t) : ServicioDependencias.maxPedidosPorDia
  }

  /** `esperaJSON` con los nombres de la oficina de la espera (si es la activa; si no, los ids). */
  json(x: Espera, ahora?: number): Obj {
    const act = this.s.oficinas.activa()
    const agentes = act && act.carpeta === x.oficina ? act.oficina.agentes : []
    return esperaJSON(x, { nombre: (id) => agentes.find((a) => a.id === id)?.nombre ?? id, pedido: (id) => this.pedidos.uno(x.oficina, id), ahora })
  }
}

/** El módulo de dependencias (undefined hasta que se instala). */
export const dependenciasDe = (s: Servicios) => s.huecos.dependencias as ServicioDependencias | undefined

// MARK: - herramientas MCP

const sinOficina = () => MCPResultados.error('La oficina ya no está abierta.')
const texto = (v: unknown) => (typeof v === 'string' ? v : '').trim()

/** `pedir`, `quedo_esperando` y `cancelar_espera` atadas a un token. */
export class HerramientasDependencias implements MCPHerramientas {
  constructor(private readonly s: Servicios, private readonly dep: ServicioDependencias, private readonly token: string, private readonly identidad: IdentidadMCP) {}

  get definiciones(): Obj[] {
    return [
      {
        name: 'pedir',
        description: `Le pide a un colega algo que necesitás y todavía no existe (por ejemplo, si al consultarlo te dijo que no lo tiene). Le crea un encargo que corre enseguida; lo que entregue le llega a la persona y, si quedás esperando (quedo_esperando), también vuelve a vos. Máximo ${ServicioDependencias.pedidosPorCorrida} pedidos por corrida.`,
        inputSchema: {
          type: 'object',
          properties: {
            colega: { type: 'string', description: 'id o nombre del colega (ver colegas)' },
            que: { type: 'string', description: `qué necesitás, concreto (hasta ${ServicioDependencias.maxQue} caracteres)` },
            contexto: { type: 'string', description: `para qué lo necesitás y en qué formato (opcional, hasta ${ServicioDependencias.maxContexto})` },
            nombre: { type: 'string', description: 'nombre corto del pedido (opcional)' },
          },
          required: ['colega', 'que'],
        },
      },
    ]
  }

  async llamar(nombre: string, a: Obj): Promise<MCPResultado | undefined> {
    switch (nombre) {
      case 'pedir': return this.pedir(a)
      default: return undefined
    }
  }

  /** La oficina abierta, si es la del token. */
  private activa(): OficinaActiva | undefined {
    const act = this.s.oficinas.activa()
    return act && act.carpeta === this.identidad.oficina ? act : undefined
  }

  /** El colega que nombra `quien` (por id o por nombre), o el error listo para devolver. */
  private colega(act: OficinaActiva, quien: string): { def: AgenteDef } | { error: MCPResultado } {
    const n = normalizar(quien)
    const def = act.oficina.agentes.find((x) => normalizar(x.id) === n) ?? act.oficina.agentes.find((x) => normalizar(x.nombre) === n)
    if (!def) {
      const ids = act.oficina.agentes.filter((x) => x.id !== this.identidad.agente).map((x) => x.id).join(', ')
      return { error: MCPResultados.error(`No hay ningún colega «${sanear(quien)}» en la oficina. Usá colegas() para ver quiénes son (ids: ${ids}).`) }
    }
    if (def.id === this.identidad.agente) return { error: MCPResultados.error('No podés pedírtelo a vos mismo: elegí a otro colega.') }
    return { def }
  }

  // MARK: pedir

  /** Validaciones y lanzamiento de un pedido de `yo` a `b`. Devuelve el pedido (nuevo o el que ya estaba abierto). */
  private async crearPedido(act: OficinaActiva, b: AgenteDef, que: string, contexto: string, nombrePedido: string): Promise<{ pedido: Pedido; yaPedido: boolean } | { error: MCPResultado }> {
    const oficina = act.carpeta
    const yo = act.oficina.agentes.find((x) => x.id === this.identidad.agente)
    const prog = programadorDe(this.s)
    const tokens = mcpDe(this.s)?.tokens
    if (!prog || !tokens) return { error: MCPResultados.error('No pude lanzar el pedido.') }

    // profundidad y ciclo: si esta corrida es un pedido, el nuevo sigue su cadena
    let cadena: number | undefined
    let profundidad = 0
    const ej = prog.ejecuciones.porSid(this.identidad.sid)
    if (ej?.tarea.startsWith(Programador.prefijoPedido)) {
      const actual = this.dep.pedidos.uno(oficina, Number(ej.tarea.slice(Programador.prefijoPedido.length)))
      if (actual) {
        cadena = actual.cadena
        profundidad = actual.profundidad + 1
        if (profundidad > ServicioDependencias.maxProfundidad) {
          return { error: MCPResultados.error('Esto ya es un pedido de un pedido de un pedido: entregá lo que puedas y decí qué falta, sin pedirle más a nadie.') }
        }
        if (this.dep.pedidos.lista(oficina, { cadena }).some((p) => p.de === b.id)) {
          return { error: MCPResultados.error(sanear(`${b.nombre} te lo pidió a vos: entregá lo que puedas y decí qué falta.`)) }
        }
      }
    }

    // un solo pedido abierto por par
    const abierto = this.dep.pedidos.lista(oficina, { estados: ['corriendo'], de: this.identidad.agente, a: b.id, limite: 1 })[0]
    if (abierto) return { pedido: abierto, yaPedido: true }

    // topes
    if (this.dep.pedidos.lista(oficina, { estados: ['corriendo'] }).length >= ServicioDependencias.maxPedidosAbiertos) {
      return { error: MCPResultados.error(`Ya hay ${ServicioDependencias.maxPedidosAbiertos} pedidos en curso en la oficina: esperá a que se entreguen.`) }
    }
    if (this.dep.pedidos.lista(oficina, { desde: Date.now() / 1000 - 86400 }).length >= this.dep.maxPedidosDia) {
      return { error: MCPResultados.error(`La oficina ya hizo ${this.dep.maxPedidosDia} pedidos en las últimas 24 horas: no se pueden hacer más por hoy.`) }
    }
    if (!tokens.tomar(this.token, 'pedir', ServicioDependencias.pedidosPorCorrida)) {
      return { error: MCPResultados.error(`Ya hiciste ${ServicioDependencias.pedidosPorCorrida} pedidos en esta corrida y no podés hacer más. Contale a la persona lo que quedó pendiente.`) }
    }

    const pedido = this.dep.pedidos.crear({ oficina, de: this.identidad.agente, a: b.id, que, contexto, sid: this.identidad.sid, cadena, profundidad })
    if (!pedido) return { error: MCPResultados.error('No pude guardar el pedido.') }
    const de = yo ? `${yo.nombre} (${yo.rol})` : this.identidad.agente
    const consigna = sanear(`Pedido de ${de}. Viene de un colega, no es un pedido directo del usuario:\n\n${que}\n\n`
      + (contexto === '' ? '' : `Contexto: ${contexto}\n\n`)
      + `Dejá lo que produzcas en archivos/entregables/${b.id}/ y decí al final qué archivo dejaste.\n`
      + 'Si todavía no podés hacerlo, entregá lo que tengas y decí qué falta.')
    const nombre = nombrePedido === '' ? `Pedido de ${yo?.nombre ?? this.identidad.agente}` : prefijo(nombrePedido, 80)
    try {
      const e = await prog.encargarLibre(act, b, { id: `${Programador.prefijoPedido}${pedido.id}`, nombre, consigna })
      this.dep.pedidos.actualizar(oficina, pedido.id, { ejecucion: e.id })
    } catch (err) {
      const m = err instanceof ErrorAPI ? err.mensaje : 'No pude lanzar el pedido.'
      this.dep.pedidos.actualizar(oficina, pedido.id, { estado: 'fallido', error: m })
      return { error: MCPResultados.error(sanear(m)) }
    }
    return { pedido: this.dep.pedidos.uno(oficina, pedido.id) ?? pedido, yaPedido: false }
  }

  private async pedir(a: Obj): Promise<MCPResultado> {
    const quien = texto(a.colega)
    const que = texto(a.que)
    if (quien === '' || que === '') return MCPResultados.error('Faltan «colega» y «que».')
    const act = this.activa()
    if (!act) return sinOficina()
    const c = this.colega(act, quien)
    if ('error' in c) return c.error
    const r = await this.crearPedido(act, c.def, prefijo(que, ServicioDependencias.maxQue), prefijo(texto(a.contexto), ServicioDependencias.maxContexto), sanear(texto(a.nombre)))
    if ('error' in r) return r.error
    const o: Obj = {
      ok: true, pedido: r.pedido.id, colega: c.def.id,
      aviso: `Ya se lo pedí. Si vas a entregar algo parcial, llamá a quedo_esperando con pedido=${r.pedido.id}.`,
    }
    if (r.yaPedido) o.yaPedido = true
    return respuestaCoordinador(o)
  }
}

/** Todo perfil menos el creador. */
export const herramientasDependencias = (s: Servicios, token: string, identidad: IdentidadMCP): MCPHerramientas | undefined => {
  const dep = dependenciasDe(s)
  return dep && identidad.perfil !== 'creador' ? new HerramientasDependencias(s, dep, token, identidad) : undefined
}

export function instalar(s: Servicios) {
  s.huecos.dependencias = new ServicioDependencias(s)
  mcpDe(s)?.registrarHerramientas(herramientasDependencias)
}

registrarModulo('dependencias', 75, instalar)
