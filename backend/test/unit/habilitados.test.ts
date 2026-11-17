// Skills, MCP y conectores en dos niveles (oficina → agente): la lista efectiva y el tope de conectores.
import { describe, expect, test } from 'vitest'
import { Habilitados, mcpLocalesDe, prefijoMCP } from '../../src/habilitados.js'
import { ConectoresAgente, TodosConectores } from '../../src/permisos.js'
import type { AgenteDef, Oficina } from '../../src/oficina.js'
import type { Config } from '../../src/config.js'

const ag = (x: Partial<AgenteDef> = {}): AgenteDef => ({ id: 'sofia', nombre: 'Sofía', rol: 'r', departamento: 'd', ...x })
const of = (ia?: Oficina['ia']): Oficina => ({ version: 1, nombre: 'O', duenio: '', departamentos: [], agentes: [], ...(ia ? { ia } : {}) })

describe('Habilitados.combinar', () => {
  test('undefined = todo; el agente hereda o recorta', () => {
    expect(Habilitados.combinar(undefined, undefined)).toBeUndefined()
    expect(Habilitados.combinar(['a', 'b'], undefined)).toEqual(['a', 'b'])
    expect(Habilitados.combinar(undefined, ['x'])).toEqual(['x'])
    expect(Habilitados.combinar(['a', 'b'], ['b', 'c'])).toEqual(['b'])
    expect(Habilitados.combinar(['a'], [])).toEqual([])
    expect(Habilitados.combinar([], undefined)).toEqual([])
  })
})

describe('conectores', () => {
  const gmail = { servidor: 'Gmail', leer: ['mcp__claude_ai_Gmail__search'], actuar: [] }
  const cal = { servidor: 'Google Calendar', leer: ['mcp__claude_ai_Google_Calendar__list'], actuar: [] }

  test('la oficina recorta los asignados del agente (sin importar «claude.ai » ni mayúsculas)', () => {
    const a = ag({ conectores: [gmail, cal] })
    expect(Habilitados.conectoresAgente(of(), a)).toBe(a)
    expect(Habilitados.conectoresAgente(of({ conectores: ['claude.ai gmail'] }), a).conectores).toEqual([gmail])
    const catalogo = [
      { nombre: 'Gmail', prefijo: 'mcp__claude_ai_Gmail', estado: 'connected', herramientas: gmail.leer },
      { nombre: 'Google Calendar', prefijo: 'mcp__claude_ai_Google_Calendar', estado: 'connected', herramientas: cal.leer },
    ]
    const o = of({ conectores: ['Gmail'] })
    const r = ConectoresAgente.herramientas(o, TodosConectores.agente(undefined, a, catalogo, o), catalogo, [])
    expect(r.permitidas).toEqual(gmail.leer)
    expect(r.vedadas).toContain('mcp__claude_ai_Google_Calendar')
  })

  test('modo «todos»: solo los conectores que habilita la oficina', () => {
    const catalogo = [
      { nombre: 'Gmail', prefijo: 'mcp__claude_ai_Gmail', estado: 'connected', herramientas: gmail.leer },
      { nombre: 'Google Calendar', prefijo: 'mcp__claude_ai_Google_Calendar', estado: 'connected', herramientas: cal.leer },
    ]
    const cfg = { conectoresAgentes: 'todos' } as Config
    expect(TodosConectores.agente(cfg, ag(), catalogo, of({ conectores: ['Google Calendar'] })).conectores!.map((c) => c.servidor)).toEqual(['Google Calendar'])
    expect(TodosConectores.agente(cfg, ag(), catalogo, of()).conectores!.length).toBe(2)
  })
})

describe('MCP de Claude Code', () => {
  test('prefijo y lectura del system/init', () => {
    expect(prefijoMCP('plugin:pw:playwright')).toBe('mcp__plugin_pw_playwright')
    const l = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'context7' }, { name: 'claude.ai Gmail', source: 'claudeai' }, { name: 'hq' }] })
    expect(mcpLocalesDe(l)).toEqual(['context7'])
    expect(mcpLocalesDe('{"type":"assistant"}')).toBeUndefined()
  })
})
