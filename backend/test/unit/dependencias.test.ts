// Dependencias entre agentes (docs/plan-dependencias.md): tablas, stores y, en los pasos siguientes, herramientas MCP,
// gancho de entregas, relanzamiento y barrido. En proceso (sin servidor HTTP), con el `claude` falso del sandbox.
import { describe, expect, test } from 'vitest'
import { dependenciasDe, esperaJSON, vencimiento } from '../../src/dependencias.js'
import { Sandbox } from '../support/sandbox.js'
import { arrancar, oficina } from '../support/en-proceso.js'

async function preparar(agentes: (string | { id: string; permisos?: string[] })[] = ['marce', 'arqui']) {
  const sb = new Sandbox()
  const b = arrancar(sb)
  const carpeta = await oficina(b, agentes)
  const s = b.servicios
  return { sb, b, s, carpeta, dep: dependenciasDe(s)! }
}

describe('stores de pedidos y esperas', () => {
  test('el módulo está instalado y crea pedidos con cadena propia', async () => {
    const { dep, carpeta } = await preparar()
    expect(dep).toBeDefined()
    const p = dep.pedidos.crear({ oficina: carpeta, de: 'marce', a: 'arqui', que: 'el mapeo', sid: 's1' })!
    expect(p.estado).toBe('corriendo')
    expect(p.cadena).toBe(p.id)
    expect(p.profundidad).toBe(0)
    const hijo = dep.pedidos.crear({ oficina: carpeta, de: 'arqui', a: 'marce', que: 'algo', cadena: p.cadena, profundidad: 1 })!
    expect(hijo.cadena).toBe(p.id)
    expect(dep.pedidos.lista(carpeta, { cadena: p.id }).map((x) => x.id)).toEqual([hijo.id, p.id])
    expect(dep.pedidos.actualizar(carpeta, p.id, { estado: 'entregado', entrega: 7, ejecucion: 3 })).toBe(1)
    const r = dep.pedidos.uno(carpeta, p.id)!
    expect([r.estado, r.entrega, r.ejecucion]).toEqual(['entregado', 7, 3])
    expect(dep.pedidos.uno('/otra', p.id)).toBeUndefined()
    expect(dep.pedidos.lista(carpeta, { estados: ['corriendo'], a: 'marce' }).map((x) => x.id)).toEqual([hijo.id])
  })

  test('esperas: crear, listar con filtros, actualizar y tomar el grupo de forma atómica', async () => {
    const { dep, carpeta } = await preparar()
    const e1 = dep.esperas.crear({ oficina: carpeta, agente: 'marce', esperaA: 'arqui', que: 'mapeo', ref: 'pedido:1', pedido: 1, grupo: 'sid:s1', accion: 'continuar', sid: 's1', origen: 'mcp' })!
    const e2 = dep.esperas.crear({ oficina: carpeta, agente: 'marce', esperaA: 'nico', que: 'prueba', ref: 'pedido:2', pedido: 2, grupo: 'sid:s1', accion: 'continuar', sid: 's1', origen: 'mcp', estado: 'lista', entregaLlegada: 9 })!
    expect(e1.estado).toBe('esperando')
    expect([e1.ronda, e1.plazoDias, e1.vista]).toEqual([1, 2, false])
    expect(e2.entregaLlegada).toBe(9)
    expect(dep.esperas.lista(carpeta, { ref: 'pedido:1' }).map((x) => x.id)).toEqual([e1.id])
    expect(dep.esperas.lista(carpeta, { grupo: 'sid:s1', estados: ['lista'] }).map((x) => x.id)).toEqual([e2.id])
    expect(dep.esperas.actualizar(carpeta, e1.id, { estado: 'lista', entregaLlegada: 5, entregaParcial: 4, motivo: 'x' })).toBe(1)
    const a = dep.esperas.una(carpeta, e1.id)!
    expect([a.estado, a.entregaLlegada, a.entregaParcial, a.motivo]).toEqual(['lista', 5, 4, 'x'])
    expect(dep.esperas.lista(carpeta, { entrega: 4 }).map((x) => x.id)).toEqual([e1.id])
    // el grupo se toma una sola vez
    const t1 = dep.esperas.tomarGrupo(carpeta, 'sid:s1')
    expect(t1.map((x) => x.id).sort()).toEqual([e1.id, e2.id].sort())
    expect(t1.every((x) => x.estado === 'relanzada')).toBe(true)
    expect(dep.esperas.tomarGrupo(carpeta, 'sid:s1')).toEqual([])
    dep.esperas.soltarGrupo(carpeta, 'sid:s1')
    expect(dep.esperas.lista(carpeta, { estados: ['lista'] }).length).toBe(2)
  })

  test('esperaJSON: nombres, pedido, vencida y días (solo esperando)', async () => {
    const { dep, carpeta } = await preparar()
    const p = dep.pedidos.crear({ oficina: carpeta, de: 'marce', a: 'arqui', que: 'x' })!
    const e = dep.esperas.crear({ oficina: carpeta, agente: 'marce', esperaA: 'arqui', que: 'mapeo', ref: `pedido:${p.id}`, pedido: p.id, grupo: 'sid:s', accion: 'continuar', origen: 'mcp', plazoDias: 2 })!
    const j = dep.json(e)
    expect(j).toMatchObject({ id: e.id, agente: 'marce', agenteNombre: 'Marce', esperaA: 'arqui', esperaANombre: 'Arqui', estado: 'esperando', ref: `pedido:${p.id}`, vencida: false, dias: 0, plazoDias: 2 })
    expect(j.pedido).toEqual({ id: p.id, estado: 'corriendo', entrega: null })
    const t = e.creada + 3 * 86400
    expect(vencimiento(e, t)).toEqual({ vencida: true, dias: 3 })
    expect(vencimiento({ ...e, estado: 'lista' }, t).vencida).toBe(false)
    const persona = esperaJSON({ ...e, esperaA: 'persona', pedido: undefined }, { nombre: (i) => i, pedido: () => undefined })
    expect(persona.esperaANombre).toBe('la persona')
    expect(persona.pedido).toBeNull()
  })
})
