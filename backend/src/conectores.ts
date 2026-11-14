// Detección y clasificación de los conectores de claude.ai (Conectores.swift). El catálogo (`CatalogoConectores`) es la
// última detección, en memoria; vive en `s.huecos.catalogo` y se llena con `claude -p --model haiku --tools ""` leyendo el
// evento `system/init` (`mcp_servers`). `cortoHerramienta` y `ConectoresAgente` están en permisos.ts.
import { ClaudeError, ClaudeRunner } from './claude-runner.js'
import { esObjeto } from './json.js'
import { cortoHerramienta, type ServidorConector } from './permisos.js'
import type { Servicios } from './servicios.js'

export type { ServidorConector }

/** Un servidor está disponible si su estado es `connected`. */
export const disponible = (s: ServidorConector) => s.estado === 'connected'

/** Última detección de conectores, en memoria (una por backend). */
export class CatalogoConectores {
  private lista?: ServidorConector[]
  private cuando?: Date
  private enCurso = false
  private intentado = false

  /** Hay una detección corriendo ahora. */
  get detectando(): boolean { return this.enCurso }

  /** Reserva la detección: false si ya hay una corriendo. */
  empezarDeteccion(): boolean {
    if (this.enCurso) return false
    this.enCurso = true
    this.intentado = true
    return true
  }

  terminarDeteccion() { this.enCurso = false }

  /** true una sola vez, y solo si nunca se detectó: para lanzar la detección perezosa de `GET /api/conectores`. */
  pedirDeteccionInicial(): boolean {
    if (this.lista !== undefined || this.enCurso || this.intentado) return false
    this.enCurso = true
    this.intentado = true
    return true
  }

  /** undefined = todavía no se detectó. */
  servidores(): ServidorConector[] | undefined { return this.lista }
  detectado(): Date | undefined { return this.cuando }
  fijar(s: ServidorConector[], en: Date = new Date()) { this.lista = s; this.cuando = en }
  limpiar() { this.lista = undefined; this.cuando = undefined; this.enCurso = false; this.intentado = false }
}

export const catalogoDe = (s: Servicios) => s.huecos.catalogo as CatalogoConectores | undefined

export const Conectores = {
  prefijoClaudeAi: 'mcp__claude_ai_',
  timeoutDeteccion: 90,
  prefijosLeer: ['list', 'get', 'search', 'read', 'find', 'fetch', 'download', 'query', 'lookup', 'suggest'],

  /** Nombre de una herramienta sin el servidor: `mcp__claude_ai_Gmail__send_message` -> `send_message`. */
  corto: cortoHerramienta,

  /** `leer` si el nombre corto empieza con list, get, search, read, find, fetch, download, query, lookup o suggest
   *  (también en camelCase); `actuar` si no. Ante la duda, actuar. */
  clasificar(corto: string): 'leer' | 'actuar' {
    const c = corto.toLowerCase()
    return Conectores.prefijosLeer.some((p) => c.startsWith(p)) ? 'leer' : 'actuar'
  },

  /** Prefijo de las herramientas de un servidor: `mcp__claude_ai_` + el nombre con lo que no sea letra, número, `_` o `-`
   *  cambiado por `_`. */
  prefijo(nombre: string): string {
    let s = ''
    for (const ch of nombre) {
      const u = ch.codePointAt(0)!
      const ok = (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u === 95 || u === 45
      s += ok ? ch : '_'
    }
    return Conectores.prefijoClaudeAi + s
  },

  /** Los servidores de claude.ai del evento `system/init` de una línea de stream-json. undefined si la línea no es ese evento. */
  parsearInit(linea: string): ServidorConector[] | undefined {
    let d: unknown
    try { d = JSON.parse(linea) } catch { return undefined }
    if (!esObjeto(d) || d.type !== 'system' || d.subtype !== 'init') return undefined
    const herramientas = Array.isArray(d.tools) ? d.tools.filter((x): x is string => typeof x === 'string') : []
    const out: ServidorConector[] = []
    const servidores = Array.isArray(d.mcp_servers) ? d.mcp_servers.filter(esObjeto) : []
    for (const s of servidores) {
      if (s.source !== 'claudeai' || typeof s.name !== 'string') continue
      let nombre = s.name
      if (nombre.startsWith('claude.ai ')) nombre = nombre.slice('claude.ai '.length)
      nombre = nombre.trim()
      const pref = Conectores.prefijo(nombre)
      const estado = typeof s.status === 'string' ? s.status : 'unknown'
      out.push({ nombre, prefijo: pref, estado, herramientas: herramientas.filter((h) => h.startsWith(pref + '__')) })
    }
    return out
  },

  /** Arranca un `claude` barato (haiku, sin herramientas propias) solo para leer el `system/init` y guarda el resultado
   *  en el catálogo. Lanza `ClaudeError`; si el init no vino, no toca el catálogo. */
  async detectar(s: Servicios, catalogo: CatalogoConectores): Promise<ServidorConector[]> {
    const args = ['-p', '--model', 'haiku', '--tools', '', '--permission-mode', 'dontAsk', ...ClaudeRunner.formatoSalida, '--', 'Respondé solo: ok']
    const res = await s.runner.lanzar(args, { timeout: Conectores.timeoutDeteccion, envExtra: { MCP_CONNECTION_NONBLOCKING: 'false' } })
    if (res.timedOut) throw new ClaudeError('timeout')
    let detectados: ServidorConector[] | undefined
    for (const l of res.stdout.split(/\r\n|[\n\r]/)) {
      if (l === '') continue
      const x = Conectores.parsearInit(l)
      if (x) { detectados = x; break }
    }
    if (!detectados) throw new ClaudeError('claude', 'No pude leer la lista de conectores de claude.ai.')
    catalogo.fijar(detectados)
    return detectados
  },
}
