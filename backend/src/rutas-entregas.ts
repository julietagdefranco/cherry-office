// `/api/entregas*` (EntregasRouter.swift): entregas de la oficina activa.
//   GET  /api/entregas?estado=&agente=&origen=&limite=   → {entregas, sinRevisar}
//   GET  /api/entregas/:id                               → {entrega} (con el texto completo)
//   POST /api/entregas/:id/revisada | /sin-revisar       → {entrega, sinRevisar}
//   POST /api/entregas/:id/cambios                       → 202 {entrega} (lo corre el Programador)
//   POST /api/entregas/:id/biblioteca                    → {archivos, entrega, sinRevisar} (copia a la biblioteca)
//   GET  /api/entregas/:id/vista?ruta=                   → {vista} (un archivo de la entrega listo para mostrar)
//   POST /api/entregas/:id/retoque                       → {entrega, vista} (la persona cambia un texto a mano)
//   POST /api/entregas/:id/deshacer-retoque              → {entrega, vista} (vuelve el último retoque)
import fs from 'node:fs'
import nodePath from 'node:path'
import type { Biblioteca } from './biblioteca.js'
import { ErrorAPI } from './errores.js'
import { entregaJSON, entregaJSONCompleto, estadosEntrega, type AnclaNota, type Entrega, type NotaEntrega } from './entregas.js'
import type { Obj } from './json.js'
import type { AgenteDef } from './oficina.js'
import type { OficinaActiva } from './oficinas.js'
import { atrapar, no404, no405, type Query, type Resp, type SubRouter } from './router.js'
import { registrarModulo, type Servicios } from './servicios.js'
import { largo, prefijo, Validar } from './validar.js'
import { resolverEnOficina, retocable, tipoVista, Vista } from './vista.js'

export const maxBody = 200_000
export const maxCambios = 4000
export const maxNotas = 30
export const maxNota = 1000
export const maxRetoqueHTML = 2000

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

  /** La biblioteca, si el módulo está cargado (se busca en cada pedido: se registra después que este). */
  private get biblioteca() { return this.s.huecos.biblioteca as Biblioteca | undefined }

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
    if (partes.length === 4 && partes[3] === 'vista') {
      if (method !== 'GET') return no405
      return [200, { vista: Vista.leer(a.carpeta, archivoDe(e, query.ruta)) }]
    }
    if (partes.length === 3) {
      if (method !== 'GET') return no405
      const o = entregaJSONCompleto(e)
      o.enCambios = prog?.cambiandoEntrega(a.carpeta, id) ?? false
      const bib = this.biblioteca
      if (bib) {
        o.guardables = bib.guardables(a, e)
        o.enBiblioteca = bib.vistasDeEntrega(a.carpeta, id)
      }
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
      case 'biblioteca': {
        // Guarda una copia de archivos de la entrega en la biblioteca (`archivos/<departamento>/`, con ficha y catálogo).
        // No la marca como revisada: eso lo hace «Listo» (que además mueve flujos y pendientes).
        const bib = this.biblioteca
        if (!bib) return no404
        let d: Obj = {}
        if (body && body.length > 0) {
          if (body.length > maxBody) throw new ErrorAPI(400, 'pedido inválido')
          let crudo: unknown
          try { crudo = JSON.parse(body.toString('utf8')) } catch { throw new ErrorAPI(400, 'pedido inválido') }
          if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) throw new ErrorAPI(400, 'pedido inválido')
          d = crudo as Obj
        }
        let rels: string[]
        if (d.archivos === undefined) rels = bib.guardables(a, e)
        else if (Array.isArray(d.archivos) && d.archivos.every((x) => typeof x === 'string')) rels = [...new Set(d.archivos as string[])]
        else throw new ErrorAPI(400, '«archivos» tiene que ser una lista de rutas de la entrega.')
        if (rels.length === 0) throw new ErrorAPI(409, 'Esta entrega no tiene archivos que se puedan guardar en la biblioteca.')
        const dep = Validar.texto(d.departamento, 'departamento', 41, false) ?? 'compartido'
        const leer = typeof d.leer === 'boolean' ? d.leer : false
        const archivos = bib.guardarDeEntrega(a, e, rels, dep, leer)
        return [200, { archivos, entrega: entregaJSON(e), sinRevisar: entregas.sinRevisar(a.carpeta) }]
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
        const d = cuerpo(body)
        const notas = notasDe(e, d.notas)
        const texto = Validar.texto(d.texto, 'texto', maxCambios, notas.length === 0)
        await prog.pedirCambios(a, def, e, pedidoDeCambios(e, texto, notas))
        if (notas.length) this.s.entregas.guardarNotas(a.carpeta, id, notas)
        const o = entregaJSON(this.s.entregas.una(a.carpeta, id) ?? e)
        o.enCambios = true
        return [202, { entrega: o }]
      }
      case 'retoque': {
        if (e.estado === 'cambios') throw new ErrorAPI(409, 'Esa entrega ya tiene una versión nueva: retocá la última.')
        if (prog?.cambiandoEntrega(a.carpeta, id)) throw new ErrorAPI(409, 'El agente está haciendo cambios: esperá a que termine.')
        const d = cuerpo(body)
        const rel = archivoDe(e, d.archivo)
        const tipo = tipoVista(rel)
        if (!retocable(tipo)) throw new ErrorAPI(400, 'Ese archivo no se puede retocar a mano.')
        const abs = resolverEnOficina(a.carpeta, rel)
        const actual = fs.readFileSync(abs, 'utf8')
        let nuevo: string
        if (tipo === 'html') {
          const antes = textoCrudo(d.antes, 'antes', maxRetoqueHTML)
          const despues = textoCrudo(d.despues, 'despues', maxRetoqueHTML, true)
          if (antes.trim() === '') throw new ErrorAPI(400, 'Falta «antes».')
          nuevo = Vista.retocarHTML(actual, antes, despues)
        } else {
          if (typeof d.texto !== 'string') throw new ErrorAPI(400, 'Falta «texto».')
          if (Buffer.byteLength(d.texto) > 512 * 1024) throw new ErrorAPI(413, 'El texto es demasiado largo.')
          if (d.mod !== undefined && d.mod !== Vista.segundos(fs.statSync(abs))) throw new ErrorAPI(409, 'El archivo cambió desde que lo abriste. Volvé a abrirlo.')
          nuevo = d.texto
        }
        if (nuevo === actual) return [200, { entrega: entregaJSON(e), vista: Vista.leer(a.carpeta, rel) }]
        const ts = Date.now() / 1000
        const foto = `archivos/.papelera/retoques/${id}/${Math.floor(ts * 1000)}-${nodePath.posix.basename(rel)}`
        const absFoto = nodePath.join(a.carpeta, ...foto.split('/'))
        fs.mkdirSync(nodePath.dirname(absFoto), { recursive: true })
        fs.writeFileSync(absFoto, actual)
        fs.writeFileSync(abs, nuevo)
        const n = this.s.entregas.guardarRetoques(a.carpeta, id, [...(e.retoques ?? []), { archivo: rel, ts, foto }]) ?? e
        return [200, { entrega: entregaJSON(n), vista: Vista.leer(a.carpeta, rel) }]
      }
      case 'deshacer-retoque': {
        if (e.estado === 'cambios') throw new ErrorAPI(409, 'Esa entrega ya tiene una versión nueva.')
        if (prog?.cambiandoEntrega(a.carpeta, id)) throw new ErrorAPI(409, 'El agente está haciendo cambios: esperá a que termine.')
        const lista = e.retoques ?? []
        const ult = lista[lista.length - 1]
        if (!ult) throw new ErrorAPI(409, 'No hay retoques para deshacer.')
        const abs = resolverEnOficina(a.carpeta, ult.archivo)
        let previo: Buffer
        try { previo = fs.readFileSync(resolverEnOficina(a.carpeta, ult.foto)) } catch (err) {
          if (err instanceof ErrorAPI) throw new ErrorAPI(409, 'No encontré la copia de antes del retoque.')
          throw err
        }
        fs.writeFileSync(abs, previo)
        const n = this.s.entregas.guardarRetoques(a.carpeta, id, lista.slice(0, -1)) ?? e
        return [200, { entrega: entregaJSON(n), vista: Vista.leer(a.carpeta, ult.archivo) }]
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

/** El cuerpo JSON del pedido como objeto, o 400. */
function cuerpo(body?: Buffer): Obj {
  if (!body || body.length === 0 || body.length > maxBody * 4) throw new ErrorAPI(400, 'pedido inválido')
  let d: unknown
  try { d = JSON.parse(body.toString('utf8')) } catch { throw new ErrorAPI(400, 'pedido inválido') }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) throw new ErrorAPI(400, 'pedido inválido')
  return d as Obj
}

/** Una de las rutas de la entrega, o 400. */
function archivoDe(e: Entrega, v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new ErrorAPI(400, 'Falta «ruta» (un archivo de la entrega).')
  if (!e.archivos.includes(v)) throw new ErrorAPI(400, 'Ese archivo no es de esta entrega.')
  return v
}

/** Texto sin recortar (los espacios del borde importan para encontrarlo en el fuente). */
function textoCrudo(v: unknown, campo: string, max: number, vacioOk = false): string {
  if (typeof v !== 'string') throw new ErrorAPI(400, `Falta «${campo}».`)
  if (!vacioOk && v === '') throw new ErrorAPI(400, `Falta «${campo}».`)
  if (largo(v) > max) throw new ErrorAPI(400, `«${campo}» es demasiado largo (máximo ${max} caracteres).`)
  return v
}

const corto = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return largo(t) > n ? prefijo(t, n - 1) + '…' : t
}

/** Valida las notas de «Pedir cambios» (hasta 30, cada una de un archivo de la entrega o general). */
function notasDe(e: Entrega, v: unknown): NotaEntrega[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ErrorAPI(400, '«notas» tiene que ser una lista.')
  if (v.length > maxNotas) throw new ErrorAPI(400, `Son demasiadas notas (máximo ${maxNotas}).`)
  return v.map((x): NotaEntrega => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ErrorAPI(400, 'Cada nota tiene que ser un objeto.')
    const o = x as Obj
    const texto = Validar.texto(o.texto, 'texto de la nota', maxNota)!
    const archivo = o.archivo === undefined || o.archivo === '' ? '' : archivoDe(e, o.archivo)
    const nota: NotaEntrega = { archivo, texto }
    if (o.ancla !== undefined && o.ancla !== null) {
      if (typeof o.ancla !== 'object' || Array.isArray(o.ancla)) throw new ErrorAPI(400, '«ancla» tiene que ser un objeto.')
      const an = o.ancla as Obj, ancla: AnclaNota = {}
      for (const k of ['cita', 'selector', 'seccion'] as const) {
        if (typeof an[k] === 'string' && (an[k] as string).trim() !== '') ancla[k] = corto(an[k] as string, k === 'cita' ? 200 : 120)
      }
      for (const k of ['x', 'y'] as const) {
        const n = an[k]
        if (typeof n === 'number' && Number.isFinite(n)) ancla[k] = Math.round(Math.max(0, Math.min(100, n)))
      }
      if (Object.keys(ancla).length) nota.ancla = ancla
    }
    return nota
  })
}

/** El pedido para el agente: las notas agrupadas por archivo, el texto general y, si hubo, los retoques a mano. */
export function pedidoDeCambios(e: Entrega, texto: string | undefined, notas: NotaEntrega[]): string {
  const partes: string[] = []
  const porArchivo = new Map<string, NotaEntrega[]>()
  for (const n of notas) porArchivo.set(n.archivo, [...(porArchivo.get(n.archivo) ?? []), n])
  let i = 0
  for (const [archivo, ns] of porArchivo) {
    const lineas = ns.map((n) => `${++i}. ${dondeNota(n.ancla)}${n.texto}`)
    partes.push((archivo ? `En ${archivo}:` : 'En general:') + '\n' + lineas.join('\n'))
  }
  if (texto) partes.push(notas.length ? `Además: ${texto}` : texto)
  const retocados = [...new Set((e.retoques ?? []).map((r) => r.archivo))]
  if (retocados.length) {
    partes.push(`Ojo: retoqué a mano ${retocados.join(', ')} después de tu entrega; partí del archivo como está ahora y no pises esos cambios.`)
  }
  return partes.join('\n\n')
}

function dondeNota(a?: AnclaNota): string {
  if (!a) return ''
  if (a.cita) return `En «${a.cita}»${a.selector ? ` (${a.selector})` : a.seccion ? ` (sección «${a.seccion}»)` : ''}: `
  if (a.selector) return `En el elemento ${a.selector}: `
  if (a.x !== undefined && a.y !== undefined) return `En el punto a ${a.x} % del ancho y ${a.y} % del alto: `
  return ''
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
