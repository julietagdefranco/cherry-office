// Port de app/Tests/BackendTests/PendientesAccionesTests.swift.
// La suite de lógica pura (Programador.idEncargo/deEncargo, PendientesReunion.tildar, ValidarTareas.origenValido) no es
// observable por HTTP: queda como skip para los unit tests del port.
import { describe, expect, test } from 'vitest'
import { Fix, U, dict, esperar, lista, str, type Obj } from '../support/sandbox.js'

describe('Pendientes que se ejecutan: lógica pura', () => {
  test.skip('id de encargo: ida y vuelta; ids que no son encargos dan nil', () => {
    // interno (unit test del port): Programador.idEncargo(U.a, 3) == "encargo:<uuid>:3" y Programador.deEncargo(...) lo invierte.
  })

  test.skip('tildar marca la primera línea exacta y deja el resto igual', () => {
    // interno (unit test del port): PendientesReunion.tildar sobre conocimiento/agentes/marce.md (marca "- [ ]" -> "- [x]", false si ya no está o no hay agente).
  })

  test.skip('origen de tarea: uuid en minúsculas y posición en rango', () => {
    // interno (unit test del port): ValidarTareas.origenValido (la validación vía POST /api/tareas se cubre en «Convertir en tarea»).
  })
})

/** Reunión con marce y pato, cerrada: la síntesis falsa deja un pendiente para Marce («Armar el calendario»). */
async function reunionCerrada(f: Fix): Promise<string> {
  const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
  const id = str(r.obj.id)
  const lista = await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)
  expect(lista).toBe(true)
  const c = await f.post(`/api/reuniones/${id}/cerrar`)
  expect(c.status, `cerrar: ${JSON.stringify(c.obj)}`).toBe(200)
  return id
}

const estado = async (f: Fix, id: string): Promise<Obj[]> => lista((await f.get(`/api/reuniones/${id}`)).obj.pendientesEstado)

const crearF = () => Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }] })

describe('Pendientes que se ejecutan (API)', () => {
  test('Hacelo ahora: corre al agente con el pendiente, deja una entrega de tipo encargo y al revisarla tilda la nota', async () => {
    const f = await crearF()
    const id = await reunionCerrada(f)
    let est = await estado(f, id)
    expect(est.length).toBe(1)
    expect(str(est[0]!.agente)).toBe('marce')
    expect(est[0]!.encargable).toBe(true)
    expect(est[0]!.encargo).toBeUndefined()
    const nota = f.leer('conocimiento/agentes/marce.md')
    expect(nota.includes('- [ ] ') && nota.includes('Armar el calendario')).toBe(true)

    const r = await f.post(`/api/reuniones/${id}/pendientes/0/encargar`)
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    const ok = await esperar(async () => {
      const e = (await estado(f, id))[0]?.encargo as Obj | undefined
      return str(e?.estado) === 'ok' && e?.entrega !== undefined
    }, 15)
    expect(ok).toBe(true)
    est = await estado(f, id)
    const enc = dict(est[0]!.encargo)
    expect(str(enc.entregaEstado)).toBe('sin_revisar')
    // la consigna lleva el pendiente y el tema
    const consigna = f.sb.llamadas.findLast((l) => l.includes('--agent') && l.includes('marce'))?.at(-1)?.normalize('NFC') ?? '' // NFC: args en NFD en macOS
    expect(consigna).toContain('Pendiente de la reunión «lanzamiento»')
    expect(consigna).toContain('Armar el calendario')
    // la entrega: origen encargo, ref = id del encargo
    const ents = lista((await f.get('/api/entregas', { origen: 'encargo' })).obj.entregas)
    expect(ents.length).toBe(1)
    expect(str(ents[0]!.ref)).toBe(`encargo:${id}:0`)
    expect(str(ents[0]!.titulo)).toBe('Armar el calendario')
    // revisar -> la nota queda tildada
    const eid = typeof ents[0]!.id === 'number' ? ents[0]!.id : 0
    expect((await f.post(`/api/entregas/${eid}/revisada`)).status).toBe(200)
    const tildada = f.leer('conocimiento/agentes/marce.md')
    expect(tildada.includes('- [x] ') && !tildada.includes('- [ ] ')).toBe(true)
    est = await estado(f, id)
    expect(str(dict(est[0]!.encargo).entregaEstado)).toBe('revisada')
  })

  test('encargar: 404 sin pendiente o reunión, 409 si no está cerrada, si necesita a la persona o si no es de un agente', async () => {
    const f = await crearF()
    const id = await reunionCerrada(f)
    expect((await f.post(`/api/reuniones/${id}/pendientes/5/encargar`)).status).toBe(404)
    expect((await f.post(`/api/reuniones/${U.c}/pendientes/0/encargar`)).status).toBe(404)
    expect((await f.post(`/api/reuniones/${id}/pendientes/x/encargar`)).status).toBe(404)
    expect((await f.get(`/api/reuniones/${id}/pendientes/0/encargar`)).status).toBe(405)
    // reunión abierta
    const r = await f.post('/api/reuniones', { tema: 'otra', agentes: ['marce'] })
    const abierta = str(r.obj.id)
    await esperar(async () => str((await f.get(`/api/reuniones/${abierta}`)).obj.estado) === 'esperando', 15)
    expect((await f.post(`/api/reuniones/${abierta}/pendientes/0/encargar`)).status).toBe(409)
    // pendientes que no se pueden encargar
    f.sb.responder('acta', JSON.stringify({
      resumen: 'r', decisiones: [],
      pendientes: [{ quien: 'Marce', que: 'Mandar el mail', necesita_usuario: true }, { quien: 'Ana', que: 'Firmar' }],
    }))
    await f.post(`/api/reuniones/${abierta}/cerrar`)
    const est = await estado(f, abierta)
    expect(est.map((p) => p.encargable)).toEqual([false, false])
    expect((await f.post(`/api/reuniones/${abierta}/pendientes/0/encargar`)).status).toBe(409)
    expect((await f.post(`/api/reuniones/${abierta}/pendientes/1/encargar`)).status).toBe(409)
  })

  test('Convertir en tarea: la tarea guarda el origen y aparece en el estado del pendiente; origen inválido 400', async () => {
    const f = await crearF()
    const id = await reunionCerrada(f)
    const base: Obj = {
      agente: 'marce', nombre: 'Calendario semanal', consigna: 'Armar el calendario',
      dias: [1], hora: '09:00', zona: 'America/Argentina/Buenos_Aires',
    }
    const r = await f.post('/api/tareas', { ...base, origen: { reunion: id, pendiente: 0 } })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const og = dict(dict(r.obj.tarea).origen)
    expect(str(og.reunion) === id && og.pendiente === 0).toBe(true)
    const tareas = lista((await estado(f, id))[0]?.tareas)
    expect(tareas.map((t) => str(t.id))).toEqual(['calendario-semanal'])
    const malos: unknown[] = [{ reunion: 'x', pendiente: 0 }, { reunion: id, pendiente: -1 }, { reunion: id }, 'texto', { reunion: id, pendiente: true }]
    for (const malo of malos) {
      const m = { ...base, origen: malo, nombre: 'Otra' }
      expect((await f.post('/api/tareas', m)).status, JSON.stringify(malo)).toBe(400)
    }
  })
})
