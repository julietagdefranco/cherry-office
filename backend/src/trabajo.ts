// Carpetas de trabajo de la oficina: carpetas de la compu (un repo, por ejemplo) donde los agentes del alcance leen y
// escriben como en la carpeta de la oficina, y desde donde la app muestra archivos (imágenes, páginas, tarjetas). No pasan
// por la Biblioteca: no se fichan ni generan conocimiento. Viven en `oficina.json` → `carpetasTrabajo:[{id, ruta, alcance}]`.
//
//   GET    /api/carpetas-trabajo            {carpetas:[{id, ruta, alcance, existe}]}
//   POST   /api/carpetas-trabajo            {ruta, alcance?="oficina", id?} → {carpeta}
//   PATCH  /api/carpetas-trabajo/:id        {alcance} → {carpeta}
//   DELETE /api/carpetas-trabajo/:id        {ok} (la carpeta no se toca)
import fs from 'node:fs'
import path from 'node:path'
import { Config } from './config.js'
import { ErrorAPI } from './errores.js'
import { dentro, esDirectorio, realAunqueFalte } from './explorador.js'
import { esObjeto, objeto, type Obj } from './json.js'
import type { HQLog } from './log.js'
import type { AlcanceVinculo, CarpetaTrabajo, Oficina } from './oficina.js'
import type { Oficinas } from './oficinas.js'
import { atrapar, no404, no405, type Query, type Resp, type SubRouter } from './router.js'
import { Slug, Validar } from './validar.js'

const maxCarpetas = 20
const maxBody = 20_000

/** La carpeta de trabajo que contiene `abs` (ruta absoluta; se resuelven los enlaces) y las partes relativas a ella.
 *  undefined si no cae en ninguna, o si pasa por algo oculto (`.git`, `.env`…): eso no se muestra. */
export function enCarpetaTrabajo(o: Oficina | undefined, abs: string): { carpeta: CarpetaTrabajo; base: string; real: string; partes: string[] } | undefined {
  if (!o?.carpetasTrabajo?.length || abs.includes('\0') || !path.isAbsolute(abs)) return undefined
  const r = realAunqueFalte(path.resolve(abs))
  for (const c of o.carpetasTrabajo) {
    const base = realAunqueFalte(c.ruta)
    if (!dentro(base, r)) continue
    const partes = path.relative(base, r).split(path.sep).filter((x) => x !== '' && x !== '.')
    if (partes.some((p) => p === '..' || p.startsWith('.'))) return undefined
    return { carpeta: c, base, real: r, partes }
  }
  return undefined
}

export class TrabajoRouter implements SubRouter {
  constructor(private readonly oficinas: Oficinas, private readonly log: HQLog) {}

  async handle(method: string, p: string, _q: Query, body?: Buffer) {
    const partes = p.split('/').slice(1)
    if (partes[0] !== 'api' || partes[1] !== 'carpetas-trabajo' || partes.length > 3 || partes.includes('')) return null
    return atrapar(async (): Promise<Resp> => {
      if (partes.length === 2) {
        if (method === 'GET') return [200, this.listar()]
        if (method === 'POST') return [200, this.crear(body)]
        return no405
      }
      const id = partes[2]!
      if (!Slug.valido(id)) return no404
      if (method === 'PATCH') return [200, this.cambiar(id, body)]
      if (method === 'DELETE') return [200, this.quitar(id)]
      return no405
    })
  }

  private vista(c: CarpetaTrabajo): Obj {
    return { id: c.id, ruta: c.ruta, alcance: c.alcance as unknown as Obj, existe: esDirectorio(c.ruta) }
  }

  private listar(): Obj {
    return { carpetas: (this.oficinas.requerirActiva().oficina.carpetasTrabajo ?? []).map((c) => this.vista(c)) }
  }

  /** "oficina" o {agentes:[ids]} (también {departamentos:[ids]}, como las carpetas vinculadas). */
  private alcanceDe(v: unknown, o: Oficina): AlcanceVinculo {
    const msg = '«alcance» tiene que ser "oficina", {agentes:[...]} o {departamentos:[...]}.'
    if (v === undefined || v === null || v === 'oficina') return 'oficina'
    if (!esObjeto(v)) throw new ErrorAPI(400, msg)
    const ids = (k: 'agentes' | 'departamentos'): string[] | undefined => {
      const x = v[k]
      if (x === undefined) return undefined
      if (!Array.isArray(x) || x.length === 0) throw new ErrorAPI(400, `«alcance.${k}» tiene que ser una lista con al menos un id.`)
      const out: string[] = []
      for (const e of x) {
        if (typeof e !== 'string' || !Slug.valido(e)) throw new ErrorAPI(400, `«alcance.${k}» tiene que ser una lista de ids.`)
        if (!out.includes(e)) out.push(e)
      }
      return out
    }
    const ags = ids('agentes')
    if (ags) {
      const mal = ags.find((g) => !o.agentes.some((x) => x.id === g))
      if (mal !== undefined) throw new ErrorAPI(400, `El agente «${mal}» no está en la oficina.`)
      return { agentes: ags }
    }
    const deps = ids('departamentos')
    if (deps) {
      const mal = deps.find((d) => !o.departamentos.some((x) => x.id === d))
      if (mal !== undefined) throw new ErrorAPI(400, `El departamento «${mal}» no existe.`)
      return { departamentos: deps }
    }
    throw new ErrorAPI(400, msg)
  }

  private crear(body?: Buffer): Obj {
    const a = this.oficinas.requerirActiva()
    const d = objeto(body, maxBody)
    const cruda = Validar.texto(d.ruta, 'ruta', 1024)!.trim()
    if (!(path.isAbsolute(cruda) || cruda === '~' || cruda.startsWith('~/'))) throw new ErrorAPI(400, 'La carpeta tiene que ser una ruta absoluta.')
    const home = this.oficinas.config.home
    const ruta = Config.ruta(cruda, home)
    const real = realAunqueFalte(ruta)
    const esRaiz = (x: string) => path.parse(x).root === x
    if (esRaiz(ruta) || esRaiz(real) || ruta === home || real === realAunqueFalte(home)) {
      throw new ErrorAPI(400, 'Esa carpeta es demasiado amplia: elegí una carpeta concreta (no «/» ni tu carpeta personal entera).')
    }
    if (!fs.existsSync(ruta)) throw new ErrorAPI(404, 'No encuentro esa carpeta.')
    if (!esDirectorio(ruta)) throw new ErrorAPI(400, 'Eso no es una carpeta.')
    const of = realAunqueFalte(a.carpeta)
    if (dentro(of, real)) throw new ErrorAPI(400, 'Esa carpeta ya es parte de la oficina: los agentes ya trabajan ahí.')
    if (dentro(real, of)) throw new ErrorAPI(400, 'Esa carpeta contiene a la oficina: elegí una más concreta.')
    const existentes = a.oficina.carpetasTrabajo ?? []
    const choca = existentes.find((c) => { const b = realAunqueFalte(c.ruta); return dentro(b, real) || dentro(real, b) })
    if (choca) throw new ErrorAPI(409, choca.ruta === ruta ? 'Esa carpeta ya es de trabajo.' : `Se pisa con la carpeta de trabajo ${choca.ruta}.`)
    if (existentes.length >= maxCarpetas) throw new ErrorAPI(400, `Máximo ${maxCarpetas} carpetas de trabajo.`)
    const alcance = this.alcanceDe(d.alcance, a.oficina)
    const usados = new Set(existentes.map((c) => c.id))
    const pid = Validar.texto(d.id, 'id', 41, false)
    if (pid !== undefined && (!Slug.valido(pid) || usados.has(pid))) throw new ErrorAPI(400, 'Id inválido o repetido.')
    const c: CarpetaTrabajo = { id: pid ?? Slug.unico(path.basename(ruta), usados, 'carpeta'), ruta, alcance }
    this.oficinas.modificar((o) => { o.carpetasTrabajo = [...(o.carpetasTrabajo ?? []), c] })
    this.log.info(`carpeta de trabajo agregada id=${c.id}`)
    return { carpeta: this.vista(c) }
  }

  private cambiar(id: string, body?: Buffer): Obj {
    const a = this.oficinas.requerirActiva()
    const c = (a.oficina.carpetasTrabajo ?? []).find((x) => x.id === id)
    if (!c) throw new ErrorAPI(404, 'No existe esa carpeta de trabajo.')
    const alcance = this.alcanceDe(objeto(body, maxBody).alcance, a.oficina)
    this.oficinas.modificar((o) => { o.carpetasTrabajo = (o.carpetasTrabajo ?? []).map((x) => (x.id === id ? { ...x, alcance } : x)) })
    return { carpeta: this.vista({ ...c, alcance }) }
  }

  private quitar(id: string): Obj {
    const a = this.oficinas.requerirActiva()
    if (!(a.oficina.carpetasTrabajo ?? []).some((x) => x.id === id)) throw new ErrorAPI(404, 'No existe esa carpeta de trabajo.')
    this.oficinas.modificar((o) => {
      o.carpetasTrabajo = (o.carpetasTrabajo ?? []).filter((x) => x.id !== id)
      if (o.carpetasTrabajo.length === 0) delete o.carpetasTrabajo
    })
    this.log.info(`carpeta de trabajo quitada id=${id}`)
    return { ok: true }
  }
}
