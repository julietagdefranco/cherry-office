// Del chat a las tareas: `POST /api/chat/tareas` (propuesta) y `POST /api/tareas` con `origen: {chat}`.
import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { Fix, dict, lista, str } from '../support/sandbox.js'

describe('Del chat a las tareas', () => {
  /** Oficina con Marce y Nico; el bucle del programador apagado. */
  const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }, { id: 'nico', depto: 'direccion', rol: 'Ads' }], env: { HQ_PROGRAMADOR: '0' } })

  async function charla(f: Fix, agent = 'marce'): Promise<string> {
    const session = randomUUID()
    const r = await f.post('/api/chat', { agent, message: 'Hay que armar el calendario de diciembre', session })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    return session
  }
  const proponer = (f: Fix, session: string, agent = 'marce') => f.post('/api/chat/tareas', { agent, session })

  test('propone tareas con agente resuelto, consigna, dependencias y las de la persona aparte; registra el costo', async () => {
    const f = await fix()
    const session = await charla(f)
    const r = await proponer(f, session)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const ps = lista(r.obj.pendientes)
    expect(ps.length).toBe(2)
    expect(ps[0]).toMatchObject({ agente: 'marce', nombre: 'Calendario de diciembre', usuario: false, dependeDe: [] })
    expect(str(ps[0]!.consigna)).toContain('calendario de publicaciones')
    // sin «quien» y con necesita_usuario: de la persona; sin nombre: sale de la consigna; depende_de pasa a 0-based
    expect(ps[1]).toMatchObject({ agente: null, usuario: true, nombre: 'Aprobar el presupuesto con el cliente', dependeDe: [0], quien: 'Ana' })
    // el prompt lleva la charla, el equipo y la consigna autocontenida
    const prompt = f.sb.prompts.find((p) => p.includes('Sos quien ordena el trabajo')) ?? ''
    expect(prompt).toContain('Hay que armar el calendario de diciembre')
    expect(prompt).toContain('Nico (Ads)')
    expect(prompt).toContain('NO vio la charla')
    const c = await f.get('/api/costos')
    expect(dict(c.obj.origenes)['chat-tareas']).toBeGreaterThan(0)
  })

  test('otro agente por nombre; quien no existe queda para la persona', async () => {
    const f = await fix()
    const session = await charla(f)
    f.sb.responder('tareaschat', JSON.stringify({ pendientes: [
      { quien: 'Nico', nombre: 'Campaña', consigna: 'Armá la campaña de ads', depende_de: [] },
      { quien: 'Zoe', consigna: 'Algo de alguien que no está', depende_de: ['x', 5] },
    ] }))
    const ps = lista((await proponer(f, session)).obj.pendientes)
    expect(ps[0]).toMatchObject({ agente: 'nico', quien: 'Nico', usuario: false })
    expect(ps[1]).toMatchObject({ agente: null, usuario: true, dependeDe: [] })
  })

  test('charla vacía: lista vacía sin llamar al modelo; JSON roto o error: 502; charla ajena: 404; pedido inválido: 400', async () => {
    const f = await fix()
    const vacia = randomUUID()
    expect((await proponer(f, vacia)).status).toBe(404)
    const session = await charla(f)
    // de otro agente
    expect((await proponer(f, session, 'nico')).status).toBe(404)
    expect((await f.post('/api/chat/tareas', { agent: 'marce', session: 'no-uuid' })).status).toBe(400)
    expect((await f.post('/api/chat/tareas', { agent: 'nadie', session })).status).toBe(400)
    expect((await f.get('/api/chat/tareas')).status).toBe(405)
    f.sb.responder('tareaschat', 'esto no es json')
    expect((await proponer(f, session)).status).toBe(502)
    f.sb.responder('tareaschat', JSON.stringify({ pendientes: [] }))
    const r = await proponer(f, session)
    expect(r.status).toBe(200)
    expect(lista(r.obj.pendientes)).toEqual([])
    f.sb.modo('tareaschat', 'error')
    expect((await proponer(f, session)).status).toBe(502)
  })

  test('una sola lectura a la vez por charla (409)', async () => {
    const f = await fix()
    const session = await charla(f)
    f.sb.modo('tareaschat', 'puerta')
    const primera = proponer(f, session)
    await new Promise((r) => setTimeout(r, 300))
    expect((await proponer(f, session)).status).toBe(409)
    f.sb.abrirPuerta()
    expect((await primera).status).toBe(200)
  })

  test('crear tarea con origen {chat}: se guarda y vuelve en la API; charla de otra oficina o inválida: 400', async () => {
    const f = await fix()
    const session = await charla(f)
    const base = { agente: 'nico', nombre: 'Campaña', consigna: 'Armá la campaña', tipo: 'unica', fecha: '2099-03-10', hora: '09:00' }
    const r = await f.post('/api/tareas', { ...base, origen: { chat: session.toUpperCase() } })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(dict(r.obj.tarea).origen).toEqual({ chat: session })
    expect(lista(f.oficinaJSON().tareas)[0]!.origen).toEqual({ chat: session })
    const id = str(dict(r.obj.tarea).id)
    const vista = dict((await f.get(`/api/tareas/${id}`)).obj.tarea)
    expect(vista.origen).toEqual({ chat: session })
    // con quién era la charla, para «Salió de un chat con…»
    expect(dict(vista.charla).agente).toBe('marce')
    expect(str(dict(vista.charla).nombre)).not.toBe('')
    expect((await f.post('/api/tareas', { ...base, origen: { chat: randomUUID() } })).status).toBe(400)
    expect((await f.post('/api/tareas', { ...base, origen: { chat: 'x' } })).status).toBe(400)
    expect((await f.post('/api/tareas', { ...base, origen: { chat: 3 } })).status).toBe(400)
  })
})
