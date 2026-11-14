// `/api/*` (Router.swift). Mismo contrato que Swift: handle(method, path, query, body) -> {status, json}.
// El orden de los subrouters importa y es el mismo que en Swift:
//   extras (flujos, creador, gobierno, parte) → reuniones → biblioteca → tareas → entregas → paquete → explorador → núcleo.
// Lo que todavía no está portado responde 404 {"error":"no"}.
import { ErrorAPI } from './errores.js'
import { codificar, type Obj } from './json.js'

export type Query = Record<string, string>
export type RespuestaAPI = { status: number; json: Buffer }

/** Contrato con los transportes (servidor dev, Electron). */
export interface APIHandler {
  handle(method: string, path: string, query: Query, body?: Buffer): Promise<RespuestaAPI>
}

/** Una sección de la API que vive en otro archivo. Devuelve null si no atiende ese pedido. */
export interface SubRouter {
  handle(method: string, path: string, query: Query, body?: Buffer): Promise<RespuestaAPI | null>
}

/** Respuesta del núcleo antes de codificar. */
export type Resp = [number, Obj]
export const no405: Resp = [405, { error: 'método no permitido' }]
export const no404: Resp = [404, { error: 'no' }]

/** Una ruta del núcleo: recibe las partes del path (`["api","estado"]`) y devuelve una respuesta o null si no es suya. */
export type RutaNucleo = (p: { method: string; partes: string[]; query: Query; body?: Buffer }) => Promise<Resp | null>

const enPrefijo = (p: string, ...bases: string[]) => bases.some((b) => p === b || p.startsWith(b + '/'))

export class Router implements APIHandler {
  readonly extras: SubRouter[] = []
  reuniones?: SubRouter
  biblioteca?: SubRouter
  tareas?: SubRouter
  entregas?: SubRouter
  paquete?: SubRouter
  explorador?: SubRouter
  /** Rutas del núcleo (estado, chat, oficinas, agentes…), en orden. */
  readonly nucleo: RutaNucleo[] = []

  /** `listo`: espera la migración inicial antes de atender cada pedido. */
  constructor(private readonly listo: () => Promise<void> = async () => {}) {}

  registrarExtra(r: SubRouter) { this.extras.push(r) }

  async handle(method: string, path: string, query: Query, body?: Buffer): Promise<RespuestaAPI> {
    await this.listo()
    const m = method.toUpperCase()
    let p = path
    const i = p.search(/[?#]/)
    if (i >= 0) p = p.slice(0, i)
    for (const extra of this.extras) {
      const r = await extra.handle(m, p, query, body)
      if (r) return r
    }
    const seccion = async (sub: SubRouter | undefined) => (sub && (await sub.handle(m, p, query, body))) || { status: 404, json: codificar(no404[1]) }
    if (enPrefijo(p, '/api/reuniones')) return seccion(this.reuniones)
    if (enPrefijo(p, '/api/archivos', '/api/vinculos', '/api/biblioteca')) return seccion(this.biblioteca)
    if (enPrefijo(p, '/api/tareas')) return seccion(this.tareas)
    if (enPrefijo(p, '/api/entregas')) return seccion(this.entregas)
    if (p === '/api/oficina/exportar' || p === '/api/oficinas/importar') return seccion(this.paquete)
    if (p === '/api/fs/carpetas' || p === '/api/oficina/archivos' || p === '/api/oficina/archivo') return seccion(this.explorador)
    const [status, obj] = await this.despachar(m, p, query, body)
    return { status, json: codificar(obj) }
  }

  private async despachar(method: string, p: string, query: Query, body?: Buffer): Promise<Resp> {
    const partes = p.split('/').slice(1)
    if (!p.startsWith('/') || partes.length < 2 || partes[0] !== 'api' || partes.includes('')) return no404
    try {
      for (const ruta of this.nucleo) {
        const r = await ruta({ method, partes, query, body })
        if (r) return r
      }
      return no404
    } catch (e) {
      if (e instanceof ErrorAPI) return [e.status, { error: e.mensaje }]
      return [500, { error: 'error interno' }]
    }
  }
}

/** Atrapa ErrorAPI en un subrouter y lo convierte en respuesta (los subrouters de Swift hacen lo mismo). */
export async function atrapar(f: () => Promise<Resp | null>): Promise<RespuestaAPI | null> {
  try {
    const r = await f()
    return r ? { status: r[0], json: codificar(r[1]) } : null
  } catch (e) {
    if (e instanceof ErrorAPI) return { status: e.status, json: codificar({ error: e.mensaje }) }
    return { status: 500, json: codificar({ error: 'error interno' }) }
  }
}
