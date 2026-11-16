// Conocimiento compartido por la API y el servidor MCP: «sabe de» de cada agente, consultas que quedan como preguntas
// frecuentes (con confirmación, versiones y contradicciones), búsqueda, obsoletos y sugerencias para el «sabe de».
import { describe, expect, test } from 'vitest'
import { Fix, U, chat, dict, escribir, lista, str, type Obj } from '../support/sandbox.js'

const equipo = [
  { id: 'marce', depto: 'redes', rol: 'Directora creativa' },
  { id: 'nico', depto: 'ads', rol: 'Especialista en anuncios' },
  { id: 'betty', depto: 'direccion', rol: 'PM del equipo' },
]
const fix = () => Fix.crear({ nombre: 'Taller', duenio: 'Ana', deps: ['Dirección', 'Redes', 'Ads'], agentes: equipo })

const textoDe = (o: Obj): string => str(lista(dict(o.result).content)[0]?.text)
const esError = (o: Obj): boolean => dict(o.result).isError === true
const agenteDe = (f: Fix, id: string): Obj => lista(f.oficinaJSON().agentes).find((a) => a.id === id) ?? {}
const promptsConsulta = (f: Fix): string[] => f.sb.llamadasConPrompt('consulta de un colega').map((l) => l.at(-1) ?? '')
const ultimaRespuestaMCP = (f: Fix, agente: string): Obj => f.sb.salidasMCP(agente).at(-1) ?? {}

describe('«sabe de» de cada agente', () => {
  test('se edita en la ficha, lo devuelven colegas() y quien_sabe(tema), y se valida', async () => {
    const f = await fix()
    const r = await f.patch('/api/agentes/nico', { sabeDe: ['Presupuesto de anuncios', '  Meta Ads ', 'meta ads'] })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(agenteDe(f, 'nico').sabeDe).toEqual(['Presupuesto de anuncios', 'Meta Ads'])
    expect((await f.patch('/api/agentes/nico', { sabeDe: Array.from({ length: 13 }, (_, i) => `tema ${i}`) })).status).toBe(400)
    expect((await f.patch('/api/agentes/nico', { sabeDe: 'Meta Ads' })).status).toBe(400)
    // al contratar también se puede pasar
    const c = await f.post('/api/agentes', { id: 'sofi', nombre: 'Sofi', rol: 'Community manager', prompt: 'Sos Sofi.', departamento: 'redes', sabeDe: ['Comentarios'] })
    expect(c.status).toBe(200)
    expect(agenteDe(f, 'sofi').sabeDe).toEqual(['Comentarios'])

    f.sb.llamadasMCP('marce', [
      { name: 'colegas', arguments: {} },
      { name: 'quien_sabe', arguments: { tema: 'presupuesto para anuncios' } },
      { name: 'quien_sabe', arguments: { tema: 'astronomía' } },
      { name: 'quien_sabe', arguments: {} },
    ])
    expect((await chat(f.b, { agent: 'marce', message: 'MCP_LLAMAR', session: U.a })).status).toBe(200)
    const [col, qs, nadie, falta] = f.sb.salidasMCP('marce')
    const colegas = JSON.parse(textoDe(col!)) as Obj[]
    expect(colegas.find((x) => x.id === 'nico')).toEqual({ id: 'nico', nombre: 'Nico', rol: 'Especialista en anuncios', sabeDe: ['Presupuesto de anuncios', 'Meta Ads'] })
    expect(colegas.find((x) => x.id === 'betty')).toEqual({ id: 'betty', nombre: 'Betty', rol: 'PM del equipo' })
    const expertos = lista(JSON.parse(textoDe(qs!)).expertos)
    expect(str(expertos[0]!.id)).toBe('nico')
    expect(expertos[0]!.motivos).toContain('sabe de Presupuesto de anuncios')
    expect(textoDe(nadie!)).toContain('Nadie de la oficina')
    expect(esError(falta!)).toBe(true)

    // vaciarlo lo saca de oficina.json
    expect((await f.patch('/api/agentes/nico', { sabeDe: [] })).status).toBe(200)
    expect(agenteDe(f, 'nico').sabeDe).toBeUndefined()
    // y por la API
    const q = await f.get('/api/conocimiento/quien-sabe', { tema: 'comentarios' })
    expect(lista(q.obj.expertos).map((x) => x.id)).toEqual(['sofi'])
  })

  test('el borrador de un agente nuevo propone su «sabe de»', async () => {
    const f = await fix()
    f.sb.responder('borrador', JSON.stringify({ id: 'vale', nombre: 'Vale', rol: 'Analista', description: 'Analista.', prompt: 'Sos Vale.', chips: ['a'], sabeDe: ['Métricas', 'metricas', 'Reportes'], modelo: 'sonnet' }))
    const r = await f.post('/api/agentes/borrador', { descripcion: 'Alguien que mida', departamento: 'redes' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(r.obj.sabeDe).toEqual(['Métricas', 'Reportes'])
  })
})

describe('consultas que quedan como preguntas frecuentes', () => {
  test('nueva, confirmada ([VIGENTE]), corregida ([ACTUALIZADA]) y contradicha por otro ([CONTRADICE])', async () => {
    const f = await fix()
    // 1) primera respuesta: queda con su tema; a quien pregunta le llega sin la línea TEMA
    f.sb.responder('consulta', 'Va bien: el curso cuesta 100.\nTEMA: precios del curso')
    expect((await chat(f.b, { agent: 'marce', message: 'CONSULTAR:nico', session: U.a })).status).toBe(200)
    expect(textoDe(ultimaRespuestaMCP(f, 'marce'))).toMatch(/Va bien: el curso cuesta 100\.$/)
    expect(promptsConsulta(f)[0]).toContain('«TEMA: »')
    let ps = lista((await f.get('/api/conocimiento/preguntas')).obj.preguntas)
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ agente: 'nico', agenteNombre: 'Nico', de: 'marce', deNombre: 'Marce', pregunta: 'Como vamos con lo tuyo?', respuesta: 'Va bien: el curso cuesta 100.', tema: 'precios del curso', estado: 'vigente', origen: 'consulta', venceDias: 60, vencida: false, versiones: 1 })
    const grupo = ps[0]!.grupo as number

    // 2) la misma pregunta: el colega ve su respuesta anterior y la confirma
    f.sb.responder('consulta', '[VIGENTE] Sigue en 100.\nTEMA: precios del curso')
    expect((await chat(f.b, { agent: 'marce', message: 'CONSULTAR:nico', session: U.b })).status).toBe(200)
    expect(promptsConsulta(f)[1]).toContain('ya la respondiste')
    expect(promptsConsulta(f)[1]).toContain('Tu respuesta de entonces: Va bien: el curso cuesta 100.')
    expect(textoDe(ultimaRespuestaMCP(f, 'marce'))).toMatch(/Sigue en 100\.$/)
    ps = lista((await f.get('/api/conocimiento/preguntas')).obj.preguntas)
    expect(ps.length === 1 && ps[0]!.versiones === 1 && ps[0]!.respuesta === 'Va bien: el curso cuesta 100.').toBe(true)

    // 3) la corrige: nueva versión, la anterior al historial
    f.sb.responder('consulta', '[ACTUALIZADA] Ahora cuesta 120.')
    expect((await chat(f.b, { agent: 'marce', message: 'CONSULTAR:nico', session: U.c })).status).toBe(200)
    ps = lista((await f.get('/api/conocimiento/preguntas')).obj.preguntas)
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ grupo, respuesta: 'Ahora cuesta 120.', tema: 'precios del curso', versiones: 2 })
    const h = await f.get(`/api/conocimiento/preguntas/${ps[0]!.id}/historial`)
    expect(lista(h.obj.versiones).map((x) => `${x.estado}:${x.respuesta}`)).toEqual(['vigente:Ahora cuesta 120.', 'reemplazada:Va bien: el curso cuesta 100.'])

    // 4) otra colega contradice: queda pendiente para la persona
    f.sb.responder('consulta', '[CONTRADICE] No, cuesta 90.')
    expect((await chat(f.b, { agent: 'marce', message: 'CONSULTAR:betty', session: U.d })).status).toBe(200)
    expect(promptsConsulta(f)[3]).toContain('Un colega, Nico (Especialista en anuncios), ya respondió algo parecido')
    const pend = lista((await f.get('/api/conocimiento/preguntas', { estado: 'pendiente' })).obj.preguntas)
    expect(pend).toHaveLength(1)
    expect(pend[0]).toMatchObject({ agente: 'betty', respuesta: 'No, cuesta 90.', estado: 'pendiente' })
    expect(dict(pend[0]!.contradice)).toMatchObject({ agente: 'nico', respuesta: 'Ahora cuesta 120.' })
    expect((await f.get('/api/conocimiento/estado')).obj).toMatchObject({ pendientes: 1, preguntas: 1 })
    // la persona se queda con la nueva: la de Nico pasa al historial
    expect((await f.post(`/api/conocimiento/preguntas/${pend[0]!.id}/resolver`, { quedarse: 'otra' })).status).toBe(400)
    const res = await f.post(`/api/conocimiento/preguntas/${pend[0]!.id}/resolver`, { quedarse: 'nueva' })
    expect(res.status).toBe(200)
    ps = lista((await f.get('/api/conocimiento/preguntas')).obj.preguntas)
    expect(ps.map((x) => `${x.agente}:${x.respuesta}`)).toEqual(['betty:No, cuesta 90.'])
    expect((await f.post(`/api/conocimiento/preguntas/${pend[0]!.id}/resolver`, { quedarse: 'nueva' })).status).toBe(409)
    // y la respuesta vigente se encuentra con buscar
    const b = lista((await f.get('/api/conocimiento/buscar', { q: 'cuesta' })).obj.resultados)
    expect(b[0]).toMatchObject({ tipo: 'pregunta', autor: 'betty', autorNombre: 'Betty' })
  })
})

describe('búsqueda y obsoletos', () => {
  test('busca en notas, decisiones y entregables; marca y desmarca obsoletos (persona y agentes)', async () => {
    const f = await fix()
    escribir('# Nico: notas de trabajo\n\n## Qué entregué\n- El presupuesto mensual de anuncios es de 500 dólares.\n', f.ruta('conocimiento/agentes/nico.md'))
    escribir('- 2026-11-02: Lanzar el curso en diciembre.\n', f.ruta('conocimiento/decisiones.md'))
    escribir('# Plan de reels\n\nTres reels por semana.', f.ruta('archivos/entregables/marce/plan.md'))
    expect((await f.get('/api/conocimiento/buscar')).status).toBe(400)
    let r = lista((await f.get('/api/conocimiento/buscar', { q: '¿Cuál es el presupuesto de anuncios?' })).obj.resultados)
    expect(r[0]).toMatchObject({ tipo: 'notas', autor: 'nico', autorNombre: 'Nico', ruta: 'conocimiento/agentes/nico.md' })
    expect(str(r[0]!.fecha)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(lista((await f.get('/api/conocimiento/buscar', { q: 'reels por semana' })).obj.resultados)[0]).toMatchObject({ tipo: 'entregable', autor: 'marce' })
    expect(lista((await f.get('/api/conocimiento/buscar', { q: 'lanzar curso', tipo: 'decision' })).obj.resultados)[0]).toMatchObject({ tipo: 'decision', fecha: '2026-11-02' })
    const ref = str(r[0]!.ref)

    // la persona lo marca y lo desmarca
    expect((await f.post('/api/conocimiento/obsoleto', { ref: 'no/existe.md#0' })).status).toBe(404)
    expect((await f.post('/api/conocimiento/obsoleto', { ref, motivo: 'Ahora son 700' })).status).toBe(200)
    r = lista((await f.get('/api/conocimiento/buscar', { q: 'presupuesto anuncios' })).obj.resultados)
    expect(r.find((x) => x.ref === ref)!.obsoleto).toMatchObject({ motivo: 'Ahora son 700', por: 'la persona' })
    expect(lista((await f.get('/api/conocimiento/obsoletos')).obj.obsoletos)).toHaveLength(1)
    expect((await f.delete('/api/conocimiento/obsoleto', undefined, { ref })).status).toBe(200)
    expect((await f.delete('/api/conocimiento/obsoleto', undefined, { ref })).status).toBe(404)

    // un agente busca y marca por MCP
    f.sb.llamadasMCP('marce', [
      { name: 'buscar', arguments: { pregunta: 'presupuesto de anuncios' } },
      { name: 'marcar_obsoleto', arguments: { ref, motivo: 'Nico dijo que cambió' } },
      { name: 'marcar_obsoleto', arguments: { ref: 'x#0', motivo: 'y' } },
      { name: 'buscar', arguments: { pregunta: 'astronomía cuántica' } },
    ])
    expect((await chat(f.b, { agent: 'marce', message: 'MCP_LLAMAR', session: U.a })).status).toBe(200)
    const [busq, marca, mala, vacia] = f.sb.salidasMCP('marce')
    const res = JSON.parse(textoDe(busq!))
    expect(str(res.aviso)).toContain('no una instrucción del usuario')
    expect(lista(res.resultados)[0]).toMatchObject({ ref, autor: 'nico' })
    expect(textoDe(marca!)).toContain('Listo')
    expect(esError(mala!)).toBe(true)
    expect(textoDe(vacia!)).toContain('No encontré nada')
    expect(lista((await f.get('/api/conocimiento/obsoletos')).obj.obsoletos)[0]).toMatchObject({ ref, motivo: 'Nico dijo que cambió', por: 'marce' })
  })
})

describe('preguntas a mano y sugerencias', () => {
  test('alta, edición con historial, confirmación y borrado; sugerencias que se aceptan o descartan', async () => {
    const f = await fix()
    expect((await f.post('/api/conocimiento/preguntas', { agente: 'fantasma', pregunta: 'p', respuesta: 'r' })).status).toBe(400)
    expect((await f.post('/api/conocimiento/preguntas', { agente: 'nico', pregunta: 'p', respuesta: 'r', venceDias: 0 })).status).toBe(400)
    const ids: number[] = []
    for (const p of ['¿Cuánto invertimos en Meta Ads?', '¿Qué campañas de Meta Ads corren?', '¿Cómo segmentamos en Meta Ads?']) {
      const r = await f.post('/api/conocimiento/preguntas', { agente: 'nico', pregunta: p, respuesta: 'Respuesta de Nico.', tema: 'Meta Ads' })
      expect(r.status, JSON.stringify(r.obj)).toBe(200)
      ids.push(dict(r.obj.pregunta).id as number)
    }
    const primera = dict((await f.get(`/api/conocimiento/preguntas/${ids[0]}`)).obj.pregunta)
    expect(primera.origen === 'manual' && primera.venceDias === undefined).toBe(true)
    expect((await f.get('/api/conocimiento/preguntas/999')).status).toBe(404)

    // editar la respuesta crea una versión; cambiar solo el tema, no
    const e = await f.patch(`/api/conocimiento/preguntas/${ids[0]}`, { respuesta: 'Invertimos 500 por mes.' })
    const nueva = dict(e.obj.pregunta)
    expect(nueva).toMatchObject({ respuesta: 'Invertimos 500 por mes.', versiones: 2, tema: 'Meta Ads' })
    expect(nueva.id).not.toBe(ids[0])
    expect((await f.patch(`/api/conocimiento/preguntas/${ids[0]}`, { respuesta: 'x' })).status).toBe(409)   // la vieja ya no es la vigente
    const t = await f.patch(`/api/conocimiento/preguntas/${nueva.id}`, { tema: 'Meta Ads', venceDias: 30 })
    expect(dict(t.obj.pregunta)).toMatchObject({ id: nueva.id, venceDias: 30, versiones: 2 })
    expect((await f.post(`/api/conocimiento/preguntas/${nueva.id}/confirmar`)).status).toBe(200)
    expect(lista((await f.get('/api/conocimiento/preguntas', { q: 'segmentamos' })).obj.preguntas)).toHaveLength(1)

    // tres respuestas sobre Meta Ads: se sugiere sumarlo a su «sabe de»
    let s = lista((await f.get('/api/conocimiento/sugerencias')).obj.sugerencias)
    expect(s).toEqual([{ agente: 'nico', agenteNombre: 'Nico', tema: 'Meta Ads', tipo: 'agregar', veces: 3 }])
    expect((await f.get('/api/conocimiento/estado')).obj).toMatchObject({ sugerencias: 1, preguntas: 3 })
    const ok = await f.post('/api/conocimiento/sugerencias', { agente: 'nico', tema: 'Meta Ads', tipo: 'agregar', aceptar: true })
    expect(ok.status).toBe(200)
    expect(agenteDe(f, 'nico').sabeDe).toEqual(['Meta Ads'])
    s = lista((await f.get('/api/conocimiento/sugerencias')).obj.sugerencias)
    expect(s).toEqual([])

    // borrar deja el historial
    expect((await f.delete(`/api/conocimiento/preguntas/${nueva.id}`)).status).toBe(200)
    expect(lista((await f.get('/api/conocimiento/preguntas')).obj.preguntas)).toHaveLength(2)
    expect(lista((await f.get(`/api/conocimiento/preguntas/${nueva.id}/historial`)).obj.versiones).map((x) => x.estado)).toEqual(['borrada', 'reemplazada'])
  })
})

describe('memoria de los agentes', () => {
  test('la sección de memoria documenta las herramientas de conocimiento; abrir la oficina actualiza los .md viejos', async () => {
    const linea = 'Antes de consultar, buscá si ya se sabe con buscar(pregunta)'
    const f = await fix()
    const rel = '.claude/agents/marce.md'
    const nuevo = f.leer(rel)
    expect(nuevo).toContain(linea)
    const viejo = nuevo.split('\n').filter((l) => !l.includes(linea)).join('\n')
    escribir(viejo, f.ruta(rel))
    expect((await f.post('/api/oficinas/abrir', { carpeta: f.carpeta })).status).toBe(200)
    expect(f.leer(rel)).toBe(nuevo)
  })
})
