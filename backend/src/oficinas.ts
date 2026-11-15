// La oficina activa, los recientes (`config.json` de la app) y todas las escrituras de `oficina.json` (actor Oficinas
// de Swift). Todo es sincrónico: con un solo hilo, cada leer-modificar-escribir corre sin intercalaciones, igual que
// en el actor. Si un método necesita esperar algo en el medio (claude), tiene que releer la oficina después.
import fs from 'node:fs'
import path from 'node:path'
import { Config } from './config.js'
import { ErrorAPI } from './errores.js'
import { esObjeto, type Obj } from './json.js'
import { jsonSwift } from './json-swift.js'
import type { HQLog } from './log.js'
import {
  OficinaStore, ValidarAgenteExtra, clavesAvatar, escribirAtomico, validarOficina,
  type Avatar, type Departamento, type Oficina,
} from './oficina.js'
import { actualizarMemoria, completarEstructura, crearEstructura } from './plantillas.js'
import { Slug, Validar, largo } from './validar.js'

/** Oficina abierta: carpeta absoluta + contenido de oficina.json (leído en el momento). */
export class OficinaActiva {
  constructor(readonly carpeta: string, readonly oficina: Oficina) {}
  /** Ruta absoluta de una ruta relativa a la oficina. */
  ruta(rel: string) { return path.join(this.carpeta, rel) }
  /** `{carpeta, nombre}` del contrato de /api/estado. */
  get resumen(): Obj { return { carpeta: this.carpeta, nombre: this.oficina.nombre } }
}

type Reciente = { carpeta: string; nombre: string; abierta: number }

/** Quien dirige una oficina (YO): `duenio` + `avatarDuenio` de su oficina.json. */
export type Perfil = { nombre: string; avatar?: Avatar }
export const perfilJSON = (p: Perfil): Obj => ({ nombre: p.nombre, avatar: p.avatar ? { ...p.avatar } : null })

/** Avatar validado de un cuerpo (NuevoAgente.avatarValido de Swift): textos de hasta 60, colores #rrggbb en minúsculas. */
export function avatarValido(v: unknown): Avatar | undefined {
  if (v === undefined || v === null) return undefined
  if (!esObjeto(v)) throw new ErrorAPI(400, '«avatar» tiene que ser un objeto.')
  const a: Avatar = {}
  for (const k of clavesAvatar) {
    const x = v[k]
    if (x === undefined || x === null) continue
    if (typeof x !== 'string' || largo(x) > 60) throw new ErrorAPI(400, `Avatar: «${k}» inválido.`)
    if (x !== '') a[k] = x
  }
  for (const k of ['colorPelo', 'colorTorso', 'colorPiernas', 'colorPiel', 'colorBrazos', 'colorAccesorio'] as const) {
    const c = a[k]
    if (c === undefined) continue
    if (!Validar.colorHex(c)) throw new ErrorAPI(400, 'Avatar: los colores tienen que ser tipo #141414.')
    a[k] = c.toLowerCase()
  }
  return a
}

function perfilDesde(o: unknown): Perfil {
  if (!esObjeto(o)) return { nombre: '' }
  const n = typeof o.nombre === 'string' ? o.nombre.trim() : ''
  let avatar: Avatar | undefined
  try {
    avatar = avatarValido(o.avatar)
  } catch {}
  return { nombre: largo(n) <= 80 ? n : '', avatar }
}

export type DepartamentoNuevo = { id?: string; nombre: string; color?: string; mision?: string }

/** Ruta del usuario: absoluta o con `~`. */
const esRutaAbsoluta = (c: string) => path.isAbsolute(c) || c === '~' || c.startsWith('~/') || c.startsWith('~\\')

export class Oficinas {
  static readonly paleta = ['#ee6da6', '#a88bd6', '#f0a35b', '#e6c22e', '#4aa0dc', '#5fbf8a', '#d9684f', '#7f8fa6']
  static readonly departamentosSugeridos = ['Dirección', 'Comunicación', 'Operaciones']
  static readonly maxDepartamentos = 12
  static readonly maxAgentes = 60

  readonly estadoPath: string
  private activaCarpeta?: string
  private recientes: Reciente[] = []
  /** Perfil global de versiones anteriores (config.json); solo para migrar la minifig a cada oficina. */
  private perfilViejo: Perfil = { nombre: '' }
  /** Ganchos que borran lo guardado fuera de la carpeta para una ruta (hq.db): al borrar una oficina y al estrenar una
   *  carpeta como oficina nueva (crear o importar un .zip), por si quedó algo de una anterior en esa misma ruta. */
  readonly alOlvidar: ((dir: string) => void)[] = []

  constructor(readonly config: Config, readonly log: HQLog) {
    this.estadoPath = path.join(config.datosDir, 'config.json')
    let o: unknown
    try {
      o = JSON.parse(fs.readFileSync(this.estadoPath, 'utf8'))
    } catch {}
    if (esObjeto(o)) {
      if (typeof o.oficina_activa === 'string' && o.oficina_activa !== '') this.activaCarpeta = o.oficina_activa
      this.perfilViejo = perfilDesde(o.perfil)
      for (const r of Array.isArray(o.oficinas_recientes) ? o.oficinas_recientes : []) {
        if (esObjeto(r) && typeof r.carpeta === 'string' && typeof r.nombre === 'string') {
          this.recientes.push({ carpeta: r.carpeta, nombre: r.nombre, abierta: typeof r.abierta === 'number' ? r.abierta : 0 })
        }
      }
    }
  }

  // MARK: consulta

  /** Oficina activa leída del disco, o undefined (ninguna abierta, o su oficina.json ya no es válido). */
  activa(): OficinaActiva | undefined {
    const c = this.activaCarpeta
    if (!c) return undefined
    let o: Oficina
    try {
      o = OficinaStore.leer(c)
    } catch {
      return undefined
    }
    if (this.migrarPerfilViejo(o)) {
      try {
        OficinaStore.escribir(o, c)
      } catch {}
    }
    return new OficinaActiva(c, o)
  }

  /** Igual que `activa()` pero lanza 409 «No hay una oficina abierta». */
  requerirActiva(): OficinaActiva {
    const a = this.activa()
    if (!a) throw ErrorAPI.sinOficina
    return a
  }

  /** Recientes cuya carpeta todavía tiene una oficina válida (nombre leído del disco). */
  listar(): Obj[] {
    const out: Obj[] = []
    for (const r of [...this.recientes].sort((a, b) => b.abierta - a.abierta)) {
      try {
        const o = OficinaStore.leer(r.carpeta)
        out.push({ carpeta: r.carpeta, nombre: o.nombre, activa: r.carpeta === this.activaCarpeta })
      } catch {}
    }
    return out
  }

  // MARK: perfil (YO)

  /** Quien dirige la oficina activa (vacío si no hay oficina abierta). */
  perfilActual(): Perfil {
    const o = this.activa()?.oficina
    return o ? { nombre: o.duenio, avatar: o.avatarDuenio } : { nombre: '' }
  }

  /** Cambia quien dirige la oficina activa (nombre y minifig). Las demás oficinas no se tocan. */
  guardarPerfil(p: Perfil): [Perfil, OficinaActiva] {
    const n = p.nombre.trim()
    if (largo(n) > 80) throw new ErrorAPI(400, 'El nombre es demasiado largo (hasta 80 caracteres).')
    const av = p.avatar ? { ...p.avatar } : undefined
    if (av && av.semilla === undefined) av.semilla = 'yo'
    const [, a] = this.modificar((o) => {
      o.duenio = n
      if (av) o.avatarDuenio = av
      else delete o.avatarDuenio
    })
    return [{ nombre: n, avatar: av }, a]
  }

  /** Oficinas de antes de que cada una tuviera su director: si no tienen minifig y las dirigía el perfil global viejo,
   *  se quedan con la suya (y con su nombre si no tenían dueño). True si cambió algo. */
  private migrarPerfilViejo(o: Oficina): boolean {
    const pv = this.perfilViejo
    if (o.avatarDuenio || !pv.avatar || pv.nombre === '' || !(o.duenio === '' || o.duenio === pv.nombre)) return false
    if (o.duenio === '') o.duenio = pv.nombre
    o.avatarDuenio = { ...pv.avatar }
    return true
  }

  // MARK: crear y abrir

  /** `vacia`: la oficina arranca sin departamentos (la arma el Creador); si no, sin lista van los sugeridos. */
  crear({ nombre, duenio, carpeta, departamentos, vacia = false }: {
    nombre: string; duenio: string; carpeta?: string; departamentos?: DepartamentoNuevo[]; vacia?: boolean
  }): OficinaActiva {
    const n = nombre.trim()
    if (n === '' || largo(n) > 80) throw new ErrorAPI(400, 'Poné un nombre para la oficina (hasta 80 caracteres).')
    const d = duenio.trim()
    if (largo(d) > 80) throw new ErrorAPI(400, 'El nombre del dueño es demasiado largo.')

    const pedidos = departamentos && departamentos.length > 0 ? departamentos
      : vacia ? [] : Oficinas.departamentosSugeridos.map((x) => ({ nombre: x }))
    if (pedidos.length > Oficinas.maxDepartamentos) throw new ErrorAPI(400, `Máximo ${Oficinas.maxDepartamentos} departamentos.`)
    const deps: Departamento[] = []
    pedidos.forEach((p, i) => deps.push(Oficinas.armarDepartamento(p, i, new Set(deps.map((x) => x.id)))))

    let dir: string
    const c = carpeta?.trim()
    if (c) {
      if (!esRutaAbsoluta(c)) throw new ErrorAPI(400, 'La carpeta tiene que ser una ruta absoluta.')
      dir = Config.ruta(c, this.config.home)
      if (OficinaStore.existe(dir)) throw new ErrorAPI(409, 'Ya hay una oficina en esa carpeta. Abrila en lugar de crearla.')
    } else {
      dir = Oficinas.carpetaLibre(this.config.oficinasDir, n)
    }
    const of: Oficina = { version: 1, nombre: n, duenio: d, departamentos: deps, agentes: [] }
    validarOficina(of)
    try {
      crearEstructura(dir, of)
    } catch (e) {
      if (e instanceof ErrorAPI) throw e
      throw new ErrorAPI(500, 'No pude crear la carpeta de la oficina.')
    }
    OficinaStore.escribir(of, dir)
    this.olvidarDatos(dir)
    this.activar(dir, n)
    this.log.info(`oficina creada nombre=${largo(n)}c departamentos=${deps.length}`)
    return new OficinaActiva(dir, of)
  }

  /** Corre los ganchos de `alOlvidar` (un error no frena la creación ni el borrado). */
  olvidarDatos(dir: string) {
    for (const f of this.alOlvidar) {
      try {
        f(dir)
      } catch {
        this.log.warn('no pude limpiar lo guardado de una oficina anterior en esa carpeta')
      }
    }
  }

  /** Valida `oficina.json` de la carpeta y la deja activa. */
  abrir(carpeta: string): OficinaActiva {
    const c = carpeta.trim()
    if (!esRutaAbsoluta(c)) throw new ErrorAPI(400, 'La carpeta tiene que ser una ruta absoluta.')
    const dir = Config.ruta(c, this.config.home)
    let esDir = false
    try {
      esDir = fs.statSync(dir).isDirectory()
    } catch {}
    if (!esDir) throw new ErrorAPI(404, 'No encuentro esa carpeta.')
    const o = OficinaStore.leer(dir)
    try {
      completarEstructura(dir)
    } catch {}
    actualizarMemoria(dir, o.agentes.map((a) => a.id))
    this.activar(dir, o.nombre)
    return new OficinaActiva(dir, o)
  }

  /** Borra la oficina `dir` de la app: deja de estar activa y en recientes, y se olvida lo guardado en hq.db. Los
   *  archivos de la carpeta no se tocan (la app de escritorio los manda a la papelera). */
  borrar(dir: string) {
    if (this.activaCarpeta === dir) this.activaCarpeta = undefined
    this.recientes = this.recientes.filter((r) => r.carpeta !== dir)
    this.guardarEstado()
    this.olvidarDatos(dir)
    this.log.info('oficina borrada')
  }

  /** Deja `dir` como activa y la sube a recientes (máximo 10). Guarda config.json. */
  activar(dir: string, nombre: string) {
    this.activaCarpeta = dir
    this.recientes = this.recientes.filter((r) => r.carpeta !== dir)
    this.recientes.unshift({ carpeta: dir, nombre, abierta: Date.now() / 1000 })
    if (this.recientes.length > 10) this.recientes = this.recientes.slice(0, 10)
    this.guardarEstado()
  }

  private guardarEstado() {
    let o: Obj = {}
    if (fs.existsSync(this.estadoPath)) {
      let leido: unknown
      try {
        leido = JSON.parse(fs.readFileSync(this.estadoPath, 'utf8'))
      } catch {}
      if (!esObjeto(leido)) {
        this.log.warn('config.json ilegible: no guardo la oficina activa')
        return
      }
      o = leido
    }
    o.oficina_activa = this.activaCarpeta ?? null
    o.oficinas_recientes = this.recientes.map((r) => ({ carpeta: r.carpeta, nombre: r.nombre, abierta: r.abierta }))
    try {
      fs.mkdirSync(this.config.datosDir, { recursive: true })
      escribirAtomico(jsonSwift(o), this.estadoPath)
    } catch {
      this.log.error('no pude guardar config.json')
    }
  }

  static carpetaLibre(base: string, nombre: string): string {
    let limpio = [...nombre].map((ch) => {
      const u = ch.codePointAt(0)!
      return ch === '/' || ch === ':' || ch === '\\' || u < 32 ? '-' : ch
    }).join('').trim()
    limpio = limpio.replace(/^\.+/, '')
    // Sin punto ni espacio al final («Luis Inc.» -> «Luis Inc»): con una carpeta así en la ruta, Claude Code nunca
    // aplica las reglas `Edit(//…)`/`Write(//…)` y en `dontAsk` rechaza toda escritura (docs/aprendizajes.md).
    limpio = limpio.replace(/[.\s]+$/u, '')
    if (limpio === '') limpio = 'Oficina'
    let cand = path.join(base, limpio)
    for (let n = 2; fs.existsSync(cand); n++) cand = path.join(base, `${limpio} ${n}`)
    return cand
  }

  static armarDepartamento(p: DepartamentoNuevo, indice: number, usados: Set<string>): Departamento {
    const n = p.nombre.trim()
    if (n === '' || largo(n) > 60) throw new ErrorAPI(400, 'El nombre del departamento es obligatorio (hasta 60 caracteres).')
    const color = p.color ?? Oficinas.paleta[indice % Oficinas.paleta.length]!
    if (!Validar.colorHex(color)) throw new ErrorAPI(400, 'El color tiene que ser tipo #a88bdc.')
    let id: string
    if (p.id !== undefined) {
      if (!Slug.valido(p.id)) throw new ErrorAPI(400, 'Id de departamento inválido (usá minúsculas, números y guiones).')
      if (usados.has(p.id)) throw new ErrorAPI(409, 'Ya hay un departamento con ese id.')
      id = p.id
    } else {
      id = Slug.unico(n, usados, 'depto')
    }
    const mision = p.mision?.trim()
    ValidarAgenteExtra.mision(mision)
    const d: Departamento = { id, nombre: n, color: color.toLowerCase() }
    if (mision) d.mision = mision
    return d
  }

  // MARK: oficina y departamentos

  /** Lee la oficina activa, aplica `cambio` y la escribe (validada, atómica). */
  modificar<T>(cambio: (o: Oficina) => T): [T, OficinaActiva] {
    const a = this.requerirActiva()
    const o = structuredClone(a.oficina)
    const r = cambio(o)
    OficinaStore.escribir(o, a.carpeta)
    if (o.nombre !== a.oficina.nombre) this.activar(a.carpeta, o.nombre)
    return [r, new OficinaActiva(a.carpeta, o)]
  }

  /** Suma reglas de «Siempre» a un agente de la oficina activa (sin repetir). Devuelve las reglas que quedaron. */
  agregarReglas(id: string, nuevas: string[]): string[] {
    const [rs] = this.modificar((o) => {
      const ag = o.agentes.find((x) => x.id === id)
      if (!ag) throw new ErrorAPI(404, 'No existe ese agente.')
      const rs = [...(ag.reglas ?? [])]
      for (const r of nuevas) if (!rs.includes(r)) rs.push(r)
      ValidarAgenteExtra.reglas(rs)
      if (rs.length === 0) delete ag.reglas
      else ag.reglas = rs
      return rs
    })
    return rs
  }

  editar(nombre?: string, duenio?: string): OficinaActiva {
    const n = nombre === undefined ? undefined : nombre.trim()
    if (n !== undefined && (n === '' || largo(n) > 80)) throw new ErrorAPI(400, 'El nombre de la oficina es obligatorio (hasta 80 caracteres).')
    const d = duenio === undefined ? undefined : duenio.trim()
    if (d !== undefined && largo(d) > 80) throw new ErrorAPI(400, 'El nombre del dueño es demasiado largo.')
    return this.modificar((o) => {
      if (n !== undefined) o.nombre = n
      if (d !== undefined) o.duenio = d
    })[1]
  }

  crearDepartamento(p: DepartamentoNuevo): [Departamento, OficinaActiva] {
    return this.modificar((o) => {
      if (o.departamentos.length >= Oficinas.maxDepartamentos) throw new ErrorAPI(400, `Máximo ${Oficinas.maxDepartamentos} departamentos.`)
      const d = Oficinas.armarDepartamento(p, o.departamentos.length, new Set(o.departamentos.map((x) => x.id)))
      o.departamentos.push(d)
      return d
    })
  }

  editarDepartamento(id: string, cambios: { nombre?: string; color?: string; mision?: string }): [Departamento, OficinaActiva] {
    return this.modificar((o) => {
      const d = o.departamentos.find((x) => x.id === id)
      if (!d) throw new ErrorAPI(404, 'No existe ese departamento.')
      if (cambios.nombre !== undefined) {
        const n = cambios.nombre.trim()
        if (n === '' || largo(n) > 60) throw new ErrorAPI(400, 'El nombre del departamento es obligatorio (hasta 60 caracteres).')
        d.nombre = n
      }
      if (cambios.color !== undefined) {
        if (!Validar.colorHex(cambios.color)) throw new ErrorAPI(400, 'El color tiene que ser tipo #a88bdc.')
        d.color = cambios.color.toLowerCase()
      }
      if (cambios.mision !== undefined) {
        const m = cambios.mision.trim()
        ValidarAgenteExtra.mision(m)
        if (m === '') delete d.mision
        else d.mision = m
      }
      return { ...d }
    })
  }

  /** Borra el departamento. Con agentes adentro exige `moverA` (otro departamento existente). */
  borrarDepartamento(id: string, moverA?: string): OficinaActiva {
    return this.modificar((o) => {
      if (!o.departamentos.some((x) => x.id === id)) throw new ErrorAPI(404, 'No existe ese departamento.')
      if (o.departamentos.length <= 1) throw new ErrorAPI(409, 'La oficina necesita al menos un departamento.')
      const adentro = o.agentes.filter((a) => a.departamento === id)
      if (adentro.length > 0) {
        if (!moverA) throw new ErrorAPI(409, `El departamento tiene ${adentro.length} agente(s). Elegí a qué departamento moverlos (moverA).`)
        if (moverA === id || !o.departamentos.some((x) => x.id === moverA)) {
          throw new ErrorAPI(400, 'El departamento de destino (moverA) no existe o es el mismo.')
        }
        for (const a of adentro) a.departamento = moverA
      }
      o.departamentos = o.departamentos.filter((x) => x.id !== id)
    })[1]
  }
}
