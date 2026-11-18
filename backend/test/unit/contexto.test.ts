import { describe, expect, test } from 'vitest'
import { cantidad, parsearContexto } from '../../src/contexto.js'
import { CajaContexto, parsearEvento } from '../../src/stream.js'

const asistente = (usados: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', parent_tool_use_id: null, ...extra,
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: usados - 1002, cache_creation_input_tokens: 1000, output_tokens: 40 }, content: [{ type: 'text', text: 'x' }] },
})

describe('tamaño del contexto en el stream', () => {
  test('un mensaje del agente trae cuánto ocupa (entrada + caché leída + escrita, sin la salida)', () => {
    const evs = parsearEvento(asistente(30000))
    expect(evs[0]).toEqual({ tipo: 'contexto', usados: 30000, modelo: 'claude-opus-5-5' })
    expect(evs[1]).toMatchObject({ tipo: 'texto' })
  })

  test('los mensajes de subagentes no cuentan', () => {
    expect(parsearEvento(asistente(90000, { parent_tool_use_id: 'toolu_1' })).some((e) => e.tipo === 'contexto')).toBe(false)
  })

  test('CajaContexto: el último mensaje manda y la ventana es la del modelo del agente', () => {
    const caja = new CajaContexto()
    const obs = caja.observador()
    for (const l of [asistente(20000), asistente(41000)]) for (const e of parsearEvento(l)) obs(e)
    for (const e of parsearEvento(JSON.stringify({ type: 'result', result: 'ok', modelUsage: { 'claude-haiku-5-5': { contextWindow: 200000 }, 'claude-opus-5-5': { contextWindow: 1000000 } } }))) obs(e)
    expect(caja.valor).toEqual({ usados: 41000, ventana: 1000000 })
  })

  test('sin usage no hay contexto', () => {
    expect(new CajaContexto().valor).toBeUndefined()
    expect(parsearEvento('{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}').some((e) => e.tipo === 'contexto')).toBe(false)
  })
})

describe('informe de /context', () => {
  test('cantidades', () => {
    expect(cantidad('30.4k')).toBe(30400)
    expect(cantidad('1m')).toBe(1000000)
    expect(cantidad('648')).toBe(648)
    expect(cantidad('< 20')).toBe(0)
    expect(cantidad('~90')).toBe(90)
    expect(cantidad('abc')).toBeUndefined()
  })

  test('junta las categorías en grupos, deja afuera las diferidas y solo lee la primera tabla', () => {
    const md = '## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 30.4k / 1m (3%)\n\n### Estimated usage by category\n\n'
      + '| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.6k | 0.3% |\n| System tools | 13.2k | 1.3% |\n'
      + '| MCP tools | 648 | 0.1% |\n| MCP server instructions | 2.8k | 0.3% |\n| MCP tools (deferred) | 79.3k | 7.9% |\n| System tools (deferred) | 27k | 2.7% |\n'
      + '| Custom agents | 217 | 0.0% |\n| Memory files | 428 | 0.0% |\n| Skills | 9.4k | 0.9% |\n| Messages | 1.1k | 0.1% |\n| Free space | 936.6k | 93.7% |\n'
      + '| Autocompact buffer | 33k | 3.3% |\n\n### MCP Tools\n\n| Tool | Server | Tokens |\n|------|--------|--------|\n| Messages | x | 999k |\n'
    expect(parsearContexto(md)).toEqual({
      modelo: 'claude-opus-5-5', usados: 30400, ventana: 1000000,
      grupos: { mensajes: 1100, herramientas: 13848, instrucciones: 6045, skills: 9400, otros: 0 },
      libre: 936600, reserva: 33000,
    })
  })

  test('sin total no hay informe', () => {
    expect(parsearContexto('Unknown command: /context')).toBeUndefined()
  })
})
