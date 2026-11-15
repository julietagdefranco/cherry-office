// Dependencias entre agentes por la API (docs/plan-dependencias.md): pedir -> v1 parcial + espera -> el otro entrega -> v2.
// Siempre con el claude falso y HQ_PROGRAMADOR=0. El servidor corre en otro proceso: lo que necesita `barrer` (despedidos,
// reconciliación) se prueba en test/unit/dependencias.test.ts.
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, chat, esperar, lista, str, type Obj, U } from '../support/sandbox.js'

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
