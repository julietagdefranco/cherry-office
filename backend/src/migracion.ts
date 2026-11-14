// Importa los datos del server Python (una sola vez, idempotente, marcada en `meta`) (Migracion.swift):
// `.sesiones.json`, `.datos/hq.db` y, best effort, los transcripts de ~/.claude/projects.
// Nunca mueve ni borra nada de las carpetas de origen.
// El router espera esta migración con `s.listo` antes de atender cada pedido (como `listo()` en Swift).
import fs from 'node:fs'
import path from 'node:path'
import { Config } from './config.js'
import { esObjeto } from './json.js'
import type { HQLog } from './log.js'
import { registrarModulo, type Servicios } from './servicios.js'
import { SQLiteDB, num, txt } from './sqlite.js'
import type { Store } from './store.js'
import { uuidValido } from './validar.js'

export const claveMigracion = 'migracion_legacy_v1'

export type ResultadoMigracion = { hecha: boolean; yaHabiaCorrido: boolean; sesiones: number; mensajes: number; desdeTranscripts: number }

type LSesion = { sid: string; agente: string; activa: boolean; creada: number }
type LMsg = { sid: string; r: string; t: string; e: boolean; ts: number }
export type Lote = { sesiones: LSesion[]; mensajes: LMsg[] }

/** Importa un lote en `hq.db`: las sesiones que ya existen se dejan, y los mensajes solo entran para sesiones que no tenían
 *  ninguno antes del lote (así reimportar no duplica). Devuelve (sesiones nuevas, mensajes importados). */
export function importarLote(store: Store, lote: Lote): { sesiones: number; mensajes: number } {
  const db = store.db
  return db.transaccion(() => {
    let ns = 0
    let nm = 0
    const conMensajes = new Set(db.query('SELECT DISTINCT sid FROM mensajes').map((f) => txt(f.sid)))
    for (const s of lote.sesiones) {
      ns += db.run('INSERT OR IGNORE INTO sesiones(id,agente,creada,activa) VALUES(?,?,?,?)', [s.sid, s.agente, s.creada, s.activa ? 1 : 0])
    }
    for (const m of lote.mensajes) {
      if (conMensajes.has(m.sid) || store.agenteDe(m.sid) === undefined) continue
      nm += db.run('INSERT INTO mensajes(sid,rol,texto,error,ts) VALUES(?,?,?,?,?)', [m.sid, m.r, m.t, m.e ? 1 : 0, m.ts])
    }
    return { sesiones: ns, mensajes: nm }
  })
}

/** `.sesiones.json`: {sid: agente}; todas se consideran activas (ya existen en claude). */
export function leerSesionesJSON(ruta: string, lote: Lote) {
  let o: unknown
  try {
    o = JSON.parse(fs.readFileSync(ruta, 'utf8'))
  } catch {
    return
  }
  if (!esObjeto(o)) return
  const ahora = Date.now() / 1000
  for (const [sid, a] of Object.entries(o)) {
    if (!uuidValido(sid) || typeof a !== 'string' || a === '') continue
    lote.sesiones.push({ sid: sid.toLowerCase(), agente: a, activa: true, creada: ahora })
  }
}

/** Base vieja de Python: sesiones(sid,agente,activa,creada,...) y mensajes(sid,r,t,e,ts). Solo lectura. */
export function leerBaseVieja(ruta: string, lote: Lote) {
  if (!fs.existsSync(ruta)) return
  let db: SQLiteDB
  try {
    db = new SQLiteDB(ruta, { soloLectura: true })
  } catch {
    return
  }
  try {
    try {
      const ss: LSesion[] = db.query('SELECT sid,agente,activa,creada FROM sesiones').map((r) => ({
        sid: txt(r.sid).toLowerCase(), agente: txt(r.agente), activa: num(r.activa) !== 0, creada: num(r.creada),
      }))
      const ya = new Set(lote.sesiones.map((s) => s.sid))
      lote.sesiones.push(...ss.filter((s) => uuidValido(s.sid) && s.agente !== '' && !ya.has(s.sid)))
    } catch {}
    try {
      lote.mensajes.push(...db.query('SELECT sid,r,t,e,ts FROM mensajes ORDER BY id').map((r): LMsg => ({
        sid: txt(r.sid).toLowerCase(), r: txt(r.r), t: txt(r.t), e: num(r.e) !== 0, ts: num(r.ts),
      })))
    } catch {}
  } finally {
    db.close()
  }
}

// MARK: - transcripts de Claude Code

export type Turno = { r: string; t: string; ts: number }

/** Claude codifica la carpeta reemplazando todo lo que no es [A-Za-z0-9] por "-" (por escalar Unicode). */
export function codificarCarpeta(cwd: string): string {
  return [...cwd].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c : '-')).join('')
}

export function archivoTranscript(sid: string, proyecto: string, home: string): string | undefined {
  const base = path.join(home, '.claude', 'projects')
  const directo = path.join(base, codificarCarpeta(proyecto), `${sid}.jsonl`)
  if (fs.existsSync(directo)) return directo
  // fallback: cualquier carpeta de proyectos que lo tenga (otra codificación)
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(base)
  } catch {}
  for (const d of dirs) {
    const p = path.join(base, d, `${sid}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

/** Fecha ISO 8601 con zona (con o sin fracción de segundo) → epoch en segundos; 0 si no se entiende. */
function fechaISO(v: unknown): number {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return 0
  const t = Date.parse(v)
  return Number.isFinite(t) ? t / 1000 : 0
}

/** Un turno por cada mensaje de texto del usuario; la respuesta es el último texto del asistente antes del siguiente mensaje
 *  del usuario (lo mismo que devolvía `result`). Ignora sidechains, meta y tool_result. */
export function turnosDe(sid: string, proyecto: string, home: string): Turno[] {
  const p = archivoTranscript(sid, proyecto, home)
  if (!p) return []
  let data: string
  try {
    data = fs.readFileSync(p, 'utf8')
  } catch {
    return []
  }
  const out: Turno[] = []
  let ultimoAsistente: Turno | undefined
  const cerrar = () => {
    if (ultimoAsistente) {
      out.push(ultimoAsistente)
      ultimoAsistente = undefined
    }
  }
  for (const linea of data.split('\n')) {
    if (linea === '') continue
    let o: unknown
    try {
      o = JSON.parse(linea)
    } catch {
      continue
    }
    if (!esObjeto(o)) continue
    const tipo = o.type
    if ((tipo !== 'user' && tipo !== 'assistant') || o.isSidechain === true || o.isMeta === true || !esObjeto(o.message)) continue
    const ts = fechaISO(o.timestamp)
    const c = o.message.content
    let texto = ''
    if (typeof c === 'string') texto = c
    else if (Array.isArray(c)) {
      texto = c.filter((b) => esObjeto(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as { text: string }).text).join('\n')
    }
    texto = texto.trim()
    if (texto === '') continue
    if (tipo === 'user') {
      if (texto.startsWith('<command-') || texto.startsWith('<local-command') || texto.startsWith('<system-reminder')) continue
      cerrar()
      out.push({ r: 'u', t: texto, ts })
    } else {
      ultimoAsistente = { r: 'a', t: texto, ts }
    }
  }
  cerrar()
  return out
}

// MARK: - migración

export async function ejecutarMigracion(
  { store, config, log, env = process.env }: { store: Store; config: Config; log: HQLog; env?: NodeJS.ProcessEnv },
): Promise<ResultadoMigracion> {
  const res: ResultadoMigracion = { hecha: false, yaHabiaCorrido: false, sesiones: 0, mensajes: 0, desdeTranscripts: 0 }
  if (store.meta(claveMigracion) !== undefined) {
    res.yaHabiaCorrido = true
    return res
  }
  let dirs = [...config.legacyDirs]
  const e = env.HQ_LEGACY_DIR
  if (e !== undefined && e !== '') dirs.unshift(Config.ruta(e, config.home))
  dirs = dirs.filter((d, i) => dirs.indexOf(d) === i)

  const huerfanas: { sid: string; agente: string }[] = []
  for (const d of dirs) {
    const json = path.join(d, '.sesiones.json')
    const dbp = path.join(d, '.datos', 'hq.db')
    if (!fs.existsSync(json) && !fs.existsSync(dbp)) continue
    res.hecha = true
    const lote: Lote = { sesiones: [], mensajes: [] }
    leerSesionesJSON(json, lote)
    leerBaseVieja(dbp, lote)
    try {
      const r = importarLote(store, lote)
      res.sesiones += r.sesiones
      res.mensajes += r.mensajes
    } catch (err) {
      log.error(`migracion: no pude importar un origen (${err instanceof Error ? err.message : err})`)
      continue
    }
    for (const s of lote.sesiones) huerfanas.push({ sid: s.sid, agente: s.agente })
  }

  // transcripts: solo para sesiones que quedaron sin mensajes
  const lote2: Lote = { sesiones: [], mensajes: [] }
  for (const s of huerfanas) {
    if (store.cuentaMensajes(s.sid) !== 0) continue
    for (const t of turnosDe(s.sid, config.proyecto, config.home)) lote2.mensajes.push({ sid: s.sid, r: t.r, t: t.t, e: false, ts: t.ts })
  }
  if (lote2.mensajes.length > 0) {
    try { res.desdeTranscripts = importarLote(store, lote2).mensajes } catch {}
  }

  if (res.hecha) {
    try { store.fijarMeta(claveMigracion, String(Date.now() / 1000)) } catch {}
    log.info(`migracion sesiones=${res.sesiones} mensajes=${res.mensajes} transcripts=${res.desdeTranscripts}`)
  }
  return res
}

/** Promesa de la migración inicial (la espera el router). */
export const migracionDe = (s: Servicios) => s.huecos.migracion as Promise<ResultadoMigracion> | undefined

registrarModulo('migracion', 90, (s) => {
  const p = ejecutarMigracion({ store: s.store, config: s.config, log: s.log, env: s.env }).catch((err): ResultadoMigracion => {
    s.log.error(`migracion: ${err instanceof Error ? err.message : err}`)
    return { hecha: false, yaHabiaCorrido: false, sesiones: 0, mensajes: 0, desdeTranscripts: 0 }
  })
  s.huecos.migracion = p
  const anterior = s.listo
  s.listo = async () => {
    await anterior?.()
    await p
  }
})
