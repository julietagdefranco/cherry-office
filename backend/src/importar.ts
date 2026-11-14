// Importa la oficina de Próspera HQ (5 departamentos y 8 agentes) a `~/Oficinas/Próspera HQ/` (Importar.swift y las
// rutas `importarProspera` / `reclamarSiProspera` de Router.swift). Copia, nunca mueve ni borra los datos originales.
//
//   POST /api/oficinas/importar-prospera {origen?} → oficina abierta + {yaExistia, agentesImportados, faltantes, copiados}
//
// Las rutas de origen son de macOS (`/Users/<x>/Próspera/...`) porque los textos de los agentes las traen así; las rutas
// de esta compu se arman con `path` y andan en Windows.
import fs from 'node:fs'
import path from 'node:path'
import { Config } from './config.js'
import { ErrorAPI } from './errores.js'
import { dentro, esDirectorio, realAunqueFalte } from './explorador.js'
import { objetoOpcional } from './json.js'
import type { AgenteDef, Departamento, Oficina } from './oficina.js'
import { OficinaStore, validarOficina } from './oficina.js'
import { OficinaActiva, Oficinas } from './oficinas.js'
import { completarEstructura, crearEstructura, escribirSiFalta, notasAgenteMD, partes, valorFrontmatter } from './plantillas.js'
import { no405, type RutaNucleo } from './router.js'
import { sobreOficina } from './rutas-oficinas.js'
import { registrarModulo, type Servicios } from './servicios.js'
import { Validar } from './validar.js'

export const nombreProspera = 'Próspera HQ'
export const marcaProspera = '.importada-prospera'

type AgenteBase = {
  id: string; nombre: string; rol: string; dep: string
  colorPelo: string; colorTorso: string; colorPiernas: string
  chips: string[]
}

/** Departamentos de `DEPS` en oficina/index.html (la sala de reuniones no es un departamento). */
export const departamentosProspera: Departamento[] = [
  { id: 'dir', nombre: 'Dirección', color: '#ee6da6' },
  { id: 'redes', nombre: 'Redes y estrategia digital', color: '#a88bd6' },
  { id: 'ads', nombre: 'Ads', color: '#f0a35b' },
  { id: 'clases', nombre: 'Clases de PRÓSPERAS', color: '#e6c22e' },
  { id: 'video', nombre: 'Edición de video', color: '#4aa0dc' },
]

/** Arreglo `AGENTES` de oficina/index.html (mismo orden), con los colores del minifig actual. */
export const agentesProspera: AgenteBase[] = [
  { id: 'betty', nombre: 'Betty', rol: 'PM y directora del equipo', dep: 'dir', colorPelo: '#141414', colorTorso: '#c9263a', colorPiernas: '#5a3b2b',
    chips: ['¿Qué me toca hoy?', 'Ordenemos mis pendientes', '¿Cómo viene el lanzamiento?'] },
  { id: 'don-armando', nombre: 'Don Armando', rol: 'Editor de videos de PRÓSPERAS', dep: 'video', colorPelo: '#3a2214', colorTorso: '#1d2133', colorPiernas: '#0b0c10',
    chips: ['¿Qué necesitás para editar una clase?', '¿Cómo es tu flujo de trabajo?'] },
  { id: 'mario', nombre: 'Mario', rol: 'Editor de reels', dep: 'video', colorPelo: '#141414', colorTorso: '#5d6b3a', colorPiernas: '#5d6b3a',
    chips: ['¿Qué necesitás para editar un reel?', '¿Cómo trabajás con Redes?'] },
  { id: 'marce', nombre: 'Marce', rol: 'Directora creativa de redes', dep: 'redes', colorPelo: '#0e0e12', colorTorso: '#1a1a1f', colorPiernas: '#0e0b0e',
    chips: ['¿Qué tendría que publicar esta semana?', 'Armemos la estrategia del lanzamiento'] },
  { id: 'catalina', nombre: 'Doña Catalina', rol: 'Social Media Manager', dep: 'redes', colorPelo: '#c98a30', colorTorso: '#c9a97a', colorPiernas: '#cdb08a',
    chips: ['Armame un calendario de publicaciones', '¿Qué piezas están pendientes?'] },
  { id: 'patricia', nombre: 'Patricia', rol: 'Community Manager', dep: 'redes', colorPelo: '#dcae52', colorTorso: '#f4f4f6', colorPiernas: '#efefef',
    chips: ['Redactá una respuesta para una consulta', '¿Qué preguntas se repiten?'] },
  { id: 'sofia', nombre: 'Doña Sofía', rol: 'Creadora de las clases de PRÓSPERAS', dep: 'clases', colorPelo: '#b5562a', colorTorso: '#d6342c', colorPiernas: '#1a1a1f',
    chips: ['¿Qué clases quedan por hacer?', 'Proponeme el tema de diciembre'] },
  { id: 'nicolas', nombre: 'Nicolás Mora', rol: 'Ads (Meta Ads)', dep: 'ads', colorPelo: '#2b2430', colorTorso: '#1c1c24', colorPiernas: '#6b6a42',
    chips: ['¿Cómo analizamos los anuncios del taller?', '¿Qué datos necesitás de mí?'] },
]

// «Próspera» puede venir con la ó compuesta o descompuesta (o + U+0301).
const pros = 'Pr(?:\\u00f3|o\\u0301)spera'

/** Rutas absolutas de la instalación de Juli -> rutas relativas a la oficina. */
const reemplazos: [RegExp, string][] = [
  [new RegExp(`/Users/[^/\\s\`]+/${pros}/_betty/estado-actual\\.md`, 'gu'), 'conocimiento/oficina.md'],
  [new RegExp('/Users/[^/\\s`]+/\\.claude/betty/contexto-maestro\\.md', 'gu'), 'conocimiento/contexto-maestro.md'],
  [new RegExp(`/Users/[^/\\s\`]+/${pros}/_equipo/`, 'gu'), 'conocimiento/'],
]

/** Lo que queda de `/Users/<x>/Próspera/...` (Reels, Meta ads, Guiones, intro) apunta a la carpeta real de Próspera. */
const rutaProyecto = new RegExp(`/Users/[^/\\s\`]+/${pros}(?![\\p{L}\\p{N}_.-])`, 'gu')

/** Agentes que referencian esos archivos: son los que reciben la carpeta vinculada (--add-dir). */
export const agentesProyecto = ['mario', 'don-armando', 'nicolas', 'sofia']

/** Rutas del autor -> relativas a la oficina. Con `proyecto` (carpeta real de Próspera), el resto de las rutas absolutas
 *  apunta a esa carpeta (coincide con la carpeta vinculada). */
export function adaptarRutas(texto: string, proyecto?: string): string {
  let t = texto
  const lista = [...reemplazos]
  if (proyecto !== undefined) lista.push([rutaProyecto, proyecto])
  for (const [re, nuevo] of lista) t = t.replace(re, () => nuevo)
  return t
}

export type ResultadoImportacion = {
  activa: OficinaActiva
  yaExistia: boolean
  agentes: string[]
  faltantes: string[]
  copiados: string[]
}

const esArchivo = (p: string) => { try { return fs.statSync(p).isFile() } catch { return false } }

/** Carpetas candidatas con los `<id>.md` de los agentes y raíz del repo (con `contexto/`) para el fallback. */
export function origenesProspera(config: Config, origen?: string): { agentes: string[]; repo?: string } {
  const o = origen?.trim()
  if (o) {
    const dir = Config.ruta(o, config.home)
    if (!esDirectorio(dir)) throw new ErrorAPI(404, 'No encuentro la carpeta de origen.')
    return { agentes: [path.join(dir, 'agentes'), dir], repo: fs.existsSync(path.join(dir, 'contexto')) ? dir : undefined }
  }
  const cands: string[] = []
  let repo: string | undefined
  for (const l of config.legacyDirs) {
    const base = path.dirname(l)
    cands.push(path.join(base, 'agentes'))
    if (repo === undefined && fs.existsSync(path.join(base, 'contexto'))) repo = base
  }
  cands.push(path.join(config.home, '.claude', 'agents'))
  return { agentes: cands, repo }
}

/** Crea la oficina «Próspera HQ» (idempotente: si ya existe no se toca nada) y la deja activa. */
export function importarProspera(s: Servicios, origen?: string): ResultadoImportacion {
  const { config, oficinas, log } = s
  const dir = path.join(config.oficinasDir, nombreProspera)
  if (OficinaStore.existe(dir)) {
    const o = OficinaStore.leer(dir)
    oficinas.activar(dir, o.nombre)
    return { activa: new OficinaActiva(dir, o), yaExistia: true, agentes: o.agentes.map((a) => a.id), faltantes: [], copiados: [] }
  }
  const { agentes: dirsAgentes, repo } = origenesProspera(config, origen)

  // agentes: el primer origen que tenga <id>.md
  const textos = new Map<string, string>()
  const faltantes: string[] = []
  for (const a of agentesProspera) {
    let hallado: string | undefined
    for (const d of dirsAgentes) {
      try {
        hallado = fs.readFileSync(path.join(d, `${a.id}.md`), 'utf8')
        break
      } catch {}
    }
    if (hallado !== undefined) textos.set(a.id, hallado)
    else faltantes.push(a.id)
  }
  if (textos.size === 0) throw new ErrorAPI(404, 'No encontré los agentes de Próspera (agentes/*.md). Indicá la carpeta con «origen».')

  // conocimiento que se copia (nunca se mueve)
  completarEstructura(dir)
  const copiados: string[] = []
  const copiar = (origenArchivo: string, rel: string) => {
    const destino = path.join(dir, ...rel.split('/'))
    if (!fs.existsSync(origenArchivo) || fs.existsSync(destino)) return
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true })
      fs.cpSync(origenArchivo, destino)
      copiados.push(rel)
    } catch {}
  }
  const proyecto = config.proyecto
  copiar(path.join(proyecto, '_betty', 'estado-actual.md'), 'conocimiento/oficina.md')
  copiar(path.join(config.home, '.claude', 'betty', 'contexto-maestro.md'), 'conocimiento/contexto-maestro.md')
  if (repo) copiar(path.join(repo, 'contexto', 'contexto-maestro.md'), 'conocimiento/contexto-maestro.md')
  const equipo = path.join(proyecto, '_equipo')
  let hijos: string[] = []
  try {
    hijos = fs.readdirSync(equipo, { recursive: true }).map((r) => String(r).split(path.sep).join('/')).sort()
  } catch {}
  for (const rel of hijos) {
    if (rel.split('/').some((x) => x.startsWith('.')) || rel.endsWith('PLANTILLA.md')) continue
    const src = path.join(equipo, ...rel.split('/'))
    if (esArchivo(src)) copiar(src, `conocimiento/${rel}`)
  }
  if (repo) copiar(path.join(repo, 'contexto', 'equipo', 'decisiones.md'), 'conocimiento/decisiones.md')

  // agentes: .md con rutas adaptadas + definición
  const defs: AgenteDef[] = []
  const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  // La carpeta de Próspera se vincula solo si existe y no es la carpeta personal entera ni algo de la oficina.
  const proyectoAbs = proyecto === '' ? '' : path.resolve(proyecto)
  const realProyecto = realAunqueFalte(proyectoAbs)
  const realHome = realAunqueFalte(config.home)
  const realOficina = realAunqueFalte(dir)
  const proyectoOk = proyecto !== '' && esDirectorio(proyectoAbs) && realProyecto !== realHome
    && realProyecto !== path.parse(realProyecto).root && !(dentro(realOficina, realProyecto))
  const vinculados = proyectoOk ? agentesProyecto.filter((id) => textos.has(id)) : []
  for (const a of agentesProspera) {
    const t = textos.get(a.id)
    if (t === undefined) continue
    const adaptado = adaptarRutas(t, vinculados.includes(a.id) ? proyectoAbs : undefined)
    try {
      fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.claude', 'agents', `${a.id}.md`), adaptado)
    } catch {
      throw new ErrorAPI(500, `No pude escribir el agente ${a.id}.`)
    }
    const modelo = valorFrontmatter(partes(adaptado).frontmatter, 'model')
    defs.push({
      id: a.id, nombre: a.nombre, rol: a.rol, departamento: a.dep,
      modelo: modelo !== undefined && Validar.modelos.has(modelo) ? modelo : 'sonnet',
      chips: a.chips,
      avatar: { semilla: a.id, colorPelo: a.colorPelo, colorTorso: a.colorTorso, colorPiernas: a.colorPiernas },
      creado: ahora,
      ...(a.id === 'betty' ? { escritura: ['conocimiento/oficina.md', 'conocimiento/decisiones.md'] } : {}),
    })
  }
  const of: Oficina = {
    version: 1, nombre: nombreProspera, duenio: 'Juli', departamentos: departamentosProspera.map((d) => ({ ...d })), agentes: defs,
    ...(vinculados.length > 0 ? { vinculos: [{ id: 'prospera', ruta: proyectoAbs, alcance: { agentes: vinculados } }] } : {}),
  }
  validarOficina(of)
  crearEstructura(dir, of)
  for (const d of defs) {
    try { escribirSiFalta(dir, `conocimiento/agentes/${d.id}.md`, notasAgenteMD(d.nombre, d.rol)) } catch {}
  }
  try { fs.writeFileSync(path.join(dir, marcaProspera), '{}\n') } catch {}
  OficinaStore.escribir(of, dir)
  oficinas.activar(dir, of.nombre)
  log.info(`Próspera HQ importada agentes=${defs.length} copiados=${copiados.length}`)
  return { activa: new OficinaActiva(dir, of), yaExistia: false, agentes: defs.map((d) => d.id), faltantes, copiados }
}

/** Los chats anteriores a las oficinas pasan a la oficina importada de Próspera. */
export function reclamarSiProspera(s: Servicios, carpeta: string) {
  if (!fs.existsSync(path.join(carpeta, marcaProspera))) return
  try {
    const n = s.store.reclamarLegacy(carpeta)
    if (n > 0) s.log.info(`chats anteriores asignados a la oficina importada: ${n}`)
  } catch {}
}

function rutaImportar(s: Servicios): RutaNucleo {
  return async ({ method, partes: p, body }) => {
    if (p.length !== 3 || p[1] !== 'oficinas' || p[2] !== 'importar-prospera') return null
    if (method !== 'POST') return no405
    const d = objetoOpcional(body)
    const r = importarProspera(s, Validar.texto(d.origen, 'origen', 1024, false))
    // reclamar los chats viejos y volver a escanear los vínculos, igual que al abrir una oficina
    for (const f of s.alAbrir) {
      try { await f(r.activa) } catch {}
    }
    return [200, { ...sobreOficina(r.activa), yaExistia: r.yaExistia, agentesImportados: r.agentes, faltantes: r.faltantes, copiados: r.copiados }]
  }
}

registrarModulo('importar', 90, (s) => {
  s.alAbrir.push(async (a) => reclamarSiProspera(s, a.carpeta))
  s.router.nucleo.push(rutaImportar(s))
})
