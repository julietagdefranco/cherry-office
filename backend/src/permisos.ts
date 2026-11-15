// Permisos por agente y construcción del comando exacto de `claude` (Permisos.swift), más las piezas que usa:
// instrucciones (Instrucciones.swift), herramientas de conectores (ConectoresAgente), herramientas MCP propias
// (HerramientasMCPAgente) y el perfil de coordinador.
import fs from 'node:fs'
import path from 'node:path'
import { ClaudeRunner, type TurnoConPermiso } from './claude-runner.js'
import { Config } from './config.js'
import { jsonCompacto } from './json-swift.js'
import type { AgenteDef, AlcanceVinculo, Oficina } from './oficina.js'
import type { OficinaActiva } from './oficinas.js'
import { Validar, largo, prefijo } from './validar.js'

/** Carpeta de trabajo (cwd) y permisos de un agente dentro de su oficina (ContextoOficina de Swift). */
export type ContextoOficina = {
  carpeta: string
  escritura: string[]
  dirsExtra: string[]
  /** URL del servidor MCP de la oficina; undefined = el chat corre sin consultas a colegas. */
  mcpUrl?: string
  /** Texto para `--append-system-prompt`. */
  instrucciones?: string
  /** Herramientas MCP propias del agente; undefined equivale a `herramientasMCP`. */
  herramientasMCP?: string[]
  /** Herramientas base; undefined equivale a las de la config. */
  herramientasBase?: string
  /** Herramientas de conectores permitidas (`--allowedTools`). */
  permitidas: string[]
  /** Herramientas vedadas (`--disallowedTools`). */
  vedadas: string[]
  /** Perfil del token del servidor MCP: agente | coordinador | creador. */
  perfilMCP: string
  /** Reglas guardadas del agente (`AgenteDef.reglas`): van a `--allowedTools` en todas sus corridas. */
  reglas?: string[]
  /** Chat con la persona presente: lo no permitido se le pregunta (`--permission-prompt-tool`) en vez de rechazarse. */
  preguntar?: boolean
  /** Corrida sin la persona (tareas): Bash, Edit y Write visibles pero en `dontAsk`; lo no permitido se rechaza, queda en
   *  `permission_denials` y se guarda como pedido pendiente (permisos-tareas.ts). */
  anotarRechazos?: boolean
}

/** Un servidor MCP de la cuenta (catálogo de conectores de claude.ai). */
export type ServidorConector = { nombre: string; prefijo: string; estado: string; herramientas: string[] }

/** Herramientas MCP del servidor propio (`hq`): consultar a un colega y ver quiénes son. */
export const herramientasMCP = ['mcp__hq__consultar', 'mcp__hq__colegas']
/** Variable de entorno con el token del servidor MCP (así no aparece en los argumentos del proceso). */
export const variableTokenMCP = 'HQ_MCP_TOKEN'
/** Lo que un agente puede pedir en un chat (además de lo que ya tiene): comandos y escribir archivos. */
export const herramientasPreguntables = ['Bash', 'Edit', 'Write']
/** Herramienta de `hq` que contesta los pedidos de permiso (`--permission-prompt-tool`). */
export const herramientaPermiso = 'mcp__hq__pedir_permiso'

export const esCoordinador = (a: AgenteDef) => a.permisos?.includes('coordinador') ?? false

export const Coordinador = {
  nombresMCP: ['estado_oficina', 'entregas', 'corridas', 'bloqueos', 'encargar'],
  perfil: (_o: Oficina, a: AgenteDef) => (esCoordinador(a) ? 'coordinador' : 'agente'),
  herramientasMCP: (_o: Oficina, a: AgenteDef) => (esCoordinador(a) ? Coordinador.nombresMCP.map((n) => 'mcp__hq__' + n) : []),
}

export const Acciones = {
  herramientaPropuesta: 'mcp__hq__proponer_accion',
  /** Herramientas de actuar que el agente tiene asignadas (nombres completos). */
  actuar(a: AgenteDef): string[] {
    const out: string[] = []
    for (const h of (a.conectores ?? []).flatMap((c) => c.actuar)) if (!out.includes(h)) out.push(h)
    return out
  },
  herramientasMCP: (_o: Oficina, a: AgenteDef) => (Acciones.actuar(a).length === 0 ? [] : [Acciones.herramientaPropuesta]),
}

export const HerramientasMCPAgente = {
  lista(o: Oficina, a: AgenteDef): string[] {
    const out: string[] = []
    for (const h of [...herramientasMCP, ...Coordinador.herramientasMCP(o, a), ...Acciones.herramientasMCP(o, a)]) if (!out.includes(h)) out.push(h)
    return out
  },
}

/** Nombre corto de una herramienta MCP (lo que sigue al último `__`). */
export function cortoHerramienta(nombre: string): string {
  const i = nombre.lastIndexOf('__')
  return i < 0 ? nombre : nombre.slice(i + 2)
}

export const ConectoresAgente = {
  /** Herramientas permitidas (leer + las de actuar aprobadas en esta corrida) y vedadas (el resto del catálogo). */
  herramientas(_o: Oficina, a: AgenteDef, catalogo: ServidorConector[] | undefined, actuar: string[]): { permitidas: string[]; vedadas: string[] } {
    const asignados = a.conectores ?? []
    const actuarAsignadas = new Set(asignados.flatMap((c) => c.actuar))
    const permitidas: string[] = []
    for (const h of [...asignados.flatMap((c) => c.leer), ...actuar.filter((x) => actuarAsignadas.has(x))]) if (!permitidas.includes(h)) permitidas.push(h)
    if (permitidas.length === 0) return { permitidas: [], vedadas: ['mcp__claude_ai_*'] }
    if (!catalogo) return { permitidas, vedadas: [] }
    const normalizar = (s: string) => { let t = s.trim().toLowerCase(); if (t.startsWith('claude.ai ')) t = t.slice('claude.ai '.length); return t }
    const nombres = new Set(asignados.map((c) => normalizar(c.servidor)))
    const vedadas: string[] = []
    for (const srv of catalogo) {
      const asignado = nombres.has(normalizar(srv.nombre)) || permitidas.some((p) => p.startsWith(srv.prefijo + '__'))
      if (!asignado) vedadas.push(srv.prefijo)
      else for (const h of srv.herramientas) if (!permitidas.includes(h)) vedadas.push(h)
    }
    return { permitidas, vedadas }
  },
}

/** Instrucciones inyectadas con `--append-system-prompt`: reglas, límites, conectores y rol de coordinador. */
export const Instrucciones = {
  maxCaracteres: 8000,
  para(o: Oficina, a: AgenteDef): string | undefined {
    const d = o.duenio.trim()
    const jefe = d === '' ? 'la persona' : d
    const secciones: string[] = []
    const limpio = (s: string) => s.trim()

    const reglas = (o.reglas ?? []).map((r) => limpio(typeof (r as { texto?: unknown }).texto === 'string' ? (r as { texto: string }).texto : '')).filter((x) => x !== '')
    if (reglas.length > 0) secciones.push('## Reglas de la oficina\n' + reglas.map((r) => '- ' + r).join('\n'))

    const solo = (a.limites?.solo ?? []).map(limpio).filter((x) => x !== '')
    const proponer = (a.limites?.proponer ?? []).map(limpio).filter((x) => x !== '')
    const conectores = a.conectores ?? []
    const actuaConectores = conectores.some((c) => c.actuar.length > 0)
    if (solo.length > 0 || proponer.length > 0 || actuaConectores || reglas.length > 0) {
      const l = ['## Tus límites']
      if (solo.length > 0) l.push('Hacés solo: ' + solo.join('; ') + '.')
      if (proponer.length > 0) l.push(`Dejás como propuesta y esperás la aprobación de ${jefe}: ` + proponer.join('; ') + '.')
      l.push('Nunca hacés directo nada que salga de la oficina (mandar un mail, crear un evento, publicar, gastar): lo dejás como propuesta.')
      secciones.push(l.join('\n'))
    }

    const c: string[] = []
    const leen = conectores.filter((x) => x.leer.length > 0)
    if (leen.length > 0) c.push('Podés leer con: ' + leen.map((x) => `${x.servidor} (${x.leer.map(cortoHerramienta).join(', ')})`).join('; ') + '.')
    const actuan = conectores.filter((x) => x.actuar.length > 0)
    if (actuan.length > 0) {
      c.push('Para actuar con ' + actuan.map((x) => `${x.servidor} (${x.actuar.map(cortoHerramienta).join(', ')})`).join('; ')
        + ` usá la herramienta proponer_accion: ${jefe} la aprueba y recién ahí se ejecuta.`)
    }
    if (c.length > 0) secciones.push('## Conectores\n' + c.join('\n'))

    if (esCoordinador(a)) {
      secciones.push('## Sos coordinador/a de la oficina\n'
        + 'Ves entregas, flujos y bloqueos de todos (herramientas estado_oficina, entregas, corridas, bloqueos) y podés repartir encargos (encargar). No hacés el trabajo de otros: lo pedís.')
    }
    if (secciones.length === 0) return undefined
    const texto = secciones.join('\n\n')
    return largo(texto) > this.maxCaracteres ? prefijo(texto, this.maxCaracteres) : texto
  },
}

/** Catálogo de conectores de la cuenta (lo detecta el módulo de gobierno; hasta portarlo, ninguno). */
export type FuenteCatalogo = () => ServidorConector[] | undefined

// MARK: - modo sin oficina (legado de Próspera)

/** Rutas absolutas donde `agente` puede escribir (comodín "*" + las propias), `{id}` expandido. */
export function rutasEscritura(cfg: Config, agente: string): string[] {
  const out: string[] = []
  for (const r of [...(cfg.escritura['*'] ?? []), ...(cfg.escritura[agente] ?? [])]) {
    const r2 = r.replaceAll('{id}', agente)
    const abs = path.isAbsolute(r2) || r2 === '~' || r2.startsWith('~/')
    const p = Config.ruta(abs ? r2 : path.join(cfg.proyecto, r2), cfg.home)
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/** `Edit(//abs/path)`: la doble barra marca una ruta absoluta para Claude Code. En Windows la ruta va con `/`
 *  (`Edit(//C:/Users/…)`): cómo la interpreta Claude Code queda para el spike de Windows (plan, riesgo 2). */
export function regla(herramienta: string, ruta: string): string {
  return `${herramienta}(//${ruta.replace(/\\/g, '/').replace(/^\/+/, '')})`
}

/** `--mcp-config` (JSON inline) del servidor `hq`: `Authorization: Bearer ${HQ_MCP_TOKEN}`, que claude expande. */
export function configMCP(url: string): string {
  return jsonCompacto({ mcpServers: { hq: { type: 'http', url, headers: { Authorization: `Bearer \${${variableTokenMCP}}` } } } })
}

// MARK: - oficinas

/** Dónde corre un agente de oficina y qué puede escribir (rutas absolutas). */
export function contexto(a: OficinaActiva, agente: AgenteDef, { dirsExtra = [], actuar = [], catalogo }: { dirsExtra?: string[]; actuar?: string[]; catalogo?: ServidorConector[] } = {}): ContextoOficina {
  const rutas = [a.ruta(`conocimiento/agentes/${agente.id}.md`)]
  for (const r of agente.escritura ?? []) if (Validar.rutaEscrituraValida(r)) rutas.push(a.ruta(r))
  const e = entregables(a, agente.id)
  if (e) rutas.push(e)
  const { permitidas, vedadas } = ConectoresAgente.herramientas(a.oficina, agente, catalogo, actuar)
  return {
    carpeta: a.carpeta, escritura: rutas, dirsExtra: [...dirsExtra, ...dirsVinculos(a.oficina, agente)],
    instrucciones: Instrucciones.para(a.oficina, agente), permitidas, vedadas,
    herramientasMCP: HerramientasMCPAgente.lista(a.oficina, agente), perfilMCP: Coordinador.perfil(a.oficina, agente),
    reglas: agente.reglas ?? [], preguntar: false,
  }
}

/** Patrón de escritura de `archivos/entregables/<id>/` (crea la carpeta del agente). undefined si la oficina no tiene
 *  la estructura de biblioteca. */
export function entregables(a: OficinaActiva, id: string): string | undefined {
  try {
    if (!fs.statSync(a.ruta('archivos/entregables')).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const d = a.ruta(`archivos/entregables/${id}`)
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {}
  return d + '/**'
}

export function alcanceIncluye(al: AlcanceVinculo, a: AgenteDef): boolean {
  if (al === 'oficina') return true
  if ('departamentos' in al) return al.departamentos.includes(a.departamento)
  return al.agentes.includes(a.id)
}

/** Carpetas vinculadas a las que `agente` tiene acceso, para `--add-dir`. Solo las que existen. */
export function dirsVinculos(o: Oficina, agente: AgenteDef): string[] {
  const out: string[] = []
  for (const v of o.vinculos ?? []) {
    if (!alcanceIncluye(v.alcance, agente)) continue
    let dir = false
    try {
      dir = fs.statSync(v.ruta).isDirectory()
    } catch {}
    if (dir && !out.includes(v.ruta)) out.push(v.ruta)
  }
  return out
}

/** Herramientas base: las del contexto, o las del agente en la config, o las generales. */
function baseOficina(cfg: Config, ctx: ContextoOficina, agente: string): string {
  if (ctx.herramientasBase) return ctx.herramientasBase
  return cfg.herramientasAgente[agente] || cfg.herramientas
}

/** Pide permiso en vivo solo un chat con la persona presente y con el servidor MCP andando. */
export const puedePreguntar = (ctx: ContextoOficina) => (ctx.preguntar ?? false) && ctx.mcpUrl !== undefined

/** `--tools` de un agente de oficina: base + Edit,Write (si tiene alguna ruta) + las de sus reglas guardadas (Bash...)
 *  + Bash,Edit,Write si puede pedir permiso (o anota rechazos) + las MCP si hay servidor. */
export function herramientasOficina(cfg: Config, ctx: ContextoOficina, agente: string): string {
  let h = baseOficina(cfg, ctx, agente)
  const lista = h.split(',').map((x) => x.trim())
  const sumar = (n: string) => { if (!lista.includes(n)) { lista.push(n); h += ',' + n } }
  if (ctx.escritura.length > 0) { h += ',Edit,Write'; lista.push('Edit', 'Write') }
  for (const r of ctx.reglas ?? []) { const i = r.indexOf('('); if (i >= 0) sumar(r.slice(0, i)) }
  if (puedePreguntar(ctx) || ctx.anotarRechazos) for (const n of herramientasPreguntables) sumar(n)
  if (ctx.mcpUrl !== undefined) h += ',' + (ctx.herramientasMCP ?? herramientasMCP).join(',')
  return h
}

/** Argumentos (sin el binario) de un chat de oficina. Orden fijo; `--` antes del mensaje. */
export function argumentos(cfg: Config, ctx: ContextoOficina, p: { agente: string; mensaje: string; sid: string; flag: string }): string[] {
  const a = ['-p', '--agent', p.agente, p.flag, p.sid, ...ClaudeRunner.formatoSalida]
  a.push('--tools', herramientasOficina(cfg, ctx, p.agente))
  // con la persona presente: modo normal + la herramienta que le pregunta; si no, se rechaza solo lo no permitido
  if (puedePreguntar(ctx)) a.push('--permission-mode', 'default', '--permission-prompt-tool', herramientaPermiso)
  else a.push('--permission-mode', 'dontAsk')
  if (ctx.mcpUrl !== undefined) a.push('--mcp-config', configMCP(ctx.mcpUrl))
  for (const d of ctx.dirsExtra) a.push('--add-dir', d)
  a.push('--allowedTools')
  for (const h of baseOficina(cfg, ctx, p.agente).split(',').map((x) => x.trim())) if (h !== '') a.push(h)
  for (const r of ctx.escritura) for (const h of ['Edit', 'Write']) a.push(regla(h, r))
  a.push(...(ctx.reglas ?? []))
  if (ctx.mcpUrl !== undefined) a.push(...(ctx.herramientasMCP ?? herramientasMCP))
  if (puedePreguntar(ctx)) a.push(herramientaPermiso)
  a.push(...ctx.permitidas)
  if (ctx.vedadas.length > 0) a.push('--disallowedTools', ...ctx.vedadas)
  if (ctx.instrucciones) a.push('--append-system-prompt', ctx.instrucciones)
  return [...a, '--', p.mensaje]
}

/** Milisegundos que claude espera una herramienta MCP cuando pide permiso en vivo: por defecto corta a los 60 s
 * («The operation timed out»), y la persona puede tardar más (docs/aprendizajes.md). 15 min, más que cualquier turno. */
export const esperaHerramientaMCP = '900000'

/** Variables extra del hijo: con conectores de claude.ai asignados hay que esperar a que se conecten; si pide permiso
 * en vivo, claude tiene que esperar a la persona más de 60 s. */
export function entorno(ctx: ContextoOficina): Record<string, string> {
  const e: Record<string, string> = {}
  if (ctx.permitidas.some((p) => p.startsWith('mcp__claude_ai_'))) e.MCP_CONNECTION_NONBLOCKING = 'false'
  if (puedePreguntar(ctx)) e.MCP_TOOL_TIMEOUT = esperaHerramientaMCP
  return e
}

/** Permiso en vivo para un turno de reunión (`turnoSoloLectura`): las herramientas de las reglas guardadas del agente +
 *  las que puede pedir (Bash, Edit, Write), sus reglas en `--allowedTools`, y el servidor MCP con el token interactivo. */
export function turnoConPermiso(p: { mcpUrl: string; token: string; reglas?: string[] }): TurnoConPermiso {
  const herramientas: string[] = []
  const sumar = (n: string) => { if (n !== '' && !herramientas.includes(n)) herramientas.push(n) }
  for (const r of p.reglas ?? []) { const i = r.indexOf('('); if (i > 0) sumar(r.slice(0, i)) }
  for (const n of herramientasPreguntables) sumar(n)
  return {
    herramientas, permitidas: [...(p.reglas ?? [])], herramientaPermiso, mcpConfig: configMCP(p.mcpUrl),
    env: { [variableTokenMCP]: p.token, MCP_TOOL_TIMEOUT: esperaHerramientaMCP },
  }
}
