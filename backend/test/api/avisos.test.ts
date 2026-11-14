// Port de app/Tests/BackendTests/AvisosTests.swift.
// Sin acceso a internals: el callback `avisos.alCrear` (notificaciones nativas) queda para los unit tests del port.
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, esperar, lista, llamar, str, type Obj } from '../support/sandbox.js'

const avisos = async (f: Fix): Promise<Obj[]> => lista((await f.get('/api/avisos')).obj.avisos)

describe('Avisos (te necesita)', () => {
  test('una respuesta deja un aviso; otra del mismo agente lo reemplaza; verlo por agente lo limpia; también viene en /api/actividad', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.a })
    await chat(f.b, { agent: 'marce', message: 'hola de nuevo', session: U.a })
    await chat(f.b, { agent: 'pato', message: 'hola', session: U.b })
    let av = await avisos(f)
    expect(av.map((a) => str(a.agente))).toEqual(['marce', 'pato'])
    expect(av.every((a) => str(a.tipo) === 'respuesta')).toBe(true)
    expect(str(av[0]!.texto)).toBe('hola marce')
    expect(str(av[0]!.ref)).toBe(U.a)
    expect(lista((await f.get('/api/actividad')).obj.avisos).length).toBe(2)

    expect((await f.post('/api/avisos/visto', { agente: 'marce' })).obj.vistos).toBe(1)
    av = await avisos(f)
    expect(av.map((a) => str(a.agente))).toEqual(['pato'])
    expect((await f.post('/api/avisos/visto', { id: str(av[0]!.id) })).obj.vistos).toBe(1)
    expect(await avisos(f)).toEqual([])
  })

  test('un error del chat deja un aviso de tipo error', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'ISERR', session: U.a })
    const av = await avisos(f)
    expect(av.length).toBe(1)
    expect(str(av[0]?.tipo)).toBe('error')
    expect(str(av[0]?.texto).startsWith('No pudo responder')).toBe(true)
  })

  test('una reunión que espera aparece como aviso calculado y desaparece al cerrarla', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }] })
    const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
    const id = str(r.obj.id)
    expect(await esperar(async () => (await avisos(f)).some((a) => str(a.id) === `reunion:${id}`), 15)).toBe(true)
    // los turnos de la reunión no dejan avisos de respuesta
    expect((await avisos(f)).some((a) => str(a.tipo) === 'respuesta')).toBe(false)
    await f.post(`/api/reuniones/${id}/cerrar`)
    expect(await esperar(async () => !(await avisos(f)).some((a) => str(a.tipo) === 'reunion'), 15)).toBe(true)
  })

  test('abrir la reunión que espera apaga su aviso (marcarla vista) hasta que vuelva a esperar', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }] })
    const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
    const id = str(r.obj.id)
    expect(await esperar(async () => (await avisos(f)).some((a) => str(a.id) === `reunion:${id}`), 15)).toBe(true)
    const v = await f.post('/api/avisos/visto', { id: `reunion:${id}` })
    expect(v.obj.vistos).toBe(1)
    expect((await avisos(f)).some((a) => str(a.tipo) === 'reunion')).toBe(false)
    // terminar otra ronda la deja esperando de nuevo: vuelve a avisar
    await f.post(`/api/reuniones/${id}/ronda`)
    expect(await esperar(async () => (await avisos(f)).some((a) => str(a.id) === `reunion:${id}`), 15)).toBe(true)
  })

  test('sin oficina: /api/avisos 409 y /api/actividad trae avisos vacíos', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    expect((await llamar(b, 'GET', '/api/avisos')).status).toBe(409)
    expect(lista((await llamar(b, 'GET', '/api/actividad')).obj.avisos)).toEqual([])
  })
})
