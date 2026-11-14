// Corridas de flujos y sus pasos (CorridasStore.swift): tablas `corridas` y `corrida_pasos`.
// `definicion` es el JSON del flujo tal como estaba al arrancar la corrida (no cambia aunque se edite el flujo).
import { iso } from './entregas.js'
import { esObjeto, type Obj } from './json.js'
import { num, txt, type Fila, type SQLValor, type SQLiteDB } from './sqlite.js'

export const estadosCorrida = ['en_curso', 'esperando_aprobacion', 'esperando_persona', 'trabada', 'terminada', 'cancelada']
export const corridasAbiertas = ['en_curso', 'esperando_aprobacion', 'esperando_persona', 'trabada']
export const estadosPaso = ['pendiente', 'corriendo', 'esperando_aprobacion', 'esperando_persona', 'listo', 'error', 'saltado', 'cancelado']

export type Corrida = {
  id: number
  oficina: string
  flujo: string
  nombre: string
  contexto: string
  /** JSON del flujo al arrancar. */
  definicion: string
  paso: number
  estado: string
  creada: number
  actualizada: number
  terminada?: number
  vista: boolean
}

export type PasoCorrida = {
  id: number
  corrida: number
  paso: number
  intento: number
  quien: string
  estado: string
  ejecucion?: number
  entrega?: number
  inicio: number
  /** No lanzar antes de esta fecha (esperaDias). */
  despues?: number
  fin?: number
  costo?: number
  nota?: string
}

// La definición no cambia nunca: se parsea una vez por definición y se guarda lo mínimo para resúmenes (se pide seguido y
// para todas las corridas abiertas: /api/actividad, avisos, parte).
type Pasos = { nombre: string; quien: string; plazoDias?: number }[]
type DefLiviana = { nombre: string; pasos: Pasos }
const cacheDef = new Map<string, DefLiviana>()

function defLiviana(c: Corrida): DefLiviana {
  const k = c.definicion
  const hit = cacheDef.get(k)
  if (hit) return hit
  let r: DefLiviana = { nombre: '', pasos: [] }
  try {
    const o: unknown = JSON.parse(c.definicion)
    if (esObjeto(o)) {
      const pasos = Array.isArray(o.pasos) ? o.pasos : []
      r = {
        nombre: typeof o.nombre === 'string' ? o.nombre : '',
        pasos: pasos.map((p) => {
          const d: Obj = esObjeto(p) ? p : {}
          const x: Pasos[number] = { nombre: typeof d.nombre === 'string' ? d.nombre : '', quien: typeof d.quien === 'string' ? d.quien : '' }
          if (typeof d.plazoDias === 'number') x.plazoDias = d.plazoDias
          return x
        }),
      }
    }
  } catch {}
  if (cacheDef.size > 300) cacheDef.clear()
  cacheDef.set(k, r)
  return r
}

/** Nombre y responsable del paso actual, y responsable del anterior. */
export function resumenPaso(c: Corrida): { nombre: string; quien: string; anterior: string } {
  const { pasos } = defLiviana(c)
  const actual = c.paso >= 0 && c.paso < pasos.length ? pasos[c.paso] : undefined
  const anterior = c.paso > 0 && c.paso - 1 < pasos.length ? pasos[c.paso - 1] : undefined
  return { nombre: actual?.nombre ?? '', quien: actual?.quien ?? '', anterior: anterior?.quien ?? '' }
}

/** `plazoDias` del paso actual de la definición congelada (undefined si no lo trae). */
export function plazoDelPaso(c: Corrida): number | undefined {
  const p = defLiviana(c).pasos[c.paso]
  return c.paso >= 0 && p?.plazoDias !== undefined && p.plazoDias > 0 ? p.plazoDias : undefined
}

export function corridaJSON(c: Corrida): Obj {
  const d = defLiviana(c)
  const actual = c.paso >= 0 && c.paso < d.pasos.length ? d.pasos[c.paso] : undefined
  return {
    id: c.id, flujo: c.flujo, nombre: c.nombre, contexto: c.contexto, definicion: c.definicion, paso: c.paso, estado: c.estado,
    creada: iso(c.creada), actualizada: iso(c.actualizada), vista: c.vista,
    flujoNombre: d.nombre === '' ? c.flujo : d.nombre, total: d.pasos.length,
    pasoNombre: actual?.nombre ?? '', quien: actual?.quien ?? '',
    terminada: c.terminada === undefined ? null : iso(c.terminada),
  }
}

export function pasoJSON(p: PasoCorrida): Obj {
  return {
    id: p.id, corrida: p.corrida, paso: p.paso, intento: p.intento, quien: p.quien, estado: p.estado, inicio: iso(p.inicio),
    ejecucion: p.ejecucion ?? null, entrega: p.entrega ?? null, despues: p.despues === undefined ? null : iso(p.despues),
    fin: p.fin === undefined ? null : iso(p.fin), costo: p.costo ?? null, nota: p.nota ?? null,
  }
}

const colsCorrida = 'id,oficina,flujo,nombre,contexto,definicion,paso,estado,creada,actualizada,terminada,vista'
const colsPaso = 'id,corrida,paso,intento,quien,estado,ejecucion,entrega,inicio,despues,fin,costo,nota'
const nulo = (v: SQLValor | undefined) => v === null || v === undefined

function deFilaCorrida(f: Fila, p = ''): Corrida {
  const c: Corrida = {
    id: num(f[p + 'id']), oficina: txt(f[p + 'oficina']), flujo: txt(f[p + 'flujo']), nombre: txt(f[p + 'nombre']),
    contexto: txt(f[p + 'contexto']), definicion: txt(f[p + 'definicion']), paso: num(f[p + 'paso']), estado: txt(f[p + 'estado']),
    creada: num(f[p + 'creada']), actualizada: num(f[p + 'actualizada']), vista: num(f[p + 'vista']) !== 0,
  }
  if (!nulo(f[p + 'terminada'])) c.terminada = num(f[p + 'terminada'])
  return c
}

function deFilaPaso(f: Fila, p = ''): PasoCorrida {
  const x: PasoCorrida = {
    id: num(f[p + 'id']), corrida: num(f[p + 'corrida']), paso: num(f[p + 'paso']), intento: num(f[p + 'intento']),
    quien: txt(f[p + 'quien']), estado: txt(f[p + 'estado']), inicio: num(f[p + 'inicio']),
  }
  if (!nulo(f[p + 'ejecucion'])) x.ejecucion = num(f[p + 'ejecucion'])
  if (!nulo(f[p + 'entrega'])) x.entrega = num(f[p + 'entrega'])
  if (!nulo(f[p + 'despues'])) x.despues = num(f[p + 'despues'])
  if (!nulo(f[p + 'fin'])) x.fin = num(f[p + 'fin'])
  if (!nulo(f[p + 'costo'])) x.costo = num(f[p + 'costo'])
  if (!nulo(f[p + 'nota'])) x.nota = txt(f[p + 'nota'])
  return x
}

export class CorridasStore {
  constructor(private readonly db: SQLiteDB) { this.preparar() }

  preparar() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS corridas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oficina TEXT NOT NULL,
        flujo TEXT NOT NULL,
        nombre TEXT NOT NULL,
        contexto TEXT NOT NULL DEFAULT '',
        definicion TEXT NOT NULL,
        paso INTEGER NOT NULL DEFAULT 0,
        estado TEXT NOT NULL,
        creada REAL NOT NULL,
        actualizada REAL NOT NULL,
        terminada REAL,
        vista INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS corridas_oficina ON corridas(oficina, estado);

    CREATE TABLE IF NOT EXISTS corrida_pasos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corrida INTEGER NOT NULL,
        paso INTEGER NOT NULL,
        intento INTEGER NOT NULL DEFAULT 1,
        quien TEXT NOT NULL,
        estado TEXT NOT NULL,
        ejecucion INTEGER,
        entrega INTEGER,
        inicio REAL NOT NULL,
        despues REAL,
        fin REAL,
        costo REAL,
        nota TEXT
    );
    CREATE INDEX IF NOT EXISTS corrida_pasos_c ON corrida_pasos(corrida, paso, intento);
    CREATE INDEX IF NOT EXISTS corrida_pasos_entrega ON corrida_pasos(entrega);
    `)
  }

  // MARK: corridas

  corridaCrear(p: { oficina: string; flujo: string; nombre: string; contexto: string; definicion: string; estado?: string }): Corrida | undefined {
    const ahora = Date.now() / 1000
    try {
      this.db.run('INSERT INTO corridas(oficina,flujo,nombre,contexto,definicion,paso,estado,creada,actualizada) VALUES(?,?,?,?,?,0,?,?,?)',
        [p.oficina, p.flujo, p.nombre, p.contexto, p.definicion, p.estado ?? 'en_curso', ahora, ahora])
      const id = num(this.db.query('SELECT last_insert_rowid() AS id')[0]?.id)
      return this.corrida(p.oficina, id)
    } catch {
      return undefined
    }
  }

  corrida(oficina: string, id: number): Corrida | undefined {
    try {
      const f = this.db.query(`SELECT ${colsCorrida} FROM corridas WHERE oficina=? AND id=?`, [oficina, id])[0]
      return f ? deFilaCorrida(f) : undefined
    } catch {
      return undefined
    }
  }

  /** De la que se movió hace menos a la que hace más. Filtros opcionales. */
  corridas(oficina: string, { estados, flujo, limite = 100 }: { estados?: string[]; flujo?: string; limite?: number } = {}): Corrida[] {
    let sql = `SELECT ${colsCorrida} FROM corridas WHERE oficina=?`
    const p: SQLValor[] = [oficina]
    if (estados) {
      if (estados.length === 0) return []
      sql += ` AND estado IN (${estados.map(() => '?').join(',')})`
      p.push(...estados)
    }
    if (flujo !== undefined) { sql += ' AND flujo=?'; p.push(flujo) }
    sql += ' ORDER BY actualizada DESC, id DESC LIMIT ?'
    p.push(Math.max(1, Math.min(limite, 500)))
    try {
      return this.db.query(sql, p).map((f) => deFilaCorrida(f))
    } catch {
      return []
    }
  }

  /** Siempre toca `actualizada`. Pasar a `esperando_persona` marca la corrida como no vista. */
  corridaActualizar(oficina: string, id: number, { paso, estado, terminada }: { paso?: number; estado?: string; terminada?: number } = {}): Corrida | undefined {
    const sets = ['actualizada=?']
    const p: SQLValor[] = [Date.now() / 1000]
    if (paso !== undefined) { sets.push('paso=?'); p.push(paso) }
    if (estado !== undefined) {
      sets.push('estado=?'); p.push(estado)
      if (estado === 'esperando_persona') sets.push('vista=0')
    }
    if (terminada !== undefined) { sets.push('terminada=?'); p.push(terminada) }
    p.push(oficina, id)
    try { this.db.run(`UPDATE corridas SET ${sets.join(',')} WHERE oficina=? AND id=?`, p) } catch {}
    return this.corrida(oficina, id)
  }

  /** Marca la corrida como vista. Devuelve si existía. */
  corridaVista(oficina: string, id: number): boolean {
    if (!this.corrida(oficina, id)) return false
    try { this.db.run('UPDATE corridas SET vista=1 WHERE oficina=? AND id=?', [oficina, id]) } catch {}
    return true
  }

  /** Las que esperan a la persona y todavía no vio. */
  corridasEsperandoPersona(oficina: string): Corrida[] {
    try {
      return this.db.query(`SELECT ${colsCorrida} FROM corridas WHERE oficina=? AND estado='esperando_persona' AND vista=0 ORDER BY actualizada DESC, id DESC`, [oficina])
        .map((f) => deFilaCorrida(f))
    } catch {
      return []
    }
  }

  // MARK: pasos

  pasoCrear(p: { corrida: number; paso: number; intento: number; quien: string; estado: string; despues?: number; nota?: string }): PasoCorrida | undefined {
    try {
      this.db.run('INSERT INTO corrida_pasos(corrida,paso,intento,quien,estado,inicio,despues,nota) VALUES(?,?,?,?,?,?,?,?)',
        [p.corrida, p.paso, p.intento, p.quien, p.estado, Date.now() / 1000, p.despues ?? null, p.nota ?? null])
      const id = num(this.db.query('SELECT last_insert_rowid() AS id')[0]?.id)
      return this.pasoPorId(id)
    } catch {
      return undefined
    }
  }

  private pasoPorId(id: number): PasoCorrida | undefined {
    try {
      const f = this.db.query(`SELECT ${colsPaso} FROM corrida_pasos WHERE id=?`, [id])[0]
      return f ? deFilaPaso(f) : undefined
    } catch {
      return undefined
    }
  }

  /** Solo toca lo que viene. `sumarCosto` acumula sobre lo que ya hay (NULL cuenta como 0). */
  pasoActualizar(id: number, c: { estado?: string; ejecucion?: number; entrega?: number; fin?: number; sumarCosto?: number; nota?: string } = {}): PasoCorrida | undefined {
    const sets: string[] = []
    const p: SQLValor[] = []
    if (c.estado !== undefined) { sets.push('estado=?'); p.push(c.estado) }
    if (c.ejecucion !== undefined) { sets.push('ejecucion=?'); p.push(c.ejecucion) }
    if (c.entrega !== undefined) { sets.push('entrega=?'); p.push(c.entrega) }
    if (c.fin !== undefined) { sets.push('fin=?'); p.push(c.fin) }
    if (c.sumarCosto !== undefined) { sets.push('costo=COALESCE(costo,0)+?'); p.push(c.sumarCosto) }
    if (c.nota !== undefined) { sets.push('nota=?'); p.push(c.nota) }
    if (sets.length > 0) {
      p.push(id)
      try { this.db.run(`UPDATE corrida_pasos SET ${sets.join(',')} WHERE id=?`, p) } catch {}
    }
    return this.pasoPorId(id)
  }

  /** Por paso y después por intento. */
  pasosDe(corrida: number): PasoCorrida[] {
    try {
      return this.db.query(`SELECT ${colsPaso} FROM corrida_pasos WHERE corrida=? ORDER BY paso, intento, id`, [corrida]).map((f) => deFilaPaso(f))
    } catch {
      return []
    }
  }

  /** El de mayor id. */
  pasoVigente(corrida: number): PasoCorrida | undefined {
    try {
      const f = this.db.query(`SELECT ${colsPaso} FROM corrida_pasos WHERE corrida=? ORDER BY id DESC LIMIT 1`, [corrida])[0]
      return f ? deFilaPaso(f) : undefined
    } catch {
      return undefined
    }
  }

  pasoBuscar(corrida: number, paso: number, intento: number): PasoCorrida | undefined {
    try {
      const f = this.db.query(`SELECT ${colsPaso} FROM corrida_pasos WHERE corrida=? AND paso=? AND intento=? ORDER BY id DESC LIMIT 1`, [corrida, paso, intento])[0]
      return f ? deFilaPaso(f) : undefined
    } catch {
      return undefined
    }
  }

  /** El paso cuya entrega vigente es esa. */
  pasoPorEntrega(entrega: number): PasoCorrida | undefined {
    try {
      const f = this.db.query(`SELECT ${colsPaso} FROM corrida_pasos WHERE entrega=? ORDER BY id DESC LIMIT 1`, [entrega])[0]
      return f ? deFilaPaso(f) : undefined
    } catch {
      return undefined
    }
  }

  /** Pasos en esos estados de las corridas de la oficina, junto con su corrida. */
  pasosEnEstado(oficina: string, estados: string[]): [Corrida, PasoCorrida][] {
    if (estados.length === 0) return []
    const cc = colsCorrida.split(',').map((c) => `c.${c} AS c_${c}`).join(',')
    const pc = colsPaso.split(',').map((c) => `p.${c} AS p_${c}`).join(',')
    const sql = `SELECT ${cc},${pc} FROM corrida_pasos p JOIN corridas c ON c.id=p.corrida WHERE c.oficina=? AND p.estado IN (${estados.map(() => '?').join(',')}) ORDER BY p.id`
    try {
      return this.db.query(sql, [oficina, ...estados]).map((f): [Corrida, PasoCorrida] => [deFilaCorrida(f, 'c_'), deFilaPaso(f, 'p_')])
    } catch {
      return []
    }
  }

  /** Cuántos pasos terminaron bien (estado listo) desde esa fecha. */
  pasosTerminadosDesde(oficina: string, desde: number): number {
    try {
      return num(this.db.query("SELECT COUNT(*) AS n FROM corrida_pasos p JOIN corridas c ON c.id=p.corrida WHERE c.oficina=? AND p.estado='listo' AND p.fin>=?", [oficina, desde])[0]?.n)
    } catch {
      return 0
    }
  }
}
