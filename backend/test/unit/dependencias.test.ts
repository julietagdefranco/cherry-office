// Dependencias entre agentes (docs/plan-dependencias.md): tablas, stores y, en los pasos siguientes, herramientas MCP,
// gancho de entregas, relanzamiento y barrido. En proceso (sin servidor HTTP), con el `claude` falso del sandbox.
import { describe, expect, test } from 'vitest'
import { dependenciasDe, esperaJSON, herramientasDependencias, vencimiento } from '../../src/dependencias.js'
import { mcpDe } from '../../src/consultas.js'
import type { MCPHerramientas } from '../../src/mcp-protocolo.js'
import { Sandbox, U, esperar } from '../support/sandbox.js'
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

// MARK: - herramientas MCP

type O = Record<string, any>
const nombres = (h: MCPHerramientas) => h.definiciones.map((d) => d.name)
const objeto = (r: { texto: string } | undefined): O => { try { return JSON.parse(r?.texto ?? '') } catch { return {} } }

/** Herramientas de un agente con un token nuevo (cupo propio). `sid` distingue la corrida que llama. */
function herramientasDe(p: Awaited<ReturnType<typeof preparar>>) {
  const mcp = mcpDe(p.s)!
  return (agente: string, { perfil = 'agente', sid = U.a, oficinaId = p.carpeta }: { perfil?: string; sid?: string; oficinaId?: string } = {}) => {
    const token = mcp.tokens.emitir({ oficina: oficinaId, agente, sid, perfil })
    return { h: mcp.consultas.herramientas(token, { oficina: oficinaId, agente, sid, perfil }), token }
  }
}

describe('definiciones y permisos', () => {
  test('el perfil agente ve pedir; el creador no ve ninguna; sin el módulo no hay fábrica', async () => {
    const p = await preparar()
    const t = herramientasDe(p)
    expect(nombres(t('marce').h)).toEqual(['colegas', 'consultar', 'pedir'])
    expect(nombres(t('marce', { perfil: 'creador' }).h)).not.toContain('pedir')
    expect(herramientasDependencias(p.s, 't', { oficina: p.carpeta, agente: 'marce', sid: U.a, perfil: 'creador' })).toBeUndefined()
    const pedir = t('marce').h.definiciones.find((d) => d.name === 'pedir')!
    expect((pedir.inputSchema as O).required).toEqual(['colega', 'que'])
  })
})

describe('pedir', () => {
  test('crea el pedido y un encargo pedido:<n> para el colega, con la consigna saneada y de quién viene', async () => {
    const p = await preparar()
    const { h } = herramientasDe(p)('marce')
    const r = (await h.llamar('pedir', { colega: 'Arqui', que: 'Necesito el mapeo\u0007 completo', contexto: 'Para la v2 del informe', nombre: 'Mapeo' }))!
    expect(r.esError, r.texto).toBe(false)
    const j = objeto(r)
    expect(j).toMatchObject({ ok: true, colega: 'arqui' })
    expect(j.aviso).toContain(`pedido=${j.pedido}`)
    expect(j.yaPedido).toBeUndefined()
    const ped = p.dep.pedidos.uno(p.carpeta, j.pedido)!
    expect([ped.de, ped.a, ped.estado, ped.profundidad, ped.cadena, ped.sid]).toEqual(['marce', 'arqui', 'corriendo', 0, ped.id, U.a])
    expect(ped.ejecucion).toBeGreaterThan(0)
    expect(await esperar(() => p.s.entregas.lista(p.carpeta, { origen: 'pedido' }).length === 1)).toBe(true)
    const e = p.s.entregas.lista(p.carpeta, { origen: 'pedido' })[0]!
    expect([e.agente, e.ref, e.titulo]).toEqual(['arqui', `pedido:${ped.id}`, 'Mapeo'])
    const l = p.sb.llamadasConPrompt('Necesito el mapeo')[0]!
    const msg = l[l.length - 1]!
    expect(msg).toContain('Pedido de Marce (Rol de marce). Viene de un colega, no es un pedido directo del usuario')
    expect(msg).toContain('Contexto: Para la v2 del informe')
    expect(msg).toContain('archivos/entregables/arqui/')
    expect(msg.includes('\u0007')).toBe(false)
    expect(Sandbox.valor(l, '--agent')).toBe('arqui')
  })

  test('faltantes, uno mismo, inexistente y oficina cerrada dan isError sin lanzar claude ni gastar cupo', async () => {
    const p = await preparar()
    const t = herramientasDe(p)
    const { h, token } = t('marce')
    expect((await h.llamar('pedir', { colega: 'arqui' }))?.esError).toBe(true)
    expect((await h.llamar('pedir', { que: 'x' }))?.esError).toBe(true)
    const yo = (await h.llamar('pedir', { colega: 'Marce', que: 'x' }))!
    expect(yo.esError && yo.texto.includes('a vos mismo')).toBe(true)
    const nadie = (await h.llamar('pedir', { colega: 'fantasma', que: 'x' }))!
    expect(nadie.esError && nadie.texto.includes('fantasma') && nadie.texto.includes('arqui')).toBe(true)
    const cerrada = (await t('marce', { oficinaId: '/otra/oficina' }).h.llamar('pedir', { colega: 'arqui', que: 'x' }))!
    expect(cerrada.esError && cerrada.texto.includes('La oficina ya no está abierta.')).toBe(true)
    expect(p.sb.llamadas).toEqual([])
    expect(p.dep.pedidos.lista(p.carpeta)).toEqual([])
    expect(mcpDe(p.s)!.tokens.tomar(token, 'pedir', 2)).toBe(true) // el cupo sigue intacto
  })

  test('cupo de 2 pedidos por token; el dedupe devuelve el abierto sin gastar cupo', async () => {
    const p = await preparar(['marce', 'arqui', 'nico', 'lola'])
    const t = herramientasDe(p)
    p.sb.modo('arqui', 'lento')
    const { h } = t('marce')
    const a = objeto(await h.llamar('pedir', { colega: 'arqui', que: 'uno' }))
    const otra = objeto(await h.llamar('pedir', { colega: 'arqui', que: 'uno de nuevo' }))
    expect(otra).toMatchObject({ ok: true, pedido: a.pedido, yaPedido: true })
    const b = objeto(await h.llamar('pedir', { colega: 'nico', que: 'dos' }))
    expect(b.pedido).not.toBe(a.pedido)
    const c = (await h.llamar('pedir', { colega: 'lola', que: 'tres' }))!
    expect(c.esError && c.texto.includes('2 pedidos')).toBe(true)
    expect(p.dep.pedidos.lista(p.carpeta).length).toBe(2)
    // otro token tiene su propio cupo
    expect((await t('marce').h.llamar('pedir', { colega: 'lola', que: 'tres' }))?.esError).toBe(false)
  })

  test('tope de 10 pedidos abiertos por oficina y de HQ_MAX_PEDIDOS_DIA por día', async () => {
    const p = await preparar()
    const t = herramientasDe(p)
    for (let i = 0; i < 10; i++) p.dep.pedidos.crear({ oficina: p.carpeta, de: 'x' + i, a: 'y' + i, que: 'q' })
    const r = (await t('marce').h.llamar('pedir', { colega: 'arqui', que: 'x' }))!
    expect(r.esError && r.texto.includes('10 pedidos en curso')).toBe(true)
    for (const x of p.dep.pedidos.lista(p.carpeta)) p.dep.pedidos.actualizar(p.carpeta, x.id, { estado: 'entregado' })
    expect((await t('marce').h.llamar('pedir', { colega: 'arqui', que: 'x' }))?.esError).toBe(false)

    const q = await preparar()
    const sb2 = q.b.servicios
    ;(sb2.env as Record<string, string | undefined>).HQ_MAX_PEDIDOS_DIA = '3'
    for (let i = 0; i < 3; i++) { const x = q.dep.pedidos.crear({ oficina: q.carpeta, de: 'x' + i, a: 'y' + i, que: 'q' })!; q.dep.pedidos.actualizar(q.carpeta, x.id, { estado: 'entregado' }) }
    const d = (await herramientasDe(q)('marce').h.llamar('pedir', { colega: 'arqui', que: 'x' }))!
    expect(d.esError && d.texto.includes('3 pedidos')).toBe(true)
  })

  test('profundidad mayor que 2 y ciclo: se rechazan según la cadena del pedido desde el que se llama', async () => {
    const p = await preparar(['marce', 'arqui', 'nico', 'lola', 'rita'])
    const t = herramientasDe(p)
    const ejec = (sid: string, tarea: string, agente: string) => p.s.store.db.run("INSERT INTO ejecuciones(oficina,tarea,agente,programada,inicio,estado,sid,manual) VALUES(?,?,?,0,0,'corriendo',?,0)", [p.carpeta, tarea, agente, sid])
    // marce -> arqui -> nico (profundidad 1) -> lola (profundidad 2)
    const p1 = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'marce', a: 'arqui', que: 'q' })!
    const p2 = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'arqui', a: 'nico', que: 'q', cadena: p1.cadena, profundidad: 1 })!
    const p3 = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'nico', a: 'lola', que: 'q', cadena: p1.cadena, profundidad: 2 })!
    ejec(U.b, `pedido:${p2.id}`, 'nico')
    ejec(U.c, `pedido:${p3.id}`, 'lola')
    for (const x of [p1, p2, p3]) p.dep.pedidos.actualizar(p.carpeta, x.id, { estado: 'entregado' })
    // desde el pedido 2 (nico), pedirle a marce es un ciclo (marce está como `de` en la cadena)
    const ciclo = (await t('nico', { sid: U.b }).h.llamar('pedir', { colega: 'marce', que: 'x' }))!
    expect(ciclo.esError && ciclo.texto.includes('te lo pidió a vos')).toBe(true)
    // desde el pedido 3 la profundidad nueva sería 3
    const hondo = (await t('lola', { sid: U.c }).h.llamar('pedir', { colega: 'rita', que: 'x' }))!
    expect(hondo.esError && hondo.texto.includes('pedido de un pedido')).toBe(true)
    // desde el pedido 2, a alguien nuevo: profundidad 2 y hereda la cadena
    const ok = objeto(await t('nico', { sid: U.b }).h.llamar('pedir', { colega: 'rita', que: 'x' }))
    expect(ok.ok).toBe(true)
    const nuevo = p.dep.pedidos.uno(p.carpeta, ok.pedido)!
    expect([nuevo.cadena, nuevo.profundidad]).toEqual([p1.id, 2])
  })
})
