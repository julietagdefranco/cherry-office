// Uso del plan de Claude (la ventana de 5 horas y la semanal), para el medidor de la barra de herramientas.
//
// Dos fuentes, en este orden:
//  1. La cuenta: el mismo endpoint que usa `/usage` de Claude Code (`/api/oauth/usage`), con el token que Claude Code
//     guarda al iniciar sesión (en macOS, en el llavero; en Windows y Linux, en ~/.claude/.credentials.json).
//     No está documentado: si cambia o falla, se cae a la segunda fuente.
//  2. Las corridas: cada `claude -p --output-format stream-json` trae un `rate_limit_event` con el estado y cuándo se
//     reinicia la ventana. Solo llega cuando un agente corre y no siempre trae el porcentaje.
//
// El token nunca sale de este archivo: no se loguea ni va en ninguna respuesta. Tampoco se renueva acá (eso escribiría
// las credenciales de Claude Code): si venció, se espera a que Claude Code lo renueve en la próxima corrida.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { esObjeto, type Obj } from './json.js'
import type { HQLog } from './log.js'
import { atrapar, no405, type Query, type SubRouter } from './router.js'
import { registrarModulo, type Servicios } from './servicios.js'

export const URL_USO = 'https://api.anthropic.com/api/oauth/usage'

/** Una ventana de uso: porcentaje usado (0–100) y cuándo se reinicia (ISO). */
export type Ventana = { pct?: number; reinicia?: string; estado?: 'ok' | 'cerca' | 'limite' }

export type Uso = {
  /** Hay algún dato para mostrar. */
  disponible: boolean
  /** De dónde salió: la cuenta (porcentajes reales) o las corridas de los agentes (lo último que avisó claude). */
  fuente?: 'cuenta' | 'corridas'
  cinco_horas?: Ventana
  semana?: Ventana
  /** Tope semanal propio de Opus, si el plan lo tiene. */
  semana_opus?: Ventana
  /** Cuándo se leyó (ISO). */
  actualizado?: string
  /** Por qué no hay datos de la cuenta: sin_sesion · vencido · error. */
  motivo?: string
}

type Credencial = { token: string; vence?: number }
type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>

export type OpcionesMedidor = {
  home: string
  env?: NodeJS.ProcessEnv
  log?: HQLog
  /** Para los tests: credenciales y fetch falsos. */
  leerCredencial?: () => Promise<Credencial | undefined>
  fetch?: Fetch
  ahora?: () => number
}

/** Cada cuánto se vuelve a pedir a la cuenta (el endpoint limita si se le pide seguido). */
const CACHE_OK_MS = 90_000
const CACHE_ERROR_MS = 30_000

export class MedidorUso {
  private cache?: { uso: Uso; leido: number; hasta: number }
  private enCurso?: Promise<Uso>
  /** Lo último que avisó claude en sus corridas, por tipo de ventana. */
  private limites: Record<string, Ventana & { visto: number }> = {}
  private readonly ahora: () => number

  constructor(private readonly op: OpcionesMedidor) {
    this.ahora = op.ahora ?? Date.now
  }

  /** Uso actual (con caché). `forzar` saltea la caché, pero nunca pide más de una vez cada 30 s. */
  leer(forzar = false): Promise<Uso> {
    const t = this.ahora(), c = this.cache
    if (c && ((t < c.hasta && !forzar) || t - c.leido < CACHE_ERROR_MS)) return Promise.resolve(this.conCorridas(c.uso))
    this.enCurso ??= this.deLaCuenta().then((uso) => {
      const leido = this.ahora()
      this.cache = { uso, leido, hasta: leido + (uso.fuente === 'cuenta' ? CACHE_OK_MS : CACHE_ERROR_MS) }
      return uso
    }).finally(() => { this.enCurso = undefined })
    return this.enCurso.then((u) => this.conCorridas(u))
  }

  /** Un `rate_limit_event` de una corrida (el objeto `rate_limit_info`). */
  registrarLimite(info: Obj) {
    const tipo = typeof info.rateLimitType === 'string' ? info.rateLimitType : ''
    if (!tipo) return
    const v: Ventana & { visto: number } = { visto: this.ahora() }
    if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) v.reinicia = new Date(info.resetsAt * 1000).toISOString()
    // en el evento, utilization viene como fracción (0–1)
    if (typeof info.utilization === 'number' && Number.isFinite(info.utilization)) v.pct = redondear(info.utilization <= 1 ? info.utilization * 100 : info.utilization)
    const st = info.status
    v.estado = st === 'rejected' ? 'limite' : st === 'allowed_warning' ? 'cerca' : 'ok'
    if (v.estado === 'limite' && v.pct === undefined) v.pct = 100
    this.limites[tipo] = v
  }

  /** Completa con lo de las corridas lo que la cuenta no dio (o todo, si la cuenta no respondió). */
  private conCorridas(uso: Uso): Uso {
    if (uso.fuente === 'cuenta') return uso
    const t = this.ahora()
    const vigente = (k: string): Ventana | undefined => {
      const v = this.limites[k]
      if (!v || (v.reinicia && Date.parse(v.reinicia) <= t)) return undefined
      const { visto: _, ...resto } = v
      return resto
    }
    const r: Uso = { ...uso }
    const c = vigente('five_hour'), s = vigente('seven_day'), o = vigente('seven_day_opus')
    if (c) r.cinco_horas = c
    if (s) r.semana = s
    if (o) r.semana_opus = o
    if (c || s || o) {
      r.disponible = true
      r.fuente = 'corridas'
      const vistos = ['five_hour', 'seven_day', 'seven_day_opus'].map((k) => this.limites[k]?.visto ?? 0)
      r.actualizado = new Date(Math.max(...vistos)).toISOString()
    }
    return r
  }

  private async deLaCuenta(): Promise<Uso> {
    let cred: Credencial | undefined
    try {
      cred = await (this.op.leerCredencial ?? (() => leerCredencial(this.op.home, this.op.env ?? process.env)))()
    } catch {
      cred = undefined
    }
    if (!cred) return { disponible: false, motivo: 'sin_sesion' }
    if (cred.vence !== undefined && cred.vence <= this.ahora()) return { disponible: false, motivo: 'vencido' }
    const f: Fetch = this.op.fetch ?? (fetch as unknown as Fetch)
    try {
      const r = await f(URL_USO, {
        headers: { Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (r.status === 401 || r.status === 403) return { disponible: false, motivo: 'vencido' }
      if (r.status !== 200) {
        this.op.log?.warn(`uso-claude status=${r.status}`)
        return { disponible: false, motivo: 'error' }
      }
      const uso = parsearUso(await r.json(), this.ahora())
      if (!uso) {
        this.op.log?.warn('uso-claude respuesta sin ventanas')
        return { disponible: false, motivo: 'error' }
      }
      return uso
    } catch (e) {
      this.op.log?.warn(`uso-claude ${e instanceof Error ? e.name : 'error'}`)
      return { disponible: false, motivo: 'error' }
    }
  }
}

/** Respuesta de `/api/oauth/usage`: `{five_hour: {utilization: 42, resets_at}, seven_day: {...}, seven_day_opus: {...}|null}`. */
export function parsearUso(o: unknown, ahora: number): Uso | undefined {
  if (!esObjeto(o)) return undefined
  const ventana = (v: unknown): Ventana | undefined => {
    if (!esObjeto(v) || typeof v.utilization !== 'number' || !Number.isFinite(v.utilization)) return undefined
    const pct = redondear(v.utilization)
    const r: Ventana = { pct, estado: pct >= 100 ? 'limite' : pct >= 80 ? 'cerca' : 'ok' }
    if (typeof v.resets_at === 'string' && !Number.isNaN(Date.parse(v.resets_at))) r.reinicia = new Date(Date.parse(v.resets_at)).toISOString()
    return r
  }
  const c = ventana(o.five_hour), s = ventana(o.seven_day), op = ventana(o.seven_day_opus)
  if (!c && !s) return undefined
  const uso: Uso = { disponible: true, fuente: 'cuenta', actualizado: new Date(ahora).toISOString() }
  if (c) uso.cinco_horas = c
  if (s) uso.semana = s
  if (op) uso.semana_opus = op
  return uso
}

const redondear = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10

/** El token de Claude Code. El llavero de macOS es solo del usuario real: con otro HOME (los tests) se lee el archivo. */
export async function leerCredencial(home: string, env: NodeJS.ProcessEnv): Promise<Credencial | undefined> {
  const dirConfig = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude')
  const homeReal = (() => { try { return os.userInfo().homedir } catch { return undefined } })()
  if (process.platform === 'darwin' && !env.CLAUDE_CONFIG_DIR && homeReal !== undefined && path.resolve(home) === path.resolve(homeReal)) {
    const c = credencialDe(await llavero().catch(() => ''))
    if (c) return c
  }
  try {
    return credencialDe(await fs.promises.readFile(path.join(dirConfig, '.credentials.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function credencialDe(texto: string): Credencial | undefined {
  try {
    const o: unknown = JSON.parse(texto)
    const c = esObjeto(o) && esObjeto(o.claudeAiOauth) ? o.claudeAiOauth : undefined
    if (!c || typeof c.accessToken !== 'string' || c.accessToken === '') return undefined
    return { token: c.accessToken, vence: typeof c.expiresAt === 'number' ? c.expiresAt : undefined }
  } catch {
    return undefined
  }
}

function llavero(): Promise<string> {
  return new Promise((ok, mal) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, encoding: 'utf8' },
      (e, out) => (e ? mal(e) : ok(out)))
  })
}

export class UsoRouter implements SubRouter {
  constructor(private readonly medidor: MedidorUso) {}

  async handle(method: string, path: string, query: Query) {
    if (path !== '/api/uso-claude') return null
    return atrapar(async () => {
      if (method !== 'GET') return no405
      return [200, (await this.medidor.leer(query.forzar === '1')) as Obj]
    })
  }
}

registrarModulo('uso-claude', 74, (s: Servicios) => {
  const medidor = new MedidorUso({ home: s.config.home, env: s.env, log: s.log })
  s.runner.alLimite.push((info) => medidor.registrarLimite(info))
  s.huecos.usoClaude = medidor
  s.router.registrarExtra(new UsoRouter(medidor))
})
