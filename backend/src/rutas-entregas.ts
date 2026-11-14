// `/api/entregas*` (EntregasRouter.swift): entregas de la oficina activa.
//   GET  /api/entregas?estado=&agente=&origen=&limite=   → {entregas, sinRevisar}
//   GET  /api/entregas/:id                               → {entrega} (con el texto completo)
//   POST /api/entregas/:id/revisada | /sin-revisar       → {entrega, sinRevisar}
//   POST /api/entregas/:id/cambios                       → 202 {entrega} (lo corre el Programador)
import { ErrorAPI } from './errores.js'
import { entregaJSON, entregaJSONCompleto, estadosEntrega, type Entrega } from './entregas.js'
import type { Obj } from './json.js'
import type { AgenteDef } from './oficina.js'
import type { OficinaActiva } from './oficinas.js'
import { atrapar, no404, no405, type Query, type Resp, type SubRouter } from './router.js'
import { registrarModulo, type Servicios } from './servicios.js'
import { Validar } from './validar.js'

export const maxBody = 200_000
export const maxCambios = 4000

/** Lo que este módulo necesita del Programador (Programador.swift: pedirCambios / cambiandoEntrega). Lo llena el módulo de
 *  tareas con `s.huecos.programador`; mientras no esté, `/cambios` responde 404 (igual que Swift sin programador). */
export interface ProgramadorEntregas {
  pedirCambios(act: OficinaActiva, def: AgenteDef, entrega: Entrega, texto: string): Promise<void>
  cambiandoEntrega(oficina: string, id: number): boolean
}
export const programadorEntregasDe = (s: Servicios) => s.huecos.programador as ProgramadorEntregas | undefined

export type AlRevisar = (e: Entrega, act: OficinaActiva) => Promise<void> | void

export class EntregasRouter implements SubRouter {
  /** Ganchos al revisar una entrega (tildar el pendiente de reunión, avisar al motor de flujos). Se corren en orden. */
  readonly alRevisar: AlRevisar[] = []
  constructor(private readonly s: Servicios) {}

  static esRuta = (p: string) => p === '/api/entregas' || p.startsWith('/api/entregas/')

  async handle(method: string, path: string, query: Query, body?: Buffer) {
    if (!EntregasRouter.esRuta(path)) return null
    return atrapar(async () => this.despachar(method, path, query, body))
  }

  private async despachar(method: string, path: string, query: Query, body?: Buffer): Promise<Resp> {
    const { entregas, oficinas } = this.s
    const partes = path.split('/').slice(1)
    if (partes.length < 2 || partes.length > 4 || partes.includes('')) return no404
    const a = oficinas.requerirActiva()
    if (partes.length === 2) {
      if (method !== 'GET') return no405
      return this.listar(a, query)
    }
    const id = entero(partes[2]!)
    if (id === undefined || id <= 0) return no404
    const e = entregas.una(a.carpeta, id)
    if (!e) return [404, { error: 'No existe esa entrega.' }]
    const prog = programadorEntregasDe(this.s)
    if (partes.length === 3) {
      if (method !== 'GET') return no405
      const o = entregaJSONCompleto(e)
      o.enCambios = prog?.cambiandoEntrega(a.carpeta, id) ?? false
      return [200, { entrega: o }]
    }
    if (method !== 'POST') return no405
    switch (partes[3]) {
      case 'revisada': {
        if (e.estado === 'cambios') throw new ErrorAPI(409, 'Esa entrega ya tiene una versión nueva.')
        const n = entregas.marcar(a.carpeta, id, 'revisada')
        if (!n) throw new ErrorAPI(500, 'No pude guardar.')
        for (const f of this.alRevisar) await f(n, a)
        return [200, { entrega: entregaJSON(n), sinRevisar: entregas.sinRevisar(a.carpeta) }]
      }
      case 'sin-revisar': {
        if (e.estado === 'cambios') throw new ErrorAPI(409, 'Esa entrega ya tiene una versión nueva.')
        const n = entregas.marcar(a.carpeta, id, 'sin_revisar')
        if (!n) throw new ErrorAPI(500, 'No pude guardar.')
        return [200, { entrega: entregaJSON(n), sinRevisar: entregas.sinRevisar(a.carpeta) }]
      }
      case 'cambios': {
        if (!prog) return no404
        if (e.estado === 'cambios') throw new ErrorAPI(409, 'Esa entrega ya tiene una versión nueva.')
        const def = e.sid === '' ? undefined : a.oficina.agentes.find((x) => x.id === e.agente)
        if (!def) throw new ErrorAPI(409, 'Esta entrega no tiene una conversación para retomar.')
        if (!body || body.length === 0 || body.length > maxBody) throw new ErrorAPI(400, 'pedido inválido')
        let d: unknown
        try { d = JSON.parse(body.toString('utf8')) } catch { throw new ErrorAPI(400, 'pedido inválido') }
        if (typeof d !== 'object' || d === null || Array.isArray(d)) throw new ErrorAPI(400, 'pedido inválido')
        const texto = Validar.texto((d as Obj).texto, 'texto', maxCambios)!
        await prog.pedirCambios(a, def, e, texto)
        const o = entregaJSON(e)
        o.enCambios = true
        return [202, { entrega: o }]
      }
      default:
        return no404
    }
  }

  private listar(a: OficinaActiva, q: Query): Resp {
    const filtro = (k: string) => (q[k] === undefined || q[k] === '' || q[k] === 'todas' ? undefined : q[k])
    const estado = filtro('estado')
    if (estado !== undefined && !estadosEntrega.includes(estado)) throw new ErrorAPI(400, '«estado» tiene que ser sin_revisar, revisada o cambios.')
    const limite = q.limite === undefined ? 100 : (entero(q.limite) ?? 100)
    const lista = this.s.entregas.lista(a.carpeta, { estado, agente: filtro('agente'), origen: filtro('origen'), limite })
    return [200, { entregas: lista.map(entregaJSON), sinRevisar: this.s.entregas.sinRevisar(a.carpeta) }]
  }
}

/** Como `Int64(String)` de Swift: signo opcional y solo dígitos; aproximado si es enorme. */
function entero(t: string): number | undefined {
  if (!/^[+-]?\d+$/.test(t)) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

export const entregasRouterDe = (s: Servicios) => s.huecos.entregasRouter as EntregasRouter

registrarModulo('entregas', 30, (s) => {
  const r = new EntregasRouter(s)
  s.huecos.entregasRouter = r
  s.router.entregas = r
})
