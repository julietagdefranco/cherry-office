// Programador de tareas (Programador.swift) y rutas /api/tareas* (TareasRouter.swift).
//
// Cada 30 s mira las tareas de la oficina activa y corre las que tocan, cada una como un chat del agente (carril, permisos
// y costo normales) en una sesión nueva. El estado vive en SQLite (`ejecuciones`). También corre los «encargos» (pendientes
// de reunión, pasos de flujo, acciones, coordinador, parte) y los «pedir cambios» de las entregas.
import { randomUUID } from 'node:crypto'
import { ClaudeError } from './claude-runner.js'
import { ErrorAPI } from './errores.js'
import { ArchivosEntrega, iso, type Entrega } from './entregas.js'
import { esObjeto, objeto, type Obj } from './json.js'
import type { AgenteDef } from './oficina.js'
import type { OficinaActiva } from './oficinas.js'
import { argumentos, contexto, entorno, variableTokenMCP } from './permisos.js'
import type { ProgramadorEntregas } from './rutas-entregas.js'
import { atrapar, no404, no405, type Query, type Resp, type SubRouter } from './router.js'
import { registrarModulo, type Servicios } from './servicios.js'
import { num, txt, type Fila, type SQLiteDB } from './sqlite.js'
import { CajaArchivos, CajaCosto } from './stream.js'
import {
  Programacion, ValidarTareas, esUnica, fechaInicio, tareaJSON, zonaDelSistema, type OrigenTarea, type TareaProgramada,
} from './tareas.js'
import { Slug, Validar, prefijo } from './validar.js'

// MARK: - ejecución (una corrida de una tarea)

export type Ejecucion = {
  id: number
  oficina: string
  tarea: string
  agente: string
  /** Horario programado que se cumple (epoch en segundos). En una corrida manual es el instante de inicio. */
  programada: number
  inicio: number
  fin?: number
  /** corriendo | ok | error */
  estado: string
  /** Sesión de chat donde quedó el pedido y la respuesta. */
  sid: string
  /** Respuesta del agente, recortada. */
  resultado: string
  error?: string
  costo?: number
  /** «Probar ahora»: no cuenta como la corrida programada de ese día. */
  manual: boolean
}

export function ejecucionJSON(e: Ejecucion): Obj {
  return {
    id: e.id, tarea: e.tarea, agente: e.agente, programada: iso(e.programada), inicio: iso(e.inicio), estado: e.estado, sid: e.sid,
    resultado: e.resultado, manual: e.manual, fin: e.fin === undefined ? null : iso(e.fin), error: e.error ?? null, costo: e.costo ?? null,
  }
}

// MARK: - SQLite (tabla `ejecuciones`, con clave de oficina)

export const maxResultado = 2000
const columnas = 'id,oficina,tarea,agente,programada,inicio,fin,estado,sid,resultado,error,costo,manual'

function deFila(f: Fila): Ejecucion {
  const e: Ejecucion = {
    id: num(f.id), oficina: txt(f.oficina), tarea: txt(f.tarea), agente: txt(f.agente), programada: num(f.programada), inicio: num(f.inicio),
    estado: txt(f.estado), sid: txt(f.sid), resultado: txt(f.resultado), manual: num(f.manual) !== 0,
  }
  if (f.fin !== null && f.fin !== undefined) e.fin = num(f.fin)
  if (f.error !== null && f.error !== undefined) e.error = txt(f.error)
  if (f.costo !== null && f.costo !== undefined) e.costo = num(f.costo)
  return e
}

/** Acceso a la tabla `ejecuciones` (extensión de Store en Swift). */
export class Ejecuciones {
  constructor(private readonly db: SQLiteDB) {}

  /** Crea la tabla si falta y pasa a `error` las ejecuciones que quedaron «corriendo» (la app se cerró en el medio). */
  preparar() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS ejecuciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oficina TEXT NOT NULL,
        tarea TEXT NOT NULL,
        agente TEXT NOT NULL,
        programada REAL NOT NULL,
        inicio REAL NOT NULL,
        fin REAL,
        estado TEXT NOT NULL,
        sid TEXT NOT NULL DEFAULT '',
        resultado TEXT NOT NULL DEFAULT '',
        error TEXT,
        costo REAL,
        manual INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ejecuciones_tarea ON ejecuciones(oficina, tarea, id);
    `)
    this.db.run("UPDATE ejecuciones SET estado='error', error=?, fin=? WHERE estado='corriendo'",
      ['Interrumpida: la app se cerró mientras corría.', Date.now() / 1000])
  }

  nueva(p: { oficina: string; tarea: string; agente: string; programada: number; inicio: number; sid: string; manual: boolean }): number {
    this.db.run("INSERT INTO ejecuciones(oficina,tarea,agente,programada,inicio,estado,sid,manual) VALUES(?,?,?,?,?,'corriendo',?,?)",
      [p.oficina, p.tarea, p.agente, p.programada, p.inicio, p.sid, p.manual ? 1 : 0])
    return num(this.db.query('SELECT last_insert_rowid() AS id')[0]?.id)
  }

  terminar(id: number, estado: string, resultado: string, error: string | undefined, costo: number | undefined) {
    this.db.run('UPDATE ejecuciones SET estado=?, fin=?, resultado=?, error=?, costo=? WHERE id=?',
      [estado, Date.now() / 1000, prefijo(resultado, maxResultado), error ?? null, costo ?? null, id])
  }

  una(id: number): Ejecucion | undefined {
    try {
      const f = this.db.query(`SELECT ${columnas} FROM ejecuciones WHERE id=?`, [id])[0]
      return f ? deFila(f) : undefined
    } catch {
      return undefined
    }
  }

  /** Últimas `limite` ejecuciones de una tarea, de la más nueva a la más vieja. */
  lista(oficina: string, tarea: string, limite = 20): Ejecucion[] {
    try {
      return this.db.query(`SELECT ${columnas} FROM ejecuciones WHERE oficina=? AND tarea=? ORDER BY id DESC LIMIT ?`, [oficina, tarea, limite]).map(deFila)
    } catch {
      return []
    }
  }

  ultima(oficina: string, tarea: string): Ejecucion | undefined { return this.lista(oficina, tarea, 1)[0] }

  /** Última corrida programada (no manual) de la tarea, en cualquier estado: con ella no se repite la misma programada. */
  ultimaProgramada(oficina: string, tarea: string): number | undefined {
    try {
      const v = this.db.query('SELECT MAX(programada) AS m FROM ejecuciones WHERE oficina=? AND tarea=? AND manual=0', [oficina, tarea])[0]?.m
      return v === null || v === undefined ? undefined : num(v)
    } catch {
      return undefined
    }
  }

  /** Última corrida programada (no manual) que arrancó desde `inicio` (epoch): para una tarea única, la que ya tuvo desde
   *  su último cambio de horario. */
  ultimaProgramadaDesde(oficina: string, tarea: string, inicio: number): number | undefined {
    try {
      const v = this.db.query('SELECT MAX(programada) AS m FROM ejecuciones WHERE oficina=? AND tarea=? AND manual=0 AND inicio>=?', [oficina, tarea, inicio])[0]?.m
      return v === null || v === undefined ? undefined : num(v)
    } catch {
      return undefined
    }
  }

  borrar(oficina: string, tarea: string) {
    this.db.run('DELETE FROM ejecuciones WHERE oficina=? AND tarea=?', [oficina, tarea])
  }
}

// MARK: - programador

export type GanchoTerminar = (e: Ejecucion) => Promise<void> | void
export type GanchoEntregar = (e: Entrega, ej: Ejecucion | undefined) => Promise<void> | void

export type OpcionesProgramador = {
  /** Reloj inyectable (tests). */
  reloj?: () => Date
  /** Zona del sistema (id IANA). */
  sistema?: string
}

export class Programador implements ProgramadorEntregas {
  /** Cada cuánto revisa las tareas (HQ_PROGRAMADOR_INTERVALO en segundos, para pruebas). */
  static readonly intervaloPorDefecto = 30
  /** Las corridas únicas que salen de un pendiente de reunión («Hacelo ahora») usan `encargo:<reunión>:<n>` como tarea. */
  static readonly prefijoEncargo = 'encargo:'
  static readonly prefijoFlujo = 'flujo:'
  static readonly prefijoAccion = 'accion:'
  static readonly prefijoCoordinador = 'coord:'
  static readonly prefijoParte = 'parte:'

  readonly ejecuciones: Ejecuciones
  readonly sistema: string
  private reloj: () => Date
  private readonly intervalo: number
  private readonly automatico: boolean
  private readonly ganchosTerminar: GanchoTerminar[] = []
  private readonly ganchosEntregar: GanchoEntregar[] = []
  private preparado = false
  private cerrado = false
  private revisando = false
  private bucle?: { parar(): void }
  /** `oficina \u001f tarea` de las que corren (o están por correr) ahora: evita dos corridas de la misma tarea a la vez. */
  private readonly reservadas = new Set<string>()
  private readonly corridas = new Map<number, Promise<void>>()

  /** `env.HQ_PROGRAMADOR === '0'` deja el bucle apagado (los tests llaman a `revisar()` a mano). */
  constructor(private readonly s: Servicios, op: OpcionesProgramador = {}) {
    this.ejecuciones = new Ejecuciones(s.store.db)
    this.reloj = op.reloj ?? (() => new Date())
    this.sistema = op.sistema ?? zonaDelSistema()
    this.automatico = s.env.HQ_PROGRAMADOR !== '0'
    const t = Number((s.env.HQ_PROGRAMADOR_INTERVALO ?? '').trim())
    this.intervalo = (s.env.HQ_PROGRAMADOR_INTERVALO ?? '').trim() !== '' && Number.isFinite(t) && t > 0 ? t : Programador.intervaloPorDefecto
  }

  /** Hook para avisos y notificaciones: se llama cuando una ejecución termina (ok o error), con la fila ya guardada.
   *  Cada llamada AGREGA un gancho. Se llama también para las corridas de «Probar ahora». */
  alTerminar(f: GanchoTerminar) { this.ganchosTerminar.push(f) }

  /** Hook para cuando se crea una entrega: con la ejecución que la produjo (`correr`) o con undefined (cambios). */
  alEntregar(f: GanchoEntregar) { this.ganchosEntregar.push(f) }

  /** Reloj inyectable (tests). */
  fijarReloj(r: () => Date) { this.reloj = r }

  /** La hora según el reloj del programador. */
  ahora(): Date { return this.reloj() }

  // MARK: ciclo de vida

  /** Arranca el bucle de revisión. Idempotente. */
  iniciar() {
    if (!this.automatico || this.bucle || this.cerrado) return
    let parar = false
    let timer: NodeJS.Timeout | undefined
    let despertar: (() => void) | undefined
    this.bucle = {
      parar: () => {
        parar = true
        if (timer) clearTimeout(timer)
        despertar?.()
      },
    }
    void (async () => {
      while (!parar) {
        await this.revisar()
        if (parar) break
        await new Promise<void>((r) => {
          despertar = r
          timer = setTimeout(r, this.intervalo * 1000)
          timer.unref()
        })
      }
    })()
  }

  /** Deja de revisar y de aceptar corridas nuevas (las en curso terminan solas; ver `esperar`). */
  detener() {
    this.cerrado = true
    this.bucle?.parar()
    this.bucle = undefined
  }

  /** Espera (hasta `limite` segundos) a que terminen las corridas en curso, para que guarden su estado antes de cerrar la base. */
  async esperar(limite = 5) {
    const en = [...this.corridas.values()]
    if (en.length === 0) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(en), new Promise<void>((r) => { timer = setTimeout(r, limite * 1000) })])
    clearTimeout(timer)
  }

  /** Crea la tabla y marca las interrumpidas, una sola vez por proceso y antes de cualquier corrida. */
  preparar() {
    if (this.preparado) return
    try {
      this.ejecuciones.preparar()
      this.preparado = true
    } catch {
      this.s.log.error('tareas: no pude preparar la tabla de ejecuciones')
    }
  }

  // MARK: revisión

  static clave(oficina: string, tarea: string) { return oficina + '\u001f' + tarea }

  estaCorriendo(oficina: string, tarea: string): boolean { return this.reservadas.has(Programador.clave(oficina, tarea)) }

  /** Una vuelta: corre las tareas activas de la oficina activa que tocan según `Programacion.debeCorrer`. */
  async revisar() {
    if (this.cerrado || this.revisando) return
    this.revisando = true
    try {
      this.preparar()
      const act = this.preparado ? this.s.oficinas.activa() : undefined
      if (!act) return
      const ahora = this.reloj()
      for (const t of act.oficina.tareas ?? []) {
        if (!t.activa) continue
        const def = act.oficina.agentes.find((a) => a.id === t.agente)
        if (!def || this.estaCorriendo(act.carpeta, t.id)) continue
        const u = esUnica(t)
          ? this.ejecuciones.ultimaProgramadaDesde(act.carpeta, t.id, (fechaInicio(t)?.getTime() ?? 0) / 1000)
          : this.ejecuciones.ultimaProgramada(act.carpeta, t.id)
        const p = Programacion.debeCorrer(t, ahora, u === undefined ? undefined : new Date(u * 1000), this.sistema)
        if (p === undefined) continue
        try {
          this.lanzar(act, t, def, p, false)
          this.s.log.info(`tarea ${t.id} agente=${def.id} programada=${Programacion.iso(p)}`)
        } catch {}
      }
    } finally {
      this.revisando = false
    }
  }

  /** «Probar ahora»: crea la ejecución y devuelve enseguida (la corrida sigue en segundo plano). */
  async correrAhora(act: OficinaActiva, t: TareaProgramada, def: AgenteDef, actuar: string[] = []): Promise<Ejecucion> {
    this.verificar(act.carpeta)
    this.preparar()
    return this.lanzar(act, t, def, new Date(), true, actuar)
  }

  /** Una tarea única que se crea «para ahora» (o con la hora ya pasada): corre enseguida como su corrida programada (no
   *  manual), así el programador no la vuelve a lanzar. */
  async correrUnica(act: OficinaActiva, t: TareaProgramada, def: AgenteDef): Promise<Ejecucion> {
    const p = esUnica(t) ? Programacion.instanteUnica(t, this.sistema) : undefined
    if (!p) throw new ErrorAPI(400, 'No es una tarea de una sola vez.')
    this.verificar(act.carpeta)
    this.preparar()
    return this.lanzar(act, t, def, p, false)
  }

  private verificar(carpeta: string) {
    try {
      this.s.runner.verificar(carpeta)
    } catch (e) {
      if (e instanceof ClaudeError) throw new ErrorAPI(500, e.mensaje)
      throw e
    }
  }

  /** Marca hecha (y en pausa) una tarea única que terminó bien, si sigue en la oficina abierta y no le cambiaron la fecha. */
  private marcarHecha(carpeta: string, t: TareaProgramada) {
    if (!esUnica(t) || this.s.oficinas.activa()?.carpeta !== carpeta) return
    const ahora = Programacion.iso(this.reloj())
    try {
      this.s.oficinas.modificar((o) => {
        const x = o.tareas?.find((y) => y.id === t.id)
        if (!x || x.fecha !== t.fecha || x.hora !== t.hora) return
        x.hecha = ahora
        x.activa = false
      })
    } catch {}
  }

  /** «Hacelo ahora» de un pendiente de reunión: una corrida única (no queda en `oficina.json`) con id de tarea
   *  `encargo:<reunión>:<n>`. */
  encargar(act: OficinaActiva, def: AgenteDef, p: { reunion: string; pendiente: number; nombre: string; consigna: string }): Promise<Ejecucion> {
    return this.encargarLibre(act, def, { id: Programador.idEncargo(p.reunion, p.pendiente), nombre: p.nombre, consigna: p.consigna })
  }

  /** Una corrida única con un id de tarea cualquiera (`encargo:`, `flujo:`, `accion:`, `coord:`, `parte:`): misma maquinaria
   *  que una tarea. `actuar`: herramientas de conectores de actuar que esta corrida puede usar. */
  encargarLibre(act: OficinaActiva, def: AgenteDef, p: { id: string; nombre: string; consigna: string; actuar?: string[] }): Promise<Ejecucion> {
    const t: TareaProgramada = { id: p.id, agente: def.id, nombre: p.nombre, consigna: p.consigna, dias: [1], hora: '00:00', activa: false }
    return this.correrAhora(act, t, def, p.actuar ?? [])
  }

  // MARK: pedir cambios (E4)

  static claveCambios(entrega: number) { return `cambios:${entrega}` }

  /** «Pedir cambios» sobre una entrega: retoma su conversación en el carril del agente con el pedido de la persona. Al
   *  terminar bien crea la entrega nueva (`padre` = la anterior, origen `cambios`) y la anterior pasa a `cambios`. Si falla,
   *  la anterior queda como estaba y se deja un aviso de error. Devuelve enseguida. */
  async pedirCambios(act: OficinaActiva, def: AgenteDef, e: Entrega, texto: string): Promise<void> {
    if (this.cerrado) throw new ErrorAPI(409, 'La app se está cerrando.')
    this.verificar(act.carpeta)
    const clave = Programador.clave(act.carpeta, Programador.claveCambios(e.id))
    if (this.reservadas.has(clave)) throw new ErrorAPI(409, 'Ya le estás pidiendo cambios a esta entrega.')
    this.reservadas.add(clave)
    const id = -e.id // las corridas de cambios se guardan con id negativo (no chocan con las ejecuciones)
    this.corridas.set(id, this.correrCambios(act, def, e, texto).catch(() => {}).finally(() => this.termino(id, clave)))
  }

  cambiandoEntrega(oficina: string, id: number): boolean { return this.reservadas.has(Programador.clave(oficina, Programador.claveCambios(id))) }

  private async correrCambios(act: OficinaActiva, def: AgenteDef, e: Entrega, texto: string) {
    const { store, runner, config, avisos, entregas } = this.s
    const ctx = contexto(act, def, { dirsExtra: config.oficinaDirsExtra, catalogo: this.s.catalogo?.() })
    const mcp = this.s.mcp?.()
    const mcpUrl = mcp ? await mcp.url() : undefined
    if (mcpUrl !== undefined) ctx.mcpUrl = mcpUrl
    const carpeta = act.carpeta, agente = def.id, sid = e.sid
    const caja = new CajaCosto(), escritos = new CajaArchivos()
    const duenio = act.oficina.duenio === '' ? 'la persona' : act.oficina.duenio
    const pedido = `Cambios que te pide ${duenio} sobre lo que entregaste («${e.titulo}»):\n\n${texto}`
    const r = await runner.conCarrilDe(carpeta, agente, async (): Promise<{ texto?: string; error?: string }> => {
      const envExtra: Record<string, string> = { ...entorno(ctx) }
      if (mcpUrl !== undefined && mcp) envExtra[variableTokenMCP] = mcp.emitir({ oficina: carpeta, agente, sid, perfil: ctx.perfilMCP })
      try {
        store.asegurarSesion(sid, agente, carpeta)
        store.agregar(sid, 'u', pedido)
        const activa = store.estaActiva(sid)
        const t = await runner.actividad.seguir({ oficina: carpeta, agente, origen: 'cambios', tarea: 'Cambios: ' + e.titulo, extra: caja.observador(escritos.observador()) },
          (obs) => runner.ejecutarChat({ agente, mensaje: pedido, sid, activa, carpeta, obs, envExtra, armar: (p) => argumentos(config, ctx, p) }))
        store.marcarActiva(sid)
        const guardado = t === '' ? '(sin respuesta)' : t
        store.agregar(sid, 'a', guardado)
        return { texto: guardado }
      } catch (err) {
        if (err instanceof ClaudeError) {
          try { store.agregar(sid, 'a', 'No pude responder: ' + err.mensaje, true) } catch {}
          return { error: err.mensaje }
        }
        return { error: 'No pude guardar la conversación.' }
      } finally {
        const tok = envExtra[variableTokenMCP]
        if (tok !== undefined) mcp?.revocar(tok)
      }
    })
    store.registrarCosto({ oficina: carpeta, agente, origen: 'cambios', ref: String(e.id), costo: caja.valor })
    if (r.texto !== undefined) {
      const nuevos = ArchivosEntrega.relativos(escritos.valor, carpeta)
      const arch = nuevos.length === 0 ? e.archivos : [...nuevos, ...e.archivos.filter((x) => !nuevos.includes(x))]
      const nueva = entregas.registrar({ oficina: carpeta, agente, nombre: def.nombre, origen: 'cambios', ref: sid, titulo: e.titulo, texto: r.texto, sid, archivos: arch, padre: e.id, costo: caja.valor })
      if (nueva) {
        entregas.marcar(carpeta, e.id, 'cambios')
        for (const g of this.ganchosEntregar) await this.llamar(() => g(nueva, undefined))
      }
      this.s.log.info(`cambios entrega=${e.id} agente=${agente} estado=ok`)
    } else {
      const av = avisos.crear({ oficina: carpeta, tipo: 'error', agente, texto: `No pudo hacer los cambios de «${e.titulo}»: ` + (r.error ?? 'error'), ref: sid })
      if (av) avisos.emitir(av, def.nombre)
      this.s.log.info(`cambios entrega=${e.id} agente=${agente} estado=error`)
    }
  }

  // MARK: ids de corridas

  /** Origen de la entrega, la actividad y el costo de una corrida, según el prefijo de su id de tarea. */
  static origenEntrega(id: string): string {
    if (id.startsWith(Programador.prefijoEncargo) || id.startsWith(Programador.prefijoCoordinador)) return 'encargo'
    if (id.startsWith(Programador.prefijoFlujo)) return 'flujo'
    if (id.startsWith(Programador.prefijoAccion)) return 'accion'
    if (id.startsWith(Programador.prefijoParte)) return 'parte'
    return 'tarea'
  }

  /** Id de tarea de un paso de flujo: `flujo:<corrida>:<paso>:<intento>`. */
  static idFlujo(p: { corrida: number; paso: number; intento: number }): string { return `${Programador.prefijoFlujo}${p.corrida}:${p.paso}:${p.intento}` }

  /** (corrida, paso, intento) de un id de paso de flujo; undefined si no lo es. */
  static deFlujo(id: string): [number, number, number] | undefined {
    if (!id.startsWith(Programador.prefijoFlujo)) return undefined
    const p = id.slice(Programador.prefijoFlujo.length).split(':')
    if (p.length !== 3 || !p.every((x) => /^[+-]?\d+$/.test(x))) return undefined
    return [Number(p[0]), Number(p[1]), Number(p[2])]
  }

  static idEncargo(reunion: string, pendiente: number): string { return `${Programador.prefijoEncargo}${reunion}:${pendiente}` }

  /** (reunión, pendiente) de un id de encargo; undefined si no lo es. */
  static deEncargo(id: string): [string, number] | undefined {
    if (!id.startsWith(Programador.prefijoEncargo)) return undefined
    const p = id.slice(Programador.prefijoEncargo.length).split(':').filter((x) => x !== '')
    if (p.length !== 2 || !/^[+-]?\d+$/.test(p[1]!)) return undefined
    return [p[0]!, Number(p[1])]
  }

  // MARK: corrida

  private lanzar(act: OficinaActiva, t: TareaProgramada, def: AgenteDef, programada: Date, manual: boolean, actuar: string[] = []): Ejecucion {
    if (this.cerrado) throw new ErrorAPI(409, 'La app se está cerrando.')
    const clave = Programador.clave(act.carpeta, t.id)
    if (this.reservadas.has(clave)) throw new ErrorAPI(409, 'Esa tarea ya se está corriendo.')
    this.reservadas.add(clave)
    const sid = randomUUID().toLowerCase()
    const inicio = Date.now() / 1000
    let id: number
    try {
      id = this.ejecuciones.nueva({ oficina: act.carpeta, tarea: t.id, agente: def.id, programada: programada.getTime() / 1000, inicio, sid, manual })
    } catch {
      this.reservadas.delete(clave)
      throw new ErrorAPI(500, 'No pude guardar la ejecución.')
    }
    const ej: Ejecucion = { id, oficina: act.carpeta, tarea: t.id, agente: def.id, programada: programada.getTime() / 1000, inicio, estado: 'corriendo', sid, resultado: '', manual }
    this.corridas.set(id, this.correr(ej, act, t, def, actuar).catch((e) => {
      this.s.log.error(`tarea ${t.id}: ${e instanceof Error ? e.message : e}`)
    }).finally(() => this.termino(id, clave)))
    return ej
  }

  private termino(id: number, clave: string) {
    this.corridas.delete(id)
    this.reservadas.delete(clave)
  }

  private async llamar(f: () => Promise<void> | void) {
    try {
      await f()
    } catch (e) {
      this.s.log.error(`programador: gancho: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Lo mismo que el chat: carril del agente, permisos de la oficina, actividad (origen «tarea») y costo (origen «tarea»,
   *  ref = id de la tarea), en una sesión nueva donde quedan el pedido y la respuesta como un chat más. */
  private async correr(ej: Ejecucion, act: OficinaActiva, t: TareaProgramada, def: AgenteDef, actuar: string[]) {
    const { store, runner, config, entregas } = this.s
    const ctx = contexto(act, def, { dirsExtra: config.oficinaDirsExtra, actuar, catalogo: this.s.catalogo?.() })
    // MCP también fuera del chat: token con el perfil del agente, que vive lo que dura la corrida
    const mcp = this.s.mcp?.()
    const mcpUrl = mcp ? await mcp.url() : undefined
    if (mcpUrl !== undefined) ctx.mcpUrl = mcpUrl
    const origen = Programador.origenEntrega(ej.tarea)
    const carpeta = act.carpeta, agente = def.id, sid = ej.sid, consigna = t.consigna, nombre = t.nombre
    const caja = new CajaCosto()
    const escritos = new CajaArchivos()
    const r = await runner.conCarrilDe(carpeta, agente, async (): Promise<{ texto: string; error?: string }> => {
      const envExtra: Record<string, string> = { ...entorno(ctx) }
      if (mcpUrl !== undefined && mcp) envExtra[variableTokenMCP] = mcp.emitir({ oficina: carpeta, agente, sid, perfil: ctx.perfilMCP })
      try {
        store.asegurarSesion(sid, agente, carpeta)
        store.agregar(sid, 'u', consigna)
        const texto = await runner.actividad.seguir({ oficina: carpeta, agente, origen, tarea: nombre, extra: caja.observador(escritos.observador()) },
          (obs) => runner.ejecutarChat({ agente, mensaje: consigna, sid, activa: false, carpeta, obs, envExtra, armar: (p) => argumentos(config, ctx, p) }))
        store.marcarActiva(sid)
        const guardado = texto === '' ? '(sin respuesta)' : texto
        store.agregar(sid, 'a', guardado)
        return { texto: guardado }
      } catch (e) {
        const m = e instanceof ClaudeError ? e.mensaje : 'No pude guardar la conversación.'
        try { store.agregar(sid, 'a', 'No pude responder: ' + m, true) } catch {}
        return { texto: '', error: m }
      } finally {
        const tok = envExtra[variableTokenMCP]
        if (tok !== undefined) mcp?.revocar(tok)
      }
    })
    store.registrarCosto({ oficina: carpeta, agente, origen, ref: ej.tarea, costo: caja.valor })
    try {
      this.ejecuciones.terminar(ej.id, r.error === undefined ? 'ok' : 'error', r.texto, r.error, caja.valor)
    } catch {}
    this.s.log.info(`tarea ${ej.tarea} agente=${agente} estado=${r.error === undefined ? 'ok' : 'error'}`)
    if (r.error === undefined) {
      const entrega = entregas.registrar({
        oficina: carpeta, agente, nombre: def.nombre, origen, ref: ej.tarea, titulo: nombre, texto: r.texto, sid,
        archivos: ArchivosEntrega.relativos(escritos.valor, carpeta), costo: caja.valor,
      })
      this.marcarHecha(carpeta, t)
      const fin = this.ejecuciones.una(ej.id)
      if (entrega && fin) for (const g of this.ganchosEntregar) await this.llamar(() => g(entrega, fin))
    }
    const fin = this.ejecuciones.una(ej.id)
    if (fin) for (const g of this.ganchosTerminar) await this.llamar(() => g(fin))
  }
}

/** Nombre para el aviso de una corrida que no es una tarea de `oficina.json`, según el prefijo de su id (Backend.nombreCorrida). */
export function nombreCorrida(id: string): string {
  if (Programador.deEncargo(id) !== undefined) return 'Pendiente de reunión'
  if (id.startsWith(Programador.prefijoFlujo)) return 'Paso de flujo'
  if (id.startsWith(Programador.prefijoAccion)) return 'Acción aprobada'
  if (id.startsWith(Programador.prefijoCoordinador)) return 'Encargo del coordinador'
  if (id.startsWith(Programador.prefijoParte)) return 'Parte del día'
  return id
}

// MARK: - rutas /api/tareas*

const maxBody = 200_000

export class TareasRouter implements SubRouter {
  constructor(private readonly s: Servicios, private readonly programador: Programador, private readonly reloj: () => Date = () => new Date()) {}

  static esRuta = (p: string) => p === '/api/tareas' || p.startsWith('/api/tareas/')

  private get sistema() { return this.programador.sistema }

  async handle(method: string, path: string, _query: Query, body?: Buffer) {
    if (!TareasRouter.esRuta(path)) return null
    return atrapar(async () => this.despachar(method, path, body))
  }

  private async despachar(method: string, path: string, body?: Buffer): Promise<Resp> {
    const partes = path.split('/').slice(1)
    if (partes.length < 2 || partes.length > 4 || partes.includes('')) return no404
    this.programador.preparar()
    if (partes.length === 2) {
      switch (method) {
        case 'GET': return this.listar()
        case 'POST': return this.crear(body)
        default: return no405
      }
    }
    const id = partes[2]!
    if (!Slug.valido(id)) return no404
    if (partes.length === 3) {
      switch (method) {
        case 'GET': return this.ver(id)
        case 'PATCH': return this.editar(id, body)
        case 'DELETE': return this.borrar(id)
        default: return no405
      }
    }
    switch (partes[3]) {
      case 'correr': return method === 'POST' ? this.correr(id) : no405
      case 'ejecuciones': return method === 'GET' ? this.ejecucionesDe(id) : no405
      default: return no404
    }
  }

  // MARK: vistas

  private vista(t: TareaProgramada, a: OficinaActiva, ahora: Date): Obj {
    const o = tareaJSON(t, this.sistema)
    const ult = this.programador.ejecuciones.ultima(a.carpeta, t.id)
    const sigue = t.activa && a.oficina.agentes.some((x) => x.id === t.agente)
    const prox = sigue ? Programacion.proxima(t, ahora, this.sistema) : undefined
    o.proxima = prox ? Programacion.iso(prox) : null
    o.ultima = ult ? ejecucionJSON(ult) : null
    o.corriendo = this.programador.estaCorriendo(a.carpeta, t.id)
    // única: el instante en que le toca (aunque ya haya pasado), para mostrarlo en la zona que sea
    if (esUnica(t)) {
      const c = Programacion.instanteUnica(t, this.sistema)
      o.cuando = c ? Programacion.iso(c) : null
    }
    return o
  }

  private buscar(id: string, a: OficinaActiva): TareaProgramada {
    const t = a.oficina.tareas?.find((x) => x.id === id)
    if (!t) throw new ErrorAPI(404, 'No existe esa tarea.')
    return t
  }

  private listar(): Resp {
    const a = this.s.oficinas.requerirActiva()
    const ahora = this.reloj()
    return [200, { tareas: (a.oficina.tareas ?? []).map((t) => this.vista(t, a, ahora)) }]
  }

  private ver(id: string): Resp {
    const a = this.s.oficinas.requerirActiva()
    return [200, { tarea: this.vista(this.buscar(id, a), a, this.reloj()) }]
  }

  // MARK: cuerpo

  private static dias(v: unknown): number[] {
    if (!Array.isArray(v) || v.length === 0) throw new ErrorAPI(400, 'Elegí al menos un día (números del 1, lunes, al 7, domingo).')
    const out: number[] = []
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 7 || out.includes(x)) {
        throw new ErrorAPI(400, 'Los días tienen que ser números del 1 (lunes) al 7 (domingo), sin repetir.')
      }
      out.push(x)
    }
    return out.sort((a, b) => a - b)
  }

  private static hora(v: unknown): string {
    const h = Validar.texto(v, 'hora', 5)!
    if (ValidarTareas.hora(h) === undefined) throw new ErrorAPI(400, 'La hora tiene que ser HH:MM (por ejemplo 08:00).')
    return h
  }

  private static zona(v: unknown): string | undefined {
    const z = Validar.texto(v, 'zona', 64, false)
    if (z === undefined) return undefined
    if (!ValidarTareas.zonaValida(z)) throw new ErrorAPI(400, 'No conozco esa zona horaria (usá, por ejemplo, America/Argentina/Buenos_Aires).')
    return z
  }

  /** «tipo»: "repetida" | "unica" (undefined si no vino). Devuelve si es única. */
  private static tipo(v: unknown): boolean | undefined {
    if (v === undefined || v === null) return undefined
    if (v === 'unica') return true
    if (v === 'repetida') return false
    throw new ErrorAPI(400, '«tipo» tiene que ser "repetida" o "unica".')
  }

  private static fecha(v: unknown): string {
    const f = Validar.texto(v, 'fecha', 10)!
    if (Programacion.diaCalendario(f) === undefined) throw new ErrorAPI(400, 'La fecha tiene que ser AAAA-MM-DD (por ejemplo 2026-11-20).')
    return f
  }

  private static booleano(v: unknown, campo: string): boolean | undefined {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'boolean') throw new ErrorAPI(400, `«${campo}» tiene que ser verdadero o falso.`)
    return v
  }

  /** `{reunion, pendiente}` opcional («Convertir en tarea» desde el acta). */
  private static origen(v: unknown): OrigenTarea | undefined {
    if (v === undefined || v === null) return undefined
    const malo = () => new ErrorAPI(400, '«origen» tiene que ser {reunion, pendiente}.')
    if (!esObjeto(v) || typeof v.reunion !== 'string' || typeof v.pendiente !== 'number' || !Number.isInteger(v.pendiente)) throw malo()
    const o: OrigenTarea = { reunion: v.reunion.toLowerCase(), pendiente: v.pendiente }
    if (!ValidarTareas.origenValido(o)) throw malo()
    return o
  }

  // MARK: altas, cambios y bajas

  private async crear(body?: Buffer): Promise<Resp> {
    const d = objeto(body, maxBody)
    const agente = Validar.texto(d.agente, 'agente', 41)!
    const nombre = Validar.texto(d.nombre, 'nombre', ValidarTareas.maxNombre)!
    const consigna = Validar.texto(d.consigna, 'consigna', ValidarTareas.maxConsigna)!
    // única: {tipo: "unica", fecha, hora} o {tipo: "unica", ahora: true}; repetida (por defecto): {dias, hora}
    if (d.fecha !== undefined && d.dias !== undefined) throw new ErrorAPI(400, 'Elegí días (si se repite) o una fecha (si es una sola vez), no las dos cosas.')
    const ahoraPedido = TareasRouter.booleano(d.ahora, 'ahora') ?? false
    const unica = TareasRouter.tipo(d.tipo) ?? (d.fecha !== undefined || ahoraPedido)
    if (ahoraPedido && !unica) throw new ErrorAPI(400, '«ahora» es solo para tareas de una sola vez.')
    const zona = TareasRouter.zona(d.zona) ?? this.sistema
    let dias: number[], hora: string, fecha: string | undefined
    if (unica) {
      dias = []
      if (ahoraPedido) {
        fecha = Programacion.textoDia(this.reloj(), zona)
        hora = Programacion.textoHora(this.reloj(), zona)
      } else {
        fecha = TareasRouter.fecha(d.fecha)
        hora = TareasRouter.hora(d.hora)
      }
    } else {
      dias = TareasRouter.dias(d.dias)
      hora = TareasRouter.hora(d.hora)
    }
    const activa = TareasRouter.booleano(d.activa, 'activa') ?? true
    const origen = TareasRouter.origen(d.origen)
    const pedidoId = Validar.texto(d.id, 'id', 41, false)
    if (pedidoId !== undefined && !Slug.valido(pedidoId)) throw new ErrorAPI(400, 'Id de tarea inválido (usá minúsculas, números y guiones).')
    const ahora = Programacion.iso(this.reloj())
    const [t, a] = this.s.oficinas.modificar((o) => {
      if (!o.agentes.some((x) => x.id === agente)) throw new ErrorAPI(404, 'No existe ese agente.')
      const ts = o.tareas ?? []
      if (ts.length >= ValidarTareas.maxTareas) throw new ErrorAPI(400, `Máximo ${ValidarTareas.maxTareas} tareas programadas.`)
      const usados = new Set(ts.map((x) => x.id))
      if (pedidoId !== undefined && usados.has(pedidoId)) throw new ErrorAPI(409, 'Ya hay una tarea con ese id.')
      const id = pedidoId ?? Slug.unico(nombre, usados, 'tarea')
      const t: TareaProgramada = { id, agente, nombre, consigna, dias, hora, zona, activa, creada: ahora, desde: ahora }
      if (origen) t.origen = origen
      if (fecha !== undefined) t.fecha = fecha
      ts.push(t)
      o.tareas = ts
      return t
    })
    // una única cuya hora ya llegó («ahora» o una hora pasada) arranca enseguida, sin esperar la vuelta del programador
    if (esUnica(t) && t.activa) {
      const i = Programacion.instanteUnica(t, this.sistema)
      const def = a.oficina.agentes.find((x) => x.id === t.agente)
      if (i !== undefined && i <= this.reloj() && def) {
        try { await this.programador.correrUnica(a, t, def) } catch {}
      }
    }
    return [200, { tarea: this.vista(t, a, this.reloj()) }]
  }

  private editar(id: string, body?: Buffer): Resp {
    const d = objeto(body, maxBody)
    const nombre = Validar.texto(d.nombre, 'nombre', ValidarTareas.maxNombre, false)
    const consigna = Validar.texto(d.consigna, 'consigna', ValidarTareas.maxConsigna, false)
    const dias = d.dias === undefined ? undefined : TareasRouter.dias(d.dias)
    const hora = d.hora === undefined ? undefined : TareasRouter.hora(d.hora)
    const zona = TareasRouter.zona(d.zona)
    const activa = TareasRouter.booleano(d.activa, 'activa')
    const tipo = TareasRouter.tipo(d.tipo)
    if (d.fecha !== undefined && d.dias !== undefined) throw new ErrorAPI(400, 'Elegí días (si se repite) o una fecha (si es una sola vez), no las dos cosas.')
    const fecha = d.fecha === undefined ? undefined : TareasRouter.fecha(d.fecha)
    const ahora = Programacion.iso(this.reloj())
    const [t, a] = this.s.oficinas.modificar((o) => {
      const i = o.tareas?.findIndex((x) => x.id === id) ?? -1
      if (i < 0) throw new ErrorAPI(404, 'No existe esa tarea.')
      const t: TareaProgramada = { ...o.tareas![i]! }
      let cambioHorario = false
      if (nombre !== undefined) t.nombre = nombre
      if (consigna !== undefined) t.consigna = consigna
      // pasar de un tipo al otro
      const unica = tipo ?? (fecha !== undefined ? true : dias !== undefined ? false : esUnica(t))
      if (unica && !esUnica(t)) {
        if (fecha === undefined) throw new ErrorAPI(400, 'Para que se haga una sola vez, elegí la fecha.')
        t.fecha = fecha
        t.dias = []
        cambioHorario = true
      } else if (!unica && esUnica(t)) {
        if (dias === undefined) throw new ErrorAPI(400, 'Para que se repita, elegí los días.')
        delete t.fecha
        delete t.hecha
        t.dias = dias
        cambioHorario = true
      } else if (unica) {
        if (dias !== undefined) throw new ErrorAPI(400, 'Una tarea de una sola vez no lleva días: cambiale la fecha.')
        if (fecha !== undefined && fecha !== t.fecha) {
          t.fecha = fecha
          cambioHorario = true
        }
      } else {
        if (fecha !== undefined) throw new ErrorAPI(400, 'Una tarea que se repite no lleva fecha: cambiale los días.')
        if (dias !== undefined && JSON.stringify(dias) !== JSON.stringify(t.dias)) {
          t.dias = dias
          cambioHorario = true
        }
      }
      if (hora !== undefined && hora !== t.hora) {
        t.hora = hora
        cambioHorario = true
      }
      if (zona !== undefined && zona !== t.zona) {
        t.zona = zona
        cambioHorario = true
      }
      // una única hecha a la que le cambian el horario vuelve a estar pendiente (y activa, salvo que la pausen)
      if (esUnica(t) && t.hecha !== undefined && cambioHorario) {
        delete t.hecha
        if (activa === undefined) t.activa = true
      }
      if (activa !== undefined) {
        if (activa && !t.activa) {
          if (!o.agentes.some((x) => x.id === t.agente)) throw new ErrorAPI(409, 'El agente de esta tarea ya no está en la oficina.')
          if (esUnica(t) && t.hecha !== undefined) {
            throw new ErrorAPI(409, 'Esta tarea ya se hizo. Cambiale la fecha o la hora para que se haga de nuevo, o usá «Hacer ahora».')
          }
          cambioHorario = true
        }
        t.activa = activa
      }
      if (esUnica(t) && t.activa && !o.agentes.some((x) => x.id === t.agente)) {
        throw new ErrorAPI(409, 'El agente de esta tarea ya no está en la oficina.')
      }
      // una tarea movida o reactivada no se pone al día con el horario que ya pasó hoy
      if (cambioHorario) t.desde = ahora
      o.tareas![i] = t
      return t
    })
    return [200, { tarea: this.vista(t, a, this.reloj()) }]
  }

  private borrar(id: string): Resp {
    const a = this.s.oficinas.requerirActiva()
    this.buscar(id, a)
    if (this.programador.estaCorriendo(a.carpeta, id)) throw new ErrorAPI(409, 'La tarea está corriendo ahora. Esperá a que termine para borrarla.')
    this.s.oficinas.modificar((o) => {
      if (!o.tareas?.some((x) => x.id === id)) throw new ErrorAPI(404, 'No existe esa tarea.')
      o.tareas = o.tareas.filter((x) => x.id !== id)
      if (o.tareas.length === 0) delete o.tareas
    })
    try { this.programador.ejecuciones.borrar(a.carpeta, id) } catch {}
    return [200, { ok: true }]
  }

  // MARK: corridas

  private async correr(id: string): Promise<Resp> {
    const a = this.s.oficinas.requerirActiva()
    const t = this.buscar(id, a)
    const def = a.oficina.agentes.find((x) => x.id === t.agente)
    if (!def) throw new ErrorAPI(409, 'El agente de esta tarea ya no está en la oficina.')
    const ej = await this.programador.correrAhora(a, t, def)
    return [202, { ejecucion: ejecucionJSON(ej) }]
  }

  private ejecucionesDe(id: string): Resp {
    const a = this.s.oficinas.requerirActiva()
    this.buscar(id, a)
    return [200, { ejecuciones: this.programador.ejecuciones.lista(a.carpeta, id, 20).map(ejecucionJSON) }]
  }
}

// MARK: - módulo

/** El programador (undefined hasta que se instala el módulo de tareas). */
export const programadorDe = (s: Servicios) => s.huecos.programador as Programador | undefined

export function instalar(s: Servicios) {
  const prog = new Programador(s)
  prog.preparar()
  s.huecos.programador = prog
  s.router.tareas = new TareasRouter(s, prog)
  s.validaciones.push((o) => ValidarTareas.validar(o))

  // una tarea que falla deja un aviso «te necesita» (y la notificación nativa, vía el canal). Las que terminan bien dejan
  // una entrega (la crea el programador), que la reemplaza en la bandeja.
  prog.alTerminar((e) => {
    if (e.estado === 'ok') return
    const of = s.oficinas.activa()?.oficina
    const tarea = of?.tareas?.find((t) => t.id === e.tarea)?.nombre ?? nombreCorrida(e.tarea)
    const texto = `«${tarea}» falló: ` + (e.error ?? 'error')
    const av = s.avisos.crear({ oficina: e.oficina, tipo: 'error', agente: e.agente, texto, ref: e.sid })
    if (av) s.avisos.emitir(av, of?.agentes.find((a) => a.id === e.agente)?.nombre ?? e.agente)
  })

  s.alArrancar.push(() => prog.iniciar())
  // Swift: programador.detener → mcp.cerrar → runner.shutdown → programador.esperar
  s.alCerrar.unshift(() => prog.detener())
  s.despuesDeProcesos.push(() => prog.esperar())
}

registrarModulo('tareas', 40, instalar)
