// Port de app/Tests/BackendTests/ActividadTests.swift.
// Los tests de la suite «Actividad en vivo y costo» (parseo de stream-json, cortador de líneas, registro, caja de costo)
// son unit tests de tipos internos de Swift: quedan como skip para los unit tests del port.
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, dict, esperar, llamar, str } from '../support/sandbox.js'

const Sb = Sandbox

describe('Actividad en vivo y costo', () => {
  // interno (unit test del port): EventoClaude.parsear (init, thinking, tool_use con objetivo corto, text, result con costo; hooks y rate limits se ignoran)
  test.skip('parsear: init, thinking, tool_use con objetivo corto, text y result con costo; hooks y rate limits se ignoran', () => {})
  // interno (unit test del port): EventoClaude.objetivo recorta a 60 caracteres
  test.skip('objetivo: nunca más de 60 caracteres', () => {})
  // interno (unit test del port): CortadorLineas arma líneas aunque el pipe las parta
  test.skip('cortador: arma líneas aunque el pipe las parta en pedazos, y entrega el resto al terminar', () => {})
  // interno (unit test del port): ActividadRegistro (estado por herramienta, corrida más reciente, terminar, recorte de tarea)
  test.skip('registro: estado por herramienta, la corrida más reciente gana, terminar limpia y la tarea se recorta', () => {})
  // interno (unit test del port): CajaCosto suma corridas y reenvía eventos
  test.skip('caja de costo: suma varias corridas y reenvía los eventos', () => {})
})

describe('Actividad en vivo (API)', () => {
  test('chat en vivo: /api/actividad muestra herramienta, archivo y tarea (sin contenido) y se limpia al terminar; el costo queda en /api/costos', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }] })
    const r = chat(f.b, { agent: 'marce', message: 'STREAM PAUSA armame el plan de diciembre', session: U.a })
    const viendo = await esperar(async () => {
      const a = await f.get('/api/actividad')
      return dict(dict(a.obj.agentes).marce).estado === 'leyendo'
    })
    expect(viendo).toBe(true)
    const a = await f.get('/api/actividad')
    const m = dict(dict(a.obj.agentes).marce)
    expect(m.herramienta).toBe('Read')
    expect(m.objetivo).toBe('oficina.md')
    expect(m.origen).toBe('chat')
    expect(str(m.tarea)).toBe('Respondiéndote')            // fijo: el pedido no va al cartel
    const crudo = JSON.stringify(a.obj)
    expect(crudo.includes('secreto'), 'la actividad no debe exponer contenido de herramientas').toBe(false)
    f.sb.abrirPuerta()
    const resp = await r
    expect(resp.status).toBe(200)
    expect(resp.obj.reply).toBe('stream marce')
    expect(dict((await f.get('/api/actividad')).obj.agentes)).toEqual({})

    const listo = await esperar(async () => (((await f.get('/api/costos')).obj.total as number | undefined) ?? 0) > 0)
    expect(listo).toBe(true)
    const c = await f.get('/api/costos')
    expect(Math.abs(((c.obj.total as number | undefined) ?? 0) - 0.25)).toBeLessThan(1e-9)
    expect(Math.abs(((dict(c.obj.agentes).marce as number | undefined) ?? 0) - 0.25)).toBeLessThan(1e-9)
    expect(Math.abs(((dict(c.obj.origenes).chat as number | undefined) ?? 0) - 0.25)).toBeLessThan(1e-9)
  })

  test('chat en vivo: /api/chat/vivo muestra el texto y las herramientas mientras escribe (sin resultados) y la respuesta trae los pasos', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    expect((await f.get('/api/chat/vivo', { agent: 'marce' })).obj).toEqual({ activo: false })
    const r = chat(f.b, { agent: 'marce', message: 'STREAM PAUSA armame el plan', session: U.b })
    const ok = await esperar(async () => {
      const v = await f.get('/api/chat/vivo', { agent: 'marce' })
      return Array.isArray(v.obj.pasos) && (v.obj.pasos as unknown[]).length >= 2
    })
    expect(ok).toBe(true)
    const v = await f.get('/api/chat/vivo', { agent: 'marce' })
    expect(v.obj.activo).toBe(true)
    expect(v.obj.session).toBe(U.b)
    expect(v.obj.pasos).toEqual([{ t: 'texto', c: 'Voy a mirar el plan.' }, { t: 'herramienta', nombre: 'Read', objetivo: 'oficina.md' }])
    expect(JSON.stringify(v.obj).includes('secreto')).toBe(false)
    f.sb.abrirPuerta()
    const resp = await r
    expect(resp.obj.reply).toBe('stream marce')
    // «listo» (después de la última herramienta) es la respuesta: no se repite en los pasos
    expect(resp.obj.pasos).toEqual([{ t: 'texto', c: 'Voy a mirar el plan.' }, { t: 'herramienta', nombre: 'Read', objetivo: 'oficina.md' }])
    expect((await f.get('/api/chat/vivo', { agent: 'marce' })).obj).toEqual({ activo: false })
    expect((await f.get('/api/chat/vivo', { agent: 'nadie' })).status).toBe(400)
  })

  test('cartel: fijo («Respondiéndote») y en vivo lo que hace; sin llamadas a la IA para resumirlo', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    const r = chat(f.b, { agent: 'marce', message: 'STREAM PAUSA necesito que me armes el plan completo de reels para diciembre', session: U.c })
    const ok = await esperar(async () => {
      const a = dict(dict((await f.get('/api/actividad')).obj.agentes).marce)
      return str(a.tarea) === 'Respondiéndote' && str(a.estado) === 'leyendo' && str(a.objetivo) === 'oficina.md'
    })
    expect(ok, JSON.stringify((await f.get('/api/actividad')).obj)).toBe(true)
    f.sb.abrirPuerta()
    await r
    expect(f.sb.llamadas.length, 'solo el chat: ningún resumen aparte').toBe(1)
    expect(dict((await f.get('/api/costos')).obj.origenes).resumen).toBeUndefined()
  })

  test('todas las corridas usan stream-json --verbose', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.b })
    const l = f.sb.llamadas.at(-1)!
    expect(Sb.valor(l, '--output-format')).toBe('stream-json')
    expect(l.includes('--verbose')).toBe(true)
  })

  test('sin oficina activa, /api/actividad responde vacío (no 409)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const r = await llamar(b, 'GET', '/api/actividad')
    expect(r.status).toBe(200)
    expect(dict(r.obj.agentes)).toEqual({})
  })
})
