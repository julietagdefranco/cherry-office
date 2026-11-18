// Contexto de la charla: `contexto` en /api/chat y /api/historial, y el desglose de `POST /api/chat/contexto`.
import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { Fix, dict } from '../support/sandbox.js'

describe('Contexto de la charla', () => {
  const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }, { id: 'nico', depto: 'direccion', rol: 'Ads' }], env: { HQ_PROGRAMADOR: '0' } })

  test('el chat devuelve cuánto ocupa la charla (último mensaje del agente, sin subagentes) y el historial lo recuerda', async () => {
    const f = await fix()
    const session = randomUUID()
    const r = await f.post('/api/chat', { agent: 'marce', message: 'CTX armame el plan', session })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(r.obj.contexto).toEqual({ usados: 42003, ventana: 1000000 })
    const h = await f.get('/api/historial?agent=marce')
    expect(h.obj.contexto).toEqual({ usados: 42003, ventana: 1000000 })
    const h2 = await f.get(`/api/historial?agent=marce&session=${session}`)
    expect(h2.obj.contexto).toEqual({ usados: 42003, ventana: 1000000 })
    // un turno sin usage no borra lo que se sabía
    await f.post('/api/chat', { agent: 'marce', message: 'gracias', session })
    expect((await f.get('/api/historial?agent=marce')).obj.contexto).toEqual({ usados: 42003, ventana: 1000000 })
  })

  test('una charla sin datos no trae contexto', async () => {
    const f = await fix()
    expect((await f.get('/api/historial?agent=marce')).obj).not.toHaveProperty('contexto')
  })

  test('el desglose corre /context con los argumentos del chat y sin guardar en la sesión', async () => {
    const f = await fix()
    const session = randomUUID()
    await f.post('/api/chat', { agent: 'marce', message: 'CTX hola', session })
    const r = await f.post('/api/chat/contexto', { agent: 'marce', session, modelo: 'sonnet' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(r.obj).toMatchObject({ modelo: 'claude-opus-5-5', usados: 150200, ventana: 1000000, libre: 816800, reserva: 33000 })
    expect(dict(r.obj.grupos)).toEqual({ mensajes: 87900, herramientas: 36100, instrucciones: 16245, skills: 10000, otros: 1200 })
    const args = f.sb.llamadasConPrompt('/context').at(-1) ?? []
    const fin = args.lastIndexOf('--')
    expect(args.indexOf('--no-session-persistence')).toBeGreaterThan(-1)
    expect(args.indexOf('--no-session-persistence')).toBeLessThan(fin)
    expect(args[args.indexOf('--resume') + 1]).toBe(session)
    expect(args[args.indexOf('--agent') + 1]).toBe('marce')
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
  })

  test('charla de otro agente, que no existe o que no empezó: no corre /context', async () => {
    const f = await fix()
    const session = randomUUID()
    await f.post('/api/chat', { agent: 'marce', message: 'CTX hola', session })
    expect((await f.post('/api/chat/contexto', { agent: 'nico', session })).status).toBe(404)
    expect((await f.post('/api/chat/contexto', { agent: 'marce', session: randomUUID() })).status).toBe(404)
    expect((await f.post('/api/chat/contexto', { agent: 'marce', session: 'x' })).status).toBe(400)
    expect(f.sb.llamadasConPrompt('/context').length).toBe(0)
  })
})
