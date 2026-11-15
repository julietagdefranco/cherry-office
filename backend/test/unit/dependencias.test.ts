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

/** Deja pasar a los claude que esperan en modo `puerta` y espera a que no quede ninguna corrida en curso (si no, el cierre tarda). */
async function terminar(p: Awaited<ReturnType<typeof preparar>>) {
  p.sb.abrirPuerta()
  await esperar(() => p.s.store.db.query("SELECT COUNT(*) AS n FROM ejecuciones WHERE estado='corriendo'")[0]!.n === 0)
}

describe('definiciones y permisos', () => {
  test('el perfil agente ve pedir; el creador no ve ninguna; sin el módulo no hay fábrica', async () => {
    const p = await preparar()
    const t = herramientasDe(p)
    expect(nombres(t('marce').h)).toEqual(['colegas', 'consultar', 'pedir', 'quedo_esperando', 'cancelar_espera'])
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
    await terminar(p)
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
    p.sb.modo('arqui', 'puerta')
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
    await terminar(p)
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
    await terminar(p)
  })

  test('profundidad mayor que 2 y ciclo: se rechazan según la cadena del pedido desde el que se llama', async () => {
    const p = await preparar(['marce', 'arqui', 'nico', 'lola', 'rita'])
    const t = herramientasDe(p)
    const ejec = (sid: string, tarea: string, agente: string) => p.s.store.db.run("INSERT INTO ejecuciones(oficina,tarea,agente,programada,inicio,estado,sid,manual) VALUES(?,?,?,0,0,'ok',?,0)", [p.carpeta, tarea, agente, sid])
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
    await terminar(p)
  })
})

// MARK: - quedo_esperando y cancelar_espera

describe('quedo_esperando', () => {
  test('sin pedido abierto lo pide por vos y deja la espera atada a pedido:<n>, en el grupo de la sesión', async () => {
    const p = await preparar()
    const { h } = herramientasDe(p)('marce')
    const r = (await h.llamar('quedo_esperando', { colega: 'arqui', que: 'el mapeo y la prueba', plazo_dias: 5 }))!
    expect(r.esError, r.texto).toBe(false)
    const j = objeto(r)
    expect(j.ok).toBe(true)
    const x = p.dep.esperas.una(p.carpeta, j.espera)!
    const ped = p.dep.pedidos.uno(p.carpeta, j.pedido)!
    expect([ped.de, ped.a, ped.que]).toEqual(['marce', 'arqui', 'el mapeo y la prueba'])
    expect(x).toMatchObject({ agente: 'marce', esperaA: 'arqui', ref: `pedido:${ped.id}`, pedido: ped.id, grupo: `sid:${U.a}`, accion: 'continuar', sid: U.a, estado: 'esperando', ronda: 1, plazoDias: 5, origen: 'mcp' })
    expect(j.aviso).toContain('Arqui')
    await terminar(p)
  })

  test('con un pedido abierto lo usa; con un pedido ajeno o inexistente da error; con uno entregado nace lista', async () => {
    const p = await preparar(['marce', 'arqui', 'nico'])
    const t = herramientasDe(p)
    p.sb.modo('arqui', 'puerta')
    const { h } = t('marce')
    const a = objeto(await h.llamar('pedir', { colega: 'arqui', que: 'mapeo' }))
    const r = objeto(await h.llamar('quedo_esperando', { colega: 'arqui', que: 'mapeo' }))
    expect(r.pedido).toBe(a.pedido)
    expect(p.dep.pedidos.lista(p.carpeta).length).toBe(1)
    // pedido de otro, o a otro colega, o inexistente
    const ajeno = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'nico', a: 'arqui', que: 'q' })!
    for (const id of [ajeno.id, 999, 'x']) {
      const e = (await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'm', pedido: id }))!
      expect(e.esError && e.texto.includes('no es un pedido tuyo'), String(id)).toBe(true)
    }
    const aNico = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'marce', a: 'nico', que: 'q' })!
    expect((await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'm', pedido: aNico.id }))?.esError).toBe(true)
    // entregado: nace lista, con lo que llegó
    p.dep.pedidos.actualizar(p.carpeta, aNico.id, { estado: 'entregado', entrega: 42 })
    const ok = objeto(await t('marce').h.llamar('quedo_esperando', { colega: 'nico', que: 'ya llegó', pedido: aNico.id }))
    const x = p.dep.esperas.una(p.carpeta, ok.espera)!
    expect([x.estado, x.entregaLlegada, x.ref]).toEqual(['lista', 42, `pedido:${aNico.id}`])
    await terminar(p)
  })

  test('validaciones: faltantes, plazo fuera de rango, uno mismo, inexistente y oficina cerrada; no lanzan claude', async () => {
    const p = await preparar()
    const t = herramientasDe(p)
    const { h } = t('marce')
    expect((await h.llamar('quedo_esperando', { colega: 'arqui' }))?.esError).toBe(true)
    for (const plazo of [0, 31, 1.5, '3']) {
      const r = (await h.llamar('quedo_esperando', { colega: 'arqui', que: 'x', plazo_dias: plazo }))!
      expect(r.esError && r.texto.includes('entre 1 y 30'), String(plazo)).toBe(true)
    }
    expect((await h.llamar('quedo_esperando', { colega: 'marce', que: 'x' }))?.esError).toBe(true)
    expect((await h.llamar('quedo_esperando', { colega: 'fantasma', que: 'x' }))?.esError).toBe(true)
    const c = (await t('marce', { oficinaId: '/otra' }).h.llamar('quedo_esperando', { colega: 'arqui', que: 'x' }))!
    expect(c.esError && c.texto.includes('oficina')).toBe(true)
    expect(p.sb.llamadas).toEqual([])
    expect(p.dep.esperas.lista(p.carpeta)).toEqual([])
  })

  test('antideadlock: si B ya espera a A (directa o transitivamente), da error', async () => {
    const p = await preparar(['marce', 'arqui', 'nico'])
    const t = herramientasDe(p)
    const hay = (agente: string, esperaA: string) => p.dep.esperas.crear({ oficina: p.carpeta, agente, esperaA, que: 'x', ref: `pedido:${agente}${esperaA}`, grupo: `sid:${agente}`, accion: 'continuar', origen: 'mcp' })
    hay('arqui', 'marce')
    const directo = (await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'x' }))!
    expect(directo.esError && directo.texto.includes('Arqui ya te está esperando a vos')).toBe(true)
    // transitivo: nico espera a arqui, arqui a marce
    const trans = (await t('marce').h.llamar('quedo_esperando', { colega: 'nico', que: 'x' }))!
    expect(trans.esError).toBe(false) // nico no espera a nadie todavía
    hay('nico', 'arqui')
    const t2 = (await t('marce').h.llamar('quedo_esperando', { colega: 'nico', que: 'otra' }))!
    expect(t2.esError && t2.texto.includes('Nico ya te está esperando')).toBe(true)
    // una espera cerrada ya no cuenta
    for (const x of p.dep.esperas.lista(p.carpeta, { agente: 'arqui' })) p.dep.esperas.actualizar(p.carpeta, x.id, { estado: 'hecha' })
    expect((await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'x' }))?.esError).toBe(false)
    await terminar(p)
  })

  test('ronda: la segunda espera de la misma conversación es la ronda 2; la tercera se rechaza', async () => {
    const p = await preparar(['marce', 'arqui', 'nico'])
    const t = herramientasDe(p)
    const e1 = objeto(await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'uno' }))
    expect(p.dep.esperas.una(p.carpeta, e1.espera)!.ronda).toBe(1)
    // la v2 corre en la misma sesión con la espera 1 `relanzada`
    p.dep.esperas.actualizar(p.carpeta, e1.espera, { estado: 'relanzada' })
    const e2 = objeto(await t('marce').h.llamar('quedo_esperando', { colega: 'nico', que: 'dos' }))
    expect(p.dep.esperas.una(p.carpeta, e2.espera)!.ronda).toBe(2)
    p.dep.esperas.actualizar(p.carpeta, e2.espera, { estado: 'hecha' })
    const e3 = (await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'tres' }))!
    expect(e3.esError && e3.texto.includes('Ya van dos versiones esperando a Arqui')).toBe(true)
    // otra sesión es otra cadena
    expect((await t('marce', { sid: U.b }).h.llamar('quedo_esperando', { colega: 'arqui', que: 'tres' }))?.esError).toBe(false)
    await terminar(p)
  })

  test('hasta 5 esperas abiertas por agente y cupo de 3 por token', async () => {
    const p = await preparar(['marce', 'arqui'])
    const t = herramientasDe(p)
    const { h } = t('marce')
    p.sb.modo('arqui', 'puerta')
    for (let i = 1; i <= 3; i++) expect((await h.llamar('quedo_esperando', { colega: 'arqui', que: `m${i}`, pedido: undefined }))?.esError, `m${i}`).toBe(false)
    const cuarta = (await h.llamar('quedo_esperando', { colega: 'arqui', que: 'm4' }))!
    expect(cuarta.esError && cuarta.texto.includes('3 esperas')).toBe(true)
    // el tope por agente: 5 abiertas (con otros tokens)
    for (let i = 0; i < 2; i++) expect((await t('marce', { sid: `5555555${i}-5555-4555-8555-555555555555` }).h.llamar('quedo_esperando', { colega: 'arqui', que: 'x' }))?.esError).toBe(false)
    const sexta = (await t('marce', { sid: U.c }).h.llamar('quedo_esperando', { colega: 'arqui', que: 'x' }))!
    expect(sexta.esError && sexta.texto.includes('5 esperas abiertas')).toBe(true)
    await terminar(p)
  })
})

describe('cancelar_espera', () => {
  test('cancela solo las esperas propias y abiertas, con motivo', async () => {
    const p = await preparar(['marce', 'arqui'])
    const t = herramientasDe(p)
    const e = objeto(await t('marce').h.llamar('quedo_esperando', { colega: 'arqui', que: 'm' }))
    expect((await t('arqui').h.llamar('cancelar_espera', { espera: e.espera }))?.esError).toBe(true)
    expect((await t('marce').h.llamar('cancelar_espera', { espera: 999 }))?.esError).toBe(true)
    expect((await t('marce').h.llamar('cancelar_espera', {}))?.esError).toBe(true)
    const r = (await t('marce').h.llamar('cancelar_espera', { espera: e.espera, motivo: 'lo resolví yo' }))!
    expect(r.esError, r.texto).toBe(false)
    const x = p.dep.esperas.una(p.carpeta, e.espera)!
    expect([x.estado, x.motivo]).toEqual(['cancelada', 'lo resolví yo'])
    const otra = (await t('marce').h.llamar('cancelar_espera', { espera: e.espera }))!
    expect(otra.esError && otra.texto.includes('ya no está abierta')).toBe(true)
    expect((await t('marce', { oficinaId: '/otra' }).h.llamar('cancelar_espera', { espera: e.espera }))?.esError).toBe(true)
    await terminar(p)
  })
})

// MARK: - gancho de entregas

describe('gancho al registrar entregas', () => {
  const registrar = (p: Awaited<ReturnType<typeof preparar>>, agente: string, o: { ref: string; sid?: string; padre?: number; origen?: string; titulo?: string }) =>
    p.s.entregas.registrar({ oficina: p.carpeta, agente, nombre: agente, origen: o.origen ?? 'tarea', ref: o.ref, titulo: o.titulo ?? 'T', texto: 'texto', sid: o.sid ?? '', padre: o.padre })!

  test('la entrega de A en su sid es la v1 de sus esperas abiertas; las de otra sid o ya vinculadas, no', async () => {
    const p = await preparar()
    const mk = (sid: string) => p.dep.esperas.crear({ oficina: p.carpeta, agente: 'marce', esperaA: 'arqui', que: 'x', ref: `pedido:${sid.length}`, grupo: `sid:${sid}`, accion: 'continuar', sid, origen: 'mcp' })!
    const a = mk('s-uno'), b = mk('s-dos')
    const v1 = registrar(p, 'marce', { ref: 't', sid: 's-uno' })
    expect(p.dep.esperas.una(p.carpeta, a.id)!.entregaParcial).toBe(v1.id)
    expect(p.dep.esperas.una(p.carpeta, b.id)!.entregaParcial).toBeUndefined()
    registrar(p, 'marce', { ref: 't', sid: 's-uno' })
    expect(p.dep.esperas.una(p.carpeta, a.id)!.entregaParcial).toBe(v1.id) // ya tenía v1
    // una entrega de otro agente con la misma sid no vincula
    registrar(p, 'nico', { ref: 't', sid: 's-dos' })
    expect(p.dep.esperas.una(p.carpeta, b.id)!.entregaParcial).toBeUndefined()
  })

  test('la entrega de B con la ref del pedido cumple el pedido y deja lista la espera de A', async () => {
    const p = await preparar()
    const ped = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'marce', a: 'arqui', que: 'q', sid: 's1' })!
    const x = p.dep.esperas.crear({ oficina: p.carpeta, agente: 'marce', esperaA: 'arqui', que: 'x', ref: `pedido:${ped.id}`, pedido: ped.id, grupo: 'sid:s1', accion: 'continuar', sid: 's1', origen: 'mcp' })!
    // de otro agente con esa ref no satisface
    registrar(p, 'nico', { ref: `pedido:${ped.id}`, origen: 'pedido' })
    expect(p.dep.esperas.una(p.carpeta, x.id)!.estado).toBe('esperando')
    expect(p.dep.pedidos.uno(p.carpeta, ped.id)!.estado).toBe('corriendo')
    const e = registrar(p, 'arqui', { ref: `pedido:${ped.id}`, origen: 'pedido' })
    const despues = p.dep.esperas.una(p.carpeta, x.id)!
    expect([despues.estado, despues.entregaLlegada]).toEqual(['lista', e.id])
    const pedido = p.dep.pedidos.uno(p.carpeta, ped.id)!
    expect([pedido.estado, pedido.entrega]).toEqual(['entregado', e.id])
  })

  test('una entrega parcial de B no satisface; su v2 (origen espera, padre = v1) sí', async () => {
    const p = await preparar(['marce', 'arqui', 'nico'])
    const ped = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'marce', a: 'arqui', que: 'q', sid: 's1' })!
    const ex1 = p.dep.esperas.crear({ oficina: p.carpeta, agente: 'marce', esperaA: 'arqui', que: 'x', ref: `pedido:${ped.id}`, pedido: ped.id, grupo: 'sid:s1', accion: 'continuar', sid: 's1', origen: 'mcp' })!
    // arqui, en su corrida del pedido (sesión s2), espera a nico
    const q = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'arqui', a: 'nico', que: 'q', sid: 's2', cadena: ped.id, profundidad: 1 })!
    const ex2 = p.dep.esperas.crear({ oficina: p.carpeta, agente: 'arqui', esperaA: 'nico', que: 'y', ref: `pedido:${q.id}`, pedido: q.id, grupo: 'sid:s2', accion: 'continuar', sid: 's2', origen: 'mcp' })!
    const v1 = registrar(p, 'arqui', { ref: `pedido:${ped.id}`, origen: 'pedido', sid: 's2' })
    expect(p.dep.esperas.una(p.carpeta, ex2.id)!.entregaParcial).toBe(v1.id)
    expect(p.dep.pedidos.uno(p.carpeta, ped.id)!.estado).toBe('corriendo')
    expect(p.dep.esperas.una(p.carpeta, ex1.id)!.estado).toBe('esperando')
    // nico entrega lo de arqui: ex2 lista (nico no entrega parcial)
    const n = registrar(p, 'nico', { ref: `pedido:${q.id}`, origen: 'pedido' })
    expect(p.dep.esperas.una(p.carpeta, ex2.id)).toMatchObject({ estado: 'lista', entregaLlegada: n.id })
    expect(p.dep.pedidos.uno(p.carpeta, q.id)!.estado).toBe('entregado')
    // la v2 de arqui se relanza (la espera 2 pasa a relanzada) y entrega
    p.dep.esperas.actualizar(p.carpeta, ex2.id, { estado: 'relanzada' })
    const v2 = registrar(p, 'arqui', { ref: `espera:${ex2.id}`, origen: 'espera', sid: 's2', padre: v1.id })
    expect(p.dep.esperas.una(p.carpeta, ex2.id)).toMatchObject({ estado: 'hecha', entregaNueva: v2.id })
    expect(p.dep.pedidos.uno(p.carpeta, ped.id)).toMatchObject({ estado: 'entregado', entrega: v2.id })
    expect(p.dep.esperas.una(p.carpeta, ex1.id)).toMatchObject({ estado: 'lista', entregaLlegada: v2.id })
  })

  test('esperando a la persona: la entrega origen persona con la ref satisface; un agente no', async () => {
    const p = await preparar()
    const x = p.dep.esperas.crear({ oficina: p.carpeta, agente: 'marce', esperaA: 'persona', que: 'x', ref: 'encargo:abc:0', grupo: 'reunion:abc:1', accion: 'encargar', origen: 'reunion', tarea: 'encargo:abc:1' })!
    registrar(p, 'arqui', { ref: 'encargo:abc:0' })
    expect(p.dep.esperas.una(p.carpeta, x.id)!.estado).toBe('esperando')
    const e = registrar(p, '', { ref: 'encargo:abc:0', origen: 'persona' })
    expect(p.dep.esperas.una(p.carpeta, x.id)).toMatchObject({ estado: 'lista', entregaLlegada: e.id })
  })

  test('un pedido o un relanzamiento que terminan en error: el pedido pasa a fallido y las esperas a fallida', async () => {
    const p = await preparar()
    const ped = p.dep.pedidos.crear({ oficina: p.carpeta, de: 'marce', a: 'arqui', que: 'q' })!
    const x = p.dep.esperas.crear({ oficina: p.carpeta, agente: 'marce', esperaA: 'arqui', que: 'x', ref: `pedido:${ped.id}`, pedido: ped.id, grupo: 'sid:s1', accion: 'continuar', sid: 's1', origen: 'mcp' })!
    const ej = { id: 1, oficina: p.carpeta, tarea: `pedido:${ped.id}`, agente: 'arqui', programada: 0, inicio: 0, estado: 'error', sid: 's', resultado: '', error: 'se cayó', manual: true }
    p.dep.alTerminarEjecucion(ej)
    expect(p.dep.pedidos.uno(p.carpeta, ped.id)).toMatchObject({ estado: 'fallido', error: 'se cayó' })
    expect(p.dep.esperas.una(p.carpeta, x.id)!.estado).toBe('esperando')
    p.dep.esperas.actualizar(p.carpeta, x.id, { estado: 'relanzada' })
    p.dep.alTerminarEjecucion({ ...ej, tarea: `espera:${x.id}`, error: 'falló la v2' })
    expect(p.dep.esperas.una(p.carpeta, x.id)).toMatchObject({ estado: 'fallida', motivo: 'falló la v2' })
    // las que terminan bien no cambian nada
    const y = p.dep.esperas.crear({ oficina: p.carpeta, agente: 'marce', esperaA: 'arqui', que: 'x', ref: 'pedido:9', grupo: 'g', accion: 'encargar', origen: 'reunion', tarea: 'encargo:r:1', estado: 'relanzada' })!
    p.dep.alTerminarEjecucion({ ...ej, tarea: 'encargo:r:1', estado: 'ok', error: undefined })
    expect(p.dep.esperas.una(p.carpeta, y.id)!.estado).toBe('relanzada')
    p.dep.alTerminarEjecucion({ ...ej, tarea: 'encargo:r:1', error: 'x' })
    expect(p.dep.esperas.una(p.carpeta, y.id)!.estado).toBe('fallida')
  })
})
