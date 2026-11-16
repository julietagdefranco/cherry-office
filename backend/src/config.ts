// Configuración del backend (Config.swift): defaults del contrato, config.json opcional y variables de entorno.
// Las claves del JSON son las de `oficina/config.ejemplo.json` más `legacy_dirs`, `oficinas_dir` y `oficina_dirs_extra`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { esObjeto } from './json.js'
import { Validar, esIdValido } from './validar.js'

export const agentesPorDefecto = ['betty', 'don-armando', 'marce', 'catalina', 'patricia', 'sofia', 'mario', 'nicolas']
export const herramientasBase = 'Read,Glob,Grep,Skill,WebFetch,WebSearch'
export const escrituraPorDefecto: Record<string, string[]> = {
  '*': ['_equipo/agentes/{id}.md'],
  betty: ['_betty/estado-actual.md', '_equipo/decisiones.md'],
}

/** Carpeta de datos por defecto de la app según el sistema. */
export function datosDirPorDefecto(home: string, plataforma: NodeJS.Platform = process.platform): string {
  if (plataforma === 'darwin') return path.join(home, 'Library/Application Support/Próspera HQ')
  if (plataforma === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Próspera HQ')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'Próspera HQ')
}

export type ModoPermisos = 'auto' | 'preguntar'
export const esModoPermisos = (v: unknown): v is ModoPermisos => v === 'auto' || v === 'preguntar'
export type ConectoresAgentes = 'todos' | 'por_agente'
export const esConectoresAgentes = (v: unknown): v is ConectoresAgentes => v === 'todos' || v === 'por_agente'

/** Modelos de los procesos que no son un agente de la oficina (clave `modelos` de config.json, toda la app).
 *  `creador`: el Creador de la recepción; `internos`: borradores de agente, fichas e imágenes de la biblioteca y síntesis
 *  de reuniones; `resumenes`: el cartel corto de lo que está haciendo un agente. `inherit` = el de Claude Code. */
export type ClaveModelo = 'creador' | 'internos' | 'resumenes'
export const modelosPorDefecto: Record<ClaveModelo, string> = { creador: 'sonnet', internos: 'sonnet', resumenes: 'haiku' }
export const clavesModelo = Object.keys(modelosPorDefecto) as ClaveModelo[]
export const modelosValidos = Validar.modelos

export class Config {
  proyecto: string
  dirsExtra: string[]
  agentes: string[]
  herramientas: string
  herramientasAgente: Record<string, string>
  escritura: Record<string, string[]>
  /** Segundos. */
  timeout: number
  /** Binario de claude forzado (config/tests). CLAUDE_BIN del entorno tiene prioridad en el locator. */
  claudeBin?: string
  /** Carpeta de datos (hq.db, hq.log, config.json). */
  datosDir: string
  /** Carpetas candidatas con datos del server Python (`.sesiones.json`, `.datos/hq.db`). */
  legacyDirs: string[]
  home: string
  version: string
  /** Carpeta donde se crean las oficinas nuevas (default ~/Oficinas). */
  oficinasDir: string
  /** `--add-dir` extra para los agentes de una oficina (clave `oficina_dirs_extra`). */
  oficinaDirsExtra: string[]
  /** Cómo piden permiso los agentes (clave `modo_permisos`, toda la app): `auto` = un clasificador de Claude Code decide
   *  y solo se pregunta lo dudoso; `preguntar` = lo que no está permitido se pregunta o se rechaza. undefined = la
   *  persona todavía no eligió (la app muestra el aviso al abrir) y se comporta como `preguntar`. */
  modoPermisos?: ModoPermisos
  /** Qué conectores de claude.ai usan los agentes (clave `conectores_agentes`, toda la app): `todos` = cada agente lee con
   *  todos los conectores conectados y lo que actúa (enviar, publicar...) se pide como cualquier permiso; `por_agente` = solo
   *  los asignados a cada agente (Ajustes › Conectores). undefined se comporta como `por_agente`. */
  conectoresAgentes?: ConectoresAgentes
  /** Solo lo que la persona cambió; lo demás sale de `modelosPorDefecto` (ver `modelo()`). */
  modelos: Partial<Record<ClaveModelo, string>> = {}

  /** Modelo elegido para `clave`, o el de por defecto. */
  modelo(clave: ClaveModelo): string { return this.modelos[clave] ?? modelosPorDefecto[clave] }
  /** Todos los modelos, con los de por defecto completados. */
  get modelosEfectivos(): Record<ClaveModelo, string> {
    return Object.fromEntries(clavesModelo.map((k) => [k, this.modelo(k)])) as Record<ClaveModelo, string>
  }

  constructor(home: string = os.homedir()) {
    this.home = home
    this.proyecto = Config.ruta('~/Próspera', home)
    this.dirsExtra = [Config.ruta('~/.claude/betty', home)]
    this.agentes = [...agentesPorDefecto]
    this.herramientas = herramientasBase
    this.herramientasAgente = {}
    this.escritura = structuredClone(escrituraPorDefecto)
    this.timeout = 600
    this.datosDir = datosDirPorDefecto(home)
    this.legacyDirs = [path.join(home, 'Próspera HQ', 'oficina')]
    this.version = '1.0.0'
    this.oficinasDir = Config.ruta('~/Oficinas', home)
    this.oficinaDirsExtra = []
  }

  /** Defaults + config.json + variables de entorno (HQ_PROYECTO, HQ_DIR_EXTRA, HQ_AGENTES, HQ_TIMEOUT, HQ_DATA_DIR,
   *  HQ_LEGACY_DIR, HQ_CONFIG, HQ_OFICINAS_DIR). */
  static load(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Config {
    const c = new Config(home)
    const no = (v: string | undefined): v is string => v !== undefined && v !== ''
    if (no(env.HQ_DATA_DIR)) c.datosDir = Config.ruta(env.HQ_DATA_DIR, home)
    const archivo = no(env.HQ_CONFIG) ? Config.ruta(env.HQ_CONFIG, home) : path.join(c.datosDir, 'config.json')
    try {
      c.aplicar(fs.readFileSync(archivo, 'utf8'), home)
    } catch {}
    if (no(env.HQ_PROYECTO)) c.proyecto = Config.ruta(env.HQ_PROYECTO, home)
    if (env.HQ_DIR_EXTRA !== undefined) {
      c.dirsExtra = env.HQ_DIR_EXTRA.split(path.delimiter).filter((s) => s !== '').map((s) => Config.ruta(s, home))
    }
    const ag = env.HQ_AGENTES?.trim()
    if (ag) {
      c.agentes = ag === 'auto' ? Config.descubrirAgentes(home) : ag.split(',').map((s) => s.trim()).filter((s) => s !== '')
    }
    if (no(env.HQ_OFICINAS_DIR)) c.oficinasDir = Config.ruta(env.HQ_OFICINAS_DIR, home)
    const t = Number(env.HQ_TIMEOUT)
    if (env.HQ_TIMEOUT && Number.isFinite(t) && t > 0) c.timeout = t
    if (no(env.HQ_DATA_DIR)) c.datosDir = Config.ruta(env.HQ_DATA_DIR, home)
    if (no(env.HQ_LEGACY_DIR)) c.legacyDirs.unshift(Config.ruta(env.HQ_LEGACY_DIR, home))
    c.agentes = c.agentes.filter(esIdValido)
    return c
  }

  /** Pisa campos con un JSON (tolerante: claves desconocidas, `_comentarios` y null se ignoran). */
  aplicar(texto: string, home: string) {
    let o: unknown
    try {
      o = JSON.parse(texto)
    } catch {
      return
    }
    if (!esObjeto(o)) return
    const s = (v: unknown): v is string => typeof v === 'string' && v !== ''
    const lista = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
    if (s(o.proyecto)) this.proyecto = Config.ruta(o.proyecto, home)
    if (typeof o.dirs_extra === 'string') this.dirsExtra = [Config.ruta(o.dirs_extra, home)]
    else if (lista(o.dirs_extra)) this.dirsExtra = o.dirs_extra.map((d) => Config.ruta(d, home))
    if (o.agentes === 'auto') this.agentes = Config.descubrirAgentes(home)
    else if (lista(o.agentes)) this.agentes = o.agentes.filter(esIdValido)
    if (s(o.herramientas)) this.herramientas = o.herramientas
    if (esObjeto(o.herramientas_agente) && Object.values(o.herramientas_agente).every((v) => typeof v === 'string')) {
      this.herramientasAgente = o.herramientas_agente as Record<string, string>
    }
    if (esObjeto(o.escritura) && Object.values(o.escritura).every(lista)) this.escritura = o.escritura as Record<string, string[]>
    const t = typeof o.timeout === 'number' ? o.timeout : typeof o.timeout === 'string' ? Number(o.timeout) : NaN
    if (Number.isFinite(t) && t > 0) this.timeout = t
    if (s(o.claude_bin)) this.claudeBin = Config.ruta(o.claude_bin, home)
    if (s(o.datos_dir)) this.datosDir = Config.ruta(o.datos_dir, home)
    if (s(o.oficinas_dir)) this.oficinasDir = Config.ruta(o.oficinas_dir, home)
    if (lista(o.oficina_dirs_extra)) this.oficinaDirsExtra = o.oficina_dirs_extra.map((d) => Config.ruta(d, home))
    if (esModoPermisos(o.modo_permisos)) this.modoPermisos = o.modo_permisos
    if (esConectoresAgentes(o.conectores_agentes)) this.conectoresAgentes = o.conectores_agentes
    if (esObjeto(o.modelos)) {
      for (const k of clavesModelo) {
        const v = o.modelos[k]
        if (typeof v === 'string' && modelosValidos.has(v)) this.modelos[k] = v
      }
    }
    if (lista(o.legacy_dirs)) this.legacyDirs = [...o.legacy_dirs.map((d) => Config.ruta(d, home)), ...this.legacyDirs]
  }

  /** `~` y `~/…` relativos al home; relativas a la carpeta actual; normalizada (sin `.` ni `..`). */
  static ruta(p: string, home: string): string {
    let s = p
    if (s === '~') s = home
    else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(home, s.slice(2))
    return path.resolve(s)
  }

  /** Ids de ~/.claude/agents/*.md (modo "auto"). */
  static descubrirAgentes(home: string): string[] {
    let archivos: string[] = []
    try {
      archivos = fs.readdirSync(path.join(home, '.claude', 'agents'))
    } catch {}
    return archivos.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort().filter(esIdValido)
  }
}
