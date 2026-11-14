// Rutas del núcleo para oficinas (Router.despachar de Swift): estado, oficinas, oficina, perfil, departamentos y la
// lista de agentes. Contratar/editar/despedir agentes, chat e historial se suman al portar sus módulos.
import type { Config } from './config.js'
import { ErrorAPI } from './errores.js'
import { esObjeto, objeto, objetoOpcional, type Obj } from './json.js'
import { ValidarAgenteExtra, agenteJSON, departamentoJSON, oficinaJSON } from './oficina.js'
import { avatarValido, perfilJSON, type DepartamentoNuevo, type OficinaActiva, type Oficinas } from './oficinas.js'
import { no404, no405, type Resp, type RutaNucleo } from './router.js'
import { Slug, Validar } from './validar.js'

/** Lo que /api/estado necesita saber de claude (lo da el runner). */
export interface InfoClaude {
  /** Binario encontrado, o undefined. */
  claudePath(): string | undefined
  /** `claude auth status` (cacheado); undefined si no se pudo saber. */
  auth(): Promise<boolean | undefined>
}

export const sobreOficina = (a: OficinaActiva): Obj => ({ carpeta: a.carpeta, oficina: oficinaJSON(a.oficina) })

/** `mision` en un PATCH: clave ausente = undefined (no se toca); null o texto vacío la borran (""). */
export function misionPatch(d: Obj): string | undefined {
  if (!('mision' in d)) return undefined
  const v = d.mision
  if (v === null) return ''
  if (typeof v !== 'string') throw new ErrorAPI(400, '«mision» tiene que ser texto.')
  return Validar.texto(v, 'mision', ValidarAgenteExtra.maxMision, false) ?? ''
}

/** `alAbrir`: ganchos al abrir una oficina (reclamar chats de Próspera, escanear vínculos), se suman al portar esos módulos. */
export function rutasOficinas({ config, oficinas, claude, alAbrir = [] }: {
  config: Config; oficinas: Oficinas; claude: InfoClaude; alAbrir?: ((a: OficinaActiva) => Promise<void>)[]
}): RutaNucleo {
  async function estado(): Promise<Obj> {
    const bin = claude.claudePath()
    const a = bin !== undefined ? ((await claude.auth()) ?? null) : null
    const act = oficinas.activa()
    return {
      app: 'prospera-hq', version: config.version, claude: bin !== undefined,
      agentes: (act?.oficina.agentes.map((x) => x.id) ?? []).sort(), auth: a,
      claudePath: bin ?? null, oficina: act ? act.resumen : null,
      perfil: perfilJSON(oficinas.perfilActual()),
    }
  }

  function crearOficina(body?: Buffer): Resp {
    const d = objeto(body)
    const nombre = Validar.texto(d.nombre, 'nombre', 80)!
    const duenio = Validar.texto(d.duenio, 'duenio', 80, false) ?? ''
    const carpeta = Validar.texto(d.carpeta, 'carpeta', 1024, false)
    let deps: DepartamentoNuevo[] | undefined
    if (d.departamentos !== undefined && d.departamentos !== null) {
      if (!Array.isArray(d.departamentos)) throw new ErrorAPI(400, '«departamentos» tiene que ser una lista.')
      deps = d.departamentos.map((x): DepartamentoNuevo => {
        if (typeof x === 'string') return { nombre: x }
        if (!esObjeto(x)) throw new ErrorAPI(400, 'Cada departamento es un texto o un objeto {nombre, color?}.')
        return { id: Validar.texto(x.id, 'id', 41, false), nombre: Validar.texto(x.nombre, 'nombre', 60)!, color: Validar.texto(x.color, 'color', 7, false) }
      })
    }
    const vacia = d.vacia === true
    return [200, sobreOficina(oficinas.crear({ nombre, duenio, carpeta, departamentos: deps, vacia }))]
  }

  return async ({ method, partes, query, body }) => {
    const [, seccion, a2] = partes
    const n = partes.length
    if (seccion === 'estado' && n === 2) return method === 'GET' ? [200, await estado()] : no405
    if (seccion === 'perfil' && n === 2) {
      if (method === 'GET') return [200, { perfil: perfilJSON(oficinas.perfilActual()) }]
      if (method === 'PUT') {
        const d = objeto(body)
        const nombre = Validar.texto(d.nombre, 'nombre', 80, false) ?? ''
        const [p, a] = oficinas.guardarPerfil({ nombre, avatar: avatarValido(d.avatar) })
        return [200, { perfil: perfilJSON(p), oficina: oficinaJSON(a.oficina) }]
      }
      return no405
    }
    if (seccion === 'oficinas' && n === 2) {
      if (method === 'GET') return [200, { oficinas: oficinas.listar(), activa: oficinas.activa()?.carpeta ?? null }]
      if (method === 'POST') return crearOficina(body)
      return no405
    }
    if (seccion === 'oficinas' && n === 3 && a2 === 'abrir') {
      if (method !== 'POST') return no405
      const d = objeto(body)
      const a = oficinas.abrir(Validar.texto(d.carpeta, 'carpeta', 1024)!)
      for (const f of alAbrir) await f(a)
      return [200, sobreOficina(a)]
    }
    if (seccion === 'oficina' && n === 2) {
      if (method === 'GET') return [200, sobreOficina(oficinas.requerirActiva())]
      if (method === 'PATCH') {
        const d = objeto(body)
        const a = oficinas.editar(Validar.texto(d.nombre, 'nombre', 80, false), Validar.texto(d.duenio, 'duenio', 80, false))
        return [200, sobreOficina(a)]
      }
      return no405
    }
    if (seccion === 'departamentos' && n === 2) {
      if (method !== 'POST') return no405
      const d = objeto(body)
      const [dep, a] = oficinas.crearDepartamento({
        id: Validar.texto(d.id, 'id', 41, false), nombre: Validar.texto(d.nombre, 'nombre', 60)!,
        color: Validar.texto(d.color, 'color', 7, false), mision: Validar.texto(d.mision, 'mision', ValidarAgenteExtra.maxMision, false),
      })
      return [200, { departamento: departamentoJSON(dep), oficina: oficinaJSON(a.oficina) }]
    }
    if (seccion === 'departamentos' && n === 3) {
      const id = a2!
      if (!Slug.valido(id)) return no404
      if (method === 'PATCH') {
        const d = objeto(body)
        const [dep, a] = oficinas.editarDepartamento(id, {
          nombre: Validar.texto(d.nombre, 'nombre', 60, false), color: Validar.texto(d.color, 'color', 7, false), mision: misionPatch(d),
        })
        return [200, { departamento: departamentoJSON(dep), oficina: oficinaJSON(a.oficina) }]
      }
      if (method === 'DELETE') {
        const d = objetoOpcional(body)
        const mover = typeof d.moverA === 'string' ? d.moverA : query.moverA
        const a = oficinas.borrarDepartamento(id, mover)
        return [200, { ok: true, oficina: oficinaJSON(a.oficina) }]
      }
      return no405
    }
    if (seccion === 'agentes' && n === 2) {
      if (method === 'GET') return [200, { agentes: oficinas.requerirActiva().oficina.agentes.map(agenteJSON) }]
      if (method !== 'POST') return no405
      // POST (contratar) llega con el módulo de agentes
    }
    return null
  }
}
