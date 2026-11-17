// Qué skills, servidores MCP de Claude Code y conectores de claude.ai puede usar cada agente, en dos niveles:
// - la oficina habilita (`oficina.ia`): lo que no está ahí no lo usa ningún agente de esa oficina;
// - cada agente elige un subconjunto (`skills`, `mcp`, `conectores` de su ficha) o hereda lo de la oficina.
// En cada nivel: undefined = todo lo del nivel de arriba; [] = nada. Lo que vale en una corrida es lo del agente que
// además esté habilitado en la oficina (si la oficina saca algo, ningún agente lo usa aunque lo tenga elegido).
import { ErrorAPI } from './errores.js'
import type { AgenteDef, Oficina } from './oficina.js'

/** Lo habilitado en una oficina. Cada lista ausente = todo. `conectores` son nombres de servidores de claude.ai. */
export type IAOficina = { skills?: string[]; mcp?: string[]; conectores?: string[] }

/** Un servidor MCP del Claude Code de la persona (no de claude.ai ni el de la oficina). */
export type ServidorMCPLocal = { nombre: string; prefijo: string }

/** Nombre de un servidor sin el «claude.ai » del principio, en minúsculas: para comparar conectores. */
export function normalizarServidor(s: string): string {
  let t = s.trim().toLowerCase()
  if (t.startsWith('claude.ai ')) t = t.slice('claude.ai '.length).trim()
  return t
}

/** Prefijo de las herramientas de un servidor MCP: `mcp__` + el nombre con lo que no sea letra, número, `_` o `-`
 *  cambiado por `_` (`plugin:x:y` → `mcp__plugin_x_y`). Como regla de permisos, el prefijo solo veda todo el servidor. */
export function prefijoMCP(nombre: string): string {
  return 'mcp__' + nombre.replace(/[^A-Za-z0-9_-]/g, '_')
}

export const Habilitados = {
  maxNombres: 200,
  maxLargo: 200,

  /** Lista efectiva: la del agente (o la de la oficina si hereda) recortada a la de la oficina. undefined = todo. */
  combinar(oficina: string[] | undefined, agente: string[] | undefined, normalizar: (s: string) => string = (s) => s): string[] | undefined {
    if (agente === undefined) return oficina ? [...oficina] : undefined
    if (!oficina) return [...agente]
    const ok = new Set(oficina.map(normalizar))
    return agente.filter((x) => ok.has(normalizar(x)))
  },

  /** Skills que puede usar el agente. undefined = todas. */
  skills(o: Oficina, a: AgenteDef): string[] | undefined { return Habilitados.combinar(o.ia?.skills, a.skills) },

  /** Servidores MCP de Claude Code que puede usar el agente. undefined = todos. */
  mcp(o: Oficina, a: AgenteDef): string[] | undefined { return Habilitados.combinar(o.ia?.mcp, a.mcp) },

  /** ¿La oficina habilita este conector de claude.ai? */
  conectorHabilitado(o: Oficina, servidor: string): boolean {
    const l = o.ia?.conectores
    return !l || l.some((x) => normalizarServidor(x) === normalizarServidor(servidor))
  },

  /** El agente con solo los conectores que la oficina habilita. */
  conectoresAgente(o: Oficina, a: AgenteDef): AgenteDef {
    if (!o.ia?.conectores || !a.conectores) return a
    const conectores = a.conectores.filter((c) => Habilitados.conectorHabilitado(o, c.servidor))
    return conectores.length === a.conectores.length ? a : { ...a, conectores }
  },

  /** Valida una lista de nombres de un PATCH/PUT: null = borrar (heredar / todo), undefined = no tocar. */
  lista(v: unknown, campo: string, { espacios = false }: { espacios?: boolean } = {}): string[] | null | undefined {
    if (v === undefined) return undefined
    if (v === null) return null
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ErrorAPI(400, `«${campo}» tiene que ser una lista de nombres (o null).`)
    const out = [...new Set((v as string[]).map((x) => x.trim()).filter((x) => x !== ''))]
    const malo = (x: string) => x.length > Habilitados.maxLargo || (!espacios && /[\s"]/.test(x)) || /["\n\r]/.test(x)
    if (out.length > Habilitados.maxNombres || out.some(malo)) throw new ErrorAPI(400, `«${campo}»: hasta ${Habilitados.maxNombres} nombres de hasta ${Habilitados.maxLargo} caracteres.`)
    return out
  },

  /** Validación al leer/guardar oficina.json. */
  validarOficina(ia: IAOficina) {
    for (const [k, espacios] of [['skills', false], ['mcp', false], ['conectores', true]] as const) {
      const l = ia[k]
      if (l !== undefined) Habilitados.lista(l, `ia.${k}`, { espacios })
    }
  },
}

/** Los servidores MCP de Claude Code de una línea `system/init` (sin los de claude.ai ni el de la oficina, `hq`), o
 *  undefined si la línea no es ese evento. */
export function mcpLocalesDe(l: string): string[] | undefined {
  let o: unknown
  try { o = JSON.parse(l) } catch { return undefined }
  if (typeof o !== 'object' || o === null) return undefined
  const d = o as Record<string, unknown>
  if (d.type !== 'system' || d.subtype !== 'init' || !Array.isArray(d.mcp_servers)) return undefined
  const out: string[] = []
  for (const s of d.mcp_servers) {
    if (typeof s !== 'object' || s === null) continue
    const x = s as Record<string, unknown>
    if (typeof x.name !== 'string' || x.source === 'claudeai' || x.name === 'hq' || x.name.startsWith('claude.ai ')) continue
    if (!out.includes(x.name)) out.push(x.name)
  }
  return out
}
