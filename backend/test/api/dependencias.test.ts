// Dependencias entre agentes por la API (docs/plan-dependencias.md): pedir -> v1 parcial + espera -> el otro entrega -> v2.
// Siempre con el claude falso y HQ_PROGRAMADOR=0. El servidor corre en otro proceso: lo que necesita `barrer` (despedidos,
// reconciliación) se prueba en test/unit/dependencias.test.ts.
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, chat, dict, esperar, lista, str, type Obj, U } from '../support/sandbox.js'

const entregas = async (f: Fix, q: Record<string, string> = {}): Promise<Obj[]> => lista((await f.get('/api/entregas', q)).obj.entregas)
const esperas = async (f: Fix, q: Record<string, string> = {}): Promise<Obj[]> => lista((await f.get('/api/esperas', q)).obj.esperas)

const fix = () => Fix.crear({
  deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }, { id: 'arqui', depto: 'direccion', rol: 'Arquitecto' }, { id: 'nico', depto: 'direccion', rol: 'Ads' }],
  env: { HQ_PROGRAMADOR: '0' },
})

/** Una tarea de una sola vez «ahora» de `agente`, que arranca enseguida. */
const tareaAhora = (f: Fix, agente: string, nombre: string, consigna: string) => f.post('/api/tareas', { agente, nombre, consigna, tipo: 'unica', ahora: true })

describe('Dependencias (API)', () => {
  test('de punta a punta: marce pide, entrega una v1 parcial y espera; arqui entrega; marce rehace la versión completa con --resume', async () => {
    const f = await fix()
    f.sb.llamadasMCP('marce', [
      { name: 'pedir', arguments: { colega: 'arqui', que: 'Armá el mapeo ENTREGA:archivos/entregables/arqui/mapeo.md y avisame', contexto: 'Para el informe' } },
      { name: 'quedo_esperando', arguments: { colega: 'arqui', que: 'el mapeo' } },
    ])
    const r = await tareaAhora(f, 'marce', 'Informe', 'MCP_LLAMAR ENTREGA:archivos/entregables/marce/v1.md')
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(await esperar(() => entregas(f).then((e) => e.some((x) => str(x.origen) === 'espera')), 20)).toBe(true)

    const es = await entregas(f)
    expect(es.length).toBe(3)
    const v1 = es.find((x) => str(x.origen) === 'tarea')!
    const delPedido = es.find((x) => str(x.origen) === 'pedido')!
    const v2 = es.find((x) => str(x.origen) === 'espera')!
    expect(str(v1.agente)).toBe('marce')
    expect(str(delPedido.agente)).toBe('arqui')
    expect(delPedido.archivos).toEqual(['archivos/entregables/arqui/mapeo.md'])
    expect([str(v2.agente), v2.padre, str(v2.ref).startsWith('espera:')]).toEqual(['marce', v1.id, true])
    expect(str(v2.sid)).toBe(str(v1.sid))
    // la v1 pasó a «cambios» (la v2 la reemplaza en la bandeja)
    expect(str(((await f.get(`/api/entregas/${v1.id}`)).obj.entrega as Obj).estado)).toBe('cambios')

    // la v2 retomó la conversación de la v1 y trajo lo de arqui
    const l = f.sb.llamadasConPrompt('Llegó lo que esperabas de Arqui')[0]!
    expect(Sandbox.valor(l, '--resume')).toBe(str(v1.sid))
    expect(l[l.length - 1]).toContain('archivos/entregables/arqui/mapeo.md')

    // las dos llamadas MCP de marce salieron bien
    const salidas = f.sb.salidasMCP('marce')
    expect(salidas.length).toBe(2)
    expect(salidas.every((o) => (o.result as Obj | undefined)?.isError !== true)).toBe(true)
  })

  /** Marce entrega una v1 parcial y queda esperando a arqui, que todavía no entregó (modo `puerta`: se destraba con abrirPuerta). */
  async function conArquiTrabado(f: Fix, modo = 'puerta') {
    f.sb.modo('arqui', modo)
    f.sb.llamadasMCP('marce', [
      { name: 'pedir', arguments: { colega: 'arqui', que: 'Armá el mapeo ENTREGA:archivos/entregables/arqui/mapeo.md y avisame' } },
      { name: 'quedo_esperando', arguments: { colega: 'arqui', que: 'el mapeo' } },
    ])
    expect((await tareaAhora(f, 'marce', 'Informe', 'MCP_LLAMAR ENTREGA:archivos/entregables/marce/v1.md')).status).toBe(200)
    expect(await esperar(async () => (await entregas(f)).some((x) => str(x.origen) === 'tarea') && (await esperas(f)).length === 1, 20)).toBe(true)
    const v1 = (await entregas(f)).find((x) => str(x.origen) === 'tarea')!
    const [x] = await esperas(f)
    return { v1, x: x! }
  }

  test('GET /api/esperas: abiertas por defecto, filtros por estado, agente y entrega; la espera trae el pedido y los nombres', async () => {
    const f = await fix()
    const { v1, x } = await conArquiTrabado(f)
    expect(x).toMatchObject({ agente: 'marce', agenteNombre: 'Marce', esperaA: 'arqui', esperaANombre: 'Arqui', estado: 'esperando', accion: 'continuar', que: 'el mapeo', ronda: 1, plazoDias: 2, origen: 'mcp', vencida: false })
    expect(x.entregaParcial).toBe(v1.id)
    expect((x.pedido as Obj).estado).toBe('corriendo')
    expect(x.ref).toBe(`pedido:${(x.pedido as Obj).id}`)
    expect((await esperas(f, { entrega: String(v1.id) })).map((e) => e.id)).toEqual([x.id])
    expect(await esperas(f, { entrega: '9999' })).toEqual([])
    expect((await esperas(f, { agente: 'marce' })).length).toBe(1)
    expect(await esperas(f, { agente: 'nico' })).toEqual([])
    expect(await esperas(f, { estado: 'hecha' })).toEqual([])
    expect((await esperas(f, { estado: 'todas' })).length).toBe(1)
    expect((await esperas(f, { estado: 'esperando' })).length).toBe(1)
    expect((await f.get('/api/esperas', { estado: 'rara' })).status).toBe(400)
    expect((await f.get('/api/esperas', { entrega: 'abc' })).status).toBe(400)
    expect((await f.post('/api/esperas')).status).toBe(405)
    expect((await f.get('/api/esperas/abc/cancelar')).status).toBe(404)
    f.sb.abrirPuerta()
  })

  test('cancelar: la deja cancelada con el motivo; cancelada otra vez o inexistente da 409/404', async () => {
    const f = await fix()
    const { x } = await conArquiTrabado(f)
    expect((await f.get(`/api/esperas/${x.id}/cancelar`)).status).toBe(405)
    const r = await f.post(`/api/esperas/${x.id}/cancelar`, { motivo: 'ya no hace falta' })
    expect(r.status).toBe(200)
    expect(r.obj.espera).toMatchObject({ estado: 'cancelada', motivo: 'ya no hace falta' })
    expect((await f.post(`/api/esperas/${x.id}/cancelar`)).status).toBe(409)
    expect((await f.post('/api/esperas/9999/cancelar')).status).toBe(404)
    expect((await f.post(`/api/esperas/${x.id}/cancelar`, { motivo: 'x'.repeat(301) })).status).toBe(400)
    expect(await esperas(f)).toEqual([])
    // cancelada: lo que entregue arqui después no relanza nada
    f.sb.abrirPuerta()
    expect(await esperar(async () => (await entregas(f)).some((e) => str(e.origen) === 'pedido'), 20)).toBe(true)
    expect((await entregas(f)).some((e) => str(e.origen) === 'espera')).toBe(false)
  })

  test('seguir sin esperar: relanza ya con lo que haya (202); la espera pasa a relanzada y después a hecha', async () => {
    const f = await fix()
    const { v1, x } = await conArquiTrabado(f)
    const r = await f.post(`/api/esperas/${x.id}/seguir`)
    expect(r.status).toBe(202)
    expect(await esperar(async () => (await entregas(f)).some((e) => str(e.origen) === 'espera'), 20)).toBe(true)
    const v2 = (await entregas(f)).find((e) => str(e.origen) === 'espera')!
    expect(v2.padre).toBe(v1.id)
    const msg = f.sb.llamadasConPrompt('Llegó lo que esperabas')[0]!.at(-1)!
    expect(msg).toContain('todavía no entregó')
    expect(await esperar(async () => str((await esperas(f, { estado: 'todas' }))[0]!.estado) === 'hecha')).toBe(true)
    expect((await f.post(`/api/esperas/${x.id}/seguir`)).status).toBe(409)
    f.sb.abrirPuerta()
  })

  test('resolver: vincula una entrega de arqui hecha por otro lado (chat) y relanza; una de otro agente da 409; sin entrega o inexistente 400/404', async () => {
    const f = await fix()
    // el pedido de marce falla; arqui entrega por otro lado (un chat con la persona) y la persona lo vincula a mano
    const { x } = await conArquiTrabado(f, 'error')
    expect(await esperar(async () => str(((await esperas(f))[0]!.pedido as Obj).estado) === 'fallido', 20)).toBe(true)
    f.sb.modo('arqui', null)
    const ajena = await chat(f.b, { agent: 'nico', message: 'ENTREGA:archivos/entregables/nico/algo.md', session: U.a })
    const idAjena = Number(ajena.obj.entrega)
    expect(idAjena).toBeGreaterThan(0)
    expect((await f.post(`/api/esperas/${x.id}/resolver`, { entrega: idAjena })).status).toBe(409)
    expect((await f.post(`/api/esperas/${x.id}/resolver`, { entrega: 9999 })).status).toBe(404)
    expect((await f.post(`/api/esperas/${x.id}/resolver`, {})).status).toBe(400)
    const suya = await chat(f.b, { agent: 'arqui', message: 'ENTREGA:archivos/entregables/arqui/chat.md', session: U.b })
    const idSuya = Number(suya.obj.entrega)
    const ok = await f.post(`/api/esperas/${x.id}/resolver`, { entrega: idSuya })
    expect(ok.status, JSON.stringify(ok.obj)).toBe(200)
    expect((ok.obj.espera as Obj).entregaLlegada).toBe(idSuya)
    expect(await esperar(async () => (await entregas(f)).some((e) => str(e.origen) === 'espera'), 20)).toBe(true)
    const msg = f.sb.llamadasConPrompt('Llegó lo que esperabas')[0]!.at(-1)!
    expect(msg).toContain('archivos/entregables/arqui/chat.md')
    expect((await f.post(`/api/esperas/${x.id}/resolver`, { entrega: idSuya })).status).toBe(409)
  })

  test('un pedido que falla: queda fallido, hay un aviso de error y «reintentar» lo vuelve a lanzar hasta que se entrega la versión completa', async () => {
    const f = await fix()
    const { v1, x } = await conArquiTrabado(f, 'error')
    expect(await esperar(async () => str(((await esperas(f))[0]!.pedido as Obj).estado) === 'fallido', 20)).toBe(true)
    const avisos = lista((await f.get('/api/avisos')).obj.avisos)
    expect(avisos.some((a) => str(a.tipo) === 'error' && str(a.texto).includes('falló'))).toBe(true)
    // la espera sigue esperando (no hay nada que reintentar si el pedido no falló, pero acá sí)
    expect(str((await esperas(f))[0]!.estado)).toBe('esperando')
    f.sb.modo('arqui', null)
    const r = await f.post(`/api/esperas/${x.id}/reintentar`)
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    expect(await esperar(async () => (await entregas(f)).some((e) => str(e.origen) === 'espera'), 20)).toBe(true)
    const v2 = (await entregas(f)).find((e) => str(e.origen) === 'espera')!
    expect(v2.padre).toBe(v1.id)
    // ya no hay nada para reintentar
    expect((await f.post(`/api/esperas/${x.id}/reintentar`)).status).toBe(409)
  })

  test('sin oficina abierta las rutas dan 409', async () => {
    const sin = await new Sandbox().backend({ env: { HQ_PROGRAMADOR: '0' }, oficina: false })
    const { llamar } = await import('../support/sandbox.js')
    expect((await llamar(sin, 'GET', '/api/esperas')).status).toBe(409)
    expect((await llamar(sin, 'POST', '/api/esperas/1/cancelar', { body: {} })).status).toBe(409)
  })

  test('el parte lista las esperas abiertas; una que no venció no es bloqueo ni aviso (la vencida se prueba en unit)', async () => {
    const f = await fix()
    const { x } = await conArquiTrabado(f)
    const parte = (await f.get('/api/parte')).obj
    expect(lista(parte.esperas).map((e) => e.id)).toEqual([x.id])
    expect(lista(parte.bloqueos).some((b) => str(b.tipo) === 'espera')).toBe(false)
    expect(lista((await f.get('/api/avisos')).obj.avisos).some((a) => str(a.tipo) === 'espera')).toBe(false)
    f.sb.abrirPuerta()
  })
})

// MARK: - dependencias entre pendientes de una reunión

const sintesis = {
  resumen: 'Se acordó el plan.', decisiones: ['Arrancar'],
  pendientes: [
    { quien: 'Marce', que: 'Armar el mapeo ENTREGA:archivos/entregables/marce/mapeo.md y avisar', necesita_usuario: false, depende_de: [] },
    { quien: 'Pato', que: 'Armar el informe ENTREGA:archivos/entregables/pato/informe.md usando el mapeo', necesita_usuario: false, depende_de: [1] },
    { quien: 'Ana', que: 'Revisar el contrato a mano', necesita_usuario: false, depende_de: [] },
    { quien: 'Pato', que: 'Mandar la propuesta ENTREGA:archivos/entregables/pato/propuesta.md ya revisada', necesita_usuario: false, depende_de: [3] },
  ],
}

async function reunionConDependencias(f: Fix): Promise<string> {
  f.sb.responder('acta', JSON.stringify(sintesis))
  const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
  const id = str(r.obj.id)
  expect(await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)).toBe(true)
  const c = await f.post(`/api/reuniones/${id}/cerrar`)
  expect(c.status, JSON.stringify(c.obj)).toBe(200)
  return id
}

const estadoPend = async (f: Fix, id: string): Promise<Obj[]> => lista((await f.get(`/api/reuniones/${id}`)).obj.pendientesEstado)
const fixReunion = () => Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }], env: { HQ_PROGRAMADOR: '0' } })
const entregasDe = async (f: Fix, ref: string) => (await entregas(f)).filter((e) => str(e.ref) === ref)

describe('Dependencias entre pendientes de una reunión (API)', () => {
  test('la síntesis guarda depende_de 0-based y el estado de los pendientes lo muestra; el acta lo escribe 1-based', async () => {
    const f = await fixReunion()
    const id = await reunionConDependencias(f)
    const r = (await f.get(`/api/reuniones/${id}`)).obj
    expect(lista((r.sintesis as Obj).pendientes).map((p) => p.depende_de)).toEqual([undefined, [0], undefined, [2]])
    const est = await estadoPend(f, id)
    expect(est.map((e) => e.dependeDe)).toEqual([[], [0], [], [2]])
    expect(est.map((e) => e.agente)).toEqual(['marce', 'pato', null, 'pato'])
    expect(est.every((e) => e.espera === undefined)).toBe(true)
    const acta = f.leer(str(r.acta))
    expect(acta).toContain('Armar el informe')
    expect(acta).toContain('_(después de 1)_')
    expect(acta).toContain('_(después de 3)_')
  })

  test('encargar un pendiente que depende de otro: encarga el otro en cascada, queda esperando y corre cuando el otro entrega, con su archivo en la consigna', async () => {
    const f = await fixReunion()
    const id = await reunionConDependencias(f)
    f.sb.modo('marce', 'puerta') // la cascada queda trabada hasta que se abra la puerta
    const r = await f.post(`/api/reuniones/${id}/pendientes/1/encargar`)
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    const e1 = lista(r.obj.pendientesEstado)[1]!
    expect(e1.espera).toMatchObject({ estado: 'esperando', esperaA: ['marce'], esperando: [0] })
    expect(await esperar(async () => f.sb.llamadasConPrompt('Armar el mapeo').length >= 1)).toBe(true)
    // el 2 no corrió todavía
    expect(f.sb.llamadasConPrompt('Armar el informe')).toEqual([])
    // volver a encargar el mismo no duplica nada
    expect((await f.post(`/api/reuniones/${id}/pendientes/1/encargar`)).status).toBe(202)
    expect(f.sb.llamadasConPrompt('Armar el mapeo').length).toBe(1)
    expect((await esperas(f)).length).toBe(1)

    f.sb.abrirPuerta()
    expect(await esperar(async () => (await entregasDe(f, `encargo:${id}:1`)).length === 1, 20)).toBe(true)
    const consigna = f.sb.llamadasConPrompt('Armar el informe')[0]!.at(-1)!
    expect(consigna).toContain('Lo que entregaron los pendientes de los que depende este')
    expect(consigna).toContain('archivos/entregables/marce/mapeo.md')
    const est = await estadoPend(f, id)
    expect(est[1]!.espera).toBeUndefined()
    expect(str(dict(est[1]!.encargo).estado)).toBe('ok')
    expect((await esperas(f, { estado: 'hecha', reunion: id })).length).toBe(1)
  })

  test('forzar: arranca enseguida sin esperar y cancela la espera abierta', async () => {
    const f = await fixReunion()
    const id = await reunionConDependencias(f)
    f.sb.modo('marce', 'puerta')
    expect((await f.post(`/api/reuniones/${id}/pendientes/1/encargar`)).status).toBe(202)
    expect((await esperas(f)).length).toBe(1)
    const r = await f.post(`/api/reuniones/${id}/pendientes/1/encargar`, { forzar: true })
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    expect(await esperar(async () => (await entregasDe(f, `encargo:${id}:1`)).length === 1, 20)).toBe(true)
    expect(f.sb.llamadasConPrompt('Armar el informe')[0]!.at(-1)).not.toContain('Lo que entregaron los pendientes')
    const todas = await esperas(f, { estado: 'todas' })
    expect(todas.map((x) => [x.estado, x.motivo])).toEqual([['cancelada', 'Arrancó igual, sin esperar']])
    f.sb.abrirPuerta()
  })

  test('un pendiente de la persona: «hecho» la libera a quien la esperaba; si es de un agente encargable, 409', async () => {
    const f = await fixReunion()
    const id = await reunionConDependencias(f)
    const r = await f.post(`/api/reuniones/${id}/pendientes/3/encargar`)
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    expect(lista(r.obj.pendientesEstado)[3]!.espera).toMatchObject({ estado: 'esperando', esperaA: ['persona'], esperando: [2] })
    expect(f.sb.llamadasConPrompt('Mandar la propuesta')).toEqual([])
    expect((await f.post(`/api/reuniones/${id}/pendientes/0/hecho`)).status).toBe(409)
    expect((await f.post(`/api/reuniones/${id}/pendientes/9/hecho`)).status).toBe(404)
    const avisosPendiente = async () => lista((await f.get('/api/avisos')).obj.avisos).filter((a) => str(a.tipo) === 'pendiente' && str(a.ref) === id)
    expect((await avisosPendiente()).length).toBe(1)
    const h = await f.post(`/api/reuniones/${id}/pendientes/2/hecho`, { nota: 'Lo revisé con el abogado.' })
    expect(h.status, JSON.stringify(h.obj)).toBe(200)
    expect(lista(h.obj.pendientesEstado)[2]!.hecho).toBeGreaterThan(0)
    // era el único pendiente de la persona: se apaga el «necesita tu parte»
    expect(await avisosPendiente()).toEqual([])
    const propia = (await entregasDe(f, `encargo:${id}:2`))[0]!
    expect([str(propia.origen), str(propia.agente), str(propia.estado), str(propia.titulo)]).toEqual(['persona', '', 'revisada', 'Revisar el contrato a mano'])
    expect(await esperar(async () => (await entregasDe(f, `encargo:${id}:3`)).length === 1, 20)).toBe(true)
    const consigna = f.sb.llamadasConPrompt('Mandar la propuesta')[0]!.at(-1)!
    expect(consigna).toContain('Lo revisé con el abogado.')
    expect(consigna).toContain('--- la persona: Revisar el contrato a mano ---')
  })

  test('encargar-todos: arranca los que no dependen de nadie y deja esperando a los demás; los de la persona no se tocan', async () => {
    const f = await fixReunion()
    const id = await reunionConDependencias(f)
    const r = await f.post(`/api/reuniones/${id}/pendientes/encargar-todos`)
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    expect(await esperar(async () => (await entregasDe(f, `encargo:${id}:1`)).length === 1, 20)).toBe(true)
    expect((await entregasDe(f, `encargo:${id}:0`)).length).toBe(1)
    expect((await entregasDe(f, `encargo:${id}:2`)).length).toBe(0) // de la persona
    const est = await estadoPend(f, id)
    expect(est[3]!.espera).toMatchObject({ estado: 'esperando', esperaA: ['persona'] })
    expect(est[3]!.encargo).toBeUndefined()
    expect(f.sb.llamadasConPrompt('Mandar la propuesta')).toEqual([])
    // una segunda vez no repite lo que ya corrió
    expect((await f.post(`/api/reuniones/${id}/pendientes/encargar-todos`)).status).toBe(202)
    const encargosDeMarce = f.sb.llamadas.filter((l) => Sandbox.valor(l, '--agent') === 'marce' && l.at(-1)!.includes('Pendiente de la reunión'))
    expect(encargosDeMarce.length).toBe(1)
    expect((await f.post(`/api/reuniones/${U.c}/pendientes/encargar-todos`)).status).toBe(404)
    expect((await f.get(`/api/reuniones/${id}/pendientes/encargar-todos`)).status).toBe(405)
  })
})

// MARK: - pasar a flujo

describe('Pasar a flujo (API)', () => {
  test('desde una reunión: pasos en orden topológico, recibeDe explícito (también []), pasos de la persona, y el editor lo puede guardar', async () => {
    const f = await fixReunion()
    f.sb.responder('acta', JSON.stringify({
      resumen: 'R', decisiones: [], pendientes: [
        { quien: 'Pato', que: 'Armar el informe', depende_de: [2] },
        { quien: 'Marce', que: 'Armar el mapeo', depende_de: [] },
        { quien: 'Ana', que: 'Revisar a mano', depende_de: [] },
        { quien: 'Marce', que: 'Mandar todo', necesita_usuario: false, depende_de: [1, 3] },
      ],
    }))
    const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
    const id = str(r.obj.id)
    expect(await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)).toBe(true)
    expect((await f.post(`/api/reuniones/${id}/cerrar`)).status).toBe(200)

    const b = await f.post(`/api/reuniones/${id}/flujo`)
    expect(b.status, JSON.stringify(b.obj)).toBe(200)
    const borrador = b.obj.borrador as Obj
    expect(str(borrador.nombre)).toBe('lanzamiento')
    expect(str(borrador.descripcion)).toBe('Armado desde la reunión «lanzamiento»')
    expect(str(borrador.origen)).toBe(`reunion:${id}`)
    expect(lista(borrador.pasos).map((p) => [p.id, p.quien, p.recibeDe, p.aprobacion])).toEqual([
      ['p2', 'marce', [], false], ['p1', 'pato', ['p2'], false], ['p3', 'persona', [], false], ['p4', 'marce', ['p1', 'p3'], false],
    ])
    expect(lista(borrador.pasos)[0]).toMatchObject({ nombre: 'Armar el mapeo', consigna: 'Armar el mapeo', entrega: 'Lo que pide el pendiente' })
    // sin guardar nada hasta que la persona lo pida: el borrador entra tal cual en POST /api/flujos
    expect(lista((await f.get('/api/flujos')).obj.flujos)).toEqual([])
    const g = await f.post('/api/flujos', borrador)
    expect(g.status, JSON.stringify(g.obj)).toBe(200)
    expect(lista((await f.get('/api/flujos')).obj.flujos).length).toBe(1)
    // validaciones de la ruta
    expect((await f.get(`/api/reuniones/${id}/flujo`)).status).toBe(405)
    expect((await f.post(`/api/reuniones/${U.c}/flujo`)).status).toBe(404)
  })

  test('409 si la reunión no tiene pendientes o ninguno depende de otro', async () => {
    const f = await fixReunion()
    f.sb.responder('acta', JSON.stringify({ resumen: 'R', decisiones: [], pendientes: [{ quien: 'Marce', que: 'Uno' }, { quien: 'Pato', que: 'Dos', depende_de: [2] }] }))
    const r = await f.post('/api/reuniones', { tema: 'x', agentes: ['marce', 'pato'] })
    const id = str(r.obj.id)
    expect(await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)).toBe(true)
    expect((await f.post(`/api/reuniones/${id}/flujo`)).status).toBe(409) // todavía no está cerrada
    expect((await f.post(`/api/reuniones/${id}/cerrar`)).status).toBe(200)
    const b = await f.post(`/api/reuniones/${id}/flujo`)
    expect(b.status).toBe(409) // «dos» depende de sí mismo: se descartó y no queda ninguna cadena
    expect(str(b.obj.error)).toContain('depende de otro')
  })

  test('esperas repetidas A→B: aparece el patrón y se arma un borrador de 2 pasos que se puede guardar como flujo', async () => {
    const f = await fix()
    f.sb.modo('arqui', 'puerta')
    for (let i = 1; i <= 3; i++) {
      f.sb.llamadasMCP('marce', [{ name: 'quedo_esperando', arguments: { colega: 'arqui', que: 'el mapeo del cliente' } }])
      expect((await tareaAhora(f, 'marce', `Informe ${i}`, `MCP_LLAMAR ENTREGA:archivos/entregables/marce/v${i}.md`)).status).toBe(200)
      expect(await esperar(async () => (await esperas(f)).length === i && (await entregas(f)).length === i, 20)).toBe(true)
    }
    const p = lista((await f.get('/api/esperas/patrones')).obj.patrones)
    expect(p.length).toBe(1)
    expect(p[0]).toMatchObject({ agente: 'marce', esperaA: 'arqui', veces: 3 })
    expect(str(p[0]!.ultima)).toMatch(/Z$/)

    expect((await f.post('/api/esperas/flujo', {})).status).toBe(400)
    expect((await f.post('/api/esperas/flujo', { agente: 'marce', esperaA: 'fantasma' })).status).toBe(404)
    expect((await f.post('/api/esperas/flujo', { agente: 'nico', esperaA: 'marce' })).status).toBe(409)
    const r = await f.post('/api/esperas/flujo', { agente: 'marce', esperaA: 'arqui' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const b = r.obj.borrador as Obj
    expect(lista(b.pasos).map((x) => [x.id, x.quien, x.recibeDe, x.consigna])).toEqual([
      ['p1', 'arqui', [], 'el mapeo del cliente'], ['p2', 'marce', ['p1'], 'Informe 3'],
    ])
    expect((await f.post('/api/flujos', b)).status).toBe(200)
    expect((await f.get('/api/esperas/flujo')).status).toBe(405)
    expect((await f.post('/api/esperas/patrones')).status).toBe(405)
    f.sb.abrirPuerta()
  })
})
