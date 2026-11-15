// Dependencias entre agentes por la API (docs/plan-dependencias.md): pedir -> v1 parcial + espera -> el otro entrega -> v2.
// Siempre con el claude falso y HQ_PROGRAMADOR=0. El servidor corre en otro proceso: lo que necesita `barrer` (despedidos,
// reconciliación) se prueba en test/unit/dependencias.test.ts.
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, esperar, lista, str, type Obj } from '../support/sandbox.js'

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
})
