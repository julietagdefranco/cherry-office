// Ejecución de `claude` (ClaudeRunner.swift): un proceso por corrida con timeout (terminar -> matar el árbol),
// un carril por agente (sus mensajes no se pisan), un tope global de procesos y el cierre ordenado.
//
// Windows:
// - No hay SIGTERM: se mata el árbol con `taskkill /T /F` (sin /F, taskkill no cierra procesos de consola).
// - Un shim `.cmd` (instalación por npm) se resuelve a `node …/cli.js` para no pasar los argumentos por cmd.exe,
//   que rompe el quoting del JSON de --mcp-config y de los saltos de línea.
// - El mensaje viaja por la entrada estándar (`claude -p` lo lee de ahí si no hay `--`; probado con el claude real:
//   mismo resultado y mismo tiempo): Windows corta la línea de comandos en ~32 mil caracteres. En Mac y Linux sigue
//   como argumento, igual que la app Swift (HQ_MENSAJE_STDIN=1 fuerza stdin para probar ese camino).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ActividadRegistro } from './actividad.js'
import { ClaudePathResolver, childEnvironment } from './claude-locator.js'
import type { Config } from './config.js'
import { esObjeto, type Obj } from './json.js'
import type { HQLog } from './log.js'
import type { Store } from './store.js'
import { CajaCosto, CortadorLineas, parsearEvento, type Observador } from './stream.js'
import { largo, prefijo } from './validar.js'

const esWindows = process.platform === 'win32'
/** Ruta completa: no depender del PATH que tenga la app (o el entorno de un test). */
const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

// MARK: - errores

export type TipoErrorClaude = 'sin_claude' | 'sin_proyecto' | 'timeout' | 'no_ejecuta' | 'login' | 'claude' | 'cerrando'

export const mensajeLogin = "Claude Code todavía no tiene la sesión iniciada. Usá «Iniciar sesión» en la app o corré 'claude auth login' en la Terminal."

/** Error de una corrida de claude, ya clasificado. `mensaje` es para el usuario; `tipo` para el log. */
export class ClaudeError extends Error {
  constructor(readonly tipo: TipoErrorClaude, readonly detalle = '') {
    super(detalle || tipo)
    this.name = 'ClaudeError'
  }
  get mensaje(): string {
    switch (this.tipo) {
      case 'sin_claude': return 'No encontré Claude Code en esta compu.'
      case 'sin_proyecto': return `No encuentro la carpeta del proyecto (${this.detalle}).`
      case 'timeout': return 'Tardó demasiado en responder.'
      case 'no_ejecuta': return 'No pude ejecutar Claude Code en esta compu.'
      case 'login': return mensajeLogin
      case 'claude': return this.detalle
      case 'cerrando': return 'La app se está cerrando.'
    }
  }
  get status() { return this.tipo === 'timeout' ? 504 : 500 }
  static clasificar(e: string) { return new ClaudeError(e.toLowerCase().includes('login') ? 'login' : 'claude', e) }
}

// MARK: - proceso

export type ProcResult = { rc: number; stdout: string; stderr: string; timedOut: boolean }

/** Un proceso en curso. `matar(false)` = terminar (SIGTERM al grupo), `matar(true)` = matar (SIGKILL). */
class Proceso {
  hijo?: ChildProcess
  cancelado = false
  vivo = false

  matar(forzar: boolean) {
    this.cancelado = true
    const h = this.hijo
    if (!h || !this.vivo || h.pid === undefined) return
    if (esWindows) {
      // sin /F, taskkill solo le pide cerrar a las ventanas: claude (consola, sin ventana) no se entera. Siempre /F.
      spawnSync(taskkill, ['/PID', String(h.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    // el hijo es líder de su grupo (detached): señal a todo el grupo, así caen también las herramientas que lanzó
    try {
      process.kill(-h.pid, forzar ? 'SIGKILL' : 'SIGTERM')
    } catch {
      try { h.kill(forzar ? 'SIGKILL' : 'SIGTERM') } catch {}
    }
  }

  /** Corre y espera. Rechaza si no pudo arrancar (ENOENT, EACCES…) o se canceló antes. */
  correr(exe: string, args: string[], op: { cwd?: string; env: Record<string, string>; timeout: number; grace: number; alLinea?: (l: string) => void; stdin?: boolean },
    alEmpezar: () => void, alTerminar: () => void): Promise<ProcResult> {
    return new Promise((resolve, reject) => {
      if (this.cancelado) return reject(new Error('cancelado'))
      const [bin, pre] = resolverEjecutable(exe)
      // mensaje por la entrada estándar: `-- <mensaje>` sale de los argumentos (tope de la línea de comandos en Windows)
      let entrada: string | undefined
      let argv = args
      if (op.stdin && args.length >= 2 && args[args.length - 2] === '--') {
        entrada = args[args.length - 1]
        argv = args.slice(0, -2)
      }
      let h: ChildProcess
      try {
        h = spawn(bin, [...pre, ...argv], {
          cwd: op.cwd, env: op.env, stdio: [entrada === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: !esWindows, windowsHide: true,
        })
      } catch (e) {
        return reject(e)
      }
      if (entrada !== undefined) {
        h.stdin!.on('error', () => {})
        h.stdin!.end(entrada)
      }
      this.hijo = h
      const so: Buffer[] = []
      const se: Buffer[] = []
      const cortador = op.alLinea ? new CortadorLineas(op.alLinea) : undefined
      h.stdout!.on('data', (d: Buffer) => { so.push(d); cortador?.agregar(d) })
      h.stderr!.on('data', (d: Buffer) => { se.push(d) })
      let timedOut = false
      let temporizador: NodeJS.Timeout | undefined
      let rematar: NodeJS.Timeout | undefined
      let terminado = false
      const fin = (rc: number) => {
        if (terminado) return
        terminado = true
        clearTimeout(temporizador)
        clearTimeout(rematar)
        this.vivo = false
        alTerminar()
        // lo que el proceso ya escribió puede estar en camino: un instante para drenar; un nieto que siga con el pipe
        // abierto no nos retiene
        const cerrar = () => {
          h.stdout!.destroy()
          h.stderr!.destroy()
          cortador?.terminar()
          resolve({ rc, stdout: Buffer.concat(so).toString('utf8'), stderr: Buffer.concat(se).toString('utf8'), timedOut })
        }
        if (h.stdout!.readableEnded && h.stderr!.readableEnded) cerrar()
        else {
          const t = setTimeout(cerrar, 200)
          let abiertos = 2
          const uno = () => { if (--abiertos === 0) { clearTimeout(t); cerrar() } }
          if (h.stdout!.readableEnded) uno(); else h.stdout!.once('end', uno)
          if (h.stderr!.readableEnded) uno(); else h.stderr!.once('end', uno)
        }
      }
      h.once('error', (e) => {
        if (!this.vivo) {
          terminado = true
          clearTimeout(temporizador)
          reject(e)
        }
      })
      h.once('spawn', () => {
        this.vivo = true
        alEmpezar()
        if (this.cancelado) this.matar(false)
        temporizador = setTimeout(() => {
          timedOut = true
          this.matar(false)
          rematar = setTimeout(() => this.matar(true), op.grace * 1000)
        }, op.timeout * 1000)
      })
      h.once('exit', (code, signal) => fin(code ?? (signal ? 128 + (signalNumero[signal] ?? 0) : 1)))
    })
  }
}

const signalNumero: Partial<Record<NodeJS.Signals, number>> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }

/** Cómo lanzar `exe`: un script de Node (.js/.cjs/.mjs) con el node actual; en Windows, un shim `.cmd`/`.bat` de npm
 *  como `node <cli.js>` (sin cmd.exe). */
export function resolverEjecutable(exe: string): [string, string[]] {
  if (/\.(c|m)?js$/i.test(exe)) return [process.execPath, [exe]]
  if (!esWindows || !/\.(cmd|bat)$/i.test(exe)) return [exe, []]
  const dir = path.dirname(exe)
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  if (fs.existsSync(cli)) {
    const nodeLocal = path.join(dir, 'node.exe')
    return [fs.existsSync(nodeLocal) ? nodeLocal : 'node', [cli]]
  }
  return [exe, []]
}

// MARK: - carriles y tope

/** Una cola por clave: serializa las llamadas de un agente (agentes distintos corren en paralelo). */
class Carriles {
  private colas = new Map<string, Promise<unknown>>()

  async con<T>(clave: string, body: () => Promise<T>): Promise<T> {
    const anterior = this.colas.get(clave) ?? Promise.resolve()
    let soltar!: () => void
    const mia = new Promise<void>((r) => { soltar = r })
    const cola = anterior.then(() => mia)
    this.colas.set(clave, cola)
    await anterior
    try {
      return await body()
    } finally {
      soltar()
      if (this.colas.get(clave) === cola) this.colas.delete(clave)
    }
  }
}

/** Semáforo: tope global de procesos claude a la vez. */
class Limite {
  private enUso = 0
  private esperando: (() => void)[] = []
  constructor(readonly maximo: number) {}
  async adquirir() {
    if (this.enUso < this.maximo) { this.enUso++; return }
    await new Promise<void>((r) => this.esperando.push(r)) // el cupo se hereda de quien libera
  }
  liberar() {
    const sig = this.esperando.shift()
    if (sig) sig()
    else this.enUso--
  }
}

// MARK: - runner

/** Contexto de un agente de oficina (Permisos.contexto). Se define en permisos.ts; acá solo lo que usa el runner. */
export interface ContextoCorrida {
  carpeta: string
}

export type ArmarArgumentos = (p: { agente: string; mensaje: string; sid: string; flag: '--resume' | '--session-id' }) => string[]

export class ClaudeRunner {
  static readonly maxClaudePorDefecto = 8
  /** `--output-format stream-json --verbose`: un evento JSON por línea y el `result` al final. */
  static readonly formatoSalida = ['--output-format', 'stream-json', '--verbose']
  /** Para corridas sin agente: `dontAsk` y sin conectores de claude.ai. */
  static readonly sinConectores = ['--permission-mode', 'dontAsk', '--disallowedTools', 'mcp__claude_ai_*']

  readonly actividad = new ActividadRegistro()
  private readonly carriles = new Carriles()
  private readonly limite: Limite
  private readonly vivos = new Set<Proceso>()
  private cerrado = false

  constructor(readonly config: Config, private readonly resolver: ClaudePathResolver, private readonly log: HQLog,
    { grace = 3, maxConcurrentes, env = process.env }: { grace?: number; maxConcurrentes?: number; env?: NodeJS.ProcessEnv } = {}) {
    const n = parseInt((env.HQ_MAX_CLAUDE ?? '').trim(), 10)
    this.limite = new Limite(Math.max(1, maxConcurrentes ?? (n >= 1 ? n : ClaudeRunner.maxClaudePorDefecto)))
    this.grace = grace
    this.mensajePorStdin = esWindows || env.HQ_MENSAJE_STDIN === '1'
  }

  /** Gracia entre terminar y matar (segundos). */
  readonly grace: number
  /** El mensaje va por la entrada estándar en vez de como último argumento: siempre en Windows (la línea de comandos
   *  tiene un tope de ~32 mil caracteres y el mensaje puede pasar los 100 mil), o con HQ_MENSAJE_STDIN=1 (tests). */
  readonly mensajePorStdin: boolean

  get claudePath() { return this.resolver.path() }
  get procesosVivos() { return this.vivos.size }
  get estaCerrado() { return this.cerrado }

  /** Comprobaciones previas: claude y la carpeta (de la oficina o del proyecto). */
  verificar(carpeta?: string) {
    if (this.claudePath === undefined) throw new ClaudeError('sin_claude')
    const c = carpeta ?? this.config.proyecto
    let ok = false
    try {
      ok = fs.statSync(c).isDirectory()
    } catch {}
    if (!ok) throw new ClaudeError('sin_proyecto', c)
  }

  // MARK: corridas sin chat

  /** `claude -p` SIN agente y SIN herramientas: borradores, síntesis, resúmenes. Devuelve el texto de `result`. */
  async correrSinAgente(prompt: string, { timeout, cwd, modelo, obs }: { timeout?: number; cwd?: string; modelo?: string; obs?: Observador } = {}): Promise<string> {
    this.verificar(cwd)
    const args = ['-p', ...ClaudeRunner.formatoSalida, '--tools', '', ...ClaudeRunner.sinConectores]
    if (modelo) args.push('--model', modelo)
    return this.resultado([...args, '--', prompt], { timeout: timeout ?? this.config.timeout, cwd, obs })
  }

  /** Un turno de `agente` en una sesión nueva, solo con Read/Glob/Grep (reuniones, consultas). Sin carril. */
  async turnoSoloLectura(p: { agente: string; prompt: string; cwd: string; timeout?: number; dirsExtra?: string[]; obs?: Observador; instrucciones?: string }): Promise<string> {
    this.verificar(p.cwd)
    const a = ['-p', '--agent', p.agente, '--session-id', randomUUID().toLowerCase(), ...ClaudeRunner.formatoSalida,
      '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk']
    for (const d of [...this.config.oficinaDirsExtra, ...(p.dirsExtra ?? [])]) a.push('--add-dir', d)
    a.push('--allowedTools', 'Read', 'Glob', 'Grep', '--disallowedTools', 'mcp__claude_ai_*')
    if (p.instrucciones) a.push('--append-system-prompt', p.instrucciones)
    return this.resultado([...a, '--', p.prompt], { timeout: p.timeout ?? this.config.timeout, cwd: p.cwd, obs: p.obs })
  }

  async resultado(args: string[], { timeout, cwd, obs, envExtra = {} }: { timeout: number; cwd?: string; obs?: Observador; envExtra?: Record<string, string> }): Promise<string> {
    const res = await this.lanzar(args, { timeout, cwd, envExtra, alLinea: lector(obs) })
    if (res.timedOut) throw new ClaudeError('timeout')
    if (this.cerrado) throw new ClaudeError('cerrando')
    const c = corrida(res)
    if (c.error !== undefined) throw ClaudeError.clasificar(c.error)
    const r = c.json?.result
    if (typeof r === 'string' && r !== '') return r
    return c.json === undefined ? res.stdout.trim() : ''
  }

  // MARK: carriles

  /** Ejecuta `body` con el carril de la clave tomado. */
  conCarril<T>(clave: string, body: () => Promise<T>): Promise<T> { return this.carriles.con(clave, body) }

  /** Carril de un agente dentro de una oficina (dos oficinas con el mismo id no se bloquean). */
  conCarrilDe<T>(oficina: string, agente: string, body: () => Promise<T>): Promise<T> {
    return this.carriles.con(oficina + '\u001f' + agente, body)
  }

  // MARK: chat

  /** Un mensaje de chat sin tomar el carril (el llamador ya lo tiene). Reintenta con la otra forma de sesión si
   *  claude dice que ya existe (o que no existe). */
  async ejecutarChat(p: { agente: string; mensaje: string; sid: string; activa: boolean; carpeta?: string; armar: ArmarArgumentos; obs?: Observador; envExtra?: Record<string, string> }): Promise<string> {
    this.verificar(p.carpeta)
    const flag = p.activa ? '--resume' : '--session-id'
    const correr = async (f: '--resume' | '--session-id') => {
      const res = await this.lanzar(p.armar({ agente: p.agente, mensaje: p.mensaje, sid: p.sid, flag: f }),
        { timeout: this.config.timeout, cwd: p.carpeta, envExtra: p.envExtra ?? {}, alLinea: lector(p.obs) })
      if (res.timedOut) throw new ClaudeError('timeout')
      if (this.cerrado) throw new ClaudeError('cerrando')
      return corrida(res)
    }
    let r = await correr(flag)
    if (r.error?.includes('already in use')) r = await correr('--resume')
    else if (r.error !== undefined && flag === '--resume' && (r.error.includes('No conversation') || r.error.toLowerCase().includes('not found'))) {
      r = await correr('--session-id')
    }
    if (r.error !== undefined) throw ClaudeError.clasificar(r.error)
    const res = r.json?.result
    if (typeof res === 'string' && res !== '') return res
    return r.json === undefined ? r.res.stdout.trim() : ''
  }

  // MARK: auth

  /** `claude auth status`: true = sesión iniciada, false = no, undefined = no se pudo saber. */
  async authStatus(timeout = 30): Promise<boolean | undefined> {
    if (this.claudePath === undefined) return undefined
    try {
      const r = await this.lanzar(['auth', 'status'], { timeout })
      if (r.timedOut) { this.log.warn('claude auth status: tiempo agotado'); return undefined }
      this.log.info(`auth_status rc=${r.rc}`)
      return r.rc === 0
    } catch {
      this.log.error('claude no se pudo ejecutar (auth status)')
      return undefined
    }
  }

  // MARK: lanzar

  /** Lanza claude con `args` y espera. Un fallo de arranque es `no_ejecuta`. */
  async lanzar(args: string[], { timeout, cwd: cwdPedido, envExtra = {}, alLinea }: { timeout: number; cwd?: string; envExtra?: Record<string, string>; alLinea?: (l: string) => void }): Promise<ProcResult> {
    const exe = this.claudePath
    if (exe === undefined) throw new ClaudeError('sin_claude')
    if (this.cerrado) throw new ClaudeError('cerrando')
    const base = cwdPedido ?? this.config.proyecto
    let cwd: string | undefined
    try {
      if (fs.statSync(base).isDirectory()) cwd = base
    } catch {}
    const env = { ...childEnvironment(exe, process.env, this.config.home), ...envExtra }
    const p = new Proceso()
    await this.limite.adquirir()
    try {
      if (this.cerrado) throw new ClaudeError('cerrando')
      return await p.correr(exe, args, { cwd, env, timeout, grace: this.grace, alLinea, stdin: this.mensajePorStdin },
        () => this.vivos.add(p), () => this.vivos.delete(p))
    } catch (e) {
      if (e instanceof ClaudeError) throw e
      throw new ClaudeError('no_ejecuta', e instanceof Error ? e.message : String(e))
    } finally {
      this.limite.liberar()
    }
  }

  /** Mata los claude en curso: terminar y, si no responden en la gracia, matar. */
  async shutdown() {
    this.cerrado = true
    const vivos = [...this.vivos]
    if (vivos.length === 0) return
    for (const p of vivos) p.matar(false)
    const limite = Date.now() + this.grace * 1000
    while (Date.now() < limite && vivos.some((p) => p.vivo)) await new Promise((r) => setTimeout(r, 50))
    for (const p of vivos) if (p.vivo) p.matar(true)
    // que terminen de verdad: en Windows su carpeta de trabajo queda tomada hasta que el proceso sale
    const fin = Date.now() + 2000
    while (Date.now() < fin && vivos.some((p) => p.vivo)) await new Promise((r) => setTimeout(r, 25))
    this.log.info(`shutdown: ${vivos.length} proceso(s) terminados`)
  }

  // MARK: resumen de la tarea (cartel sobre la cabeza)

  /** Lanza el resumen en segundo plano y lo vuelca en la actividad. Devuelve con qué cancelarlo, o undefined si el
   *  mensaje es corto. El costo se registra con origen "resumen". */
  resumirTarea(msg: string, p: { oficina: string; agente: string; token: string; store: Store }): { cancelar(): void } | undefined {
    if (!ResumenTarea.haceFalta(msg)) return undefined
    let cancelado = false
    const caja = new CajaCosto()
    void (async () => {
      try {
        const t = await this.correrSinAgente(ResumenTarea.prompt(msg), { timeout: ResumenTarea.timeout, cwd: p.oficina, modelo: 'haiku', obs: caja.observador() })
        const r = ResumenTarea.limpiar(t)
        if (!cancelado && r !== undefined) this.actividad.tarea(p.oficina, p.agente, p.token, r)
      } catch {
      } finally {
        p.store.registrarCosto({ oficina: p.oficina, agente: p.agente, origen: 'resumen', costo: caja.valor })
      }
    })()
    return { cancelar: () => { cancelado = true } }
  }
}

/** Convierte un observador de eventos en un lector de líneas. */
function lector(obs?: Observador): ((l: string) => void) | undefined {
  return obs ? (l) => { for (const e of parsearEvento(l)) obs(e) } : undefined
}

type Corrida = { res: ProcResult; json?: Obj; error?: string }

function corrida(res: ProcResult): Corrida {
  const json = parsearJSON(res.stdout)
  let error: string | undefined
  if (json && json.is_error === true) {
    const r = typeof json.result === 'string' ? json.result : ''
    error = r === '' ? 'Error desconocido' : r
  } else if (res.rc !== 0) {
    const t = res.stdout === '' ? res.stderr : res.stdout
    error = t === '' ? 'Error desconocido' : sufijo(t, 600)
  }
  return { res, json, error }
}

function sufijo(s: string, n: number): string {
  const l = largo(s)
  return l <= n ? s : [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(s)].slice(l - n).map((g) => g.segment).join('')
}

/** stdout completo como objeto JSON; si hay ruido antes, la última línea que lo sea. */
export function parsearJSON(s: string): Obj | undefined {
  const obj = (t: string) => {
    try {
      const o = JSON.parse(t)
      return esObjeto(o) ? o : undefined
    } catch {
      return undefined
    }
  }
  const todo = obj(s)
  if (todo) return todo
  const lineas = s.split('\n').filter((l) => l !== '')
  for (let i = lineas.length - 1; i >= 0; i--) {
    const o = obj(lineas[i]!)
    if (o) return o
  }
  return undefined
}

// MARK: - resumen de la tarea

export const ResumenTarea = {
  /** Mensajes de hasta este largo se muestran tal cual. */
  minimo: 40,
  timeout: 20,
  haceFalta(msg: string) { return largo(msg.trim()) > this.minimo },
  prompt(msg: string) {
    const m = largo(msg) > 2000 ? prefijo(msg, 2000) + '…' : msg
    return `Resumí en 3 a 6 palabras, en español, qué le están pidiendo a la persona en este mensaje. Empezá con un verbo en gerundio (por ejemplo «Armando el calendario de reels»). Respondé solo con el resumen, sin comillas ni punto final.

Mensaje:
${m}`
  },
  /** Primera línea, sin comillas ni punto final, máx. 48 caracteres. Vacío -> undefined. */
  limpiar(s: string): string | undefined {
    let t = s.split('\n').find((l) => l !== '') ?? ''
    t = t.replace(/^[\s"'«»“”*]+|[\s"'«»“”*]+$/gu, '')
    t = t.replace(/\.+$/, '')
    return t === '' ? undefined : ActividadRegistro.recortar(t)
  },
}
