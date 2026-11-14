// Backend de la Oficina: arma las piezas y expone el contrato que usan los transportes.
// Etapa 2 (Electron) usa `createBackend` igual que el servidor dev: sin process.exit ni estado global acá adentro.
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { Avisos } from './avisos.js'
import { ClaudePathResolver } from './claude-locator.js'
import { ClaudeRunner } from './claude-runner.js'
import { Config } from './config.js'
import { Entregas } from './entregas.js'
import { ExploradorRouter } from './explorador.js'
import { HQLog } from './log.js'
import { Oficinas } from './oficinas.js'
import { Router, type APIHandler } from './router.js'
import { infoClaude, rutasChat } from './rutas-chat.js'
import { rutasOficinas } from './rutas-oficinas.js'
import { Store } from './store.js'

export type OpcionesBackend = {
  config: Config
  /** Binario de claude fijo (sin búsqueda). */
  claudePath?: string
  /** Entorno para los procesos hijos y las variables HQ_*. */
  env?: NodeJS.ProcessEnv
}

export interface Backend {
  readonly config: Config
  readonly log: HQLog
  readonly store: Store
  readonly oficinas: Oficinas
  readonly runner: ClaudeRunner
  readonly avisosStore: Avisos
  readonly entregas: Entregas
  readonly router: APIHandler
  /** Avisos nuevos (`'aviso'`, {aviso, nombre}): notificaciones nativas e insignia en la etapa 2. */
  readonly avisos: EventEmitter
  /** Mata los claude en curso y cierra la base. */
  shutdown(): Promise<void>
}

export function createBackend({ config, claudePath, env = process.env }: OpcionesBackend): Backend {
  const log = new HQLog(config.datosDir)
  const store = new Store(path.join(config.datosDir, 'hq.db'))
  const oficinas = new Oficinas(config, log)
  const router = new Router()
  const avisos = new EventEmitter()

  const resolver = new ClaudePathResolver({ fijo: claudePath, explicito: config.claudeBin, env, home: config.home })
  const runner = new ClaudeRunner(config, resolver, log, { env })
  const avisosStore = new Avisos(store, avisos)
  const entregas = new Entregas(store, avisosStore)

  router.explorador = new ExploradorRouter(config, oficinas, log)
  router.nucleo.push(rutasOficinas({ config, oficinas, claude: infoClaude(runner) }))
  router.nucleo.push(rutasChat({ config, store, runner, oficinas, avisos: avisosStore, entregas, log }))

  log.info(`arranque oficinasDir=${config.oficinasDir} claude=${runner.claudePath ?? 'no'}`)
  // chequeo de arranque, sin bloquear
  void runner.authStatus(30)
  let cerrado = false
  return {
    config,
    log,
    store,
    oficinas,
    runner,
    avisosStore,
    entregas,
    router,
    avisos,
    async shutdown() {
      if (cerrado) return
      cerrado = true
      await runner.shutdown()
      store.close()
      log.info('shutdown')
    },
  }
}
