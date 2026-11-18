// El informe de `/context` de Claude Code (markdown), reducido a lo que muestra el chip de contexto del chat.
//
//   ## Context Usage
//   **Model:** claude-opus-5-5
//   **Tokens:** 30.4k / 1m (3%)
//   ### Estimated usage by category
//   | Category | Tokens | Percentage |
//   | System prompt | 2.6k | 0.3% |  …
//
// Las categorías se juntan en cinco grupos con nombres para cualquiera. Las «(deferred)» no ocupan contexto (son
// herramientas que se cargan solo si el agente las busca) y quedan afuera. Si una versión nueva de Claude Code trae
// una categoría que no se conoce, va a «otros».

export type GrupoContexto = 'mensajes' | 'herramientas' | 'instrucciones' | 'skills' | 'otros'

export type DesgloseContexto = {
  modelo?: string
  usados: number
  ventana: number
  grupos: Record<GrupoContexto, number>
  libre: number
  /** Lo que Claude Code aparta para resumir la charla cuando se llena (autocompact). */
  reserva: number
}

const grupoDe: Record<string, GrupoContexto | 'libre' | 'reserva'> = {
  'messages': 'mensajes',
  'system tools': 'herramientas',
  'mcp tools': 'herramientas',
  'system prompt': 'instrucciones',
  'mcp server instructions': 'instrucciones',
  'custom agents': 'instrucciones',
  'memory files': 'instrucciones',
  'skills': 'skills',
  'free space': 'libre',
  'autocompact buffer': 'reserva',
}

/** «30.4k» → 30400, «1m» → 1000000, «648» → 648, «< 20» → 0. undefined si no es un número. */
export function cantidad(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/,/g, '')
  if (t.startsWith('<')) return 0
  const m = /^~?\s*(\d+(?:\.\d+)?)\s*([km]?)$/.exec(t)
  if (!m) return undefined
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1
  return Math.round(parseFloat(m[1]!) * mult)
}

/** Lee el markdown de `/context`. undefined si no trae el total («Tokens: X / Y»). */
export function parsearContexto(md: string): DesgloseContexto | undefined {
  const tot = /\*\*Tokens:\*\*\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)/i.exec(md)
  if (!tot) return undefined
  const usados = cantidad(tot[1]!)
  const ventana = cantidad(tot[2]!)
  if (usados === undefined || ventana === undefined || !(ventana > 0)) return undefined
  const out: DesgloseContexto = { usados, ventana, grupos: { mensajes: 0, herramientas: 0, instrucciones: 0, skills: 0, otros: 0 }, libre: 0, reserva: 0 }
  const mod = /\*\*Model:\*\*\s*(\S+)/i.exec(md)
  if (mod) out.modelo = mod[1]!
  // solo la primera tabla (la de categorías): las siguientes detallan herramientas, skills, etc.
  const ini = md.search(/###\s*Estimated usage by category/i)
  if (ini < 0) return out
  const resto = md.slice(ini).split('\n').slice(1)
  let enTabla = false
  for (const linea of resto) {
    const l = linea.trim()
    if (!l.startsWith('|')) {
      if (enTabla) break
      continue
    }
    enTabla = true
    const celdas = l.split('|').slice(1, -1).map((c) => c.trim())
    if (celdas.length < 2) continue
    const nombre = celdas[0]!.toLowerCase()
    if (nombre === 'category' || /^-+$/.test(nombre) || nombre.includes('(deferred)')) continue
    const n = cantidad(celdas[1]!)
    if (n === undefined) continue
    const g = grupoDe[nombre] ?? 'otros'
    if (g === 'libre') out.libre += n
    else if (g === 'reserva') out.reserva += n
    else out.grupos[g] += n
  }
  return out
}
