// Rutas del núcleo para el chat (Router.swift): historial, chat, actividad, avisos y costos.
import { Adjuntos, type Adjunto } from './adjuntos.js'
import type { Avisos } from './avisos.js'
import { TextoAviso, avisoJSON } from './avisos.js'
import { ClaudeError, type ClaudeRunner } from './claude-runner.js'
import { ErrorAPI } from './errores.js'
import type { Config } from './config.js'
import { ArchivosEntrega, TextoEntrega, type Entregas } from './entregas.js'
import { esObjeto, maxBody, objeto, type Obj } from './json.js'
import type { HQLog } from './log.js'
import type { Oficinas } from './oficinas.js'
import { argumentos, contexto, entorno, variableTokenMCP, type FuenteCatalogo } from './permisos.js'
import { no405, type Resp, type RutaNucleo } from './router.js'
import type { InfoClaude } from './rutas-oficinas.js'
import type { Store } from './store.js'
import { CajaArchivos, CajaCosto } from './stream.js'
import { largo, uuidValido } from './validar.js'

export const maxMensaje = 100_000

/** Servidor MCP propio (consultas entre agentes): lo enchufa ese módulo. Sin él, el chat corre sin consultas. */
export interface MCPChat {
  url(): Promise<string | undefined>
  emitir(p: { oficina: string; agente: string; sid: string; perfil: string }): string
  revocar(token: string): void
}

export type DepsChat = {
  config: Config
  store: Store
  runner: ClaudeRunner
  oficinas: Oficinas
  avisos: Avisos
  entregas: Entregas
  log: HQLog
  mcp?: () => MCPChat | undefined
  catalogo?: FuenteCatalogo
  /** Resumen de corridas de flujos para /api/actividad (motor de flujos). */
  corridas?: (oficina: string) => Obj[]
  /** Versión del Creador para /api/actividad. */
  creadorVersion?: (oficina: string) => number
}

/** `claude auth status` cacheado unos segundos (la UI de onboarding consulta /api/estado seguido). */
export class AuthCache {
  private valorCache?: boolean
  private cuando = 0
  private enCurso?: Promise<boolean | undefined>
  constructor(private readonly runner: ClaudeRunner, private readonly ttl = 5000) {}
  async valor(): Promise<boolean | undefined> {
    if (Date.now() - this.cuando < this.ttl) return this.valorCache
    if (this.enCurso) return this.enCurso
    this.enCurso = this.runner.authStatus(8)
    const v = await this.enCurso
    this.enCurso = undefined
    this.valorCache = v
    this.cuando = Date.now()
    return v
  }
}

export function infoClaude(runner: ClaudeRunner): InfoClaude {
  const cache = new AuthCache(runner)
  return { claudePath: () => runner.claudePath, auth: () => cache.valor() }
}

export function rutasChat(d: DepsChat): RutaNucleo {
  const { config, store, runner, oficinas, avisos, entregas, log } = d
  const invalido: Resp = [400, { error: 'pedido inválido' }]

  function historial(q: Record<string, string>): Resp {
    const act = oficinas.requerirActiva()
    const agente = q.agent
    if (agente === undefined || !act.oficina.agentes.some((a) => a.id === agente)) return invalido
    const lista = (ms: { r: string; t: string; e: boolean }[]) => ms.map((m) => (m.e ? { r: m.r, t: m.t, e: true } : { r: m.r, t: m.t }))
    const sidRaw = q.session
    if (sidRaw === undefined) {
      const ult = store.ultimaSesion(agente, act.carpeta)
      return [200, { session: ult ?? null, msgs: lista(ult ? store.mensajes(ult) : []) }]
    }
    if (!uuidValido(sidRaw)) return invalido
    const sid = sidRaw.toLowerCase()
    const dueno = store.agenteDe(sid)
    if (dueno !== undefined && dueno !== agente) return [200, { msgs: [] }]
    const of = store.oficinaDe(sid)
    if (of !== undefined && of !== act.carpeta) return [200, { msgs: [] }]
    return [200, { msgs: lista(store.mensajes(sid)) }]
  }

  async function chat(body?: Buffer): Promise<Resp> {
    const act = oficinas.requerirActiva()
    if (!body) return invalido
    // con archivos adjuntos el cuerpo puede ser grande (base64); sin ellos, el tope de siempre
    if (body.length > Adjuntos.maxBody) return [413, { error: 'pedido demasiado grande' }]
    let b: unknown
    try {
      b = JSON.parse(body.toString('utf8'))
    } catch {
      b = undefined
    }
    if (body.length > maxBody && (!esObjeto(b) || b.archivos === undefined)) return [413, { error: 'pedido demasiado grande' }]
    if (!esObjeto(b) || typeof b.agent !== 'string' || typeof b.message !== 'string' || typeof b.session !== 'string') return invalido
    let adjuntos: Adjunto[]
    try {
      adjuntos = Adjuntos.leer(b.archivos)
    } catch (e) {
      if (e instanceof ErrorAPI) return [e.status, { error: e.mensaje }]
      throw e
    }
    const agente = b.agent
    const escrito = b.message.trim()
    // solo archivos, sin texto: se los pasa igual
    const msg = escrito === '' && adjuntos.length > 0 ? 'Te paso estos archivos.' : escrito
    const def = act.oficina.agentes.find((a) => a.id === agente)
    if (!def || msg === '' || largo(msg) > maxMensaje || !uuidValido(b.session)) return invalido
    const sid = b.session.toLowerCase()

    try {
      runner.verificar(act.carpeta)
    } catch (e) {
      if (e instanceof ClaudeError) {
        log.error(`chat agente=${agente} tipo=${e.tipo}`)
        return [500, { error: e.mensaje }]
      }
      return [500, { error: 'error interno' }]
    }

    const dueno = store.agenteDe(sid)
    if (dueno !== undefined && dueno !== agente) return invalido
    const of = store.oficinaDe(sid)
    if (of !== undefined && of !== act.carpeta) return invalido
    // los adjuntos se guardan en la oficina y el agente recibe sus rutas al final del mensaje
    let mensaje: string
    try {
      mensaje = msg + Adjuntos.texto(Adjuntos.guardar(act, `chat/${agente}`, adjuntos))
    } catch (e) {
      if (e instanceof ErrorAPI) return [e.status, { error: e.mensaje }]
      throw e
    }
    const t0 = Date.now()
    const carpeta = act.carpeta
    const caja = new CajaCosto()
    const escritos = new CajaArchivos()
    const ctx = contexto(act, def, { dirsExtra: config.oficinaDirsExtra, catalogo: d.catalogo?.() })
    // consultas a colegas: el token vive lo que dura este chat. Si el servidor MCP no arrancó, el chat sale igual.
    const mcp = d.mcp?.()
    const mcpUrl = mcp ? await mcp.url() : undefined
    if (mcpUrl !== undefined) ctx.mcpUrl = mcpUrl

    let resultado: Resp
    try {
      resultado = await runner.conCarrilDe(carpeta, agente, async (): Promise<Resp> => {
        const envExtra: Record<string, string> = { ...entorno(ctx) }
        if (mcpUrl !== undefined && mcp) envExtra[variableTokenMCP] = mcp.emitir({ oficina: carpeta, agente, sid, perfil: ctx.perfilMCP })
        try {
          store.asegurarSesion(sid, agente, carpeta)
          store.agregar(sid, 'u', mensaje)
          const activa = store.estaActiva(sid)
          const texto = await runner.actividad.seguir({ oficina: carpeta, agente, origen: 'chat', tarea: msg, extra: caja.observador(escritos.observador()) },
            async (obs, token) => {
              const resumen = runner.resumirTarea(msg, { oficina: carpeta, agente, token, store })
              try {
                return await runner.ejecutarChat({
                  agente, mensaje, sid, activa, carpeta, obs, envExtra,
                  armar: (p) => argumentos(config, ctx, p),
                })
              } finally {
                resumen?.cancelar()
              }
            })
          store.marcarActiva(sid)
          const guardado = texto === '' ? '(sin respuesta)' : texto
          store.agregar(sid, 'a', guardado)
          const av = avisos.crear({ oficina: carpeta, tipo: 'respuesta', agente, texto: TextoAviso.respuesta(guardado), ref: sid })
          if (av) avisos.emitir(av, def.nombre)
          // un chat que dejó archivos en archivos/entregables/ cuenta como entrega para revisar
          const archivos = ArchivosEntrega.enEntregables(ArchivosEntrega.relativos(escritos.valor, carpeta))
          const r: Obj = { reply: texto }
          if (archivos.length > 0) {
            const e = entregas.registrar({ oficina: carpeta, agente, nombre: def.nombre, origen: 'chat', ref: sid, titulo: TextoEntrega.titulo(msg),
              texto, sid, archivos, costo: caja.valor })
            if (e) r.entrega = String(e.id)
          }
          return [200, r]
        } catch (e) {
          if (e instanceof ClaudeError) {
            try { store.agregar(sid, 'a', 'No pude responder: ' + e.mensaje, true) } catch {}
            const av = avisos.crear({ oficina: carpeta, tipo: 'error', agente, texto: 'No pudo responder: ' + e.mensaje, ref: sid })
            if (av) avisos.emitir(av, def.nombre)
            return [e.status, { error: e.mensaje }]
          }
          const t = 'No pude guardar la conversación.'
          try { store.agregar(sid, 'a', 'No pude responder: ' + t, true) } catch {}
          return [500, { error: t }]
        } finally {
          const tok = envExtra[variableTokenMCP]
          if (tok !== undefined) mcp?.revocar(tok)
        }
      })
    } finally {
      store.registrarCosto({ oficina: carpeta, agente, origen: 'chat', ref: sid, costo: caja.valor })
    }
    log.info(`chat agente=${agente} sid=${sid.slice(0, 8)} estado=${resultado[0]} seg=${((Date.now() - t0) / 1000).toFixed(1)}`)
    return resultado
  }

  return async ({ method, partes, query, body }) => {
    const [, seccion, a2] = partes
    const n = partes.length
    if (seccion === 'historial' && n === 2) return method === 'GET' ? historial(query) : no405
    if (seccion === 'chat' && n === 2) return method === 'POST' ? chat(body) : no405
    if (seccion === 'actividad' && n === 2) {
      if (method !== 'GET') return no405
      const act = oficinas.activa()
      if (!act) return [200, { agentes: {}, version: 0, avisos: [], entregasSinRevisar: 0, corridas: [], creadorVersion: 0 }]
      const r = runner.actividad.json(act.carpeta)
      r.avisos = avisos.pendientes(act.carpeta).map(avisoJSON)
      r.entregasSinRevisar = entregas.sinRevisar(act.carpeta)
      r.corridas = d.corridas?.(act.carpeta) ?? []
      r.creadorVersion = d.creadorVersion?.(act.carpeta) ?? 0
      return [200, r]
    }
    if (seccion === 'avisos' && n === 2) {
      if (method !== 'GET') return no405
      const act = oficinas.requerirActiva()
      return [200, { avisos: avisos.pendientes(act.carpeta).map(avisoJSON) }]
    }
    if (seccion === 'avisos' && n === 3 && a2 === 'visto') {
      if (method !== 'POST') return no405
      const act = oficinas.requerirActiva()
      const b = objeto(body)
      const n2 = avisos.vistos(act.carpeta, {
        id: typeof b.id === 'string' ? b.id : undefined,
        agente: b.todos === true ? undefined : typeof b.agente === 'string' ? b.agente : undefined,
      })
      return [200, { vistos: n2 }]
    }
    if (seccion === 'costos' && n === 2) {
      if (method !== 'GET') return no405
      const act = oficinas.requerirActiva()
      const desde = Number(query.desde)
      return [200, store.costos(act.carpeta, Number.isFinite(desde) ? desde : 0)]
    }
    return null
  }
}
